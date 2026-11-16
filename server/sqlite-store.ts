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
  type CreateInvoicePayload,
  type LimsStore,
  type ParamPayload,
  StoreError,
  type TestCommissionOverride,
  type UpdateInvoicePayload,
  type UpdateLabResultsPayload,
} from './store-types.ts';

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
          upsert.run(k, String(updates[k]).trim());
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

    const recentQueue = db
      .prepare(
        `SELECT it.id, it.test_name, it.category_name, it.status, it.collected_at,
                i.id as invoice_id, i.invoice_no, p.patient_uid, p.name as patient_name, p.gender, p.age_years
         FROM invoice_tests it
         JOIN invoices i ON i.id = it.invoice_id
         JOIN patients p ON p.id = i.patient_id
         ORDER BY it.id DESC LIMIT 10`
      )
      .all();

    return {
      todayPatients,
      sampleCollectedCount,
      processingCount,
      verifiedCount,
      pendingTestsCount: sampleCollectedCount + processingCount + verifiedCount,
      readyReportsCount,
      dueInvoicesCount,
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
           COALESCE(SUM(net_total), 0) as netRevenue,
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
      netRevenue: number;
      collectedFromInvoices: number;
      pendingDueInRange: number;
      doctorCommissionPayable: number;
    };

    const dueRecoveredRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as recovered
         FROM due_payments
         WHERE substr(collected_at, 1, 10) BETWEEN ? AND ?`
      )
      .get(from, to) as { recovered: number };

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

    const netCollection = initialCashRow.initialPaid + dueRecoveredRow.recovered;
    const netProfit = netCollection - invoiceAgg.doctorCommissionPayable - expenseRow.totalExpenses;

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

    const recentInvoices = db
      .prepare(
        `SELECT i.*, p.patient_uid, p.name as patient_name, p.mobile as patient_mobile,
                d.name as doctor_name
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         LEFT JOIN doctors d ON d.id = i.doctor_id
         ORDER BY i.id DESC LIMIT 8`
      )
      .all();

    return {
      from,
      to,
      metrics: {
        patientsCount: invoiceAgg.patientsCount,
        totalBilled: invoiceAgg.totalBilled,
        totalDiscount: invoiceAgg.totalDiscount,
        netRevenue: invoiceAgg.netRevenue,
        netCollection,
        dueRecovered: dueRecoveredRow.recovered,
        pendingDueInRange: invoiceAgg.pendingDueInRange,
        doctorCommissionPayable: invoiceAgg.doctorCommissionPayable,
        totalExpenses: expenseRow.totalExpenses,
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
      .all() as Array<{ id: number }>;

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
    parameters?: ParamPayload[];
  }): Promise<{ id: number }> {
    const testCode = payload.code?.trim() || `TST-${Date.now().toString().slice(-4)}`;
    const insTest = db.prepare('INSERT INTO tests (category_id, code, name, price, sample_type) VALUES (?, ?, ?, ?, ?)');
    const insParam = db.prepare(`
      INSERT INTO test_parameters (
        test_id, name, unit, input_type, normal_text, default_value, select_options, abnormal_values,
        min_male, max_male, min_female, max_female, min_child, max_child, min_newborn, max_newborn, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const id = db.transaction(() => {
      const r = insTest.run(payload.category_id, testCode, payload.name.trim(), Number(payload.price), payload.sample_type.trim());
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
      parameters?: ParamPayload[];
    }
  ): Promise<void> {
    const updTest = db.prepare(
      'UPDATE tests SET category_id = ?, code = ?, name = ?, price = ?, sample_type = ?, is_active = ? WHERE id = ?'
    );
    const delParams = db.prepare('DELETE FROM test_parameters WHERE test_id = ?');
    const insParam = db.prepare(`
      INSERT INTO test_parameters (
        test_id, name, unit, input_type, normal_text, default_value, select_options, abnormal_values,
        min_male, max_male, min_female, max_female, min_child, max_child, min_newborn, max_newborn, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      updTest.run(payload.category_id, payload.code?.trim() || '', payload.name.trim(), Number(payload.price), payload.sample_type.trim(), payload.is_active ?? 1, id);
      if (Array.isArray(payload.parameters)) {
        delParams.run(id);
        payload.parameters.forEach((p, idx) => {
          if (!p.name?.trim()) return;
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
            idx + 1
          );
        });
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

  async listDoctors(includeCommission: boolean): Promise<unknown[]> {
    const docs = db
      .prepare(
        `SELECT id, name, degree, hospital, mobile,
                ${
                  includeCommission
                    ? 'commission_pct, last_commission_paid_up_to, last_commission_settled_at, last_commission_paid_amount,'
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
      [key: string]: unknown;
    }>;

    if (!includeCommission) return docs;

    const allInvs = db
      .prepare(`SELECT doctor_id, created_at, commission_amount, commission_paid FROM invoices WHERE doctor_id IS NOT NULL`)
      .all() as Array<{
      doctor_id: number;
      created_at: string;
      commission_amount: number;
      commission_paid: number;
    }>;

    const docMap = new Map(docs.map((d) => [d.id, d]));
    const unpaidStats = new Map<number, { count: number; amount: number }>();
    for (const inv of allInvs) {
      const doc = docMap.get(inv.doctor_id);
      const lastPaidUpTo = String(doc?.last_commission_paid_up_to || '').trim();
      const invDate = String(inv.created_at || '').slice(0, 10);
      const isPaid = inv.commission_paid === 1 || (Boolean(lastPaidUpTo) && invDate <= lastPaidUpTo);
      if (!isPaid) {
        const cur = unpaidStats.get(inv.doctor_id) || { count: 0, amount: 0 };
        cur.count += 1;
        cur.amount = roundCurrency(cur.amount + Number(inv.commission_amount || 0));
        unpaidStats.set(inv.doctor_id, cur);
      }
    }

    return docs.map((d) => {
      const stats = unpaidStats.get(d.id) || { count: 0, amount: 0 };
      return {
        ...d,
        last_commission_paid_up_to: d.last_commission_paid_up_to || '',
        last_commission_settled_at: d.last_commission_settled_at || '',
        last_commission_paid_amount: Number(d.last_commission_paid_amount || 0),
        unpaid_referrals_count: stats.count,
        unpaid_commission_total: stats.amount,
      };
    });
  }

  async createDoctor(payload: {
    name: string;
    degree?: string;
    hospital?: string;
    mobile?: string;
    commission_pct?: number;
  }): Promise<{ id: number }> {
    const info = db
      .prepare('INSERT INTO doctors (name, degree, hospital, mobile, commission_pct) VALUES (?, ?, ?, ?, ?)')
      .run(payload.name.trim(), payload.degree?.trim() || '', payload.hospital?.trim() || '', payload.mobile?.trim() || '', Number(payload.commission_pct || 0));
    return { id: Number(info.lastInsertRowid) };
  }

  async updateDoctor(
    id: number,
    payload: { name: string; degree?: string; hospital?: string; mobile?: string; commission_pct?: number }
  ): Promise<void> {
    db.prepare('UPDATE doctors SET name = ?, degree = ?, hospital = ?, mobile = ?, commission_pct = ? WHERE id = ?').run(
      payload.name.trim(),
      payload.degree?.trim() || '',
      payload.hospital?.trim() || '',
      payload.mobile?.trim() || '',
      Number(payload.commission_pct || 0),
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
                i.discount_amount, i.discount_pct, i.net_total, i.paid_amount, i.due_amount,
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

      return {
        id: i.id,
        invoice_no: i.invoice_no,
        created_at: i.created_at,
        subtotal: i.subtotal,
        discount_type: i.discount_type,
        discount_value: i.discount_value,
        discount_pct: discountPct,
        discount_amount: i.discount_amount,
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
    return db
      .prepare(
        `SELECT i.id, i.invoice_no, i.patient_id, i.doctor_id, i.subtotal, i.discount_type, i.discount_value,
                i.discount_amount,
                CASE WHEN i.discount_pct > 0 OR i.discount_amount = 0 THEN i.discount_pct
                     WHEN i.subtotal > 0 THEN ROUND((i.discount_amount / i.subtotal) * 100, 2)
                     ELSE 0 END as discount_pct,
                i.net_total, i.paid_amount, i.due_amount, i.payment_status,
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
      .all(...params);
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
                i.discount_amount,
                CASE WHEN i.discount_pct > 0 OR i.discount_amount = 0 THEN i.discount_pct
                     WHEN i.subtotal > 0 THEN ROUND((i.discount_amount / i.subtotal) * 100, 2)
                     ELSE 0 END as discount_pct,
                i.net_total, i.paid_amount, i.due_amount, i.payment_status,
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
      const outTest: Record<string, unknown> = {
        ...t,
        results: resultsStmt.all(t.id),
      };
      if (!includeCommission) {
        delete outTest.commission_type;
        delete outTest.commission_value;
        delete outTest.commission_amount;
      }
      return outTest;
    });

    const duePayments = db.prepare(`SELECT * FROM due_payments WHERE invoice_id = ? ORDER BY id ASC`).all(invoiceId);

    return { invoice, tests: enrichedTests, duePayments };
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
    }>;

    if (selectedTests.length === 0) throw new StoreError(400, 'Selected tests were not found.');

    const subtotal = selectedTests.reduce((sum, t) => sum + Number(t.price), 0);
    const dType = payload.discountType === 'percent' ? 'percent' : 'flat';
    const dVal = Math.max(0, Number(payload.discountValue || 0));
    let discountAmount = dType === 'percent' ? (subtotal * dVal) / 100 : dVal;
    discountAmount = Math.min(subtotal, Math.round(discountAmount * 100) / 100);

    const maxStaffPct = Number(sqliteGetSetting('max_staff_discount_pct') || '15');
    const effectivePct = subtotal > 0 ? (discountAmount / subtotal) * 100 : 0;
    if (!payload.isAdmin && effectivePct > maxStaffPct + 0.01) {
      throw new StoreError(
        403,
        `Staff discount limit is ${maxStaffPct}%. Switch to Admin mode to authorize higher discounts.`
      );
    }

    const netTotal = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);
    const discountPct = subtotal > 0 ? roundCurrency((discountAmount / subtotal) * 100) : 0;
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
            net_total, paid_amount, due_amount, payment_status,
            commission_pct, commission_amount, commission_type, commission_value, commission_paid,
            notes, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
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
          netTotal,
          paid,
          due,
          paymentStatus,
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
          commission_type, commission_value, commission_amount, status, collected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sample Collected', ?)`
      );
      const getParams = db.prepare(`SELECT * FROM test_parameters WHERE test_id = ? ORDER BY sort_order ASC, id ASC`);
      const insResult = db.prepare(
        `INSERT INTO test_results (invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const t of selectedTests) {
        const tc = computedComm.perTestMap.get(t.id);
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
          nowTs
        );
        const invoiceTestId = Number(itRes.lastInsertRowid);
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

    const existingTestRows = db
      .prepare('SELECT id, test_id, price, commission_type, commission_value FROM invoice_tests WHERE invoice_id = ?')
      .all(payload.invoiceId) as Array<{
      id: number;
      test_id: number;
      price: number;
      commission_type?: string;
      commission_value?: number;
    }>;
    const existingTestIds = new Set(existingTestRows.map((r) => r.test_id));
    const newTestIds = requestedIds.filter((id) => !existingTestIds.has(id));

    let testsToAdd: Array<{ id: number; name: string; category_name: string; sample_type: string; price: number }> = [];
    if (newTestIds.length > 0) {
      const ph = newTestIds.map(() => '?').join(',');
      testsToAdd = db
        .prepare(
          `SELECT t.*, c.name as category_name FROM tests t JOIN test_categories c ON c.id = t.category_id WHERE t.id IN (${ph}) AND t.is_active = 1`
        )
        .all(...newTestIds) as typeof testsToAdd;
    }

    const newSubtotal =
      existingTestRows.reduce((sum, r) => sum + Number(r.price), 0) +
      testsToAdd.reduce((sum, t) => sum + Number(t.price), 0);

    const dType =
      payload.discountType === 'percent' || payload.discountType === 'flat'
        ? payload.discountType
        : existingInv.discount_type;
    const dVal =
      payload.discountValue !== undefined && payload.discountValue !== null
        ? Math.max(0, Number(payload.discountValue || 0))
        : Number(existingInv.discount_value || 0);

    let discountAmount = dType === 'percent' ? (newSubtotal * dVal) / 100 : dVal;
    discountAmount = Math.min(newSubtotal, Math.round(discountAmount * 100) / 100);

    const discountChanged =
      (payload.discountType !== undefined && payload.discountType !== existingInv.discount_type) ||
      (payload.discountValue !== undefined && Number(payload.discountValue) !== Number(existingInv.discount_value));

    if (discountChanged) {
      const maxStaffPct = Number(sqliteGetSetting('max_staff_discount_pct') || '15');
      const effectivePct = newSubtotal > 0 ? (discountAmount / newSubtotal) * 100 : 0;
      if (!payload.isAdmin && effectivePct > maxStaffPct + 0.01) {
        throw new StoreError(
          403,
          `Staff discount limit is ${maxStaffPct}%. Switch to Admin mode to authorize higher discounts.`
        );
      }
    }

    const netTotal = Math.max(0, Math.round((newSubtotal - discountAmount) * 100) / 100);
    const discountPct = newSubtotal > 0 ? roundCurrency((discountAmount / newSubtotal) * 100) : 0;
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
        : existingTestRows.map((it) => ({
            testId: it.test_id,
            commissionType: it.commission_type === 'flat' ? 'flat' : 'percent',
            commissionValue:
              typeof it.commission_value === 'number' ? it.commission_value : docCommissionPct,
          }));

    const allCombinedTests = [
      ...existingTestRows.map((r) => ({ test_id: r.test_id, price: Number(r.price) })),
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
    const maxCollectable = Math.max(0, Math.round((netTotal - Number(existingInv.paid_amount)) * 100) / 100);
    const appliedExtraPay = Math.min(extraPayRaw, maxCollectable);
    const newPaid = Math.round((Number(existingInv.paid_amount) + appliedExtraPay) * 100) / 100;
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
          commission_type, commission_value, commission_amount, status, collected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sample Collected', ?)`
      );
      const getParams = db.prepare(`SELECT * FROM test_parameters WHERE test_id = ? ORDER BY sort_order ASC, id ASC`);
      const insResult = db.prepare(
        `INSERT INTO test_results (invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const t of testsToAdd) {
        const tc = computedComm.perTestMap.get(t.id);
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
          nowTs
        );
        const invoiceTestId = Number(itRes.lastInsertRowid);
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
      for (const existingIt of existingTestRows) {
        const tc = computedComm.perTestMap.get(existingIt.test_id);
        if (tc) {
          updExistingIt.run(tc.commission_type, tc.commission_value, tc.commission_amount, existingIt.id);
        }
      }

      if (appliedExtraPay > 0) {
        db.prepare(
          `INSERT INTO due_payments (invoice_id, amount, payment_method, note, collected_by, collected_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          payload.invoiceId,
          appliedExtraPay,
          payload.paymentMethod?.trim() || 'Cash',
          testsToAdd.length > 0 ? 'Payment on added tests' : 'Updated invoice payment',
          payload.isAdmin ? 'Admin' : 'Staff',
          nowTs
        );
      }

      db.prepare(
        `UPDATE invoices
         SET doctor_id = ?, subtotal = ?, discount_type = ?, discount_value = ?, discount_amount = ?, discount_pct = ?,
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
    if (payAmt > inv.due_amount + 0.01) {
      throw new StoreError(400, `Payment exceeds current due of ৳${inv.due_amount}.`);
    }

    const newPaid = Math.round((inv.paid_amount + payAmt) * 100) / 100;
    const newDue = Math.max(0, Math.round((inv.net_total - newPaid) * 100) / 100);
    const newStatus = newDue <= 0 ? 'Paid' : 'Partial';
    const nowTs = getLocalTimestampStr();

    db.transaction(() => {
      db.prepare('INSERT INTO due_payments (invoice_id, amount, payment_method, note, collected_by, collected_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        payload.invoiceId,
        payAmt,
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

    db.transaction(() => {
      const invTests = db
        .prepare('SELECT id FROM invoice_tests WHERE invoice_id = ?')
        .all(invoiceId) as Array<{ id: number }>;
      const itIds = invTests.map((it) => it.id);

      if (itIds.length > 0) {
        const placeholders = itIds.map(() => '?').join(',');
        const resDel = db
          .prepare(`DELETE FROM test_results WHERE invoice_test_id IN (${placeholders})`)
          .run(...itIds);
        deletedResultsCount = resDel.changes;
      }

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
      .get(invoiceTestId);

    if (!item) return null;

    const results = db
      .prepare(
        `SELECT tr.*, tp.input_type, tp.select_options, tp.abnormal_values, tp.normal_text,
                tp.min_male, tp.max_male, tp.min_female, tp.max_female, tp.min_child, tp.max_child,
                tp.min_newborn, tp.max_newborn
         FROM test_results tr
         LEFT JOIN test_parameters tp ON tp.id = tr.parameter_id
         WHERE tr.invoice_test_id = ?
         ORDER BY tr.sort_order ASC, tr.id ASC`
      )
      .all(invoiceTestId);

    return { item, results };
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

    db.transaction(() => {
      for (const [parameterId, value] of submittedMap.entries()) {
        const param = getParam.get(parameterId) as
          | {
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
        updResult.run(String(value ?? '').trim(), rangeLabel, flag, payload.invoiceTestId, parameterId);
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
      .prepare('INSERT INTO expenses (title, category, amount, expense_date, note) VALUES (?, ?, ?, ?, ?)')
      .run(
        payload.title.trim(),
        payload.category?.trim() || 'General',
        Number(payload.amount),
        payload.expense_date || getTodayDateStr(),
        payload.note?.trim() || ''
      );
    return { id: Number(info.lastInsertRowid) };
  }

  async deleteExpense(id: number): Promise<void> {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
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
