import os from 'node:os';
import path from 'node:path';
import {
  createEncryptedPatientQrToken,
  decryptPortalPassword,
  encryptPortalPassword,
  generatePatientQrSecret,
  generatePortalPassword,
  hashPassword,
  verifyQrSecretMatch,
} from './auth.ts';
import {
  addDaysToIsoDate,
  computeInvoiceCommission,
  deduplicateResultRows,
  getCanonicalParameterKey,
  getLocalTimestampStr,
  getTodayDateStr,
  roundCurrency,
} from './clinical-rules.ts';
import {
  db,
  evaluateResultFlag,
  getAllSettings as sqliteGetAllSettings,
  getSetting as sqliteGetSetting,
  initDatabase,
} from './db.ts';
import {
  type AdjustInvoiceBillPayload,
  type CreateInvoicePayload,
  type LimsStore,
  type ParamPayload,
  type ReagentDeductionRecord,
  StoreError,
  type TestCommissionOverride,
  type UpdateInvoicePayload,
  type UpdateLabResultsPayload,
} from './store-types.ts';
import {
  type ReagentMatchCandidate,
  selectFefoReagentBatchesForTest,
} from '../shared/reagentMatcher.ts';
import {
  computeSequentialDiscounts,
  resolveInvoiceDiscountBreakdown,
} from '../shared/discountMath.ts';

function normalizeMappedReagents(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const clean = String(item ?? '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function parseMappedReagentsJson(raw: unknown): string[] {
  if (Array.isArray(raw)) return normalizeMappedReagents(raw);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    return normalizeMappedReagents(JSON.parse(raw));
  } catch {
    return [];
  }
}

function parseReagentDeductionsJson(raw: unknown): ReagentDeductionRecord[] {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw.trim()
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return [];
          }
        })()
      : [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((d: unknown) => {
      const obj = d as Partial<ReagentDeductionRecord>;
      return {
        reagent_id: Number(obj.reagent_id || 0),
        reagent_name: String(obj.reagent_name || '').trim(),
        quantity: Math.max(0, Math.round(Number(obj.quantity || 0))),
      };
    })
    .filter((d) => d.reagent_id > 0 && d.reagent_name.length > 0 && d.quantity > 0);
}

export class SqliteLimsStore implements LimsStore {
  readonly mode = 'sqlite' as const;
  readonly label = 'Local SQLite (Fallback — Set MONGO_URI for Cloud Persistence)';
  readonly warning?: string;
  private cachedSecret = '';

  constructor(warning?: string) {
    this.warning = warning;
  }

  async init(): Promise<void> {
    initDatabase();
    this.cachedSecret = process.env.AUTH_SECRET?.trim() || sqliteGetSetting('auth_secret');
  }

  async ping(): Promise<boolean> {
    db.prepare('SELECT 1').get();
    return true;
  }

  getAuthSecret(): string {
    return this.cachedSecret || sqliteGetSetting('auth_secret');
  }

  async getSetting(key: string): Promise<string> {
    return sqliteGetSetting(key);
  }

  async setSetting(key: string, value: string): Promise<void> {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    if (key === 'auth_secret' && !process.env.AUTH_SECRET?.trim()) {
      this.cachedSecret = value;
    }
  }

  async getAllSettings(): Promise<Record<string, string>> {
    return sqliteGetAllSettings();
  }

  async updateSettings(
    updates: Record<string, string | number>,
    allowedKeys: string[]
  ): Promise<Record<string, string>> {
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const tx = db.transaction(() => {
      for (const k of allowedKeys) {
        if (updates[k] !== undefined && updates[k] !== null) {
          let val = String(updates[k]).trim();
          if (k === 'max_staff_discount_pct') {
            const num = Number(val);
            const clamped = Number.isFinite(num) ? Math.min(100, Math.max(0, num)) : 100;
            val = String(clamped);
          }
          upsert.run(k, val);
        }
      }
    });
    tx();
    return this.getAllSettings();
  }

  async getStaffOverview(): Promise<Record<string, unknown>> {
    const today = getTodayDateStr();
    const todayPatients = (
      db.prepare(`SELECT COUNT(*) as c FROM invoices WHERE substr(created_at, 1, 10) = ?`).get(today) as { c: number }
    ).c;
    const sampleCollectedCount = (
      db.prepare(`SELECT COUNT(*) as c FROM invoice_tests WHERE status = 'Sample Collected'`).get() as { c: number }
    ).c;
    const processingCount = (
      db.prepare(`SELECT COUNT(*) as c FROM invoice_tests WHERE status = 'Processing'`).get() as { c: number }
    ).c;
    const verifiedCount = (
      db.prepare(`SELECT COUNT(*) as c FROM invoice_tests WHERE status = 'Verified'`).get() as { c: number }
    ).c;
    const readyReportsCount = (
      db
        .prepare(`SELECT COUNT(*) as c FROM invoice_tests WHERE status = 'Ready' AND substr(collected_at, 1, 10) = ?`)
        .get(today) as { c: number }
    ).c;
    const dueInvoicesCount = (
      db.prepare(`SELECT COUNT(*) as c FROM invoices WHERE due_amount > 0`).get() as { c: number }
    ).c;

    const recentInvs = db
      .prepare(
        `SELECT i.id as invoice_id, i.invoice_no, i.created_at,
                p.patient_uid, p.name as patient_name, p.age_years, p.age_months, p.age_days, p.gender, p.mobile as patient_mobile,
                d.name as doctor_name
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         LEFT JOIN doctors d ON d.id = i.doctor_id
         ORDER BY i.id DESC LIMIT 12`
      )
      .all() as Array<{
      invoice_id: number;
      invoice_no: string;
      created_at: string;
      patient_uid: string;
      patient_name: string;
      age_years: number;
      age_months: number;
      age_days: number;
      gender: 'Male' | 'Female' | 'Other';
      patient_mobile: string;
      doctor_name: string | null;
    }>;

    const invIds = recentInvs.map((i) => i.invoice_id);
    const invTests =
      invIds.length > 0
        ? (db
            .prepare(
              `SELECT id, invoice_id, test_name, category_name, status, collected_at
               FROM invoice_tests
               WHERE invoice_id IN (${invIds.map(() => '?').join(',')})
               ORDER BY id ASC`
            )
            .all(...invIds) as Array<{
            id: number;
            invoice_id: number;
            test_name: string;
            category_name: string;
            status: 'Sample Collected' | 'Processing' | 'Verified' | 'Ready';
            collected_at: string;
          }>)
        : [];

    const testsByInv = new Map<number, typeof invTests>();
    for (const it of invTests) {
      const list = testsByInv.get(it.invoice_id) || [];
      list.push(it);
      testsByInv.set(it.invoice_id, list);
    }

    const recentPatientQueue = recentInvs.map((inv) => {
      const items = testsByInv.get(inv.invoice_id) || [];
      const readyCount = items.filter((t) => t.status === 'Ready').length;
      const latestCollectedAt =
        items.reduce((latest, t) => (!latest || (t.collected_at && t.collected_at > latest) ? t.collected_at : latest), '') ||
        inv.created_at;

      return {
        invoice_id: inv.invoice_id,
        invoice_no: inv.invoice_no,
        created_at: inv.created_at,
        patient_uid: inv.patient_uid,
        patient_name: inv.patient_name,
        age_years: inv.age_years || 0,
        age_months: inv.age_months || 0,
        age_days: inv.age_days || 0,
        gender: inv.gender || 'Male',
        patient_mobile: inv.patient_mobile || '',
        doctor_name: inv.doctor_name || '',
        latest_collected_at: latestCollectedAt,
        ready_count: readyCount,
        total_tests: items.length,
        tests: items.map((it) => ({
          id: it.id,
          test_name: it.test_name,
          category_name: it.category_name,
          status: it.status,
          collected_at: it.collected_at,
        })),
      };
    });

    const recentQueue = recentPatientQueue.flatMap((grp) =>
      grp.tests.map((it) => ({
        id: it.id,
        test_name: it.test_name,
        category_name: it.category_name,
        status: it.status,
        collected_at: it.collected_at,
        invoice_id: grp.invoice_id,
        invoice_no: grp.invoice_no,
        patient_uid: grp.patient_uid,
        patient_name: grp.patient_name,
        gender: grp.gender,
        age_years: grp.age_years,
        age_months: grp.age_months,
        age_days: grp.age_days,
      }))
    );

    return {
      todayPatients,
      sampleCollectedCount,
      processingCount,
      verifiedCount,
      pendingTestsCount: sampleCollectedCount + processingCount + verifiedCount,
      readyReportsCount,
      dueInvoicesCount,
      recentPatientQueue,
      recentQueue,
    };
  }

  async getAdminDashboard(from: string, to: string): Promise<Record<string, unknown>> {
    const invoiceAgg = db
      .prepare(
        `SELECT
           COUNT(*) as patientsCount,
           COALESCE(SUM(subtotal), 0) as totalBilled,
           COALESCE(SUM(discount_amount), 0) as totalDiscount,
           COALESCE(SUM(net_total), 0) as totalNetBilled,
           COALESCE(SUM(paid_amount), 0) as collectedFromInvoices,
           COALESCE(SUM(due_amount), 0) as pendingDueInRange,
           COALESCE(SUM(commission_amount), 0) as doctorCommissionPayable
         FROM invoices
         WHERE substr(created_at, 1, 10) BETWEEN ? AND ?`
      )
      .get(from, to) as {
      patientsCount: number;
      totalBilled: number;
      totalDiscount: number;
      totalNetBilled: number;
      collectedFromInvoices: number;
      pendingDueInRange: number;
      doctorCommissionPayable: number;
    };

    const dueRecoveredRow = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as recovered,
           COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) as refunded
         FROM due_payments
         WHERE substr(collected_at, 1, 10) BETWEEN ? AND ?`
      )
      .get(from, to) as { recovered: number; refunded: number };

    const expenseRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as totalExpenses
         FROM expenses
         WHERE expense_date BETWEEN ? AND ?`
      )
      .get(from, to) as { totalExpenses: number };

    const pendingReports = (
      db.prepare(`SELECT COUNT(*) as c FROM invoice_tests WHERE status != 'Ready'`).get() as { c: number }
    ).c;

    const readyReportsInRange = (
      db
        .prepare(`SELECT COUNT(*) as c FROM invoice_tests WHERE status = 'Ready' AND substr(collected_at, 1, 10) BETWEEN ? AND ?`)
        .get(from, to) as { c: number }
    ).c;

    const allTimeDueRow = db
      .prepare(`SELECT COALESCE(SUM(due_amount), 0) as totalDue, COUNT(*) as dueCount FROM invoices WHERE due_amount > 0`)
      .get() as { totalDue: number; dueCount: number };

    const initialCashRow = db
      .prepare(
        `SELECT COALESCE(SUM(i.paid_amount - COALESCE(dp.dp_sum, 0)), 0) as initialPaid
         FROM invoices i
         LEFT JOIN (SELECT invoice_id, SUM(amount) as dp_sum FROM due_payments GROUP BY invoice_id) dp
           ON dp.invoice_id = i.id
         WHERE substr(i.created_at, 1, 10) BETWEEN ? AND ?`
      )
      .get(from, to) as { initialPaid: number };

    // Master Unpaid Commission Pool across all referring doctors
    const allCommissionInvs = db
      .prepare(
        `SELECT i.created_at, i.commission_amount, i.commission_paid, d.last_commission_paid_up_to
         FROM invoices i
         JOIN doctors d ON d.id = i.doctor_id
         WHERE i.doctor_id IS NOT NULL`
      )
      .all() as Array<{
      created_at: string;
      commission_amount: number;
      commission_paid: number;
      last_commission_paid_up_to?: string;
    }>;

    let masterUnpaidCommissionPool = 0;
    for (const ci of allCommissionInvs) {
      const lastPaidUpTo = String(ci.last_commission_paid_up_to || '').trim();
      const invDate = String(ci.created_at || '').slice(0, 10);
      const isPaid = ci.commission_paid === 1 || (Boolean(lastPaidUpTo) && invDate <= lastPaidUpTo);
      if (!isPaid) {
        masterUnpaidCommissionPool = roundCurrency(
          masterUnpaidCommissionPool + Number(ci.commission_amount || 0)
        );
      }
    }

    const totalNetBilled = roundCurrency(Number(invoiceAgg.totalNetBilled || 0));
    const doctorCommissionPayable = roundCurrency(Number(invoiceAgg.doctorCommissionPayable || 0));
    const netRevenue = roundCurrency(totalNetBilled - doctorCommissionPayable);
    const netCollection = roundCurrency(
      initialCashRow.initialPaid + dueRecoveredRow.recovered - dueRecoveredRow.refunded
    );
    const netProfit = roundCurrency(netCollection - doctorCommissionPayable - expenseRow.totalExpenses);

    const departmentBreakdown = db
      .prepare(
        `SELECT it.category_name as category, COUNT(*) as testCount, COALESCE(SUM(it.price), 0) as grossAmount
         FROM invoice_tests it
         JOIN invoices i ON i.id = it.invoice_id
         WHERE substr(i.created_at, 1, 10) BETWEEN ? AND ?
         GROUP BY it.category_name
         ORDER BY grossAmount DESC`
      )
      .all(from, to);

    const recentInvoicesRaw = db
      .prepare(
        `SELECT i.*, p.patient_uid, p.name as patient_name, p.age_years, p.age_months, p.age_days, p.gender, p.mobile as patient_mobile,
                d.name as doctor_name, d.degree as doctor_degree, d.hospital as doctor_hospital,
                d.commission_pct as doctor_default_commission_pct, d.last_commission_paid_up_to
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         LEFT JOIN doctors d ON d.id = i.doctor_id
         WHERE substr(i.created_at, 1, 10) BETWEEN ? AND ?
         ORDER BY i.id DESC`
      )
      .all(from, to) as Array<
      Record<string, unknown> & {
        id: number;
        doctor_id: number | null;
        created_at: string;
        commission_amount: number;
        commission_paid: number;
        last_commission_paid_up_to?: string;
      }
    >;

    const recentInvIds = recentInvoicesRaw.map((r) => r.id);
    const recentTestsByInv = new Map<
      number,
      Array<{
        id: number;
        test_id: number;
        test_name: string;
        category_name: string;
        status: string;
        price: number;
        commission_type: string;
        commission_value: number;
        commission_amount: number;
      }>
    >();
    if (recentInvIds.length > 0) {
      const recentTestRows = db
        .prepare(
          `SELECT id, invoice_id, test_id, test_name, category_name, status, price, commission_type, commission_value, commission_amount
           FROM invoice_tests
           WHERE invoice_id IN (${recentInvIds.map(() => '?').join(',')})
           ORDER BY id ASC`
        )
        .all(...recentInvIds) as Array<{
        id: number;
        invoice_id: number;
        test_id: number;
        test_name: string;
        category_name: string;
        status: string;
        price: number;
        commission_type: string;
        commission_value: number;
        commission_amount: number;
      }>;
      for (const tr of recentTestRows) {
        const list = recentTestsByInv.get(tr.invoice_id) || [];
        list.push({
          id: tr.id,
          test_id: tr.test_id,
          test_name: tr.test_name,
          category_name: tr.category_name,
          status: tr.status,
          price: Number(tr.price || 0),
          commission_type: tr.commission_type || 'percent',
          commission_value: Number(tr.commission_value || 0),
          commission_amount: Number(tr.commission_amount || 0),
        });
        recentTestsByInv.set(tr.invoice_id, list);
      }
    }

    let unpaidCommissionInRange = 0;
    let paidCommissionInRange = 0;

    const recentInvoices = recentInvoicesRaw.map((inv) => {
      const items = recentTestsByInv.get(inv.id) || [];
      const lastPaidUpTo = String(inv.last_commission_paid_up_to || '').trim();
      const invDate = String(inv.created_at || '').slice(0, 10);
      const isCommissionPaid =
        Boolean(inv.doctor_id) &&
        (Number(inv.commission_paid || 0) === 1 || (Boolean(lastPaidUpTo) && invDate <= lastPaidUpTo));
      const commAmt = Number(inv.commission_amount || 0);
      if (inv.doctor_id) {
        if (isCommissionPaid) paidCommissionInRange = roundCurrency(paidCommissionInRange + commAmt);
        else unpaidCommissionInRange = roundCurrency(unpaidCommissionInRange + commAmt);
      }
      return {
        ...inv,
        is_commission_paid: isCommissionPaid,
        total_tests: items.length,
        ready_tests: items.filter((t) => t.status === 'Ready').length,
        test_items: items,
      };
    });

    return {
      from,
      to,
      metrics: {
        patientsCount: invoiceAgg.patientsCount,
        totalBilled: roundCurrency(Number(invoiceAgg.totalBilled || 0)),
        totalDiscount: roundCurrency(Number(invoiceAgg.totalDiscount || 0)),
        totalNetBilled,
        netRevenue,
        netCollection,
        dueRecovered: dueRecoveredRow.recovered,
        pendingDueInRange: roundCurrency(Number(invoiceAgg.pendingDueInRange || 0)),
        doctorCommissionPayable,
        unpaidCommissionInRange,
        paidCommissionInRange,
        masterUnpaidCommissionPool,
        totalExpenses: roundCurrency(Number(expenseRow.totalExpenses || 0)),
        netProfit,
        pendingReports,
        readyReportsInRange,
        allTimeDue: allTimeDueRow.totalDue,
        allTimeDueCount: allTimeDueRow.dueCount,
      },
      departmentBreakdown,
      recentInvoices,
    };
  }

  async getCatalog(includeInactive: boolean): Promise<{ categories: unknown[]; tests: unknown[] }> {
    const categories = db.prepare('SELECT * FROM test_categories ORDER BY sort_order ASC, id ASC').all();
    const tests = db
      .prepare(
        `SELECT t.*, c.name as category_name
         FROM tests t
         JOIN test_categories c ON c.id = t.category_id
         ${includeInactive ? '' : 'WHERE t.is_active = 1'}
         ORDER BY c.sort_order ASC, t.code ASC, t.id ASC`
      )
      .all() as Array<{ id: number; mapped_reagents?: string }>;

    const params = db.prepare('SELECT * FROM test_parameters ORDER BY sort_order ASC, id ASC').all() as Array<{
      id: number;
      test_id: number;
    }>;

    const paramsByTest = new Map<number, typeof params>();
    for (const p of params) {
      const arr = paramsByTest.get(p.test_id) || [];
      arr.push(p);
      paramsByTest.set(p.test_id, arr);
    }

    const enrichedTests = tests.map((t) => ({
      ...t,
      mapped_reagents: parseMappedReagentsJson(t.mapped_reagents),
      parameters: paramsByTest.get(t.id) || [],
    }));

    return { categories, tests: enrichedTests };
  }

  async createCategory(name: string): Promise<{ id: number; name: string }> {
    try {
      const maxSort = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM test_categories').get() as { m: number }).m;
      const info = db.prepare('INSERT INTO test_categories (name, sort_order) VALUES (?, ?)').run(name.trim(), maxSort + 1);
      return { id: Number(info.lastInsertRowid), name: name.trim() };
    } catch {
      throw new StoreError(409, 'Category already exists.');
    }
  }

  async deleteCategory(id: number): Promise<void> {
    const testCount = (db.prepare('SELECT COUNT(*) as c FROM tests WHERE category_id = ? AND is_active = 1').get(id) as { c: number }).c;
    if (testCount > 0) {
      throw new StoreError(400, 'Cannot delete a category with active tests. Remove or move tests first.');
    }
    db.prepare('DELETE FROM test_categories WHERE id = ?').run(id);
  }

  async createTest(payload: {
    category_id: number;
    code: string;
    name: string;
    price: number;
    sample_type: string;
    mapped_reagents?: string[];
    parameters?: ParamPayload[];
  }): Promise<{ id: number }> {
    const testCode = payload.code?.trim() || `TST-${Date.now().toString().slice(-4)}`;
    const mappedReagentsJson = JSON.stringify(normalizeMappedReagents(payload.mapped_reagents));
    const insTest = db.prepare(
      'INSERT INTO tests (category_id, code, name, price, sample_type, mapped_reagents) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insParam = db.prepare(`
      INSERT INTO test_parameters (
        test_id, name, unit, input_type, normal_text, default_value, select_options, abnormal_values,
        min_male, max_male, min_female, max_female, min_child, max_child, min_newborn, max_newborn, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const id = db.transaction(() => {
      const r = insTest.run(
        payload.category_id,
        testCode,
        payload.name.trim(),
        Number(payload.price),
        payload.sample_type.trim(),
        mappedReagentsJson
      );
      const testId = Number(r.lastInsertRowid);
      const list: ParamPayload[] =
        payload.parameters && payload.parameters.length > 0
          ? payload.parameters
          : [{ name: payload.name.trim(), unit: '', input_type: 'text', normal_text: '', default_value: '' }];
      list.forEach((p, idx) => {
        insParam.run(
          testId,
          p.name.trim(),
          p.unit?.trim() || '',
          p.input_type || 'numeric',
          p.normal_text?.trim() || '',
          p.default_value?.trim() || '',
          p.select_options?.trim() || '',
          p.abnormal_values?.trim() || '',
          p.min_male ?? null,
          p.max_male ?? null,
          p.min_female ?? null,
          p.max_female ?? null,
          p.min_child ?? null,
          p.max_child ?? null,
          p.min_newborn ?? null,
          p.max_newborn ?? null,
          idx + 1
        );
      });
      return testId;
    })();

    return { id };
  }

  async updateTest(
    id: number,
    payload: {
      category_id: number;
      code: string;
      name: string;
      price: number;
      sample_type: string;
      is_active?: number;
      mapped_reagents?: string[];
      parameters?: ParamPayload[];
    }
  ): Promise<void> {
    const updTest = db.prepare(
      'UPDATE tests SET category_id = ?, code = ?, name = ?, price = ?, sample_type = ?, is_active = ?, mapped_reagents = ? WHERE id = ?'
    );
    const existingRow = db.prepare('SELECT mapped_reagents FROM tests WHERE id = ?').get(id) as
      | { mapped_reagents?: string }
      | undefined;
    const mappedReagentsJson =
      payload.mapped_reagents !== undefined
        ? JSON.stringify(normalizeMappedReagents(payload.mapped_reagents))
        : existingRow?.mapped_reagents || '[]';
    const getExistingIds = db.prepare('SELECT id FROM test_parameters WHERE test_id = ?');
    const updParam = db.prepare(`
      UPDATE test_parameters
      SET name = ?, unit = ?, input_type = ?, normal_text = ?, default_value = ?, select_options = ?, abnormal_values = ?,
          min_male = ?, max_male = ?, min_female = ?, max_female = ?, min_child = ?, max_child = ?, min_newborn = ?, max_newborn = ?, sort_order = ?
      WHERE id = ? AND test_id = ?
    `);
    const delParamById = db.prepare('DELETE FROM test_parameters WHERE id = ? AND test_id = ?');
    const insParam = db.prepare(`
      INSERT INTO test_parameters (
        test_id, name, unit, input_type, normal_text, default_value, select_options, abnormal_values,
        min_male, max_male, min_female, max_female, min_child, max_child, min_newborn, max_newborn, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updPendingResultMeta = db.prepare(`
      UPDATE test_results
      SET parameter_name = ?, unit = ?, sort_order = ?
      WHERE parameter_id = ?
        AND invoice_test_id IN (SELECT id FROM invoice_tests WHERE test_id = ? AND status != 'Ready')
    `);
    const delPendingResultsByParam = db.prepare(`
      DELETE FROM test_results
      WHERE parameter_id = ?
        AND invoice_test_id IN (SELECT id FROM invoice_tests WHERE test_id = ? AND status != 'Ready')
    `);

    db.transaction(() => {
      updTest.run(
        payload.category_id,
        payload.code?.trim() || '',
        payload.name.trim(),
        Number(payload.price),
        payload.sample_type.trim(),
        payload.is_active ?? 1,
        mappedReagentsJson,
        id
      );
      if (Array.isArray(payload.parameters)) {
        const existingIdSet = new Set(
          (getExistingIds.all(id) as Array<{ id: number }>).map((row) => row.id)
        );
        const keptIds = new Set<number>();
        let sortOrder = 0;

        for (const p of payload.parameters) {
          if (!p.name?.trim()) continue;
          sortOrder += 1;
          const paramId = typeof p.id === 'number' && existingIdSet.has(p.id) ? p.id : null;
          if (paramId !== null) {
            keptIds.add(paramId);
            updParam.run(
              p.name.trim(),
              p.unit?.trim() || '',
              p.input_type || 'numeric',
              p.normal_text?.trim() || '',
              p.default_value?.trim() || '',
              p.select_options?.trim() || '',
              p.abnormal_values?.trim() || '',
              p.min_male ?? null,
              p.max_male ?? null,
              p.min_female ?? null,
              p.max_female ?? null,
              p.min_child ?? null,
              p.max_child ?? null,
              p.min_newborn ?? null,
              p.max_newborn ?? null,
              sortOrder,
              paramId,
              id
            );
            updPendingResultMeta.run(p.name.trim(), p.unit?.trim() || '', sortOrder, paramId, id);
          } else {
            insParam.run(
              id,
              p.name.trim(),
              p.unit?.trim() || '',
              p.input_type || 'numeric',
              p.normal_text?.trim() || '',
              p.default_value?.trim() || '',
              p.select_options?.trim() || '',
              p.abnormal_values?.trim() || '',
              p.min_male ?? null,
              p.max_male ?? null,
              p.min_female ?? null,
              p.max_female ?? null,
              p.min_child ?? null,
              p.max_child ?? null,
              p.min_newborn ?? null,
              p.max_newborn ?? null,
              sortOrder
            );
          }
        }

        for (const oldId of existingIdSet) {
          if (!keptIds.has(oldId)) {
            delPendingResultsByParam.run(oldId, id);
            delParamById.run(oldId, id);
          }
        }
      }
    })();
  }

  async deleteTest(id: number): Promise<{ success: boolean; softDeleted?: boolean }> {
    const usedCount = (db.prepare('SELECT COUNT(*) as c FROM invoice_tests WHERE test_id = ?').get(id) as { c: number }).c;
    if (usedCount > 0) {
      db.prepare('UPDATE tests SET is_active = 0 WHERE id = ?').run(id);
      return { success: true, softDeleted: true };
    }
    db.prepare('DELETE FROM tests WHERE id = ?').run(id);
    return { success: true };
  }

  async listDoctors(
    includeCommission: boolean,
    dateRange?: { from?: string; to?: string }
  ): Promise<unknown[]> {
    const docs = db
      .prepare(
        `SELECT id, name, degree, hospital, mobile,
                ${
                  includeCommission
                    ? 'commission_pct, last_commission_paid_up_to, last_commission_settled_at, last_commission_paid_amount, portal_username, portal_password_enc, portal_enabled,'
                    : ''
                }
                is_active, created_at
         FROM doctors WHERE is_active = 1 ORDER BY name ASC`
      )
      .all() as Array<{
      id: number;
      last_commission_paid_up_to?: string;
      last_commission_settled_at?: string;
      last_commission_paid_amount?: number;
      portal_username?: string;
      portal_password_enc?: string;
      portal_enabled?: number;
      [key: string]: unknown;
    }>;

    const cleanFrom = dateRange?.from?.trim() || '';
    const cleanTo = dateRange?.to?.trim() || '';
    const hasDateFilter = Boolean(cleanFrom || cleanTo);

    if (!includeCommission && !hasDateFilter) return docs;

    const conditions = ['doctor_id IS NOT NULL'];
    const params: unknown[] = [];
    if (cleanFrom && cleanTo) {
      conditions.push(`substr(created_at, 1, 10) BETWEEN ? AND ?`);
      params.push(cleanFrom, cleanTo);
    } else if (cleanFrom) {
      conditions.push(`substr(created_at, 1, 10) >= ?`);
      params.push(cleanFrom);
    } else if (cleanTo) {
      conditions.push(`substr(created_at, 1, 10) <= ?`);
      params.push(cleanTo);
    }

    const matchingInvs = db
      .prepare(
        `SELECT doctor_id, created_at, commission_amount, commission_paid
         FROM invoices
         WHERE ${conditions.join(' AND ')}`
      )
      .all(...params) as Array<{
      doctor_id: number;
      created_at: string;
      commission_amount: number;
      commission_paid: number;
    }>;

    const docMap = new Map(docs.map((d) => [d.id, d]));
    const referralStats = new Map<
      number,
      { totalCount: number; totalCommission: number; unpaidCount: number; unpaidAmount: number }
    >();

    for (const inv of matchingInvs) {
      const doc = docMap.get(inv.doctor_id);
      if (!doc) continue;
      const cur = referralStats.get(inv.doctor_id) || {
        totalCount: 0,
        totalCommission: 0,
        unpaidCount: 0,
        unpaidAmount: 0,
      };
      cur.totalCount += 1;
      cur.totalCommission = roundCurrency(cur.totalCommission + Number(inv.commission_amount || 0));

      const lastPaidUpTo = String(doc.last_commission_paid_up_to || '').trim();
      const invDate = String(inv.created_at || '').slice(0, 10);
      const isPaid = inv.commission_paid === 1 || (Boolean(lastPaidUpTo) && invDate <= lastPaidUpTo);
      if (!isPaid) {
        cur.unpaidCount += 1;
        cur.unpaidAmount = roundCurrency(cur.unpaidAmount + Number(inv.commission_amount || 0));
      }
      referralStats.set(inv.doctor_id, cur);
    }

    const filteredDocs = hasDateFilter
      ? docs.filter((d) => (referralStats.get(d.id)?.totalCount || 0) > 0)
      : docs;

    if (!includeCommission) return filteredDocs;

    const secret = this.getAuthSecret();
    return filteredDocs.map((d) => {
      const stats = referralStats.get(d.id) || {
        totalCount: 0,
        totalCommission: 0,
        unpaidCount: 0,
        unpaidAmount: 0,
      };
      const { portal_password_enc, ...rest } = d;
      const decryptedPw = portal_password_enc ? decryptPortalPassword(portal_password_enc, secret) : '';
      return {
        ...rest,
        portal_username: d.portal_username || '',
        portal_password: decryptedPw,
        portal_enabled: d.portal_enabled ?? 1,
        last_commission_paid_up_to: d.last_commission_paid_up_to || '',
        last_commission_settled_at: d.last_commission_settled_at || '',
        last_commission_paid_amount: Number(d.last_commission_paid_amount || 0),
        period_referrals_count: stats.totalCount,
        period_commission_total: stats.totalCommission,
        unpaid_referrals_count: stats.unpaidCount,
        unpaid_commission_total: stats.unpaidAmount,
      };
    });
  }

  async createDoctor(payload: {
    name: string;
    degree?: string;
    hospital?: string;
    mobile?: string;
    commission_pct?: number;
    portal_username?: string;
    portal_password?: string;
    portal_enabled?: number;
  }): Promise<{ id: number }> {
    const normalizedUsername = (payload.portal_username || '').trim().toLowerCase();
    const rawPassword = (payload.portal_password || '').trim();
    const portalEnabled = payload.portal_enabled === 0 ? 0 : 1;

    if (normalizedUsername) {
      if (normalizedUsername.length < 3) {
        throw new StoreError(400, 'Portal username must be at least 3 characters.');
      }
      const existing = db
        .prepare(`SELECT id FROM doctors WHERE LOWER(portal_username) = ? AND is_active = 1`)
        .get(normalizedUsername) as { id: number } | undefined;
      if (existing) {
        throw new StoreError(400, `Portal username "${normalizedUsername}" is already assigned to another doctor.`);
      }
      if (!rawPassword || rawPassword.length < 4) {
        throw new StoreError(400, 'Portal password (min 4 characters) is required when setting a portal username.');
      }
    }

    const secret = this.getAuthSecret();
    const pwHash = normalizedUsername && rawPassword ? hashPassword(rawPassword) : '';
    const pwEnc = normalizedUsername && rawPassword ? encryptPortalPassword(rawPassword, secret) : '';

    const info = db
      .prepare(
        `INSERT INTO doctors (name, degree, hospital, mobile, commission_pct, portal_username, portal_password_hash, portal_password_enc, portal_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.name.trim(),
        payload.degree?.trim() || '',
        payload.hospital?.trim() || '',
        payload.mobile?.trim() || '',
        Number(payload.commission_pct || 0),
        normalizedUsername,
        pwHash,
        pwEnc,
        portalEnabled,
        getLocalTimestampStr()
      );
    return { id: Number(info.lastInsertRowid) };
  }

  async updateDoctor(
    id: number,
    payload: {
      name: string;
      degree?: string;
      hospital?: string;
      mobile?: string;
      commission_pct?: number;
      portal_username?: string;
      portal_password?: string;
      portal_enabled?: number;
    }
  ): Promise<void> {
    const current = db
      .prepare(`SELECT id, portal_username, portal_password_hash, portal_password_enc, portal_enabled FROM doctors WHERE id = ?`)
      .get(id) as
      | {
          id: number;
          portal_username: string;
          portal_password_hash: string;
          portal_password_enc: string;
          portal_enabled: number;
        }
      | undefined;
    if (!current) throw new StoreError(404, 'Doctor not found.');

    const hasUsernameField = payload.portal_username !== undefined;
    const normalizedUsername = hasUsernameField
      ? (payload.portal_username || '').trim().toLowerCase()
      : (current.portal_username || '').trim().toLowerCase();
    const rawPassword = (payload.portal_password || '').trim();
    const portalEnabled =
      payload.portal_enabled !== undefined ? (payload.portal_enabled === 0 ? 0 : 1) : (current.portal_enabled ?? 1);

    if (normalizedUsername) {
      if (normalizedUsername.length < 3) {
        throw new StoreError(400, 'Portal username must be at least 3 characters.');
      }
      const conflict = db
        .prepare(`SELECT id FROM doctors WHERE LOWER(portal_username) = ? AND id != ? AND is_active = 1`)
        .get(normalizedUsername, id) as { id: number } | undefined;
      if (conflict) {
        throw new StoreError(400, `Portal username "${normalizedUsername}" is already assigned to another doctor.`);
      }
    }

    let nextPwHash = current.portal_password_hash || '';
    let nextPwEnc = current.portal_password_enc || '';
    if (!normalizedUsername) {
      nextPwHash = '';
      nextPwEnc = '';
    } else if (rawPassword) {
      if (rawPassword.length < 4) {
        throw new StoreError(400, 'Portal password must be at least 4 characters.');
      }
      const secret = this.getAuthSecret();
      nextPwHash = hashPassword(rawPassword);
      nextPwEnc = encryptPortalPassword(rawPassword, secret);
    } else if (!nextPwHash) {
      throw new StoreError(400, 'Please enter a portal password (min 4 characters) for this doctor.');
    }

    db.prepare(
      `UPDATE doctors
       SET name = ?, degree = ?, hospital = ?, mobile = ?, commission_pct = ?,
           portal_username = ?, portal_password_hash = ?, portal_password_enc = ?, portal_enabled = ?
       WHERE id = ?`
    ).run(
      payload.name.trim(),
      payload.degree?.trim() || '',
      payload.hospital?.trim() || '',
      payload.mobile?.trim() || '',
      Number(payload.commission_pct || 0),
      normalizedUsername,
      nextPwHash,
      nextPwEnc,
      portalEnabled,
      id
    );
  }

  async softDeleteDoctor(id: number): Promise<void> {
    db.prepare('UPDATE doctors SET is_active = 0 WHERE id = ?').run(id);
  }

  async getDoctorStatement(
    id: number,
    fromArg?: string,
    toArg?: string,
    status: 'unpaid' | 'all' | 'paid' = 'all'
  ): Promise<Record<string, unknown>> {
    const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(id) as
      | {
          id: number;
          name: string;
          degree: string;
          hospital: string;
          mobile: string;
          commission_pct: number;
          last_commission_paid_up_to?: string;
          last_commission_settled_at?: string;
          last_commission_paid_amount?: number;
          [key: string]: unknown;
        }
      | undefined;
    if (!doctor) throw new StoreError(404, 'Doctor not found.');

    const lastPaidUpTo = String(doctor.last_commission_paid_up_to || '').trim();
    const today = getTodayDateStr();
    const defaultFrom = lastPaidUpTo ? addDaysToIsoDate(lastPaidUpTo, 1) : `${today.slice(0, 7)}-01`;
    const from = (fromArg || '').trim() || defaultFrom;
    const to = (toArg || '').trim() || today;

    const invRows = db
      .prepare(
        `SELECT i.id, i.invoice_no, i.created_at, i.subtotal, i.discount_type, i.discount_value,
                i.discount_amount, i.discount_pct, i.doctor_less_percent, i.doctor_less_amount, i.flat_discount_amount,
                i.net_total, i.paid_amount, i.due_amount,
                i.commission_type, i.commission_value, i.commission_pct, i.commission_amount,
                i.commission_paid, i.commission_paid_at,
                p.patient_uid, p.name as patient_name
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         WHERE i.doctor_id = ? AND substr(i.created_at, 1, 10) BETWEEN ? AND ?
         ORDER BY i.created_at DESC`
      )
      .all(id, from, to) as Array<{
      id: number;
      invoice_no: string;
      created_at: string;
      subtotal: number;
      discount_type: 'percent' | 'flat';
      discount_value: number;
      discount_amount: number;
      discount_pct: number;
      doctor_less_percent?: number;
      doctor_less_amount?: number;
      flat_discount_amount?: number;
      net_total: number;
      paid_amount: number;
      due_amount: number;
      commission_type: string;
      commission_value: number;
      commission_pct: number;
      commission_amount: number;
      commission_paid: number;
      commission_paid_at: string;
      patient_uid: string;
      patient_name: string;
    }>;

    const testStmt = db.prepare(
      `SELECT id, test_id, test_name, price, commission_type, commission_value, commission_amount
       FROM invoice_tests WHERE invoice_id = ? ORDER BY id ASC`
    );

    const mapped = invRows.map((i) => {
      const its = testStmt.all(i.id) as Array<{
        id: number;
        test_id: number;
        test_name: string;
        price: number;
        commission_type: string;
        commission_value: number;
        commission_amount: number;
      }>;
      const invDate = String(i.created_at || '').slice(0, 10);
      const isPaid = i.commission_paid === 1 || (Boolean(lastPaidUpTo) && invDate <= lastPaidUpTo);
      const isAfterLastPaid = Boolean(lastPaidUpTo) && invDate > lastPaidUpTo;
      const discountPct =
        Number(i.discount_pct) > 0 || i.discount_amount === 0
          ? Number(i.discount_pct || 0)
          : i.subtotal > 0
          ? roundCurrency((i.discount_amount / i.subtotal) * 100)
          : 0;
      const commType = i.commission_type || 'percent';
      const commVal = Number(i.commission_value ?? i.commission_pct ?? 0);
      const breakdown = resolveInvoiceDiscountBreakdown(i);

      return {
        id: i.id,
        invoice_no: i.invoice_no,
        created_at: i.created_at,
        subtotal: i.subtotal,
        discount_type: i.discount_type,
        discount_value: i.discount_value,
        discount_pct: discountPct,
        discount_amount: i.discount_amount,
        doctor_less_percent: breakdown.doctorLessPercent,
        doctor_less_amount: breakdown.doctorLessAmount,
        flat_discount_amount: breakdown.flatDiscountAmount,
        net_total: i.net_total,
        paid_amount: i.paid_amount,
        due_amount: i.due_amount,
        commission_type: commType,
        commission_value: commVal,
        commission_pct: i.commission_pct,
        commission_amount: i.commission_amount,
        is_commission_paid: isPaid,
        commission_paid_at: i.commission_paid_at || '',
        is_accrued_after_last_paid: isAfterLastPaid,
        patient_uid: i.patient_uid,
        patient_name: i.patient_name,
        test_names: its.map((t) => t.test_name).join(', '),
        test_items: its.map((t) => ({
          id: t.id,
          test_id: t.test_id,
          test_name: t.test_name,
          price: t.price,
          commission_type: t.commission_type || 'percent',
          commission_value: Number(t.commission_value ?? i.commission_pct ?? 0),
          commission_amount:
            Number(t.commission_amount || 0) > 0 || i.commission_amount === 0
              ? Number(t.commission_amount || 0)
              : i.subtotal > 0
              ? roundCurrency((t.price / i.subtotal) * i.commission_amount)
              : 0,
        })),
      };
    });

    const referrals = mapped.filter((r) => {
      if (status === 'unpaid') return !r.is_commission_paid;
      if (status === 'paid') return r.is_commission_paid;
      return true;
    });

    const totals = referrals.reduce(
      (acc, r) => {
        acc.totalPatients += 1;
        acc.totalGross = roundCurrency(acc.totalGross + r.subtotal);
        acc.totalDoctorLess = roundCurrency(acc.totalDoctorLess + Number(r.doctor_less_amount || 0));
        acc.totalFlatDiscount = roundCurrency(acc.totalFlatDiscount + Number(r.flat_discount_amount || 0));
        acc.totalDiscount = roundCurrency(acc.totalDiscount + r.discount_amount);
        acc.totalNet = roundCurrency(acc.totalNet + r.net_total);
        acc.totalPaid = roundCurrency(acc.totalPaid + r.paid_amount);
        acc.totalDue = roundCurrency(acc.totalDue + r.due_amount);
        acc.totalCommission = roundCurrency(acc.totalCommission + r.commission_amount);
        if (!r.is_commission_paid) {
          acc.unpaidPatients += 1;
          acc.unpaidCommission = roundCurrency(acc.unpaidCommission + r.commission_amount);
        } else {
          acc.paidCommission = roundCurrency(acc.paidCommission + r.commission_amount);
        }
        return acc;
      },
      {
        totalPatients: 0,
        totalGross: 0,
        totalDoctorLess: 0,
        totalFlatDiscount: 0,
        totalDiscount: 0,
        totalNet: 0,
        totalPaid: 0,
        totalDue: 0,
        totalCommission: 0,
        unpaidPatients: 0,
        unpaidCommission: 0,
        paidCommission: 0,
      }
    );

    const allDocInvs = db
      .prepare(`SELECT created_at, commission_amount, commission_paid FROM invoices WHERE doctor_id = ?`)
      .all(id) as Array<{ created_at: string; commission_amount: number; commission_paid: number }>;

    const allTimeUnpaid = allDocInvs.reduce(
      (acc, inv) => {
        const isPaid =
          inv.commission_paid === 1 || (Boolean(lastPaidUpTo) && String(inv.created_at || '').slice(0, 10) <= lastPaidUpTo);
        if (!isPaid) {
          acc.count += 1;
          acc.amount = roundCurrency(acc.amount + Number(inv.commission_amount || 0));
        }
        return acc;
      },
      { count: 0, amount: 0 }
    );

    const payoutHistory = db
      .prepare(`SELECT * FROM doctor_commission_payouts WHERE doctor_id = ? ORDER BY id DESC LIMIT 20`)
      .all(id);

    return {
      doctor: {
        ...doctor,
        last_commission_paid_up_to: lastPaidUpTo,
        last_commission_settled_at: doctor.last_commission_settled_at || '',
        last_commission_paid_amount: Number(doctor.last_commission_paid_amount || 0),
      },
      from,
      to,
      status,
      suggestedNextFrom: lastPaidUpTo ? addDaysToIsoDate(lastPaidUpTo, 1) : '',
      allTimeUnpaid,
      referrals,
      totals,
      payoutHistory,
    };
  }

  async settleDoctorCommission(payload: {
    doctorId: number;
    paidUpToDate: string;
    fromDate?: string;
    note?: string;
    settledBy?: string;
  }): Promise<Record<string, unknown>> {
    const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(payload.doctorId) as
      | { id: number; last_commission_paid_up_to?: string }
      | undefined;
    if (!doctor) throw new StoreError(404, 'Doctor not found.');

    const cutoff = (payload.paidUpToDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
      throw new StoreError(400, 'Valid Paid Up To Date (YYYY-MM-DD) is required.');
    }

    const lastPaidUpTo = String(doctor.last_commission_paid_up_to || '').trim();
    const candidates = db
      .prepare(
        `SELECT id, created_at, commission_amount, commission_paid
         FROM invoices
         WHERE doctor_id = ? AND substr(created_at, 1, 10) <= ?
         ORDER BY created_at ASC`
      )
      .all(payload.doctorId, cutoff) as Array<{
      id: number;
      created_at: string;
      commission_amount: number;
      commission_paid: number;
    }>;

    const unpaidInvs = candidates.filter(
      (inv) => !(inv.commission_paid === 1 || (Boolean(lastPaidUpTo) && String(inv.created_at || '').slice(0, 10) <= lastPaidUpTo))
    );

    const totalCommissionPaid = roundCurrency(
      unpaidInvs.reduce((sum, inv) => sum + Number(inv.commission_amount || 0), 0)
    );
    const nowTs = getLocalTimestampStr();
    const effectiveFrom =
      (payload.fromDate || '').trim() ||
      (lastPaidUpTo
        ? addDaysToIsoDate(lastPaidUpTo, 1)
        : unpaidInvs.length > 0
        ? String(unpaidInvs[0].created_at || '').slice(0, 10)
        : cutoff);
    const nextCutoff = !lastPaidUpTo || cutoff > lastPaidUpTo ? cutoff : lastPaidUpTo;

    const payoutId = db.transaction(() => {
      const pRes = db
        .prepare(
          `INSERT INTO doctor_commission_payouts (
            doctor_id, from_date, paid_up_to_date, patients_count, total_commission_paid, note, settled_by, settled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          payload.doctorId,
          effectiveFrom,
          cutoff,
          unpaidInvs.length,
          totalCommissionPaid,
          payload.note?.trim() || '',
          payload.settledBy?.trim() || 'Admin',
          nowTs
        );
      const newPayoutId = Number(pRes.lastInsertRowid);

      const markPaidStmt = db.prepare(
        `UPDATE invoices SET commission_paid = 1, commission_paid_at = ?, commission_payout_id = ? WHERE id = ?`
      );
      for (const inv of unpaidInvs) {
        markPaidStmt.run(nowTs, newPayoutId, inv.id);
      }

      db.prepare(
        `UPDATE doctors
         SET last_commission_paid_up_to = ?, last_commission_settled_at = ?, last_commission_paid_amount = ?
         WHERE id = ?`
      ).run(nextCutoff, nowTs, totalCommissionPaid, payload.doctorId);

      return newPayoutId;
    })();

    return {
      success: true,
      payoutId,
      doctorId: payload.doctorId,
      paidUpToDate: nextCutoff,
      patientsCount: unpaidInvs.length,
      totalCommissionPaid,
      settledAt: nowTs,
    };
  }

  async updateInvoiceCommission(payload: {
    invoiceId: number;
    commissionMode: 'doctor_default' | 'custom_invoice' | 'custom_per_test';
    commissionType?: 'percent' | 'flat';
    commissionValue?: number;
    testCommissions?: TestCommissionOverride[];
  }): Promise<Record<string, unknown>> {
    const inv = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(payload.invoiceId) as
      | { id: number; doctor_id: number | null; subtotal: number; net_total: number }
      | undefined;
    if (!inv) throw new StoreError(404, 'Invoice not found.');

    const doc = inv.doctor_id
      ? (db.prepare(`SELECT commission_pct FROM doctors WHERE id = ?`).get(inv.doctor_id) as
          | { commission_pct: number }
          | undefined)
      : undefined;

    const invTests = db
      .prepare(`SELECT id, test_id, price FROM invoice_tests WHERE invoice_id = ? ORDER BY id ASC`)
      .all(payload.invoiceId) as Array<{ id: number; test_id: number; price: number }>;

    const computed = computeInvoiceCommission({
      tests: invTests.map((it) => ({ test_id: it.test_id, price: Number(it.price) })),
      subtotal: Number(inv.subtotal),
      netTotal: Number(inv.net_total),
      hasDoctor: Boolean(inv.doctor_id),
      doctorCommissionPct: Number(doc?.commission_pct || 0),
      commissionMode: payload.commissionMode,
      commissionType: payload.commissionType,
      commissionValue: payload.commissionValue,
      testCommissions: payload.testCommissions,
    });

    db.transaction(() => {
      db.prepare(
        `UPDATE invoices
         SET commission_type = ?, commission_value = ?, commission_pct = ?, commission_amount = ?
         WHERE id = ?`
      ).run(
        computed.invoiceCommissionType,
        computed.invoiceCommissionValue,
        computed.invoiceCommissionPct,
        computed.invoiceCommissionAmount,
        payload.invoiceId
      );

      const updIt = db.prepare(
        `UPDATE invoice_tests SET commission_type = ?, commission_value = ?, commission_amount = ? WHERE id = ?`
      );
      for (const it of invTests) {
        const tc = computed.perTestMap.get(it.test_id);
        if (tc) {
          updIt.run(tc.commission_type, tc.commission_value, tc.commission_amount, it.id);
        }
      }
    })();

    return (await this.getFullInvoice(payload.invoiceId, true, true))!;
  }

  async disburseInvoiceCommission(payload: {
    invoiceId: number;
    note?: string;
    settledBy?: string;
  }): Promise<Record<string, unknown>> {
    const inv = db
      .prepare(`SELECT id, invoice_no, doctor_id, created_at, commission_amount, commission_paid FROM invoices WHERE id = ?`)
      .get(payload.invoiceId) as
      | {
          id: number;
          invoice_no: string;
          doctor_id: number | null;
          created_at: string;
          commission_amount: number;
          commission_paid: number;
        }
      | undefined;

    if (!inv) throw new StoreError(404, 'Invoice not found.');
    if (!inv.doctor_id) throw new StoreError(400, 'No referring doctor is assigned to this invoice.');

    const doctor = db
      .prepare(`SELECT id, name, last_commission_paid_up_to FROM doctors WHERE id = ?`)
      .get(inv.doctor_id) as { id: number; name: string; last_commission_paid_up_to?: string } | undefined;
    if (!doctor) throw new StoreError(404, 'Referring doctor not found.');

    const invDate = String(inv.created_at || '').slice(0, 10);
    const lastPaidUpTo = String(doctor.last_commission_paid_up_to || '').trim();
    const alreadyPaid = inv.commission_paid === 1 || (Boolean(lastPaidUpTo) && invDate <= lastPaidUpTo);
    if (alreadyPaid) {
      throw new StoreError(400, 'Doctor commission for this invoice has already been disbursed.');
    }

    const commissionAmount = roundCurrency(Number(inv.commission_amount || 0));
    const nowTs = getLocalTimestampStr();
    const effectiveNote =
      payload.note?.trim() || `Direct commission disbursement for ${inv.invoice_no}`;

    const payoutId = db.transaction(() => {
      const pRes = db
        .prepare(
          `INSERT INTO doctor_commission_payouts (
            doctor_id, from_date, paid_up_to_date, patients_count, total_commission_paid, note, settled_by, settled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          doctor.id,
          invDate,
          invDate,
          1,
          commissionAmount,
          effectiveNote,
          payload.settledBy?.trim() || 'Admin',
          nowTs
        );
      const newPayoutId = Number(pRes.lastInsertRowid);

      db.prepare(
        `UPDATE invoices SET commission_paid = 1, commission_paid_at = ?, commission_payout_id = ? WHERE id = ?`
      ).run(nowTs, newPayoutId, inv.id);

      db.prepare(
        `UPDATE doctors SET last_commission_settled_at = ?, last_commission_paid_amount = ? WHERE id = ?`
      ).run(nowTs, commissionAmount, doctor.id);

      return newPayoutId;
    })();

    return {
      success: true,
      payoutId,
      invoiceId: inv.id,
      invoiceNo: inv.invoice_no,
      doctorId: doctor.id,
      doctorName: doctor.name,
      commissionAmount,
      settledAt: nowTs,
    };
  }

  async listInvoices(filters: {
    search?: string;
    dueOnly?: boolean;
    todayOnly?: boolean;
    date?: string;
    includeCommission: boolean;
  }): Promise<unknown[]> {
    const todayStr = getTodayDateStr();
    const conditions: string[] = [];
    const params: unknown[] = [todayStr];

    if (filters.search?.trim()) {
      conditions.push(`(i.invoice_no LIKE ? OR p.patient_uid LIKE ? OR p.name LIKE ? OR p.mobile LIKE ?)`);
      const like = `%${filters.search.trim()}%`;
      params.push(like, like, like, like);
    }
    if (filters.dueOnly) conditions.push(`i.due_amount > 0`);
    if (filters.todayOnly) {
      conditions.push(`substr(i.created_at, 1, 10) = ?`);
      params.push(todayStr);
    } else if (filters.date) {
      conditions.push(`substr(i.created_at, 1, 10) = ?`);
      params.push(filters.date);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT i.id, i.invoice_no, i.patient_id, i.doctor_id, i.subtotal, i.discount_type, i.discount_value,
                i.discount_amount, i.doctor_less_percent, i.doctor_less_amount, i.flat_discount_amount,
                CASE WHEN i.discount_pct > 0 OR i.discount_amount = 0 THEN i.discount_pct
                     WHEN i.subtotal > 0 THEN ROUND((i.discount_amount / i.subtotal) * 100, 2)
                     ELSE 0 END as discount_pct,
                i.net_total, i.paid_amount, i.due_amount, i.payment_status,
                i.adjustment_amount, i.adjustment_reason, i.adjusted_by, i.adjusted_at, i.initial_payment_method,
                ${
                  filters.includeCommission
                    ? 'i.commission_pct, i.commission_amount, i.commission_type, i.commission_value, i.commission_paid, i.commission_paid_at,'
                    : ''
                }
                i.notes, i.created_by, i.created_at,
                CASE WHEN substr(i.created_at, 1, 10) = ? THEN 1 ELSE 0 END as is_today,
                p.patient_uid, p.name as patient_name, p.age_years, p.age_months, p.age_days, p.gender, p.mobile as patient_mobile,
                d.name as doctor_name, d.degree as doctor_degree,
                (SELECT COUNT(*) FROM invoice_tests it WHERE it.invoice_id = i.id) as total_tests,
                (SELECT COUNT(*) FROM invoice_tests it WHERE it.invoice_id = i.id AND it.status = 'Ready') as ready_tests
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         LEFT JOIN doctors d ON d.id = i.doctor_id
         ${whereClause}
         ORDER BY i.id DESC
         LIMIT 200`
      )
      .all(...params) as Array<Record<string, unknown> & { id: number }>;

    const invIds = rows.map((r) => r.id);
    const itemsByInv = new Map<number, Array<{ id: number; test_name: string; category_name: string; status: string }>>();
    if (invIds.length > 0) {
      const testRows = db
        .prepare(
          `SELECT id, invoice_id, test_name, category_name, status
           FROM invoice_tests
           WHERE invoice_id IN (${invIds.map(() => '?').join(',')})
           ORDER BY id ASC`
        )
        .all(...invIds) as Array<{
        id: number;
        invoice_id: number;
        test_name: string;
        category_name: string;
        status: string;
      }>;
      for (const tr of testRows) {
        const list = itemsByInv.get(tr.invoice_id) || [];
        list.push({ id: tr.id, test_name: tr.test_name, category_name: tr.category_name, status: tr.status });
        itemsByInv.set(tr.invoice_id, list);
      }
    }

    return rows.map((r) => {
      const breakdown = resolveInvoiceDiscountBreakdown(r as Record<string, unknown>);
      return {
        ...r,
        doctor_less_percent: breakdown.doctorLessPercent,
        doctor_less_amount: breakdown.doctorLessAmount,
        flat_discount_amount: breakdown.flatDiscountAmount,
        test_items: itemsByInv.get(r.id) || [],
      };
    });
  }

  async searchPatients(q: string): Promise<unknown[]> {
    const clean = q.trim();
    if (!clean) return [];
    const like = `%${clean}%`;
    return db
      .prepare(
        `SELECT id, patient_uid, name, age_years, age_months, age_days, gender, mobile, address, created_at
         FROM patients
         WHERE patient_uid LIKE ? OR name LIKE ? OR mobile LIKE ?
         ORDER BY id DESC LIMIT 12`
      )
      .all(like, like, like);
  }

  async getFullInvoice(
    invoiceId: number,
    includeCommission: boolean,
    includePortalPassword = true
  ): Promise<Record<string, unknown> | null> {
    const todayStr = getTodayDateStr();
    const invoice = db
      .prepare(
        `SELECT i.id, i.invoice_no, i.patient_id, i.doctor_id, i.subtotal, i.discount_type, i.discount_value,
                i.discount_amount, i.doctor_less_percent, i.doctor_less_amount, i.flat_discount_amount,
                CASE WHEN i.discount_pct > 0 OR i.discount_amount = 0 THEN i.discount_pct
                     WHEN i.subtotal > 0 THEN ROUND((i.discount_amount / i.subtotal) * 100, 2)
                     ELSE 0 END as discount_pct,
                i.net_total, i.paid_amount, i.due_amount, i.payment_status,
                i.adjustment_amount, i.adjustment_reason, i.adjusted_by, i.adjusted_at, i.initial_payment_method,
                ${
                  includeCommission
                    ? 'i.commission_pct, i.commission_amount, i.commission_type, i.commission_value, i.commission_paid, i.commission_paid_at,'
                    : ''
                }
                i.notes, i.created_by, i.created_at,
                CASE WHEN substr(i.created_at, 1, 10) = ? THEN 1 ELSE 0 END as is_today,
                p.patient_uid, p.name as patient_name, p.age_years, p.age_months, p.age_days, p.gender,
                p.mobile as patient_mobile, p.address as patient_address, p.qr_token as patient_qr_token, p.qr_secret as _qr_secret,
                ${includePortalPassword ? 'p.portal_password_enc,' : ''}
                d.name as doctor_name, d.degree as doctor_degree, d.hospital as doctor_hospital
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         LEFT JOIN doctors d ON d.id = i.doctor_id
         WHERE i.id = ?`
      )
      .get(todayStr, invoiceId) as Record<string, unknown> | undefined;

    if (!invoice) return null;

    const breakdown = resolveInvoiceDiscountBreakdown(invoice as Record<string, unknown>);
    invoice.doctor_less_percent = breakdown.doctorLessPercent;
    invoice.doctor_less_amount = breakdown.doctorLessAmount;
    invoice.flat_discount_amount = breakdown.flatDiscountAmount;

    if (!invoice.patient_qr_token) {
      const pid = Number(invoice.patient_id);
      const qrSecret =
        (typeof invoice._qr_secret === 'string' && invoice._qr_secret) || generatePatientQrSecret();
      const qrToken = createEncryptedPatientQrToken(pid, qrSecret, this.getAuthSecret());
      db.prepare(`UPDATE patients SET qr_secret = ?, qr_token = ? WHERE id = ?`).run(
        qrSecret,
        qrToken,
        pid
      );
      invoice.patient_qr_token = qrToken;
    }
    delete invoice._qr_secret;

    if (includePortalPassword) {
      const enc = typeof invoice.portal_password_enc === 'string' ? invoice.portal_password_enc : '';
      invoice.patient_portal_password = enc ? decryptPortalPassword(enc, this.getAuthSecret()) : '';
      delete invoice.portal_password_enc;
    }

    const tests = db
      .prepare(`SELECT * FROM invoice_tests WHERE invoice_id = ? ORDER BY id ASC`)
      .all(invoiceId) as Array<{ id: number; [key: string]: unknown }>;

    const resultsStmt = db.prepare(
      `SELECT tr.*, tp.input_type, tp.normal_text,
              tp.min_male, tp.max_male, tp.min_female, tp.max_female,
              tp.min_child, tp.max_child, tp.min_newborn, tp.max_newborn
       FROM test_results tr
       LEFT JOIN test_parameters tp ON tp.id = tr.parameter_id
       WHERE tr.invoice_test_id = ?
       ORDER BY tr.sort_order ASC, tr.id ASC`
    );
    const enrichedTests = tests.map((t) => {
      const rawResults = resultsStmt.all(t.id) as Array<{
        id?: number;
        parameter_id?: number;
        parameter_name?: string;
        result_value?: string;
        reference_range_text?: string | null;
        normal_text?: string | null;
        unit?: string | null;
        sort_order?: number;
      }>;
      const outTest: Record<string, unknown> = {
        ...t,
        reagent_deductions: parseReagentDeductionsJson(t.reagent_deductions),
        results: deduplicateResultRows(rawResults),
      };
      if (!includeCommission) {
        delete outTest.commission_type;
        delete outTest.commission_value;
        delete outTest.commission_amount;
      }
      return outTest;
    });

    const duePayments = db.prepare(`SELECT * FROM due_payments WHERE invoice_id = ? ORDER BY id ASC`).all(invoiceId);
    const adjustments = db.prepare(`SELECT * FROM invoice_adjustments WHERE invoice_id = ? ORDER BY id DESC`).all(invoiceId);

    return { invoice, tests: enrichedTests, duePayments, adjustments };
  }

  private deductReagentsFefo(
    test: { id: number; name: string; code?: string; mapped_reagents?: unknown },
    params: Array<{ id?: number; name: string }>,
    nowTs: string
  ): ReagentDeductionRecord[] {
    const availableBatches = db
      .prepare(
        `SELECT id, name, remaining_tests, expiry_date, linked_test_id, linked_test_name, linked_parameter_id, linked_parameter_name
         FROM reagents
         WHERE remaining_tests > 0
         ORDER BY expiry_date ASC, id ASC`
      )
      .all() as ReagentMatchCandidate[];
    if (availableBatches.length === 0) return [];

    const selected = selectFefoReagentBatchesForTest(availableBatches, {
      test_id: test.id,
      test_name: test.name,
      test_code: test.code,
      mapped_reagents: parseMappedReagentsJson(test.mapped_reagents),
      parameters: params.map((p) => ({ id: p.id, name: p.name })),
    });
    if (selected.length === 0) return [];

    const decBatch = db.prepare(
      `UPDATE reagents SET remaining_tests = remaining_tests - 1, updated_at = ? WHERE id = ? AND remaining_tests > 0`
    );
    const deductions: ReagentDeductionRecord[] = [];
    for (const batch of selected) {
      const res = decBatch.run(nowTs, batch.id);
      if (res.changes > 0) {
        deductions.push({
          reagent_id: batch.id,
          reagent_name: batch.name,
          quantity: 1,
        });
      }
    }
    return deductions;
  }

  private restoreReagentDeductions(rawDeductions: unknown, nowTs: string): void {
    const deductions = parseReagentDeductionsJson(rawDeductions);
    if (deductions.length === 0) return;
    const findById = db.prepare(`SELECT id FROM reagents WHERE id = ?`);
    const findFallbackByName = db.prepare(
      `SELECT id FROM reagents WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY expiry_date ASC, id ASC LIMIT 1`
    );
    const incBatch = db.prepare(`UPDATE reagents SET remaining_tests = remaining_tests + ?, updated_at = ? WHERE id = ?`);
    for (const d of deductions) {
      const byId = findById.get(d.reagent_id) as { id: number } | undefined;
      if (byId) {
        incBatch.run(d.quantity, nowTs, byId.id);
        continue;
      }
      const fallback = findFallbackByName.get(d.reagent_name) as { id: number } | undefined;
      if (fallback) {
        incBatch.run(d.quantity, nowTs, fallback.id);
      }
    }
  }

  async createInvoice(payload: CreateInvoicePayload): Promise<Record<string, unknown>> {
    const placeholders = payload.testIds.map(() => '?').join(',');
    const selectedTests = db
      .prepare(
        `SELECT t.*, c.name as category_name
         FROM tests t
         JOIN test_categories c ON c.id = t.category_id
         WHERE t.id IN (${placeholders}) AND t.is_active = 1`
      )
      .all(...payload.testIds) as Array<{
      id: number;
      name: string;
      category_name: string;
      sample_type: string;
      price: number;
      mapped_reagents?: string;
    }>;
    type SelectedTestRow = {
      id: number;
      code?: string;
      name: string;
      category_name: string;
      sample_type: string;
      price: number;
      mapped_reagents?: string;
    };
    const typedSelectedTests = selectedTests as SelectedTestRow[];

    if (selectedTests.length === 0) throw new StoreError(400, 'Selected tests were not found.');

    const subtotal = selectedTests.reduce((sum, t) => sum + Number(t.price), 0);
    const disc = computeSequentialDiscounts({
      subtotal,
      doctorLessPercent: payload.doctorLessPercent,
      flatDiscountAmount: payload.flatDiscountAmount,
      legacyDiscountType: payload.discountType,
      legacyDiscountValue: payload.discountValue,
    });
    const dType = disc.legacyDiscountType;
    const dVal = disc.legacyDiscountValue;
    const discountAmount = disc.discountAmount;
    const doctorLessPercent = disc.doctorLessPercent;
    const doctorLessAmount = disc.doctorLessAmount;
    const flatDiscountAmount = disc.flatDiscountAmount;

    const rawCap = sqliteGetSetting('max_staff_discount_pct');
    const maxStaffPct =
      rawCap !== '' && Number.isFinite(Number(rawCap)) ? Math.min(100, Math.max(0, Number(rawCap))) : 100;
    const effectivePct = subtotal > 0 ? (discountAmount / subtotal) * 100 : 0;
    if (!payload.isAdmin && effectivePct > maxStaffPct + 0.01) {
      throw new StoreError(
        403,
        `Staff discount limit is ${maxStaffPct}%. Switch to Admin mode to authorize higher discounts.`
      );
    }

    const netTotal = disc.netBeforeAdjustment;
    const discountPct = disc.discountPct;
    const paid = Math.min(netTotal, Math.max(0, Math.round(Number(payload.paidAmount || 0) * 100) / 100));
    const due = Math.max(0, Math.round((netTotal - paid) * 100) / 100);
    const paymentStatus = due <= 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Due';

    let docCommissionPct = 0;
    if (payload.doctorId) {
      const doc = db.prepare('SELECT commission_pct FROM doctors WHERE id = ?').get(payload.doctorId) as
        | { commission_pct: number }
        | undefined;
      if (doc) docCommissionPct = Number(doc.commission_pct || 0);
    }

    const computedComm = computeInvoiceCommission({
      tests: selectedTests.map((t) => ({ test_id: t.id, price: Number(t.price) })),
      subtotal,
      netTotal,
      hasDoctor: Boolean(payload.doctorId),
      doctorCommissionPct: docCommissionPct,
      commissionMode: payload.isAdmin ? payload.commissionMode || 'doctor_default' : 'doctor_default',
      commissionType: payload.commissionType,
      commissionValue: payload.commissionValue,
      testCommissions: payload.testCommissions,
    });
    const nowTs = getLocalTimestampStr();

    const createdInvoiceId = db.transaction(() => {
      let patientId = 0;
      if (payload.existingPatientId) {
        const existing = db.prepare('SELECT id FROM patients WHERE id = ?').get(payload.existingPatientId) as { id: number } | undefined;
        if (existing) {
          patientId = existing.id;
          db.prepare(
            `UPDATE patients SET name = ?, age_years = ?, age_months = ?, age_days = ?, gender = ?, mobile = ?, address = ? WHERE id = ?`
          ).run(
            payload.patient.name.trim(),
            Number(payload.patient.ageYears || 0),
            Number(payload.patient.ageMonths || 0),
            Number(payload.patient.ageDays || 0),
            payload.patient.gender,
            payload.patient.mobile?.trim() || '',
            payload.patient.address?.trim() || '',
            patientId
          );
        }
      }

      if (!patientId) {
        const nextPatientSeq = (db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as n FROM patients').get() as { n: number }).n;
        const patientUid = `ALEA-${2600 + nextPatientSeq}`;
        const plainPortalPw = generatePortalPassword();
        const portalHash = hashPassword(plainPortalPw);
        const portalEnc = encryptPortalPassword(plainPortalPw, this.getAuthSecret());

        const pRes = db
          .prepare(
            `INSERT INTO patients (
              patient_uid, name, age_years, age_months, age_days, gender, mobile, address,
              portal_password_hash, portal_password_enc, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            patientUid,
            payload.patient.name.trim(),
            Number(payload.patient.ageYears || 0),
            Number(payload.patient.ageMonths || 0),
            Number(payload.patient.ageDays || 0),
            payload.patient.gender,
            payload.patient.mobile?.trim() || '',
            payload.patient.address?.trim() || '',
            portalHash,
            portalEnc,
            nowTs
          );
        patientId = Number(pRes.lastInsertRowid);
        const qrSecret = generatePatientQrSecret();
        const qrToken = createEncryptedPatientQrToken(patientId, qrSecret, this.getAuthSecret());
        db.prepare(`UPDATE patients SET qr_secret = ?, qr_token = ? WHERE id = ?`).run(
          qrSecret,
          qrToken,
          patientId
        );
      }

      const nextInvSeq = (db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as n FROM invoices').get() as { n: number }).n;
      const invoiceNo = `INV-${26000 + nextInvSeq}`;

      const iRes = db
        .prepare(
          `INSERT INTO invoices (
            invoice_no, patient_id, doctor_id, subtotal, discount_type, discount_value, discount_amount, discount_pct,
            doctor_less_percent, doctor_less_amount, flat_discount_amount,
            net_total, paid_amount, due_amount, payment_status,
            initial_payment_method,
            commission_pct, commission_amount, commission_type, commission_value, commission_paid,
            notes, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          invoiceNo,
          patientId,
          payload.doctorId || null,
          subtotal,
          dType,
          dVal,
          discountAmount,
          discountPct,
          doctorLessPercent,
          doctorLessAmount,
          flatDiscountAmount,
          netTotal,
          paid,
          due,
          paymentStatus,
          payload.paymentMethod?.trim() || 'Cash',
          computedComm.invoiceCommissionPct,
          computedComm.invoiceCommissionAmount,
          computedComm.invoiceCommissionType,
          computedComm.invoiceCommissionValue,
          payload.notes?.trim() || '',
          payload.isAdmin ? 'Admin' : 'Staff',
          nowTs
        );
      const invoiceId = Number(iRes.lastInsertRowid);

      const insInvTest = db.prepare(
        `INSERT INTO invoice_tests (
          invoice_id, test_id, test_name, category_name, sample_type, price,
          commission_type, commission_value, commission_amount, reagent_deductions, status, collected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sample Collected', ?)`
      );
      const getParams = db.prepare(`SELECT * FROM test_parameters WHERE test_id = ? ORDER BY sort_order ASC, id ASC`);
      const insResult = db.prepare(
        `INSERT INTO test_results (invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const t of typedSelectedTests) {
        const tc = computedComm.perTestMap.get(t.id);
        const params = getParams.all(t.id) as Array<{
          id: number;
          name: string;
          unit: string;
          input_type: string;
          normal_text: string;
          default_value: string;
          abnormal_values: string;
          min_male: number | null;
          max_male: number | null;
          min_female: number | null;
          max_female: number | null;
          min_child: number | null;
          max_child: number | null;
          min_newborn: number | null;
          max_newborn: number | null;
          sort_order: number;
        }>;
        const deductions = this.deductReagentsFefo(t, params, nowTs);
        const itRes = insInvTest.run(
          invoiceId,
          t.id,
          t.name,
          t.category_name,
          t.sample_type,
          t.price,
          tc?.commission_type || 'percent',
          tc?.commission_value ?? docCommissionPct,
          tc?.commission_amount ?? 0,
          JSON.stringify(deductions),
          nowTs
        );
        const invoiceTestId = Number(itRes.lastInsertRowid);
        for (const param of params) {
          const initialVal = param.default_value || '';
          const evalRes = evaluateResultFlag(
            initialVal,
            param,
            payload.patient.gender,
            Number(payload.patient.ageYears || 0),
            Number(payload.patient.ageMonths || 0),
            Number(payload.patient.ageDays || 0)
          );
          insResult.run(
            invoiceTestId,
            param.id,
            param.name,
            param.unit,
            initialVal,
            evalRes.rangeLabel,
            evalRes.flag,
            param.sort_order
          );
        }
      }

      return invoiceId;
    })();

    return (await this.getFullInvoice(createdInvoiceId, payload.isAdmin, true))!;
  }

  async updateInvoice(payload: UpdateInvoicePayload): Promise<Record<string, unknown>> {
    const existingInv = db
      .prepare(`SELECT i.*, p.patient_uid FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE i.id = ?`)
      .get(payload.invoiceId) as
      | {
          id: number;
          patient_id: number;
          doctor_id: number | null;
          discount_type: 'percent' | 'flat';
          discount_value: number;
          discount_amount: number;
          doctor_less_percent?: number;
          doctor_less_amount?: number;
          flat_discount_amount?: number;
          subtotal: number;
          commission_type?: string;
          commission_value?: number;
          commission_pct: number;
          paid_amount: number;
          notes: string;
          created_at: string;
        }
      | undefined;

    if (!existingInv) throw new StoreError(404, 'Invoice not found.');

    const todayStr = getTodayDateStr();
    if (!payload.isAdmin && String(existingInv.created_at || '').slice(0, 10) !== todayStr) {
      throw new StoreError(
        403,
        "Staff can only edit today's entered patients. Switch to Admin mode to modify older invoices."
      );
    }

    if (!payload.patient?.name?.trim() || !payload.patient?.gender) {
      throw new StoreError(400, 'Patient full name and gender are required.');
    }

    const requestedIds = Array.isArray(payload.addTestIds)
      ? Array.from(new Set(payload.addTestIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)))
      : [];
    const removeInvTestIdSet = new Set(
      Array.isArray(payload.removeInvoiceTestIds)
        ? payload.removeInvoiceTestIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : []
    );
    const removeCatalogTestIdSet = new Set(
      Array.isArray(payload.removeTestIds)
        ? payload.removeTestIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : []
    );

    const existingTestRows = db
      .prepare('SELECT id, test_id, price, commission_type, commission_value, reagent_deductions FROM invoice_tests WHERE invoice_id = ?')
      .all(payload.invoiceId) as Array<{
      id: number;
      test_id: number;
      price: number;
      commission_type?: string;
      commission_value?: number;
      reagent_deductions?: string;
    }>;
    const removedTestRows = existingTestRows.filter(
      (r) => removeInvTestIdSet.has(r.id) || removeCatalogTestIdSet.has(r.test_id)
    );
    const keptExistingRows = existingTestRows.filter(
      (r) => !removeInvTestIdSet.has(r.id) && !removeCatalogTestIdSet.has(r.test_id)
    );

    const keptExistingTestIds = new Set(keptExistingRows.map((r) => r.test_id));
    const newTestIds = requestedIds.filter((id) => !keptExistingTestIds.has(id));

    let testsToAdd: Array<{
      id: number;
      code?: string;
      name: string;
      category_name: string;
      sample_type: string;
      price: number;
      mapped_reagents?: string;
    }> = [];
    if (newTestIds.length > 0) {
      const ph = newTestIds.map(() => '?').join(',');
      testsToAdd = db
        .prepare(
          `SELECT t.*, c.name as category_name FROM tests t JOIN test_categories c ON c.id = t.category_id WHERE t.id IN (${ph}) AND t.is_active = 1`
        )
        .all(...newTestIds) as typeof testsToAdd;
    }

    if (keptExistingRows.length + testsToAdd.length === 0) {
      throw new StoreError(400, 'An invoice must have at least one diagnostic test.');
    }

    const newSubtotal =
      keptExistingRows.reduce((sum, r) => sum + Number(r.price), 0) +
      testsToAdd.reduce((sum, t) => sum + Number(t.price), 0);

    const existingBreakdown = resolveInvoiceDiscountBreakdown(existingInv);
    const hasSplitUpdate =
      payload.doctorLessPercent !== undefined || payload.flatDiscountAmount !== undefined;
    const hasLegacyUpdate =
      !hasSplitUpdate && (payload.discountType !== undefined || payload.discountValue !== undefined);

    const disc = hasSplitUpdate
      ? computeSequentialDiscounts({
          subtotal: newSubtotal,
          doctorLessPercent:
            payload.doctorLessPercent !== undefined
              ? payload.doctorLessPercent
              : existingBreakdown.doctorLessPercent,
          flatDiscountAmount:
            payload.flatDiscountAmount !== undefined
              ? payload.flatDiscountAmount
              : existingBreakdown.flatDiscountAmount,
        })
      : hasLegacyUpdate
      ? computeSequentialDiscounts({
          subtotal: newSubtotal,
          legacyDiscountType:
            payload.discountType === 'percent' || payload.discountType === 'flat'
              ? payload.discountType
              : existingInv.discount_type,
          legacyDiscountValue:
            payload.discountValue !== undefined && payload.discountValue !== null
              ? Number(payload.discountValue || 0)
              : Number(existingInv.discount_value || 0),
        })
      : computeSequentialDiscounts({
          subtotal: newSubtotal,
          doctorLessPercent: existingBreakdown.doctorLessPercent,
          flatDiscountAmount: existingBreakdown.flatDiscountAmount,
        });

    const dType = disc.legacyDiscountType;
    const dVal = disc.legacyDiscountValue;
    const discountAmount = disc.discountAmount;
    const doctorLessPercent = disc.doctorLessPercent;
    const doctorLessAmount = disc.doctorLessAmount;
    const flatDiscountAmount = disc.flatDiscountAmount;

    const discountChanged = hasSplitUpdate
      ? (payload.doctorLessPercent !== undefined &&
          Number(payload.doctorLessPercent) !== existingBreakdown.doctorLessPercent) ||
        (payload.flatDiscountAmount !== undefined &&
          Number(payload.flatDiscountAmount) !== existingBreakdown.flatDiscountAmount)
      : (payload.discountType !== undefined && payload.discountType !== existingInv.discount_type) ||
        (payload.discountValue !== undefined && Number(payload.discountValue) !== Number(existingInv.discount_value));

    if (discountChanged) {
      const rawCap = sqliteGetSetting('max_staff_discount_pct');
      const maxStaffPct =
        rawCap !== '' && Number.isFinite(Number(rawCap)) ? Math.min(100, Math.max(0, Number(rawCap))) : 100;
      const effectivePct = newSubtotal > 0 ? (discountAmount / newSubtotal) * 100 : 0;
      if (!payload.isAdmin && effectivePct > maxStaffPct + 0.01) {
        throw new StoreError(
          403,
          `Staff discount limit is ${maxStaffPct}%. Switch to Admin mode to authorize higher discounts.`
        );
      }
    }

    const existingAdjAmt = Number((existingInv as { adjustment_amount?: number }).adjustment_amount || 0);
    const nextAdjustmentAmount =
      payload.isAdmin && payload.adjustmentAmount !== undefined && payload.adjustmentAmount !== null
        ? roundCurrency(Number(payload.adjustmentAmount || 0))
        : existingAdjAmt;
    const netTotal = Math.max(0, Math.round((disc.netBeforeAdjustment - nextAdjustmentAmount) * 100) / 100);
    const discountPct = disc.discountPct;
    const nextDoctorId = payload.doctorId !== undefined ? payload.doctorId : existingInv.doctor_id;
    let docCommissionPct = 0;
    if (nextDoctorId) {
      const doc = db.prepare('SELECT commission_pct FROM doctors WHERE id = ?').get(nextDoctorId) as
        | { commission_pct: number }
        | undefined;
      if (doc) docCommissionPct = Number(doc.commission_pct || 0);
    }

    const doctorChanged = Number(nextDoctorId || 0) !== Number(existingInv.doctor_id || 0);
    const resolvedMode: 'doctor_default' | 'custom_invoice' | 'custom_per_test' =
      payload.isAdmin && payload.commissionMode
        ? payload.commissionMode
        : doctorChanged
        ? 'doctor_default'
        : existingInv.commission_type === 'per_test'
        ? 'custom_per_test'
        : existingInv.commission_type === 'flat' ||
          (typeof existingInv.commission_value === 'number' &&
            Math.abs(existingInv.commission_value - docCommissionPct) > 0.01)
        ? 'custom_invoice'
        : 'doctor_default';

    const resolvedType: 'percent' | 'flat' =
      payload.isAdmin && payload.commissionMode
        ? payload.commissionType === 'flat'
          ? 'flat'
          : 'percent'
        : existingInv.commission_type === 'flat'
        ? 'flat'
        : 'percent';

    const resolvedValue =
      payload.isAdmin && payload.commissionMode
        ? payload.commissionValue
        : typeof existingInv.commission_value === 'number'
        ? existingInv.commission_value
        : existingInv.commission_pct;

    const resolvedTestCommissions: TestCommissionOverride[] =
      payload.isAdmin && payload.commissionMode === 'custom_per_test' && Array.isArray(payload.testCommissions)
        ? payload.testCommissions
        : keptExistingRows.map((it) => ({
            testId: it.test_id,
            commissionType: it.commission_type === 'flat' ? 'flat' : 'percent',
            commissionValue:
              typeof it.commission_value === 'number' ? it.commission_value : docCommissionPct,
          }));

    const allCombinedTests = [
      ...keptExistingRows.map((r) => ({ test_id: r.test_id, price: Number(r.price) })),
      ...testsToAdd.map((t) => ({ test_id: t.id, price: Number(t.price) })),
    ];

    const computedComm = computeInvoiceCommission({
      tests: allCombinedTests,
      subtotal: newSubtotal,
      netTotal,
      hasDoctor: Boolean(nextDoctorId),
      doctorCommissionPct: docCommissionPct,
      commissionMode: resolvedMode,
      commissionType: resolvedType,
      commissionValue: resolvedValue,
      testCommissions: resolvedTestCommissions,
    });

    const extraPayRaw = Math.max(0, Math.round(Number(payload.additionalPayment || 0) * 100) / 100);
    const prevPaid = Number(existingInv.paid_amount || 0);
    const maxCollectable = Math.max(0, Math.round((netTotal - prevPaid) * 100) / 100);
    const appliedExtraPay = Math.min(extraPayRaw, maxCollectable);
    const shouldRefundExcess = Boolean(payload.isAdmin && payload.refundExcess && prevPaid > netTotal);
    const refundAmount = shouldRefundExcess ? roundCurrency(prevPaid - netTotal) : 0;
    const newPaid = shouldRefundExcess
      ? netTotal
      : Math.round((prevPaid + appliedExtraPay) * 100) / 100;
    const newDue = Math.max(0, Math.round((netTotal - newPaid) * 100) / 100);
    const newStatus = newDue <= 0 ? 'Paid' : newPaid > 0 ? 'Partial' : 'Due';
    const nowTs = getLocalTimestampStr();

    db.transaction(() => {
      db.prepare(
        `UPDATE patients SET name = ?, age_years = ?, age_months = ?, age_days = ?, gender = ?, mobile = ?, address = ? WHERE id = ?`
      ).run(
        payload.patient!.name!.trim(),
        Number(payload.patient!.ageYears || 0),
        Number(payload.patient!.ageMonths || 0),
        Number(payload.patient!.ageDays || 0),
        payload.patient!.gender!,
        payload.patient!.mobile?.trim() || '',
        payload.patient!.address?.trim() || '',
        existingInv.patient_id
      );

      if (removedTestRows.length > 0) {
        const delResults = db.prepare(`DELETE FROM test_results WHERE invoice_test_id = ?`);
        const delInvTest = db.prepare(`DELETE FROM invoice_tests WHERE id = ?`);
        for (const rem of removedTestRows) {
          this.restoreReagentDeductions(rem.reagent_deductions, nowTs);
          delResults.run(rem.id);
          delInvTest.run(rem.id);
        }
      }

      const existingResults = db
        .prepare(
          `SELECT tr.id, tr.result_value, tp.input_type, tp.abnormal_values, tp.normal_text,
                  tp.min_male, tp.max_male, tp.min_female, tp.max_female, tp.min_child, tp.max_child,
                  tp.min_newborn, tp.max_newborn
           FROM test_results tr
           JOIN invoice_tests it ON it.id = tr.invoice_test_id
           LEFT JOIN test_parameters tp ON tp.id = tr.parameter_id
           WHERE it.invoice_id = ?`
        )
        .all(payload.invoiceId) as Array<{
        id: number;
        result_value: string;
        input_type: string | null;
        abnormal_values: string | null;
        normal_text: string | null;
        min_male: number | null;
        max_male: number | null;
        min_female: number | null;
        max_female: number | null;
        min_child: number | null;
        max_child: number | null;
        min_newborn: number | null;
        max_newborn: number | null;
      }>;

      const updExistingRes = db.prepare(`UPDATE test_results SET reference_range_text = ?, flag = ? WHERE id = ?`);
      for (const er of existingResults) {
        if (er.input_type) {
          const reEval = evaluateResultFlag(
            er.result_value || '',
            {
              input_type: er.input_type,
              abnormal_values: er.abnormal_values || '',
              normal_text: er.normal_text || '',
              min_male: er.min_male,
              max_male: er.max_male,
              min_female: er.min_female,
              max_female: er.max_female,
              min_child: er.min_child,
              max_child: er.max_child,
              min_newborn: er.min_newborn,
              max_newborn: er.max_newborn,
            },
            payload.patient!.gender!,
            Number(payload.patient!.ageYears || 0),
            Number(payload.patient!.ageMonths || 0),
            Number(payload.patient!.ageDays || 0)
          );
          updExistingRes.run(reEval.rangeLabel, reEval.flag, er.id);
        }
      }

      const insInvTest = db.prepare(
        `INSERT INTO invoice_tests (
          invoice_id, test_id, test_name, category_name, sample_type, price,
          commission_type, commission_value, commission_amount, reagent_deductions, status, collected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sample Collected', ?)`
      );
      const getParams = db.prepare(`SELECT * FROM test_parameters WHERE test_id = ? ORDER BY sort_order ASC, id ASC`);
      const insResult = db.prepare(
        `INSERT INTO test_results (invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const t of testsToAdd) {
        const tc = computedComm.perTestMap.get(t.id);
        const params = getParams.all(t.id) as Array<{
          id: number;
          name: string;
          unit: string;
          input_type: string;
          normal_text: string;
          default_value: string;
          abnormal_values: string;
          min_male: number | null;
          max_male: number | null;
          min_female: number | null;
          max_female: number | null;
          min_child: number | null;
          max_child: number | null;
          min_newborn: number | null;
          max_newborn: number | null;
          sort_order: number;
        }>;
        const deductions = this.deductReagentsFefo(t, params, nowTs);
        const itRes = insInvTest.run(
          payload.invoiceId,
          t.id,
          t.name,
          t.category_name,
          t.sample_type,
          t.price,
          tc?.commission_type || 'percent',
          tc?.commission_value ?? docCommissionPct,
          tc?.commission_amount ?? 0,
          JSON.stringify(deductions),
          nowTs
        );
        const invoiceTestId = Number(itRes.lastInsertRowid);
        for (const param of params) {
          const initialVal = param.default_value || '';
          const evalRes = evaluateResultFlag(
            initialVal,
            param,
            payload.patient!.gender!,
            Number(payload.patient!.ageYears || 0),
            Number(payload.patient!.ageMonths || 0),
            Number(payload.patient!.ageDays || 0)
          );
          insResult.run(invoiceTestId, param.id, param.name, param.unit, initialVal, evalRes.rangeLabel, evalRes.flag, param.sort_order);
        }
      }

      const updExistingIt = db.prepare(
        `UPDATE invoice_tests SET commission_type = ?, commission_value = ?, commission_amount = ? WHERE id = ?`
      );
      for (const existingIt of keptExistingRows) {
        const tc = computedComm.perTestMap.get(existingIt.test_id);
        if (tc) {
          updExistingIt.run(tc.commission_type, tc.commission_value, tc.commission_amount, existingIt.id);
        }
      }

      if (appliedExtraPay > 0) {
        db.prepare(
          `INSERT INTO due_payments (invoice_id, amount, entry_type, payment_method, note, collected_by, collected_at)
           VALUES (?, ?, 'payment', ?, ?, ?, ?)`
        ).run(
          payload.invoiceId,
          appliedExtraPay,
          payload.paymentMethod?.trim() || 'Cash',
          testsToAdd.length > 0 ? 'Payment on added tests' : 'Updated invoice payment',
          payload.isAdmin ? 'Admin' : 'Staff',
          nowTs
        );
      }

      if (refundAmount > 0) {
        db.prepare(
          `INSERT INTO due_payments (invoice_id, amount, entry_type, payment_method, note, collected_by, collected_at)
           VALUES (?, ?, 'refund', ?, ?, ?, ?)`
        ).run(
          payload.invoiceId,
          -refundAmount,
          payload.refundMethod?.trim() || 'Cash',
          payload.adjustmentReason?.trim()
            ? `Admin Bill Adjustment Refund: ${payload.adjustmentReason.trim()}`
            : 'Admin Bill Adjustment Refund',
          payload.adjustedBy?.trim() || 'Admin',
          nowTs
        );
      }

      const prevNetTotal = Number((existingInv as { net_total?: number }).net_total || 0);
      const adjChanged =
        payload.isAdmin &&
        (Math.abs(nextAdjustmentAmount - existingAdjAmt) > 0.01 ||
          refundAmount > 0 ||
          (payload.adjustmentReason !== undefined &&
            payload.adjustmentReason.trim() !== String((existingInv as { adjustment_reason?: string }).adjustment_reason || '').trim()));

      if (adjChanged && Math.abs(netTotal - prevNetTotal) + refundAmount > 0.001) {
        db.prepare(
          `INSERT INTO invoice_adjustments (
            invoice_id, previous_net_total, new_net_total, adjustment_delta,
            previous_paid_amount, new_paid_amount, refund_amount, reason, adjusted_by, adjusted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          payload.invoiceId,
          prevNetTotal,
          netTotal,
          roundCurrency(prevNetTotal - netTotal),
          prevPaid,
          newPaid,
          refundAmount,
          payload.adjustmentReason?.trim() || '',
          payload.adjustedBy?.trim() || 'Admin',
          nowTs
        );
      }

      db.prepare(
        `UPDATE invoices
         SET doctor_id = ?, subtotal = ?, discount_type = ?, discount_value = ?, discount_amount = ?, discount_pct = ?,
             doctor_less_percent = ?, doctor_less_amount = ?, flat_discount_amount = ?,
             adjustment_amount = ?, adjustment_reason = ?, adjusted_by = ?, adjusted_at = ?,
             net_total = ?, paid_amount = ?, due_amount = ?, payment_status = ?,
             commission_pct = ?, commission_amount = ?, commission_type = ?, commission_value = ?, notes = ?
         WHERE id = ?`
      ).run(
        nextDoctorId || null,
        newSubtotal,
        dType,
        dVal,
        discountAmount,
        discountPct,
        doctorLessPercent,
        doctorLessAmount,
        flatDiscountAmount,
        nextAdjustmentAmount,
        payload.isAdmin && payload.adjustmentReason !== undefined
          ? payload.adjustmentReason.trim()
          : (existingInv as { adjustment_reason?: string }).adjustment_reason || '',
        adjChanged ? payload.adjustedBy?.trim() || 'Admin' : (existingInv as { adjusted_by?: string }).adjusted_by || '',
        adjChanged ? nowTs : (existingInv as { adjusted_at?: string }).adjusted_at || '',
        netTotal,
        newPaid,
        newDue,
        newStatus,
        computedComm.invoiceCommissionPct,
        computedComm.invoiceCommissionAmount,
        computedComm.invoiceCommissionType,
        computedComm.invoiceCommissionValue,
        payload.notes !== undefined ? payload.notes.trim() : existingInv.notes,
        payload.invoiceId
      );
    })();

    return (await this.getFullInvoice(payload.invoiceId, payload.isAdmin, true))!;
  }

  async removeInvoiceTest(payload: {
    invoiceId: number;
    invoiceTestId: number;
    isAdmin: boolean;
  }): Promise<Record<string, unknown>> {
    const existing = db
      .prepare(
        `SELECT i.id, p.name, p.age_years, p.age_months, p.age_days, p.gender, p.mobile, p.address
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         WHERE i.id = ?`
      )
      .get(payload.invoiceId) as
      | {
          id: number;
          name: string;
          age_years: number;
          age_months: number;
          age_days: number;
          gender: 'Male' | 'Female' | 'Other';
          mobile: string;
          address: string;
        }
      | undefined;
    if (!existing) throw new StoreError(404, 'Invoice not found.');

    const targetTest = db
      .prepare(`SELECT id FROM invoice_tests WHERE id = ? AND invoice_id = ?`)
      .get(payload.invoiceTestId, payload.invoiceId) as { id: number } | undefined;
    if (!targetTest) throw new StoreError(404, 'Invoice test item not found.');

    return this.updateInvoice({
      invoiceId: payload.invoiceId,
      isAdmin: payload.isAdmin,
      patient: {
        name: existing.name,
        ageYears: existing.age_years,
        ageMonths: existing.age_months,
        ageDays: existing.age_days,
        gender: existing.gender,
        mobile: existing.mobile,
        address: existing.address,
      },
      removeInvoiceTestIds: [payload.invoiceTestId],
    });
  }

  async addDuePayment(payload: {
    invoiceId: number;
    amount: number;
    paymentMethod?: string;
    note?: string;
    isAdmin: boolean;
  }): Promise<Record<string, unknown>> {
    const payAmt = Math.round(Number(payload.amount || 0) * 100) / 100;
    if (payAmt <= 0) throw new StoreError(400, 'Payment amount must be greater than 0.');

    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(payload.invoiceId) as
      | { id: number; net_total: number; paid_amount: number; due_amount: number }
      | undefined;
    if (!inv) throw new StoreError(404, 'Invoice not found.');
    if (inv.due_amount <= 0) {
      throw new StoreError(400, 'This invoice has no pending due balance.');
    }
    if (payAmt > inv.due_amount + 0.01) {
      throw new StoreError(400, `Payment exceeds current due of ৳${inv.due_amount}.`);
    }

    const appliedPay = Math.min(payAmt, inv.due_amount);
    const newPaid = Math.round((inv.paid_amount + appliedPay) * 100) / 100;
    const newDue = Math.max(0, Math.round((inv.net_total - newPaid) * 100) / 100);
    const newStatus = newDue <= 0 ? 'Paid' : 'Partial';
    const nowTs = getLocalTimestampStr();

    db.transaction(() => {
      db.prepare(
        `INSERT INTO due_payments (invoice_id, amount, entry_type, payment_method, note, collected_by, collected_at)
         VALUES (?, ?, 'payment', ?, ?, ?, ?)`
      ).run(
        payload.invoiceId,
        appliedPay,
        payload.paymentMethod?.trim() || 'Cash',
        payload.note?.trim() || '',
        payload.isAdmin ? 'Admin' : 'Staff',
        nowTs
      );
      db.prepare('UPDATE invoices SET paid_amount = ?, due_amount = ?, payment_status = ? WHERE id = ?').run(
        newPaid,
        newDue,
        newStatus,
        payload.invoiceId
      );
    })();

    return (await this.getFullInvoice(payload.invoiceId, payload.isAdmin, true))!;
  }

  async adjustInvoiceBill(payload: AdjustInvoiceBillPayload): Promise<Record<string, unknown>> {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(payload.invoiceId) as
      | {
          id: number;
          doctor_id: number | null;
          subtotal: number;
          discount_amount: number;
          adjustment_amount?: number;
          net_total: number;
          paid_amount: number;
          due_amount: number;
          commission_type?: string;
          commission_value?: number;
          commission_pct: number;
        }
      | undefined;
    if (!inv) throw new StoreError(404, 'Invoice not found.');

    const baseNetAfterDiscount = Math.max(0, roundCurrency(Number(inv.subtotal) - Number(inv.discount_amount)));
    let targetNet = Number(inv.net_total);

    if (payload.targetNetTotal !== undefined && payload.targetNetTotal !== null) {
      const parsed = Number(payload.targetNetTotal);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new StoreError(400, 'Adjusted Net Bill must be 0 or greater.');
      }
      targetNet = roundCurrency(parsed);
    } else if (payload.reductionAmount !== undefined && payload.reductionAmount !== null) {
      const reduction = Number(payload.reductionAmount);
      if (!Number.isFinite(reduction) || reduction < 0) {
        throw new StoreError(400, 'Reduction amount must be 0 or greater.');
      }
      targetNet = Math.max(0, roundCurrency(Number(inv.net_total) - reduction));
    } else {
      throw new StoreError(400, 'Provide either targetNetTotal or reductionAmount.');
    }

    const newAdjustmentAmount = roundCurrency(baseNetAfterDiscount - targetNet);
    const prevNet = Number(inv.net_total);
    const prevPaid = Number(inv.paid_amount);
    const refundExcess = payload.refundExcess !== false;

    let refundAmount = 0;
    let newPaid = prevPaid;
    let newDue = 0;
    let newStatus: 'Paid' | 'Partial' | 'Due' = 'Paid';

    if (prevPaid > targetNet) {
      if (refundExcess) {
        refundAmount = roundCurrency(prevPaid - targetNet);
        newPaid = targetNet;
      }
      newDue = 0;
      newStatus = 'Paid';
    } else {
      newDue = Math.max(0, roundCurrency(targetNet - newPaid));
      newStatus = newDue <= 0 ? 'Paid' : newPaid > 0 ? 'Partial' : 'Due';
    }

    const invTests = db
      .prepare('SELECT id, test_id, price, commission_type, commission_value FROM invoice_tests WHERE invoice_id = ?')
      .all(payload.invoiceId) as Array<{
      id: number;
      test_id: number;
      price: number;
      commission_type?: string;
      commission_value?: number;
    }>;

    let docCommissionPct = 0;
    if (inv.doctor_id) {
      const doc = db.prepare('SELECT commission_pct FROM doctors WHERE id = ?').get(inv.doctor_id) as
        | { commission_pct: number }
        | undefined;
      if (doc) docCommissionPct = Number(doc.commission_pct || 0);
    }

    const resolvedMode: 'doctor_default' | 'custom_invoice' | 'custom_per_test' =
      inv.commission_type === 'per_test'
        ? 'custom_per_test'
        : inv.commission_type === 'flat' ||
          (typeof inv.commission_value === 'number' && Math.abs(inv.commission_value - docCommissionPct) > 0.01)
        ? 'custom_invoice'
        : 'doctor_default';

    const computedComm = computeInvoiceCommission({
      tests: invTests.map((it) => ({ test_id: it.test_id, price: Number(it.price) })),
      subtotal: Number(inv.subtotal),
      netTotal: targetNet,
      hasDoctor: Boolean(inv.doctor_id),
      doctorCommissionPct: docCommissionPct,
      commissionMode: resolvedMode,
      commissionType: inv.commission_type === 'flat' ? 'flat' : 'percent',
      commissionValue: typeof inv.commission_value === 'number' ? inv.commission_value : inv.commission_pct,
      testCommissions: invTests.map((it) => ({
        testId: it.test_id,
        commissionType: it.commission_type === 'flat' ? 'flat' : 'percent',
        commissionValue: typeof it.commission_value === 'number' ? it.commission_value : docCommissionPct,
      })),
    });

    const nowTs = getLocalTimestampStr();
    const reason = payload.reason?.trim() || '';
    const adjustedBy = payload.adjustedBy?.trim() || 'Admin';

    db.transaction(() => {
      db.prepare(
        `UPDATE invoices
         SET adjustment_amount = ?, adjustment_reason = ?, adjusted_by = ?, adjusted_at = ?,
             net_total = ?, paid_amount = ?, due_amount = ?, payment_status = ?,
             commission_pct = ?, commission_amount = ?, commission_type = ?, commission_value = ?
         WHERE id = ?`
      ).run(
        newAdjustmentAmount,
        reason,
        adjustedBy,
        nowTs,
        targetNet,
        newPaid,
        newDue,
        newStatus,
        computedComm.invoiceCommissionPct,
        computedComm.invoiceCommissionAmount,
        computedComm.invoiceCommissionType,
        computedComm.invoiceCommissionValue,
        payload.invoiceId
      );

      const updIt = db.prepare(
        `UPDATE invoice_tests SET commission_type = ?, commission_value = ?, commission_amount = ? WHERE id = ?`
      );
      for (const it of invTests) {
        const tc = computedComm.perTestMap.get(it.test_id);
        if (tc) {
          updIt.run(tc.commission_type, tc.commission_value, tc.commission_amount, it.id);
        }
      }

      if (refundAmount > 0) {
        db.prepare(
          `INSERT INTO due_payments (invoice_id, amount, entry_type, payment_method, note, collected_by, collected_at)
           VALUES (?, ?, 'refund', ?, ?, ?, ?)`
        ).run(
          payload.invoiceId,
          -refundAmount,
          payload.refundMethod?.trim() || 'Cash',
          reason ? `Admin Bill Reduction Refund: ${reason}` : 'Admin Bill Reduction Refund',
          adjustedBy,
          nowTs
        );
      }

      db.prepare(
        `INSERT INTO invoice_adjustments (
          invoice_id, previous_net_total, new_net_total, adjustment_delta,
          previous_paid_amount, new_paid_amount, refund_amount, reason, adjusted_by, adjusted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        payload.invoiceId,
        prevNet,
        targetNet,
        roundCurrency(prevNet - targetNet),
        prevPaid,
        newPaid,
        refundAmount,
        reason,
        adjustedBy,
        nowTs
      );
    })();

    return (await this.getFullInvoice(payload.invoiceId, true, true))!;
  }

  async deleteInvoiceEntry(invoiceId: number): Promise<{
    success: boolean;
    deletedInvoiceId: number;
    invoiceNo: string;
    deletedPatientId: number;
    patientUid: string;
    patientName: string;
    patientDeleted: boolean;
    deletedTestsCount: number;
    deletedResultsCount: number;
  }> {
    const inv = db
      .prepare('SELECT id, invoice_no, patient_id FROM invoices WHERE id = ?')
      .get(invoiceId) as { id: number; invoice_no: string; patient_id: number } | undefined;
    if (!inv) {
      throw new StoreError(404, 'Patient invoice record not found.');
    }

    const patient = db
      .prepare('SELECT id, patient_uid, name FROM patients WHERE id = ?')
      .get(inv.patient_id) as { id: number; patient_uid: string; name: string } | undefined;

    let deletedTestsCount = 0;
    let deletedResultsCount = 0;
    let patientDeleted = false;

    const nowTs = getLocalTimestampStr();
    db.transaction(() => {
      const invTests = db
        .prepare('SELECT id, reagent_deductions FROM invoice_tests WHERE invoice_id = ?')
        .all(invoiceId) as Array<{ id: number; reagent_deductions?: string }>;
      for (const it of invTests) {
        this.restoreReagentDeductions(it.reagent_deductions, nowTs);
      }
      const itIds = invTests.map((it) => it.id);

      if (itIds.length > 0) {
        const placeholders = itIds.map(() => '?').join(',');
        const resDel = db
          .prepare(`DELETE FROM test_results WHERE invoice_test_id IN (${placeholders})`)
          .run(...itIds);
        deletedResultsCount = resDel.changes;
      }

      db.prepare('DELETE FROM invoice_adjustments WHERE invoice_id = ?').run(invoiceId);
      db.prepare('DELETE FROM due_payments WHERE invoice_id = ?').run(invoiceId);
      const testsDel = db.prepare('DELETE FROM invoice_tests WHERE invoice_id = ?').run(invoiceId);
      deletedTestsCount = testsDel.changes;

      db.prepare('DELETE FROM invoices WHERE id = ?').run(invoiceId);

      const remaining = db
        .prepare('SELECT COUNT(*) as cnt FROM invoices WHERE patient_id = ?')
        .get(inv.patient_id) as { cnt: number };
      if ((remaining?.cnt || 0) === 0) {
        const patDel = db.prepare('DELETE FROM patients WHERE id = ?').run(inv.patient_id);
        patientDeleted = patDel.changes > 0;
      }
    })();

    return {
      success: true,
      deletedInvoiceId: invoiceId,
      invoiceNo: inv.invoice_no,
      deletedPatientId: inv.patient_id,
      patientUid: patient?.patient_uid || '',
      patientName: patient?.name || '',
      patientDeleted,
      deletedTestsCount,
      deletedResultsCount,
    };
  }

  async getLabQueue(filters: { search?: string; status?: string }): Promise<unknown[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.search?.trim()) {
      conditions.push(`(i.invoice_no LIKE ? OR p.patient_uid LIKE ? OR p.name LIKE ? OR it.test_name LIKE ?)`);
      const like = `%${filters.search.trim()}%`;
      params.push(like, like, like, like);
    }
    if (filters.status && filters.status !== 'All') {
      if (filters.status === 'Pending') {
        conditions.push(`it.status != 'Ready'`);
      } else {
        conditions.push(`it.status = ?`);
        params.push(filters.status);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return db
      .prepare(
        `SELECT it.*, i.invoice_no, i.created_at as invoice_date,
                p.patient_uid, p.name as patient_name, p.age_years, p.age_months, p.age_days, p.gender, p.mobile as patient_mobile,
                d.name as doctor_name,
                (SELECT COUNT(*) FROM test_results tr WHERE tr.invoice_test_id = it.id) as total_params,
                (SELECT COUNT(*) FROM test_results tr WHERE tr.invoice_test_id = it.id AND tr.result_value != '') as filled_params,
                (SELECT COUNT(*) FROM test_results tr WHERE tr.invoice_test_id = it.id AND tr.flag != 'Normal') as abnormal_count
         FROM invoice_tests it
         JOIN invoices i ON i.id = it.invoice_id
         JOIN patients p ON p.id = i.patient_id
         LEFT JOIN doctors d ON d.id = i.doctor_id
         ${whereClause}
         ORDER BY
           CASE it.status
             WHEN 'Sample Collected' THEN 1
             WHEN 'Processing' THEN 2
             WHEN 'Verified' THEN 3
             ELSE 4
           END,
           it.id DESC
         LIMIT 200`
      )
      .all(...params);
  }

  async getLabTestDetail(invoiceTestId: number): Promise<{ item: unknown; results: unknown[] } | null> {
    const item = db
      .prepare(
        `SELECT it.*, i.invoice_no, i.created_at as invoice_date,
                p.patient_uid, p.name as patient_name, p.age_years, p.age_months, p.age_days, p.gender, p.mobile as patient_mobile,
                d.name as doctor_name
         FROM invoice_tests it
         JOIN invoices i ON i.id = it.invoice_id
         JOIN patients p ON p.id = i.patient_id
         LEFT JOIN doctors d ON d.id = i.doctor_id
         WHERE it.id = ?`
      )
      .get(invoiceTestId) as
      | {
          id: number;
          test_id: number;
          status: string;
          gender: string;
          age_years: number;
          age_months: number;
          age_days: number;
          [key: string]: unknown;
        }
      | undefined;

    if (!item) return null;

    const configuredParams = db
      .prepare(`SELECT * FROM test_parameters WHERE test_id = ? ORDER BY sort_order ASC, id ASC`)
      .all(item.test_id) as Array<{
      id: number;
      test_id: number;
      name: string;
      unit: string;
      input_type: string;
      normal_text: string;
      default_value: string;
      select_options: string;
      abnormal_values: string;
      min_male: number | null;
      max_male: number | null;
      min_female: number | null;
      max_female: number | null;
      min_child: number | null;
      max_child: number | null;
      min_newborn: number | null;
      max_newborn: number | null;
      sort_order: number;
    }>;

    const rawResults = db
      .prepare(
        `SELECT tr.*, tp.input_type, tp.select_options, tp.abnormal_values, tp.normal_text,
                tp.min_male, tp.max_male, tp.min_female, tp.max_female, tp.min_child, tp.max_child,
                tp.min_newborn, tp.max_newborn
         FROM test_results tr
         LEFT JOIN test_parameters tp ON tp.id = tr.parameter_id
         WHERE tr.invoice_test_id = ?
         ORDER BY tr.sort_order ASC, tr.id ASC`
      )
      .all(invoiceTestId) as Array<{
      id: number;
      invoice_test_id: number;
      parameter_id: number;
      parameter_name: string;
      unit: string;
      result_value: string;
      reference_range_text: string | null;
      flag: string;
      normal_text?: string | null;
      sort_order: number;
    }>;

    if (configuredParams.length === 0) {
      return { item, results: deduplicateResultRows(rawResults) };
    }

    const dedupedRaw = deduplicateResultRows(rawResults);
    const matchedIds = new Set<number>();
    const byParamId = new Map<number, typeof rawResults[number]>();
    const byCanonKey = new Map<string, typeof rawResults[number]>();

    for (const r of dedupedRaw) {
      if (typeof r.parameter_id === 'number' && !byParamId.has(r.parameter_id)) {
        byParamId.set(r.parameter_id, r);
      }
      const canon = getCanonicalParameterKey(r.parameter_name || '');
      if (canon && !byCanonKey.has(canon)) {
        byCanonKey.set(canon, r);
      }
    }

    const matchedByParam = new Map<number, typeof rawResults[number]>();
    for (const tp of configuredParams) {
      const canon = getCanonicalParameterKey(tp.name);
      const candById = byParamId.get(tp.id);
      const candByKey = canon ? byCanonKey.get(canon) : undefined;
      const chosen =
        candById && !matchedIds.has(candById.id)
          ? candById
          : candByKey && !matchedIds.has(candByKey.id)
            ? candByKey
            : undefined;
      if (chosen) {
        matchedIds.add(chosen.id);
        matchedByParam.set(tp.id, chosen);
      }
    }

    if (item.status !== 'Ready') {
      const delRow = db.prepare(`DELETE FROM test_results WHERE id = ?`);
      const updRow = db.prepare(
        `UPDATE test_results SET parameter_id = ?, parameter_name = ?, unit = ?, reference_range_text = ?, flag = ?, sort_order = ? WHERE id = ?`
      );
      const insRow = db.prepare(
        `INSERT INTO test_results (invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      let dbModified = false;
      db.transaction(() => {
        for (const r of rawResults) {
          if (!matchedIds.has(r.id)) {
            delRow.run(r.id);
            dbModified = true;
          }
        }
        for (const tp of configuredParams) {
          const existing = matchedByParam.get(tp.id);
          if (existing) {
            const evalRes = evaluateResultFlag(
              existing.result_value || '',
              tp,
              item.gender,
              item.age_years,
              item.age_months,
              item.age_days
            );
            if (
              existing.parameter_id !== tp.id ||
              existing.parameter_name !== tp.name ||
              (existing.unit || '') !== (tp.unit || '') ||
              existing.sort_order !== tp.sort_order ||
              (existing.reference_range_text || '') !== evalRes.rangeLabel
            ) {
              updRow.run(tp.id, tp.name, tp.unit || '', evalRes.rangeLabel, evalRes.flag, tp.sort_order, existing.id);
              dbModified = true;
            }
          } else {
            const initialVal = tp.default_value || '';
            const evalRes = evaluateResultFlag(
              initialVal,
              tp,
              item.gender,
              item.age_years,
              item.age_months,
              item.age_days
            );
            insRow.run(
              invoiceTestId,
              tp.id,
              tp.name,
              tp.unit || '',
              initialVal,
              evalRes.rangeLabel,
              evalRes.flag,
              tp.sort_order
            );
            dbModified = true;
          }
        }
      })();

      if (dbModified) {
        const syncedResults = db
          .prepare(
            `SELECT tr.*, tp.input_type, tp.select_options, tp.abnormal_values, tp.normal_text,
                    tp.min_male, tp.max_male, tp.min_female, tp.max_female, tp.min_child, tp.max_child,
                    tp.min_newborn, tp.max_newborn
             FROM test_results tr
             JOIN test_parameters tp ON tp.id = tr.parameter_id
             WHERE tr.invoice_test_id = ? AND tp.test_id = ?
             ORDER BY tp.sort_order ASC, tp.id ASC`
          )
          .all(invoiceTestId, item.test_id);
        return { item, results: syncedResults };
      }
    }

    const strictResults = configuredParams.map((tp) => {
      const matched = matchedByParam.get(tp.id);
      const val = matched?.result_value || '';
      const evalRes = evaluateResultFlag(val, tp, item.gender, item.age_years, item.age_months, item.age_days);
      return {
        id: matched?.id ?? -tp.id,
        invoice_test_id: invoiceTestId,
        parameter_id: tp.id,
        parameter_name: tp.name,
        unit: tp.unit || '',
        result_value: val,
        reference_range_text: matched?.reference_range_text || evalRes.rangeLabel,
        flag: matched?.flag || evalRes.flag,
        sort_order: tp.sort_order,
        input_type: tp.input_type,
        select_options: tp.select_options,
        abnormal_values: tp.abnormal_values,
        normal_text: tp.normal_text,
        min_male: tp.min_male,
        max_male: tp.max_male,
        min_female: tp.min_female,
        max_female: tp.max_female,
        min_child: tp.min_child,
        max_child: tp.max_child,
        min_newborn: tp.min_newborn,
        max_newborn: tp.max_newborn,
      };
    });

    return { item, results: strictResults };
  }

  async updateLabTestResults(payload: UpdateLabResultsPayload): Promise<{ item: unknown; results: unknown[] }> {
    const item = db
      .prepare(
        `SELECT it.*, p.gender, p.age_years, p.age_months, p.age_days
         FROM invoice_tests it
         JOIN invoices i ON i.id = it.invoice_id
         JOIN patients p ON p.id = i.patient_id
         WHERE it.id = ?`
      )
      .get(payload.invoiceTestId) as
      | {
          id: number;
          gender: string;
          age_years: number;
          age_months: number;
          age_days: number;
          verified_at: string | null;
          ready_at: string | null;
          consultant_name: string;
          consultant_title: string;
        }
      | undefined;

    if (!item) throw new StoreError(404, 'Lab test entry not found.');

    const validStatuses = ['Sample Collected', 'Processing', 'Verified', 'Ready'];
    const nextStatus = validStatuses.includes(payload.status) ? payload.status : 'Processing';
    const nowTs = getLocalTimestampStr();

    const testResultMeta = db
      .prepare(`SELECT parameter_id, parameter_name, result_value FROM test_results WHERE invoice_test_id = ?`)
      .all(payload.invoiceTestId) as Array<{ parameter_id: number; parameter_name: string; result_value: string }>;

    const submittedMap = new Map<number, string>();
    for (const r of testResultMeta) submittedMap.set(r.parameter_id, r.result_value ?? '');
    if (Array.isArray(payload.results)) {
      for (const r of payload.results) submittedMap.set(r.parameterId, String(r.value ?? '').trim());
    }

    const findMetaByName = (pred: (lower: string) => boolean) =>
      testResultMeta.find((m) => pred(m.parameter_name.toLowerCase()));

    const wbcMeta = findMetaByName((n) => n.includes('total wbc'));
    const eosMeta = findMetaByName((n) => n.startsWith('eosinophil') && !n.includes('circulating'));
    const circEosMeta = findMetaByName((n) => n.includes('circulating eosinophil'));

    if (wbcMeta && eosMeta && circEosMeta) {
      const wbcRaw = (submittedMap.get(wbcMeta.parameter_id) || '').replace(/,/g, '').trim();
      const eosRaw = (submittedMap.get(eosMeta.parameter_id) || '').replace(/,/g, '').trim();
      const wbcNum = wbcRaw === '' ? Number.NaN : Number(wbcRaw);
      const eosNum = eosRaw === '' ? Number.NaN : Number(eosRaw);

      if (Number.isFinite(wbcNum) && Number.isFinite(eosNum) && wbcNum >= 0 && eosNum >= 0) {
        const calculated = Math.round(((wbcNum * eosNum) / 100) * 100) / 100;
        submittedMap.set(circEosMeta.parameter_id, String(calculated));
      } else {
        submittedMap.set(circEosMeta.parameter_id, '');
      }
    }

    const hbMeta = findMetaByName((n) => n === 'hemoglobin (hb)' || n === 'hemoglobin' || n === 'hb' || (n.includes('hemoglobin') && !n.includes('hba1c') && !n.includes('glycated') && !n.includes('occult')));
    const pcvMeta = findMetaByName((n) => /\bpcv\b/.test(n) || /\bhct\b/.test(n) || n.includes('packed cell volume') || n.includes('hematocrit'));
    const rbcMeta = findMetaByName((n) => (n.includes('total rbc') || /\brbc\b/.test(n)) && !n.includes('urine'));
    const mcvMeta = findMetaByName((n) => /\bmcv\b/.test(n) || n.includes('mean corpuscular volume'));
    const mchMeta = findMetaByName((n) => (/\bmch\b/.test(n) || (n.includes('mean corpuscular hemoglobin') && !n.includes('concentration'))) && !n.includes('mchc'));
    const mchcMeta = findMetaByName((n) => /\bmchc\b/.test(n) || n.includes('mean corpuscular hemoglobin concentration'));

    if (hbMeta || pcvMeta || rbcMeta) {
      const parseNum = (meta?: { parameter_id: number }) => {
        if (!meta) return Number.NaN;
        const raw = (submittedMap.get(meta.parameter_id) || '').replace(/,/g, '').trim();
        if (!raw) return Number.NaN;
        const val = Number(raw);
        return Number.isFinite(val) ? val : Number.NaN;
      };
      const hbNum = parseNum(hbMeta);
      const pcvNum = parseNum(pcvMeta);
      const rbcNum = parseNum(rbcMeta);

      if (mcvMeta && !(submittedMap.get(mcvMeta.parameter_id) || '').trim() && Number.isFinite(pcvNum) && pcvNum > 0 && Number.isFinite(rbcNum) && rbcNum > 0) {
        submittedMap.set(mcvMeta.parameter_id, String(Math.round(((pcvNum * 10) / rbcNum) * 100) / 100));
      }
      if (mchMeta && !(submittedMap.get(mchMeta.parameter_id) || '').trim() && Number.isFinite(hbNum) && hbNum > 0 && Number.isFinite(rbcNum) && rbcNum > 0) {
        submittedMap.set(mchMeta.parameter_id, String(Math.round(((hbNum * 10) / rbcNum) * 100) / 100));
      }
      if (mchcMeta && !(submittedMap.get(mchcMeta.parameter_id) || '').trim() && Number.isFinite(hbNum) && hbNum > 0 && Number.isFinite(pcvNum) && pcvNum > 0) {
        submittedMap.set(mchcMeta.parameter_id, String(Math.round(((hbNum / pcvNum) * 100) * 100) / 100));
      }
    }

    const diffMeta = testResultMeta.filter((m) => {
      const n = m.parameter_name.toLowerCase();
      return (
        n.startsWith('neutrophil') ||
        n.startsWith('lymphocyte') ||
        n.startsWith('monocyte') ||
        (n.startsWith('eosinophil') && !n.includes('circulating')) ||
        n.startsWith('basophil')
      );
    });

    if (nextStatus === 'Ready' && diffMeta.length >= 4) {
      let diffSum = 0;
      let hasInvalidNumber = false;
      for (const dm of diffMeta) {
        const raw = (submittedMap.get(dm.parameter_id) || '').replace(/,/g, '').trim();
        if (raw !== '') {
          const num = Number(raw);
          if (!Number.isFinite(num) || num < 0) {
            hasInvalidNumber = true;
            break;
          }
          diffSum += num;
        }
      }
      const roundedDiff = Math.round(diffSum * 100) / 100;
      if (hasInvalidNumber || Math.abs(diffSum - 100) > 0.01) {
        throw new StoreError(
          400,
          hasInvalidNumber
            ? 'Differential Count contains an invalid value. All percentages must be valid numbers totaling 100%.'
            : `Differential Count total is ${roundedDiff}%. Total differential count must equal 100% before marking the CBC report Ready.`
        );
      }
    }

    const getParam = db.prepare(`SELECT * FROM test_parameters WHERE id = ?`);
    const updResult = db.prepare(
      `UPDATE test_results SET result_value = ?, reference_range_text = ?, flag = ? WHERE invoice_test_id = ? AND parameter_id = ?`
    );
    const insMissingResult = db.prepare(
      `INSERT INTO test_results (invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    db.transaction(() => {
      for (const [parameterId, value] of submittedMap.entries()) {
        const param = getParam.get(parameterId) as
          | {
              name: string;
              unit: string;
              sort_order: number;
              input_type: string;
              abnormal_values: string;
              normal_text: string;
              min_male: number | null;
              max_male: number | null;
              min_female: number | null;
              max_female: number | null;
              min_child: number | null;
              max_child: number | null;
              min_newborn: number | null;
              max_newborn: number | null;
            }
          | undefined;

        let flag = 'Normal';
        let rangeLabel = '';
        if (param) {
          const evalRes = evaluateResultFlag(
            String(value ?? ''),
            param,
            item.gender,
            item.age_years,
            item.age_months,
            item.age_days
          );
          flag = evalRes.flag;
          rangeLabel = evalRes.rangeLabel;
        }
        const updInfo = updResult.run(String(value ?? '').trim(), rangeLabel, flag, payload.invoiceTestId, parameterId);
        if (updInfo.changes === 0 && param) {
          insMissingResult.run(
            payload.invoiceTestId,
            parameterId,
            param.name,
            param.unit || '',
            String(value ?? '').trim(),
            rangeLabel,
            flag,
            param.sort_order ?? 1
          );
        }
      }

      const verifiedAt = nextStatus === 'Verified' || nextStatus === 'Ready' ? item.verified_at || nowTs : null;
      const readyAt = nextStatus === 'Ready' ? item.ready_at || nowTs : null;
      const verifier = payload.verifiedBy?.trim() || sqliteGetSetting('technologist_name') || 'Medical Technologist';
      const nextConsultantName =
        payload.consultantName !== undefined ? payload.consultantName.trim() : item.consultant_name || '';
      const nextConsultantTitle =
        payload.consultantTitle !== undefined ? payload.consultantTitle.trim() : item.consultant_title || '';

      db.prepare(
        `UPDATE invoice_tests SET status = ?, verified_at = ?, ready_at = ?, verified_by = ?, consultant_name = ?, consultant_title = ? WHERE id = ?`
      ).run(
        nextStatus,
        verifiedAt,
        readyAt,
        nextStatus === 'Verified' || nextStatus === 'Ready' ? verifier : '',
        nextConsultantName,
        nextConsultantTitle,
        payload.invoiceTestId
      );
    })();

    const detail = await this.getLabTestDetail(payload.invoiceTestId);
    if (detail) return detail;
    const updatedResults = db
      .prepare(`SELECT * FROM test_results WHERE invoice_test_id = ? ORDER BY sort_order ASC, id ASC`)
      .all(payload.invoiceTestId);
    const updatedItem = db.prepare(`SELECT * FROM invoice_tests WHERE id = ?`).get(payload.invoiceTestId);
    return { item: updatedItem, results: updatedResults };
  }

  async listExpenses(
    from: string,
    to: string
  ): Promise<{ from: string; to: string; expenses: unknown[]; total: number }> {
    const expenses = db
      .prepare(`SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC`)
      .all(from, to) as Array<{ amount: number }>;
    const total = expenses.reduce((s, e) => s + Number(e.amount), 0);
    return { from, to, expenses, total };
  }

  async createExpense(payload: {
    title: string;
    category?: string;
    amount: number;
    expense_date?: string;
    note?: string;
  }): Promise<{ id: number }> {
    const info = db
      .prepare('INSERT INTO expenses (title, category, amount, expense_date, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        payload.title.trim(),
        payload.category?.trim() || 'General',
        Number(payload.amount),
        payload.expense_date || getTodayDateStr(),
        payload.note?.trim() || '',
        getLocalTimestampStr()
      );
    return { id: Number(info.lastInsertRowid) };
  }

  async deleteExpense(id: number): Promise<void> {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  }

  async listReagents(): Promise<unknown[]> {
    return db.prepare(`SELECT * FROM reagents ORDER BY expiry_date ASC, id DESC`).all();
  }

  async createReagent(payload: {
    name: string;
    linked_test_id?: number | null;
    linked_test_name?: string;
    linked_parameter_id?: number | null;
    linked_parameter_name?: string;
    total_tests: number;
    remaining_tests: number;
    expiry_date: string;
    low_stock_threshold?: number;
    createdBy?: string;
  }): Promise<Record<string, unknown>> {
    const cleanName = payload.name.trim();
    if (!cleanName) {
      throw new StoreError(400, 'Reagent name is required.');
    }
    const totalTests = Math.max(1, Math.round(Number(payload.total_tests || 0)));
    const remainingTests = Math.max(0, Math.round(Number(payload.remaining_tests ?? totalTests)));
    const lowStockThreshold = Math.max(0, Math.round(Number(payload.low_stock_threshold ?? 5)));
    const expiryDate = String(payload.expiry_date || '').trim();
    if (!expiryDate) {
      throw new StoreError(400, 'Expiry date is required.');
    }
    const linkedTestId =
      payload.linked_test_id !== undefined && payload.linked_test_id !== null && Number(payload.linked_test_id) > 0
        ? Number(payload.linked_test_id)
        : null;
    const linkedTestName = payload.linked_test_name?.trim() || '';
    const linkedParamId =
      payload.linked_parameter_id !== undefined &&
      payload.linked_parameter_id !== null &&
      Number(payload.linked_parameter_id) > 0
        ? Number(payload.linked_parameter_id)
        : null;
    const linkedParamName = payload.linked_parameter_name?.trim() || '';
    const nowTs = getLocalTimestampStr();
    const info = db
      .prepare(
        `INSERT INTO reagents (
           name, linked_test_id, linked_test_name, linked_parameter_id, linked_parameter_name,
           total_tests, remaining_tests, expiry_date, low_stock_threshold, created_by, updated_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cleanName,
        linkedTestId,
        linkedTestName,
        linkedParamId,
        linkedParamName,
        totalTests,
        remainingTests,
        expiryDate,
        lowStockThreshold,
        payload.createdBy?.trim() || 'Staff',
        nowTs,
        nowTs
      );
    const created = db.prepare(`SELECT * FROM reagents WHERE id = ?`).get(Number(info.lastInsertRowid)) as Record<
      string,
      unknown
    >;
    return created;
  }

  async adjustReagentStock(id: number, delta: number): Promise<Record<string, unknown>> {
    const existing = db.prepare(`SELECT * FROM reagents WHERE id = ?`).get(id) as
      | { remaining_tests: number; [k: string]: unknown }
      | undefined;
    if (!existing) {
      throw new StoreError(404, 'Reagent inventory item not found.');
    }
    const nextRemaining = Math.max(0, Math.round(Number(existing.remaining_tests || 0) + Number(delta || 0)));
    const updatedAt = getLocalTimestampStr();
    db.prepare(`UPDATE reagents SET remaining_tests = ?, updated_at = ? WHERE id = ?`).run(
      nextRemaining,
      updatedAt,
      id
    );
    return {
      ...existing,
      remaining_tests: nextRemaining,
      updated_at: updatedAt,
    };
  }

  async deleteReagent(id: number): Promise<void> {
    db.prepare('DELETE FROM reagents WHERE id = ?').run(id);
  }

  private getCumulativeCashBalanceBefore(cutoffDate: string): number {
    const revRow = db
      .prepare(
        `SELECT COALESCE(SUM(net_total - commission_amount), 0) as amt
         FROM invoices
         WHERE substr(created_at, 1, 10) < ?`
      )
      .get(cutoffDate) as { amt: number };

    const otherRow = db
      .prepare(`SELECT COALESCE(SUM(amount), 0) as amt FROM other_revenues WHERE revenue_date < ?`)
      .get(cutoffDate) as { amt: number };

    const expRow = db
      .prepare(`SELECT COALESCE(SUM(amount), 0) as amt FROM expenses WHERE expense_date < ?`)
      .get(cutoffDate) as { amt: number };

    return roundCurrency(
      Number(revRow.amt || 0) +
        Number(otherRow.amt || 0) -
        Number(expRow.amt || 0)
    );
  }

  async getBalanceLedger(from: string, to: string): Promise<Record<string, unknown>> {
    const today = getTodayDateStr();
    const cleanFrom = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : `${today.slice(0, 7)}-01`;
    let cleanTo = /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : today;
    if (cleanTo < cleanFrom) cleanTo = cleanFrom;

    const isWithdrawalCat = (cat: string) => {
      const lower = (cat || '').toLowerCase();
      return (
        lower.includes('withdrawal') ||
        lower.includes('proprietor draw') ||
        lower.includes('owner draw')
      );
    };

    const priorOpeningBalance = this.getCumulativeCashBalanceBefore(cleanFrom);

    // 1. Lab Test Revenue in [cleanFrom, cleanTo] = Total Revenue (Net Billed - Doctor Commission)
    const revByDateRows = db
      .prepare(
        `SELECT substr(created_at, 1, 10) as d,
                COALESCE(SUM(net_total - commission_amount), 0) as amt,
                COUNT(*) as cnt
         FROM invoices
         WHERE substr(created_at, 1, 10) BETWEEN ? AND ?
         GROUP BY substr(created_at, 1, 10)`
      )
      .all(cleanFrom, cleanTo) as Array<{ d: string; amt: number; cnt: number }>;

    const labRevMap = new Map<string, number>();
    const labCountMap = new Map<string, number>();
    for (const r of revByDateRows) {
      labRevMap.set(r.d, roundCurrency((labRevMap.get(r.d) || 0) + Number(r.amt || 0)));
      labCountMap.set(r.d, (labCountMap.get(r.d) || 0) + Number(r.cnt || 0));
    }

    // 2. Other Revenues in [cleanFrom, cleanTo]
    const otherRevenues = db
      .prepare(
        `SELECT * FROM other_revenues
         WHERE revenue_date BETWEEN ? AND ?
         ORDER BY revenue_date DESC, id DESC`
      )
      .all(cleanFrom, cleanTo) as Array<{
      id: number;
      source: string;
      category: string;
      amount: number;
      revenue_date: string;
      note: string;
      created_by: string;
      created_at: string;
    }>;

    const otherRevMap = new Map<string, number>();
    const otherCountMap = new Map<string, number>();
    for (const o of otherRevenues) {
      otherRevMap.set(o.revenue_date, roundCurrency((otherRevMap.get(o.revenue_date) || 0) + Number(o.amount || 0)));
      otherCountMap.set(o.revenue_date, (otherCountMap.get(o.revenue_date) || 0) + 1);
    }

    // 3. Expenses & Owner Withdrawals in [cleanFrom, cleanTo]
    const expenses = db
      .prepare(
        `SELECT * FROM expenses
         WHERE expense_date BETWEEN ? AND ?
         ORDER BY expense_date DESC, id DESC`
      )
      .all(cleanFrom, cleanTo) as Array<{
      id: number;
      title: string;
      category: string;
      amount: number;
      expense_date: string;
      note: string;
      created_by: string;
      created_at: string;
    }>;

    const opExpMap = new Map<string, number>();
    const withdrawMap = new Map<string, number>();
    const expCountMap = new Map<string, number>();
    for (const ex of expenses) {
      const amt = Number(ex.amount || 0);
      if (isWithdrawalCat(ex.category)) {
        withdrawMap.set(ex.expense_date, roundCurrency((withdrawMap.get(ex.expense_date) || 0) + amt));
      } else {
        opExpMap.set(ex.expense_date, roundCurrency((opExpMap.get(ex.expense_date) || 0) + amt));
      }
      expCountMap.set(ex.expense_date, (expCountMap.get(ex.expense_date) || 0) + 1);
    }

    // Build chronological date list (every day up to 400 days; active dates if wider)
    const dates: string[] = [];
    let cursor = cleanFrom;
    while (cursor <= cleanTo && dates.length <= 400) {
      dates.push(cursor);
      cursor = addDaysToIsoDate(cursor, 1);
    }
    if (dates.length > 400) {
      const activeSet = new Set<string>([
        cleanFrom,
        cleanTo,
        ...labRevMap.keys(),
        ...otherRevMap.keys(),
        ...opExpMap.keys(),
        ...withdrawMap.keys(),
      ]);
      dates.length = 0;
      dates.push(...Array.from(activeSet).filter((d) => d >= cleanFrom && d <= cleanTo).sort());
    }

    let runningBalance = priorOpeningBalance;
    let periodLabTotal = 0;
    let periodOtherTotal = 0;
    let periodOpExpTotal = 0;
    let periodWithdrawTotal = 0;

    const rows = dates.map((d) => {
      const openingBalance = roundCurrency(runningBalance);
      const labRevenue = roundCurrency(labRevMap.get(d) || 0);
      const otherRevenue = roundCurrency(otherRevMap.get(d) || 0);
      const totalAvailableCash = roundCurrency(openingBalance + labRevenue + otherRevenue);
      const operationalExpenses = roundCurrency(opExpMap.get(d) || 0);
      const ownerWithdrawals = roundCurrency(withdrawMap.get(d) || 0);
      const expensesAndWithdrawals = roundCurrency(operationalExpenses + ownerWithdrawals);
      const closingBalance = roundCurrency(totalAvailableCash - expensesAndWithdrawals);
      const netDayChange = roundCurrency(labRevenue + otherRevenue - expensesAndWithdrawals);

      runningBalance = closingBalance;
      periodLabTotal += labRevenue;
      periodOtherTotal += otherRevenue;
      periodOpExpTotal += operationalExpenses;
      periodWithdrawTotal += ownerWithdrawals;

      return {
        date: d,
        openingBalance,
        labRevenue,
        otherRevenue,
        totalAvailableCash,
        operationalExpenses,
        ownerWithdrawals,
        expensesAndWithdrawals,
        closingBalance,
        netDayChange,
        labPaymentsCount: labCountMap.get(d) || 0,
        otherRevenuesCount: otherCountMap.get(d) || 0,
        expensesCount: expCountMap.get(d) || 0,
      };
    });

    // Today's live cash summary (always accurate regardless of selected filter range)
    const todayOpeningBalance =
      cleanFrom === today ? priorOpeningBalance : this.getCumulativeCashBalanceBefore(today);

    const todayRevRow = db
      .prepare(
        `SELECT COALESCE(SUM(net_total - commission_amount), 0) as amt
         FROM invoices
         WHERE substr(created_at, 1, 10) = ?`
      )
      .get(today) as { amt: number };
    const todayOtherRow = db
      .prepare(`SELECT COALESCE(SUM(amount), 0) as amt FROM other_revenues WHERE revenue_date = ?`)
      .get(today) as { amt: number };
    const todayExpensesRows = db
      .prepare(`SELECT category, amount FROM expenses WHERE expense_date = ?`)
      .all(today) as Array<{ category: string; amount: number }>;

    const todayLabRevenue = roundCurrency(Number(todayRevRow.amt || 0));
    const todayOtherRevenue = roundCurrency(Number(todayOtherRow.amt || 0));
    const todayTotalInflow = roundCurrency(todayLabRevenue + todayOtherRevenue);
    const todayTotalAvailable = roundCurrency(todayOpeningBalance + todayTotalInflow);

    let todayOperationalExpenses = 0;
    let todayOwnerWithdrawals = 0;
    for (const ex of todayExpensesRows) {
      if (isWithdrawalCat(ex.category)) {
        todayOwnerWithdrawals += Number(ex.amount || 0);
      } else {
        todayOperationalExpenses += Number(ex.amount || 0);
      }
    }
    todayOperationalExpenses = roundCurrency(todayOperationalExpenses);
    todayOwnerWithdrawals = roundCurrency(todayOwnerWithdrawals);
    const todayTotalExpensesAndWithdrawals = roundCurrency(todayOperationalExpenses + todayOwnerWithdrawals);
    const todayClosingBalance = roundCurrency(todayTotalAvailable - todayTotalExpensesAndWithdrawals);

    const periodTotalInflow = roundCurrency(periodLabTotal + periodOtherTotal);
    const periodTotalExp = roundCurrency(periodOpExpTotal + periodWithdrawTotal);

    return {
      from: cleanFrom,
      to: cleanTo,
      today,
      priorOpeningBalance,
      todaySummary: {
        date: today,
        openingBalance: todayOpeningBalance,
        labRevenue: todayLabRevenue,
        otherRevenue: todayOtherRevenue,
        totalInflow: todayTotalInflow,
        totalAvailable: todayTotalAvailable,
        operationalExpenses: todayOperationalExpenses,
        ownerWithdrawals: todayOwnerWithdrawals,
        totalExpensesAndWithdrawals: todayTotalExpensesAndWithdrawals,
        closingBalance: todayClosingBalance,
      },
      periodTotals: {
        openingBalance: priorOpeningBalance,
        labRevenue: roundCurrency(periodLabTotal),
        otherRevenue: roundCurrency(periodOtherTotal),
        totalInflow: periodTotalInflow,
        operationalExpenses: roundCurrency(periodOpExpTotal),
        ownerWithdrawals: roundCurrency(periodWithdrawTotal),
        totalExpensesAndWithdrawals: periodTotalExp,
        netChange: roundCurrency(periodTotalInflow - periodTotalExp),
        closingBalance: roundCurrency(runningBalance),
      },
      rows,
      otherRevenues,
      expenses,
    };
  }

  async createOtherRevenue(payload: {
    source: string;
    category?: string;
    amount: number;
    revenue_date?: string;
    note?: string;
    createdBy?: string;
  }): Promise<{ id: number }> {
    const cleanSource = (payload.source || '').trim();
    const cleanAmount = roundCurrency(Number(payload.amount || 0));
    if (!cleanSource || !Number.isFinite(cleanAmount) || cleanAmount <= 0) {
      throw new StoreError(400, 'Source description and positive amount are required.');
    }
    const cleanDate =
      payload.revenue_date && /^\d{4}-\d{2}-\d{2}$/.test(payload.revenue_date)
        ? payload.revenue_date
        : getTodayDateStr();

    const info = db
      .prepare(
        `INSERT INTO other_revenues (source, category, amount, revenue_date, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cleanSource,
        payload.category?.trim() || 'Other Income',
        cleanAmount,
        cleanDate,
        payload.note?.trim() || '',
        payload.createdBy?.trim() || 'Admin',
        getLocalTimestampStr()
      );
    return { id: Number(info.lastInsertRowid) };
  }

  async deleteOtherRevenue(id: number): Promise<void> {
    db.prepare('DELETE FROM other_revenues WHERE id = ?').run(id);
  }

  async findPatientByUid(normalizedUid: string) {
    const row = db
      .prepare(
        `SELECT id, patient_uid, name, age_years, age_months, age_days, gender, mobile, address, portal_password_hash, created_at
         FROM patients WHERE UPPER(patient_uid) = ?`
      )
      .get(normalizedUid) as
      | {
          id: number;
          patient_uid: string;
          name: string;
          age_years: number;
          age_months: number;
          age_days: number;
          gender: string;
          mobile: string;
          address: string;
          portal_password_hash: string;
          created_at: string;
        }
      | undefined;
    return row || null;
  }

  async findPatientPublicById(patientId: number): Promise<Record<string, unknown> | null> {
    const row = db
      .prepare(
        `SELECT id, patient_uid, name, age_years, age_months, age_days, gender, mobile, address, created_at
         FROM patients WHERE id = ?`
      )
      .get(patientId) as Record<string, unknown> | undefined;
    return row || null;
  }

  async findPatientByQrSecret(patientId: number, qrSecret: string): Promise<Record<string, unknown> | null> {
    const row = db
      .prepare(
        `SELECT id, patient_uid, name, age_years, age_months, age_days, gender, mobile, address, qr_secret, created_at
         FROM patients WHERE id = ?`
      )
      .get(patientId) as (Record<string, unknown> & { qr_secret?: string }) | undefined;
    if (!row || !verifyQrSecretMatch(row.qr_secret, qrSecret)) {
      return null;
    }
    const { qr_secret: _removed, ...publicPatient } = row;
    return publicPatient;
  }

  async getPatientPortalProfile(patientId: number): Promise<{
    patient: Record<string, unknown>;
    archive: unknown[];
  } | null> {
    const patient = await this.findPatientPublicById(patientId);
    if (!patient) return null;

    const visits = db
      .prepare(
        `SELECT i.id as invoice_id, i.invoice_no, i.created_at, i.net_total, i.paid_amount, i.due_amount, i.payment_status,
                d.name as doctor_name, d.degree as doctor_degree,
                (SELECT COUNT(*) FROM invoice_tests it WHERE it.invoice_id = i.id) as total_tests,
                (SELECT COUNT(*) FROM invoice_tests it WHERE it.invoice_id = i.id AND it.status = 'Ready') as ready_tests,
                (SELECT COUNT(*) FROM test_results tr
                 JOIN invoice_tests it2 ON it2.id = tr.invoice_test_id
                 WHERE it2.invoice_id = i.id AND tr.flag != 'Normal' AND tr.result_value != '') as abnormal_count
         FROM invoices i
         LEFT JOIN doctors d ON d.id = i.doctor_id
         WHERE i.patient_id = ?
         ORDER BY i.created_at DESC, i.id DESC`
      )
      .all(patientId) as Array<{ invoice_id: number; [key: string]: unknown }>;

    const testsStmt = db.prepare(
      `SELECT id, test_name, category_name, sample_type, status, collected_at, verified_at, ready_at
       FROM invoice_tests
       WHERE invoice_id = ?
       ORDER BY id ASC`
    );

    const archive = visits.map((v) => ({
      ...v,
      tests: testsStmt.all(v.invoice_id),
    }));

    return { patient, archive };
  }

  async getPatientReportIfOwned(invoiceId: number, patientId: number): Promise<Record<string, unknown> | null> {
    const owns = db.prepare(`SELECT id FROM invoices WHERE id = ? AND patient_id = ?`).get(invoiceId, patientId);
    if (!owns) return null;
    return this.getFullInvoice(invoiceId, false, false);
  }

  async findDoctorByPortalUsername(normalizedUsername: string) {
    const row = db
      .prepare(
        `SELECT id, name, degree, hospital, mobile, commission_pct,
                portal_username, portal_password_hash, portal_enabled, is_active,
                last_commission_paid_up_to
         FROM doctors
         WHERE LOWER(portal_username) = ? AND is_active = 1`
      )
      .get(normalizedUsername.trim().toLowerCase()) as
      | {
          id: number;
          name: string;
          degree: string;
          hospital: string;
          mobile: string;
          commission_pct: number;
          portal_username: string;
          portal_password_hash: string;
          portal_enabled: number;
          is_active: number;
          last_commission_paid_up_to: string;
        }
      | undefined;
    return row || null;
  }

  async findDoctorPortalProfileById(doctorId: number): Promise<Record<string, unknown> | null> {
    const row = db
      .prepare(
        `SELECT id, name, degree, hospital, mobile, commission_pct,
                portal_username, portal_enabled, is_active, last_commission_paid_up_to
         FROM doctors
         WHERE id = ? AND is_active = 1`
      )
      .get(doctorId) as Record<string, unknown> | undefined;
    return row || null;
  }

  async getDoctorPortalDashboard(doctorId: number, days = 30): Promise<Record<string, unknown> | null> {
    const doctor = await this.findDoctorPortalProfileById(doctorId);
    if (!doctor || Number(doctor.portal_enabled ?? 1) === 0) return null;

    const clampedDays = Math.min(31, Math.max(1, Math.round(Number(days || 30))));
    const to = getTodayDateStr();
    const from = addDaysToIsoDate(to, -clampedDays);
    const lastPaidUpTo = String(doctor.last_commission_paid_up_to || '').trim();

    const rows = db
      .prepare(
        `SELECT i.id as invoice_id, i.invoice_no, i.created_at,
                i.subtotal, i.discount_type, i.discount_value, i.discount_amount, i.discount_pct,
                i.doctor_less_percent, i.doctor_less_amount, i.flat_discount_amount,
                i.net_total, i.paid_amount, i.due_amount, i.payment_status,
                i.commission_type, i.commission_value, i.commission_pct, i.commission_amount,
                i.commission_paid, i.commission_paid_at,
                p.patient_uid, p.name as patient_name, p.age_years, p.age_months, p.age_days,
                p.gender, p.mobile as patient_mobile
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         WHERE i.doctor_id = ? AND substr(i.created_at, 1, 10) BETWEEN ? AND ?
         ORDER BY i.created_at DESC, i.id DESC`
      )
      .all(doctorId, from, to) as Array<{
      invoice_id: number;
      invoice_no: string;
      created_at: string;
      subtotal: number;
      discount_type: string;
      discount_value: number;
      discount_amount: number;
      discount_pct: number;
      doctor_less_percent?: number;
      doctor_less_amount?: number;
      flat_discount_amount?: number;
      net_total: number;
      paid_amount: number;
      due_amount: number;
      payment_status: string;
      commission_type: string;
      commission_value: number;
      commission_pct: number;
      commission_amount: number;
      commission_paid: number;
      commission_paid_at: string;
      patient_uid: string;
      patient_name: string;
      age_years: number;
      age_months: number;
      age_days: number;
      gender: string;
      patient_mobile: string;
    }>;

    const testsStmt = db.prepare(
      `SELECT it.id, it.test_name, it.category_name, it.sample_type, it.status,
              it.collected_at, it.verified_at, it.ready_at,
              (SELECT COUNT(*) FROM test_results tr
               WHERE tr.invoice_test_id = it.id AND tr.flag != 'Normal' AND tr.result_value != '') as abnormal_count
       FROM invoice_tests it
       WHERE it.invoice_id = ?
       ORDER BY it.id ASC`
    );

    let readyReportsCount = 0;
    let pendingReportsCount = 0;
    let totalChargedGross = 0;
    let totalDoctorLess = 0;
    let totalFlatDiscount = 0;
    let totalDiscount = 0;
    let totalNetCharged = 0;
    let totalCommission = 0;
    let unpaidCommission = 0;
    let paidCommission = 0;

    const patients = rows.map((r) => {
      const tests = testsStmt.all(r.invoice_id) as Array<{
        id: number;
        test_name: string;
        category_name: string;
        sample_type: string;
        status: string;
        collected_at: string;
        verified_at: string | null;
        ready_at: string | null;
        abnormal_count: number;
      }>;
      const totalTests = tests.length;
      const readyTests = tests.filter((t) => t.status === 'Ready').length;
      const abnormalCount = tests.reduce((acc, t) => acc + Number(t.abnormal_count || 0), 0);
      const invDate = String(r.created_at || '').slice(0, 10);
      const isCommissionPaid = r.commission_paid === 1 || (Boolean(lastPaidUpTo) && invDate <= lastPaidUpTo);
      const discountPct =
        Number(r.discount_pct) > 0 || r.discount_amount === 0
          ? Number(r.discount_pct || 0)
          : r.subtotal > 0
          ? roundCurrency((r.discount_amount / r.subtotal) * 100)
          : 0;
      const breakdown = resolveInvoiceDiscountBreakdown(r);

      if (totalTests > 0 && readyTests === totalTests) {
        readyReportsCount += 1;
      } else {
        pendingReportsCount += 1;
      }
      totalChargedGross = roundCurrency(totalChargedGross + Number(r.subtotal || 0));
      totalDoctorLess = roundCurrency(totalDoctorLess + breakdown.doctorLessAmount);
      totalFlatDiscount = roundCurrency(totalFlatDiscount + breakdown.flatDiscountAmount);
      totalDiscount = roundCurrency(totalDiscount + Number(r.discount_amount || 0));
      totalNetCharged = roundCurrency(totalNetCharged + Number(r.net_total || 0));
      totalCommission = roundCurrency(totalCommission + Number(r.commission_amount || 0));
      if (isCommissionPaid) {
        paidCommission = roundCurrency(paidCommission + Number(r.commission_amount || 0));
      } else {
        unpaidCommission = roundCurrency(unpaidCommission + Number(r.commission_amount || 0));
      }

      return {
        invoice_id: r.invoice_id,
        invoice_no: r.invoice_no,
        created_at: r.created_at,
        patient_uid: r.patient_uid,
        patient_name: r.patient_name,
        age_years: r.age_years,
        age_months: r.age_months,
        age_days: r.age_days,
        gender: r.gender,
        patient_mobile: r.patient_mobile,
        subtotal: r.subtotal,
        discount_type: r.discount_type,
        discount_value: r.discount_value,
        discount_pct: discountPct,
        discount_amount: r.discount_amount,
        doctor_less_percent: breakdown.doctorLessPercent,
        doctor_less_amount: breakdown.doctorLessAmount,
        flat_discount_amount: breakdown.flatDiscountAmount,
        net_total: r.net_total,
        paid_amount: r.paid_amount,
        due_amount: r.due_amount,
        payment_status: r.payment_status,
        commission_type: r.commission_type || 'percent',
        commission_value: Number(r.commission_value ?? r.commission_pct ?? 0),
        commission_pct: r.commission_pct,
        commission_amount: r.commission_amount,
        is_commission_paid: isCommissionPaid,
        total_tests: totalTests,
        ready_tests: readyTests,
        abnormal_count: abnormalCount,
        tests: tests.map(({ abnormal_count: _abn, ...t }) => t),
      };
    });

    return {
      doctor,
      from,
      to,
      summary: {
        totalPatients: patients.length,
        readyReportsCount,
        pendingReportsCount,
        totalChargedGross,
        totalDoctorLess,
        totalFlatDiscount,
        totalDiscount,
        totalNetCharged,
        totalCommission,
        unpaidCommission,
        paidCommission,
      },
      patients,
    };
  }

  async getDoctorReportIfOwned(invoiceId: number, doctorId: number): Promise<Record<string, unknown> | null> {
    const owns = db
      .prepare(`SELECT id FROM invoices WHERE id = ? AND doctor_id = ?`)
      .get(invoiceId, doctorId);
    if (!owns) return null;
    return this.getFullInvoice(invoiceId, false, false);
  }

  async createBackupPayload() {
    const tmpBackup = path.join(os.tmpdir(), `alea_lims_backup_${Date.now()}.db`);
    await db.backup(tmpBackup);
    return {
      type: 'sqlite-file' as const,
      filePath: tmpBackup,
      filename: `alea_diagnostic_backup_${getTodayDateStr()}.db`,
    };
  }
}
