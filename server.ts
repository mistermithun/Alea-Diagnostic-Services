import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  createAdminToken,
  createPatientToken,
  createStaffToken,
  decryptPortalPassword,
  encryptPortalPassword,
  extractTokenFromRequest,
  generatePortalPassword,
  hashPassword,
  makeRequireAdmin,
  makeRequirePatient,
  makeRequireStaffOrAdmin,
  type PatientTokenPayload,
  verifyAdminToken,
  verifyPassword,
  verifyPatientToken,
  verifyStaffToken,
} from './server/auth.ts';
import {
  db,
  evaluateResultFlag,
  getAllSettings,
  getSetting,
  initDatabase,
  resolveReferenceRange,
} from './server/db.ts';

initDatabase();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.json({ limit: '5mb' }));

const getSecret = () => getSetting('auth_secret');
const requireAdmin = makeRequireAdmin(getSecret);
const requireStaffOrAdmin = makeRequireStaffOrAdmin(getSecret);
const requirePatient = makeRequirePatient(getSecret);

function isAdminRequest(req: express.Request): boolean {
  const token = extractTokenFromRequest(req);
  return verifyAdminToken(token, getSecret()) !== null;
}

function getLanUrls(port: number): string[] {
  const nets = os.networkInterfaces();
  const urls: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

function getTodayDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLocalTimestampStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// System & Lab Branding Info
app.get('/api/system/info', (_req, res) => {
  const settings = getAllSettings();
  res.json({
    settings,
    port: PORT,
    lanUrls: getLanUrls(PORT),
    serverDate: getTodayDateStr(),
  });
});

// Authentication
app.post('/api/auth/admin-login', (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(400).json({ error: 'Password is required.' });
    return;
  }
  const storedHash = getSetting('admin_password_hash');
  if (!verifyPassword(password, storedHash)) {
    res.status(401).json({ error: 'Invalid master password.' });
    return;
  }
  const proprietor = getSetting('proprietor_name') || 'Md. Mishkatur Rahman';
  const token = createAdminToken(getSecret(), proprietor, 24);
  res.json({ token, role: 'admin', adminName: proprietor });
});

app.post('/api/auth/staff-login', (req, res) => {
  const { staffName, password } = req.body as { staffName?: string; password?: string };
  if (!password) {
    res.status(400).json({ error: 'Staff access password is required.' });
    return;
  }
  const storedHash = getSetting('staff_password_hash');
  if (!verifyPassword(password, storedHash)) {
    res.status(401).json({ error: 'Invalid staff password.' });
    return;
  }
  const cleanName = staffName?.trim() || 'Reception & Lab Staff';
  const token = createStaffToken(getSecret(), cleanName, 24);
  res.json({ token, role: 'staff', staffName: cleanName });
});

app.get('/api/auth/verify', (req, res) => {
  const token = extractTokenFromRequest(req);
  const secret = getSecret();
  const adminPayload = verifyAdminToken(token, secret);
  if (adminPayload) {
    res.json({ authenticated: true, isAdmin: true, role: 'admin', name: adminPayload.name });
    return;
  }
  const staffPayload = verifyStaffToken(token, secret);
  if (staffPayload) {
    res.json({ authenticated: true, isAdmin: false, role: 'staff', name: staffPayload.name });
    return;
  }
  res.json({ authenticated: false, isAdmin: false, role: null, name: '' });
});

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };
  if (!currentPassword || !newPassword || newPassword.length < 4) {
    res.status(400).json({ error: 'Current password and new password (min 4 chars) are required.' });
    return;
  }
  const storedHash = getSetting('admin_password_hash');
  if (!verifyPassword(currentPassword, storedHash)) {
    res.status(400).json({ error: 'Current password is incorrect.' });
    return;
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'admin_password_hash',
    hashPassword(newPassword)
  );
  res.json({ success: true });
});

app.post('/api/admin/change-staff-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body as { newPassword?: string };
  if (!newPassword || newPassword.length < 4) {
    res.status(400).json({ error: 'New staff password (min 4 chars) is required.' });
    return;
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'staff_password_hash',
    hashPassword(newPassword)
  );
  res.json({ success: true });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const allowedKeys = [
    'lab_name',
    'lab_address',
    'proprietor_name',
    'lab_phone',
    'max_staff_discount_pct',
    'technologist_name',
    'technologist_title',
    'pathologist_name',
    'pathologist_title',
    'pad_header_margin_in',
    'pad_footer_margin_in',
  ];
  const updates = req.body as Record<string, string | number>;
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const k of allowedKeys) {
      if (updates[k] !== undefined && updates[k] !== null) {
        upsert.run(k, String(updates[k]).trim());
      }
    }
  });
  tx();
  res.json({ settings: getAllSettings() });
});

// Staff-safe Operational Overview
app.get('/api/staff/overview', requireStaffOrAdmin, (_req, res) => {
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
    db.prepare(`SELECT COUNT(*) as c FROM invoice_tests WHERE status = 'Ready' AND substr(collected_at, 1, 10) = ?`).get(today) as { c: number }
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

  res.json({
    todayPatients,
    sampleCollectedCount,
    processingCount,
    verifiedCount,
    pendingTestsCount: sampleCollectedCount + processingCount + verifiedCount,
    readyReportsCount,
    dueInvoicesCount,
    recentQueue,
  });
});

// Admin Dashboard Analytics
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : getTodayDateStr();
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : from;

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

  // Note: paid_amount on invoices already increments when due_payments are recorded.
  // Initial cash collected at invoice creation = paid_amount - sum(due_payments for that invoice).
  // So total cash collected in range = initial payments in range + due_payments collected in range.
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

  res.json({
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
  });
});

// Test Catalog & Parameters
app.get('/api/catalog', requireStaffOrAdmin, (req, res) => {
  const includeInactive = req.query.includeInactive === '1' && isAdminRequest(req);
  const categories = db.prepare('SELECT * FROM test_categories ORDER BY sort_order ASC, id ASC').all();
  const tests = db
    .prepare(
      `SELECT t.*, c.name as category_name
       FROM tests t
       JOIN test_categories c ON c.id = t.category_id
       ${includeInactive ? '' : 'WHERE t.is_active = 1'}
       ORDER BY c.sort_order ASC, t.code ASC, t.id ASC`
    )
    .all() as Array<{
    id: number;
    category_id: number;
    category_name: string;
    code: string;
    name: string;
    price: number;
    sample_type: string;
    is_active: number;
  }>;

  const params = db.prepare('SELECT * FROM test_parameters ORDER BY sort_order ASC, id ASC').all() as Array<{
    id: number;
    test_id: number;
    [key: string]: unknown;
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

  res.json({ categories, tests: enrichedTests });
});

app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Category name is required.' });
    return;
  }
  try {
    const maxSort = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM test_categories').get() as { m: number }).m;
    const info = db.prepare('INSERT INTO test_categories (name, sort_order) VALUES (?, ?)').run(name.trim(), maxSort + 1);
    res.json({ id: Number(info.lastInsertRowid), name: name.trim() });
  } catch {
    res.status(409).json({ error: 'Category already exists.' });
  }
});

app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const testCount = (db.prepare('SELECT COUNT(*) as c FROM tests WHERE category_id = ? AND is_active = 1').get(id) as { c: number }).c;
  if (testCount > 0) {
    res.status(400).json({ error: 'Cannot delete a category with active tests. Remove or move tests first.' });
    return;
  }
  db.prepare('DELETE FROM test_categories WHERE id = ?').run(id);
  res.json({ success: true });
});

interface ParamPayload {
  name: string;
  unit?: string;
  input_type?: 'numeric' | 'text' | 'select';
  normal_text?: string;
  default_value?: string;
  select_options?: string;
  abnormal_values?: string;
  min_male?: number | null;
  max_male?: number | null;
  min_female?: number | null;
  max_female?: number | null;
  min_child?: number | null;
  max_child?: number | null;
}

app.post('/api/admin/tests', requireAdmin, (req, res) => {
  const { category_id, code, name, price, sample_type, parameters } = req.body as {
    category_id: number;
    code: string;
    name: string;
    price: number;
    sample_type: string;
    parameters?: ParamPayload[];
  };

  if (!category_id || !name?.trim() || price === undefined || !sample_type?.trim()) {
    res.status(400).json({ error: 'Category, test name, price, and sample type are required.' });
    return;
  }

  const testCode = code?.trim() || `TST-${Date.now().toString().slice(-4)}`;
  const insTest = db.prepare('INSERT INTO tests (category_id, code, name, price, sample_type) VALUES (?, ?, ?, ?, ?)');
  const insParam = db.prepare(`
    INSERT INTO test_parameters (
      test_id, name, unit, input_type, normal_text, default_value, select_options, abnormal_values,
      min_male, max_male, min_female, max_female, min_child, max_child, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const testId = db.transaction(() => {
    const r = insTest.run(category_id, testCode, name.trim(), Number(price), sample_type.trim());
    const id = Number(r.lastInsertRowid);
    const list: ParamPayload[] =
      parameters && parameters.length > 0
        ? parameters
        : [{ name: name.trim(), unit: '', input_type: 'text', normal_text: '', default_value: '' }];
    list.forEach((p, idx) => {
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
        idx + 1
      );
    });
    return id;
  })();

  res.json({ id: testId });
});

app.put('/api/admin/tests/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { category_id, code, name, price, sample_type, is_active, parameters } = req.body as {
    category_id: number;
    code: string;
    name: string;
    price: number;
    sample_type: string;
    is_active?: number;
    parameters?: ParamPayload[];
  };

  if (!category_id || !name?.trim() || price === undefined || !sample_type?.trim()) {
    res.status(400).json({ error: 'Category, test name, price, and sample type are required.' });
    return;
  }

  const updTest = db.prepare(
    'UPDATE tests SET category_id = ?, code = ?, name = ?, price = ?, sample_type = ?, is_active = ? WHERE id = ?'
  );
  const delParams = db.prepare('DELETE FROM test_parameters WHERE test_id = ?');
  const insParam = db.prepare(`
    INSERT INTO test_parameters (
      test_id, name, unit, input_type, normal_text, default_value, select_options, abnormal_values,
      min_male, max_male, min_female, max_female, min_child, max_child, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    updTest.run(category_id, code?.trim() || '', name.trim(), Number(price), sample_type.trim(), is_active ?? 1, id);
    if (Array.isArray(parameters)) {
      delParams.run(id);
      parameters.forEach((p, idx) => {
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
          idx + 1
        );
      });
    }
  })();

  res.json({ success: true });
});

app.delete('/api/admin/tests/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const usedCount = (db.prepare('SELECT COUNT(*) as c FROM invoice_tests WHERE test_id = ?').get(id) as { c: number }).c;
  if (usedCount > 0) {
    db.prepare('UPDATE tests SET is_active = 0 WHERE id = ?').run(id);
    res.json({ success: true, softDeleted: true });
    return;
  }
  db.prepare('DELETE FROM tests WHERE id = ?').run(id);
  res.json({ success: true });
});

// Referral Doctors
app.get('/api/doctors', requireStaffOrAdmin, (req, res) => {
  const admin = isAdminRequest(req);
  const rows = db
    .prepare(
      `SELECT id, name, degree, hospital, mobile, ${admin ? 'commission_pct,' : ''} is_active, created_at
       FROM doctors WHERE is_active = 1 ORDER BY name ASC`
    )
    .all();
  res.json({ doctors: rows });
});

app.post('/api/admin/doctors', requireAdmin, (req, res) => {
  const { name, degree, hospital, mobile, commission_pct } = req.body as {
    name?: string;
    degree?: string;
    hospital?: string;
    mobile?: string;
    commission_pct?: number;
  };
  if (!name?.trim()) {
    res.status(400).json({ error: 'Doctor name is required.' });
    return;
  }
  const info = db
    .prepare('INSERT INTO doctors (name, degree, hospital, mobile, commission_pct) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), degree?.trim() || '', hospital?.trim() || '', mobile?.trim() || '', Number(commission_pct || 0));
  res.json({ id: Number(info.lastInsertRowid) });
});

app.put('/api/admin/doctors/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { name, degree, hospital, mobile, commission_pct } = req.body as {
    name?: string;
    degree?: string;
    hospital?: string;
    mobile?: string;
    commission_pct?: number;
  };
  if (!name?.trim()) {
    res.status(400).json({ error: 'Doctor name is required.' });
    return;
  }
  db.prepare('UPDATE doctors SET name = ?, degree = ?, hospital = ?, mobile = ?, commission_pct = ? WHERE id = ?').run(
    name.trim(),
    degree?.trim() || '',
    hospital?.trim() || '',
    mobile?.trim() || '',
    Number(commission_pct || 0),
    id
  );
  res.json({ success: true });
});

app.delete('/api/admin/doctors/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE doctors SET is_active = 0 WHERE id = ?').run(id);
  res.json({ success: true });
});

app.get('/api/admin/doctors/:id/statement', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : `${getTodayDateStr().slice(0, 7)}-01`;
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : getTodayDateStr();

  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(id);
  if (!doctor) {
    res.status(404).json({ error: 'Doctor not found.' });
    return;
  }

  const referrals = db
    .prepare(
      `SELECT i.id, i.invoice_no, i.created_at, i.subtotal, i.discount_amount, i.net_total,
              i.paid_amount, i.due_amount, i.commission_pct, i.commission_amount,
              p.patient_uid, p.name as patient_name,
              (SELECT GROUP_CONCAT(it.test_name, ', ') FROM invoice_tests it WHERE it.invoice_id = i.id) as test_names
       FROM invoices i
       JOIN patients p ON p.id = i.patient_id
       WHERE i.doctor_id = ? AND substr(i.created_at, 1, 10) BETWEEN ? AND ?
       ORDER BY i.created_at DESC`
    )
    .all(id, from, to) as Array<{
    subtotal: number;
    discount_amount: number;
    net_total: number;
    paid_amount: number;
    due_amount: number;
    commission_amount: number;
  }>;

  const totals = referrals.reduce(
    (acc, r) => {
      acc.totalPatients += 1;
      acc.totalGross += r.subtotal;
      acc.totalDiscount += r.discount_amount;
      acc.totalNet += r.net_total;
      acc.totalPaid += r.paid_amount;
      acc.totalDue += r.due_amount;
      acc.totalCommission += r.commission_amount;
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
    }
  );

  res.json({ doctor, from, to, referrals, totals });
});

// Patients & Invoices
app.get('/api/invoices', requireStaffOrAdmin, (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const dueOnly = req.query.dueOnly === '1';
  const todayOnly = req.query.todayOnly === '1';
  const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
  const todayStr = getTodayDateStr();

  const conditions: string[] = [];
  const params: unknown[] = [todayStr];

  if (search) {
    conditions.push(`(i.invoice_no LIKE ? OR p.patient_uid LIKE ? OR p.name LIKE ? OR p.mobile LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (dueOnly) {
    conditions.push(`i.due_amount > 0`);
  }
  if (todayOnly) {
    conditions.push(`substr(i.created_at, 1, 10) = ?`);
    params.push(todayStr);
  } else if (date) {
    conditions.push(`substr(i.created_at, 1, 10) = ?`);
    params.push(date);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const admin = isAdminRequest(req);

  const rows = db
    .prepare(
      `SELECT i.id, i.invoice_no, i.patient_id, i.doctor_id, i.subtotal, i.discount_type, i.discount_value,
              i.discount_amount, i.net_total, i.paid_amount, i.due_amount, i.payment_status,
              ${admin ? 'i.commission_pct, i.commission_amount,' : ''}
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

  res.json({ invoices: rows });
});

// Returning Patient Lookup (for Staff/Admin registration)
app.get('/api/patients/search', requireStaffOrAdmin, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.json({ patients: [] });
    return;
  }
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT id, patient_uid, name, age_years, age_months, age_days, gender, mobile, address, created_at
       FROM patients
       WHERE patient_uid LIKE ? OR name LIKE ? OR mobile LIKE ?
       ORDER BY id DESC LIMIT 12`
    )
    .all(like, like, like);
  res.json({ patients: rows });
});

function getFullInvoice(
  invoiceId: number,
  includeCommission: boolean,
  includePortalPassword = true
) {
  const todayStr = getTodayDateStr();
  const invoice = db
    .prepare(
      `SELECT i.id, i.invoice_no, i.patient_id, i.doctor_id, i.subtotal, i.discount_type, i.discount_value,
              i.discount_amount, i.net_total, i.paid_amount, i.due_amount, i.payment_status,
              ${includeCommission ? 'i.commission_pct, i.commission_amount,' : ''}
              i.notes, i.created_by, i.created_at,
              CASE WHEN substr(i.created_at, 1, 10) = ? THEN 1 ELSE 0 END as is_today,
              p.patient_uid, p.name as patient_name, p.age_years, p.age_months, p.age_days, p.gender,
              p.mobile as patient_mobile, p.address as patient_address,
              ${includePortalPassword ? 'p.portal_password_enc,' : ''}
              d.name as doctor_name, d.degree as doctor_degree, d.hospital as doctor_hospital
       FROM invoices i
       JOIN patients p ON p.id = i.patient_id
       LEFT JOIN doctors d ON d.id = i.doctor_id
       WHERE i.id = ?`
    )
    .get(todayStr, invoiceId) as Record<string, unknown> | undefined;

  if (!invoice) return null;

  if (includePortalPassword) {
    const enc = typeof invoice.portal_password_enc === 'string' ? invoice.portal_password_enc : '';
    invoice.patient_portal_password = enc ? decryptPortalPassword(enc, getSecret()) : '';
    delete invoice.portal_password_enc;
  }

  const tests = db
    .prepare(`SELECT * FROM invoice_tests WHERE invoice_id = ? ORDER BY id ASC`)
    .all(invoiceId) as Array<{ id: number; [key: string]: unknown }>;

  const resultsStmt = db.prepare(`SELECT * FROM test_results WHERE invoice_test_id = ? ORDER BY sort_order ASC, id ASC`);
  const enrichedTests = tests.map((t) => ({
    ...t,
    results: resultsStmt.all(t.id),
  }));

  const duePayments = db
    .prepare(`SELECT * FROM due_payments WHERE invoice_id = ? ORDER BY id ASC`)
    .all(invoiceId);

  return {
    invoice,
    tests: enrichedTests,
    duePayments,
  };
}

app.get('/api/invoices/:id', requireStaffOrAdmin, (req, res) => {
  const id = Number(req.params.id);
  const full = getFullInvoice(id, isAdminRequest(req));
  if (!full) {
    res.status(404).json({ error: 'Invoice not found.' });
    return;
  }
  res.json(full);
});

app.post('/api/invoices', requireStaffOrAdmin, (req, res) => {
  const admin = isAdminRequest(req);
  const {
    existingPatientId,
    patient,
    doctorId,
    testIds,
    discountType,
    discountValue,
    paidAmount,
    notes,
  } = req.body as {
    existingPatientId?: number | null;
    patient: {
      name: string;
      ageYears: number;
      ageMonths?: number;
      ageDays?: number;
      gender: 'Male' | 'Female' | 'Other';
      mobile?: string;
      address?: string;
    };
    doctorId?: number | null;
    testIds: number[];
    discountType?: 'percent' | 'flat';
    discountValue?: number;
    paidAmount?: number;
    notes?: string;
  };

  if (!patient?.name?.trim() || !patient?.gender || !Array.isArray(testIds) || testIds.length === 0) {
    res.status(400).json({ error: 'Patient name, gender, and at least one test are required.' });
    return;
  }

  const placeholders = testIds.map(() => '?').join(',');
  const selectedTests = db
    .prepare(
      `SELECT t.*, c.name as category_name
       FROM tests t
       JOIN test_categories c ON c.id = t.category_id
       WHERE t.id IN (${placeholders}) AND t.is_active = 1`
    )
    .all(...testIds) as Array<{
    id: number;
    name: string;
    category_name: string;
    sample_type: string;
    price: number;
  }>;

  if (selectedTests.length === 0) {
    res.status(400).json({ error: 'Selected tests were not found.' });
    return;
  }

  const subtotal = selectedTests.reduce((sum, t) => sum + Number(t.price), 0);
  const dType = discountType === 'percent' ? 'percent' : 'flat';
  const dVal = Math.max(0, Number(discountValue || 0));
  let discountAmount = dType === 'percent' ? (subtotal * dVal) / 100 : dVal;
  discountAmount = Math.min(subtotal, Math.round(discountAmount * 100) / 100);

  // Enforce Staff discount cap
  const maxStaffPct = Number(getSetting('max_staff_discount_pct') || '15');
  const effectivePct = subtotal > 0 ? (discountAmount / subtotal) * 100 : 0;
  if (!admin && effectivePct > maxStaffPct + 0.01) {
    res.status(403).json({
      error: `Staff discount limit is ${maxStaffPct}%. Switch to Admin mode to authorize higher discounts.`,
    });
    return;
  }

  const netTotal = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);
  const paid = Math.min(netTotal, Math.max(0, Math.round(Number(paidAmount || 0) * 100) / 100));
  const due = Math.max(0, Math.round((netTotal - paid) * 100) / 100);
  const paymentStatus = due <= 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Due';

  let commissionPct = 0;
  if (doctorId) {
    const doc = db.prepare('SELECT commission_pct FROM doctors WHERE id = ?').get(doctorId) as { commission_pct: number } | undefined;
    if (doc) commissionPct = Number(doc.commission_pct || 0);
  }
  const commissionAmount = Math.round(((netTotal * commissionPct) / 100) * 100) / 100;

  const nowTs = getLocalTimestampStr();

  const createdInvoiceId = db.transaction(() => {
    let patientId: number;
    if (existingPatientId) {
      const existing = db
        .prepare('SELECT id FROM patients WHERE id = ?')
        .get(existingPatientId) as { id: number } | undefined;
      if (existing) {
        patientId = existing.id;
        db.prepare(
          `UPDATE patients SET name = ?, age_years = ?, age_months = ?, age_days = ?, gender = ?, mobile = ?, address = ? WHERE id = ?`
        ).run(
          patient.name.trim(),
          Number(patient.ageYears || 0),
          Number(patient.ageMonths || 0),
          Number(patient.ageDays || 0),
          patient.gender,
          patient.mobile?.trim() || '',
          patient.address?.trim() || '',
          patientId
        );
      } else {
        patientId = 0;
      }
    } else {
      patientId = 0;
    }

    if (!patientId) {
      const nextPatientSeq = (db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as n FROM patients').get() as { n: number }).n;
      const patientUid = `ALEA-${2600 + nextPatientSeq}`;
      const plainPortalPw = generatePortalPassword();
      const portalHash = hashPassword(plainPortalPw);
      const portalEnc = encryptPortalPassword(plainPortalPw, getSecret());

      const pRes = db
        .prepare(
          `INSERT INTO patients (
            patient_uid, name, age_years, age_months, age_days, gender, mobile, address,
            portal_password_hash, portal_password_enc, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          patientUid,
          patient.name.trim(),
          Number(patient.ageYears || 0),
          Number(patient.ageMonths || 0),
          Number(patient.ageDays || 0),
          patient.gender,
          patient.mobile?.trim() || '',
          patient.address?.trim() || '',
          portalHash,
          portalEnc,
          nowTs
        );
      patientId = Number(pRes.lastInsertRowid);
    }

    const nextInvSeq = (db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as n FROM invoices').get() as { n: number }).n;
    const invoiceNo = `INV-${26000 + nextInvSeq}`;

    const iRes = db
      .prepare(
        `INSERT INTO invoices (
          invoice_no, patient_id, doctor_id, subtotal, discount_type, discount_value, discount_amount,
          net_total, paid_amount, due_amount, payment_status, commission_pct, commission_amount,
          notes, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        invoiceNo,
        patientId,
        doctorId || null,
        subtotal,
        dType,
        dVal,
        discountAmount,
        netTotal,
        paid,
        due,
        paymentStatus,
        commissionPct,
        commissionAmount,
        notes?.trim() || '',
        admin ? 'Admin' : 'Staff',
        nowTs
      );
    const invoiceId = Number(iRes.lastInsertRowid);

    const insInvTest = db.prepare(
      `INSERT INTO invoice_tests (invoice_id, test_id, test_name, category_name, sample_type, price, status, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Sample Collected', ?)`
    );
    const getParams = db.prepare(`SELECT * FROM test_parameters WHERE test_id = ? ORDER BY sort_order ASC, id ASC`);
    const insResult = db.prepare(
      `INSERT INTO test_results (invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const t of selectedTests) {
      const itRes = insInvTest.run(invoiceId, t.id, t.name, t.category_name, t.sample_type, t.price, nowTs);
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
        sort_order: number;
      }>;
      for (const param of params) {
        const initialVal = param.default_value || '';
        const evalRes = evaluateResultFlag(initialVal, param, patient.gender, Number(patient.ageYears || 0));
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

  res.json(getFullInvoice(createdInvoiceId, admin));
});

// Edit Today's Patient Details & Add Tests (preserves Patient ID & Portal Login Credentials)
app.put('/api/invoices/:id', requireStaffOrAdmin, (req, res) => {
  const admin = isAdminRequest(req);
  const invoiceId = Number(req.params.id);
  const existingInv = db
    .prepare(
      `SELECT i.*, p.patient_uid
       FROM invoices i
       JOIN patients p ON p.id = i.patient_id
       WHERE i.id = ?`
    )
    .get(invoiceId) as
    | {
        id: number;
        patient_id: number;
        patient_uid: string;
        doctor_id: number | null;
        subtotal: number;
        discount_type: 'percent' | 'flat';
        discount_value: number;
        discount_amount: number;
        net_total: number;
        paid_amount: number;
        due_amount: number;
        notes: string;
        created_at: string;
      }
    | undefined;

  if (!existingInv) {
    res.status(404).json({ error: 'Invoice not found.' });
    return;
  }

  const todayStr = getTodayDateStr();
  const invoiceDateStr = String(existingInv.created_at || '').slice(0, 10);
  if (!admin && invoiceDateStr !== todayStr) {
    res.status(403).json({
      error: "Staff can only edit today's entered patients. Switch to Admin mode to modify older invoices.",
    });
    return;
  }

  const {
    patient,
    doctorId,
    addTestIds,
    discountType,
    discountValue,
    additionalPayment,
    paymentMethod,
    notes,
  } = req.body as {
    patient?: {
      name?: string;
      ageYears?: number;
      ageMonths?: number;
      ageDays?: number;
      gender?: 'Male' | 'Female' | 'Other';
      mobile?: string;
      address?: string;
    };
    doctorId?: number | null;
    addTestIds?: number[];
    discountType?: 'percent' | 'flat';
    discountValue?: number;
    additionalPayment?: number;
    paymentMethod?: string;
    notes?: string;
  };

  if (!patient?.name?.trim() || !patient?.gender) {
    res.status(400).json({ error: 'Patient full name and gender are required.' });
    return;
  }

  const requestedIds = Array.isArray(addTestIds)
    ? Array.from(new Set(addTestIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)))
    : [];

  const existingTestRows = db
    .prepare('SELECT test_id, price FROM invoice_tests WHERE invoice_id = ?')
    .all(invoiceId) as Array<{ test_id: number; price: number }>;
  const existingTestIds = new Set(existingTestRows.map((r) => r.test_id));
  const newTestIds = requestedIds.filter((id) => !existingTestIds.has(id));

  let testsToAdd: Array<{
    id: number;
    name: string;
    category_name: string;
    sample_type: string;
    price: number;
  }> = [];

  if (newTestIds.length > 0) {
    const ph = newTestIds.map(() => '?').join(',');
    testsToAdd = db
      .prepare(
        `SELECT t.*, c.name as category_name
         FROM tests t
         JOIN test_categories c ON c.id = t.category_id
         WHERE t.id IN (${ph}) AND t.is_active = 1`
      )
      .all(...newTestIds) as typeof testsToAdd;
  }

  const newSubtotal =
    existingTestRows.reduce((sum, r) => sum + Number(r.price), 0) +
    testsToAdd.reduce((sum, t) => sum + Number(t.price), 0);

  const dType =
    discountType === 'percent' || discountType === 'flat' ? discountType : existingInv.discount_type;
  const dVal =
    discountValue !== undefined && discountValue !== null
      ? Math.max(0, Number(discountValue || 0))
      : Number(existingInv.discount_value || 0);

  let discountAmount = dType === 'percent' ? (newSubtotal * dVal) / 100 : dVal;
  discountAmount = Math.min(newSubtotal, Math.round(discountAmount * 100) / 100);

  const discountChanged =
    (discountType !== undefined && discountType !== existingInv.discount_type) ||
    (discountValue !== undefined && Number(discountValue) !== Number(existingInv.discount_value));

  if (discountChanged) {
    const maxStaffPct = Number(getSetting('max_staff_discount_pct') || '15');
    const effectivePct = newSubtotal > 0 ? (discountAmount / newSubtotal) * 100 : 0;
    if (!admin && effectivePct > maxStaffPct + 0.01) {
      res.status(403).json({
        error: `Staff discount limit is ${maxStaffPct}%. Switch to Admin mode to authorize higher discounts.`,
      });
      return;
    }
  }

  const netTotal = Math.max(0, Math.round((newSubtotal - discountAmount) * 100) / 100);
  const nextDoctorId = doctorId !== undefined ? doctorId : existingInv.doctor_id;
  let commissionPct = 0;
  if (nextDoctorId) {
    const doc = db.prepare('SELECT commission_pct FROM doctors WHERE id = ?').get(nextDoctorId) as
      | { commission_pct: number }
      | undefined;
    if (doc) commissionPct = Number(doc.commission_pct || 0);
  }
  const commissionAmount = Math.round(((netTotal * commissionPct) / 100) * 100) / 100;

  const extraPayRaw = Math.max(0, Math.round(Number(additionalPayment || 0) * 100) / 100);
  const maxCollectable = Math.max(0, Math.round((netTotal - Number(existingInv.paid_amount)) * 100) / 100);
  const appliedExtraPay = Math.min(extraPayRaw, maxCollectable);
  const newPaid = Math.round((Number(existingInv.paid_amount) + appliedExtraPay) * 100) / 100;
  const newDue = Math.max(0, Math.round((netTotal - newPaid) * 100) / 100);
  const newStatus = newDue <= 0 ? 'Paid' : newPaid > 0 ? 'Partial' : 'Due';
  const nowTs = getLocalTimestampStr();

  db.transaction(() => {
    // Update patient demographics ONLY — preserve patient_uid, portal_password_hash, portal_password_enc
    db.prepare(
      `UPDATE patients
       SET name = ?, age_years = ?, age_months = ?, age_days = ?, gender = ?, mobile = ?, address = ?
       WHERE id = ?`
    ).run(
      patient.name!.trim(),
      Number(patient.ageYears || 0),
      Number(patient.ageMonths || 0),
      Number(patient.ageDays || 0),
      patient.gender!,
      patient.mobile?.trim() || '',
      patient.address?.trim() || '',
      existingInv.patient_id
    );

    // Re-evaluate existing test_results reference ranges/flags in case gender or age changed
    const existingResults = db
      .prepare(
        `SELECT tr.id, tr.result_value, tp.input_type, tp.abnormal_values, tp.normal_text,
                tp.min_male, tp.max_male, tp.min_female, tp.max_female, tp.min_child, tp.max_child
         FROM test_results tr
         JOIN invoice_tests it ON it.id = tr.invoice_test_id
         LEFT JOIN test_parameters tp ON tp.id = tr.parameter_id
         WHERE it.invoice_id = ?`
      )
      .all(invoiceId) as Array<{
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
          },
          patient.gender!,
          Number(patient.ageYears || 0)
        );
        updExistingRes.run(reEval.rangeLabel, reEval.flag, er.id);
      }
    }

    // Add newly requested tests and pre-fill parameter default values
    const insInvTest = db.prepare(
      `INSERT INTO invoice_tests (invoice_id, test_id, test_name, category_name, sample_type, price, status, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Sample Collected', ?)`
    );
    const getParams = db.prepare(`SELECT * FROM test_parameters WHERE test_id = ? ORDER BY sort_order ASC, id ASC`);
    const insResult = db.prepare(
      `INSERT INTO test_results (invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const t of testsToAdd) {
      const itRes = insInvTest.run(invoiceId, t.id, t.name, t.category_name, t.sample_type, t.price, nowTs);
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
        sort_order: number;
      }>;
      for (const param of params) {
        const initialVal = param.default_value || '';
        const evalRes = evaluateResultFlag(
          initialVal,
          param,
          patient.gender!,
          Number(patient.ageYears || 0)
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

    if (appliedExtraPay > 0) {
      db.prepare(
        `INSERT INTO due_payments (invoice_id, amount, payment_method, note, collected_by, collected_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        invoiceId,
        appliedExtraPay,
        paymentMethod?.trim() || 'Cash',
        testsToAdd.length > 0 ? 'Payment on added tests' : 'Updated invoice payment',
        admin ? 'Admin' : 'Staff',
        nowTs
      );
    }

    db.prepare(
      `UPDATE invoices
       SET doctor_id = ?, subtotal = ?, discount_type = ?, discount_value = ?, discount_amount = ?,
           net_total = ?, paid_amount = ?, due_amount = ?, payment_status = ?,
           commission_pct = ?, commission_amount = ?, notes = ?
       WHERE id = ?`
    ).run(
      nextDoctorId || null,
      newSubtotal,
      dType,
      dVal,
      discountAmount,
      netTotal,
      newPaid,
      newDue,
      newStatus,
      commissionPct,
      commissionAmount,
      notes !== undefined ? notes.trim() : existingInv.notes,
      invoiceId
    );
  })();

  res.json(getFullInvoice(invoiceId, admin, true));
});

// Due Collection
app.post('/api/invoices/:id/due-payment', requireStaffOrAdmin, (req, res) => {
  const invoiceId = Number(req.params.id);
  const { amount, paymentMethod, note } = req.body as {
    amount?: number;
    paymentMethod?: string;
    note?: string;
  };
  const payAmt = Math.round(Number(amount || 0) * 100) / 100;
  if (payAmt <= 0) {
    res.status(400).json({ error: 'Payment amount must be greater than 0.' });
    return;
  }

  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as
    | { id: number; net_total: number; paid_amount: number; due_amount: number }
    | undefined;
  if (!inv) {
    res.status(404).json({ error: 'Invoice not found.' });
    return;
  }
  if (payAmt > inv.due_amount + 0.01) {
    res.status(400).json({ error: `Payment exceeds current due of ৳${inv.due_amount}.` });
    return;
  }

  const admin = isAdminRequest(req);
  const newPaid = Math.round((inv.paid_amount + payAmt) * 100) / 100;
  const newDue = Math.max(0, Math.round((inv.net_total - newPaid) * 100) / 100);
  const newStatus = newDue <= 0 ? 'Paid' : 'Partial';
  const nowTs = getLocalTimestampStr();

  db.transaction(() => {
    db.prepare('INSERT INTO due_payments (invoice_id, amount, payment_method, note, collected_by, collected_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      invoiceId,
      payAmt,
      paymentMethod?.trim() || 'Cash',
      note?.trim() || '',
      admin ? 'Admin' : 'Staff',
      nowTs
    );
    db.prepare('UPDATE invoices SET paid_amount = ?, due_amount = ?, payment_status = ? WHERE id = ?').run(
      newPaid,
      newDue,
      newStatus,
      invoiceId
    );
  })();

  res.json(getFullInvoice(invoiceId, admin));
});

// Lab Queue & Result Entry
app.get('/api/lab-queue', requireStaffOrAdmin, (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    conditions.push(`(i.invoice_no LIKE ? OR p.patient_uid LIKE ? OR p.name LIKE ? OR it.test_name LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (status && status !== 'All') {
    if (status === 'Pending') {
      conditions.push(`it.status != 'Ready'`);
    } else {
      conditions.push(`it.status = ?`);
      params.push(status);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const queue = db
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

  res.json({ queue });
});

app.get('/api/lab-tests/:invoiceTestId', requireStaffOrAdmin, (req, res) => {
  const invoiceTestId = Number(req.params.invoiceTestId);
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
    .get(invoiceTestId) as { id: number; test_id: number; gender: string; age_years: number } | undefined;

  if (!item) {
    res.status(404).json({ error: 'Lab test entry not found.' });
    return;
  }

  const results = db
    .prepare(
      `SELECT tr.*, tp.input_type, tp.select_options, tp.abnormal_values, tp.normal_text,
              tp.min_male, tp.max_male, tp.min_female, tp.max_female, tp.min_child, tp.max_child
       FROM test_results tr
       LEFT JOIN test_parameters tp ON tp.id = tr.parameter_id
       WHERE tr.invoice_test_id = ?
       ORDER BY tr.sort_order ASC, tr.id ASC`
    )
    .all(invoiceTestId);

  res.json({ item, results });
});

app.put('/api/lab-tests/:invoiceTestId/results', requireStaffOrAdmin, (req, res) => {
  const invoiceTestId = Number(req.params.invoiceTestId);
  const { results, status, verifiedBy } = req.body as {
    results: Array<{ parameterId: number; value: string }>;
    status: 'Sample Collected' | 'Processing' | 'Verified' | 'Ready';
    verifiedBy?: string;
  };

  const item = db
    .prepare(
      `SELECT it.*, p.gender, p.age_years
       FROM invoice_tests it
       JOIN invoices i ON i.id = it.invoice_id
       JOIN patients p ON p.id = i.patient_id
       WHERE it.id = ?`
    )
    .get(invoiceTestId) as { id: number; gender: string; age_years: number; verified_at: string | null; ready_at: string | null } | undefined;

  if (!item) {
    res.status(404).json({ error: 'Lab test entry not found.' });
    return;
  }

  const validStatuses = ['Sample Collected', 'Processing', 'Verified', 'Ready'];
  const nextStatus = validStatuses.includes(status) ? status : 'Processing';
  const nowTs = getLocalTimestampStr();

  // Inspect existing test_results rows for parameter names so we can enforce CBC rules cleanly
  const testResultMeta = db
    .prepare(`SELECT parameter_id, parameter_name, result_value FROM test_results WHERE invoice_test_id = ?`)
    .all(invoiceTestId) as Array<{ parameter_id: number; parameter_name: string; result_value: string }>;

  const submittedMap = new Map<number, string>();
  for (const r of testResultMeta) {
    submittedMap.set(r.parameter_id, r.result_value ?? '');
  }
  if (Array.isArray(results)) {
    for (const r of results) {
      submittedMap.set(r.parameterId, String(r.value ?? '').trim());
    }
  }

  const findMetaByName = (pred: (lower: string) => boolean) =>
    testResultMeta.find((m) => pred(m.parameter_name.toLowerCase()));

  const wbcMeta = findMetaByName((n) => n.includes('total wbc'));
  const eosMeta = findMetaByName((n) => n.startsWith('eosinophil') && !n.includes('circulating'));
  const circEosMeta = findMetaByName((n) => n.includes('circulating eosinophil'));

  // Auto-calculate Total Circulating Eosinophil Count = (Total WBC Count * Eosinophils) / 100
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

  // Enforce Differential Count = 100% before allowing 'Ready' status
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
      res.status(400).json({
        error: hasInvalidNumber
          ? 'Differential Count contains an invalid value. All percentages must be valid numbers totaling 100%.'
          : `Differential Count total is ${roundedDiff}%. Total differential count must equal 100% before marking the CBC report Ready.`,
      });
      return;
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
          }
        | undefined;

      let flag = 'Normal';
      let rangeLabel = '';
      if (param) {
        const evalRes = evaluateResultFlag(String(value ?? ''), param, item.gender, item.age_years);
        flag = evalRes.flag;
        rangeLabel = evalRes.rangeLabel;
      }
      updResult.run(String(value ?? '').trim(), rangeLabel, flag, invoiceTestId, parameterId);
    }

    const verifiedAt = nextStatus === 'Verified' || nextStatus === 'Ready' ? item.verified_at || nowTs : null;
    const readyAt = nextStatus === 'Ready' ? item.ready_at || nowTs : null;
    const verifier = verifiedBy?.trim() || getSetting('technologist_name') || 'Medical Technologist';

    db.prepare(`UPDATE invoice_tests SET status = ?, verified_at = ?, ready_at = ?, verified_by = ? WHERE id = ?`).run(
      nextStatus,
      verifiedAt,
      readyAt,
      nextStatus === 'Verified' || nextStatus === 'Ready' ? verifier : '',
      invoiceTestId
    );
  })();

  const updatedResults = db
    .prepare(`SELECT * FROM test_results WHERE invoice_test_id = ? ORDER BY sort_order ASC, id ASC`)
    .all(invoiceTestId);
  const updatedItem = db.prepare(`SELECT * FROM invoice_tests WHERE id = ?`).get(invoiceTestId);

  res.json({ item: updatedItem, results: updatedResults });
});

// Expenses (Admin Only)
app.get('/api/admin/expenses', requireAdmin, (req, res) => {
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : `${getTodayDateStr().slice(0, 7)}-01`;
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : getTodayDateStr();

  const expenses = db
    .prepare(`SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC`)
    .all(from, to) as Array<{ amount: number }>;
  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);

  res.json({ from, to, expenses, total });
});

app.post('/api/admin/expenses', requireAdmin, (req, res) => {
  const { title, category, amount, expense_date, note } = req.body as {
    title?: string;
    category?: string;
    amount?: number;
    expense_date?: string;
    note?: string;
  };
  if (!title?.trim() || !amount || Number(amount) <= 0) {
    res.status(400).json({ error: 'Expense title and positive amount are required.' });
    return;
  }
  const info = db
    .prepare('INSERT INTO expenses (title, category, amount, expense_date, note) VALUES (?, ?, ?, ?, ?)')
    .run(
      title.trim(),
      category?.trim() || 'General',
      Number(amount),
      expense_date || getTodayDateStr(),
      note?.trim() || ''
    );
  res.json({ id: Number(info.lastInsertRowid) });
});

app.delete('/api/admin/expenses/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  res.json({ success: true });
});

// Safe SQLite Database Backup Download (Admin Only)
app.get('/api/admin/backup', requireAdmin, async (_req, res) => {
  const tmpBackup = path.join(os.tmpdir(), `alea_lims_backup_${Date.now()}.db`);
  try {
    await db.backup(tmpBackup);
    const filename = `alea_diagnostic_backup_${getTodayDateStr()}.db`;
    res.download(tmpBackup, filename, () => {
      fs.unlink(tmpBackup, () => {});
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed.' });
  }
});

// ============================================================================
// PATIENT PORTAL API (Strictly Isolated from Admin/Staff & Other Patients)
// ============================================================================
app.post('/api/patient-auth/login', (req, res) => {
  const { patientUid, password } = req.body as { patientUid?: string; password?: string };
  if (!patientUid?.trim() || !password?.trim()) {
    res.status(400).json({ error: 'Patient ID and Password are required.' });
    return;
  }

  const normalizedUid = patientUid.trim().toUpperCase();
  const patient = db
    .prepare(
      `SELECT id, patient_uid, name, age_years, age_months, age_days, gender, mobile, address, portal_password_hash, created_at
       FROM patients
       WHERE UPPER(patient_uid) = ?`
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

  if (!patient || !patient.portal_password_hash) {
    res.status(401).json({ error: 'Invalid Patient ID or Password.' });
    return;
  }

  const trimmedPw = password.trim();
  const isValid =
    verifyPassword(trimmedPw, patient.portal_password_hash) ||
    verifyPassword(trimmedPw.toUpperCase(), patient.portal_password_hash);

  if (!isValid) {
    res.status(401).json({ error: 'Invalid Patient ID or Password.' });
    return;
  }

  const token = createPatientToken(getSecret(), patient.id, patient.patient_uid, patient.name, 12);
  res.json({
    token,
    patient: {
      id: patient.id,
      patient_uid: patient.patient_uid,
      name: patient.name,
      age_years: patient.age_years,
      age_months: patient.age_months,
      age_days: patient.age_days,
      gender: patient.gender,
      mobile: patient.mobile,
      address: patient.address,
      created_at: patient.created_at,
    },
  });
});

app.get('/api/patient-auth/verify', (req, res) => {
  const token = extractTokenFromRequest(req);
  const payload = verifyPatientToken(token, getSecret());
  if (!payload) {
    res.json({ authenticated: false });
    return;
  }
  const patient = db
    .prepare(
      `SELECT id, patient_uid, name, age_years, age_months, age_days, gender, mobile, address, created_at
       FROM patients WHERE id = ?`
    )
    .get(payload.patientId);
  if (!patient) {
    res.json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, patient });
});

app.get('/api/patient/portal-profile', requirePatient, (req, res) => {
  const auth = (req as express.Request & { patientAuth: PatientTokenPayload }).patientAuth;
  const patient = db
    .prepare(
      `SELECT id, patient_uid, name, age_years, age_months, age_days, gender, mobile, address, created_at
       FROM patients WHERE id = ?`
    )
    .get(auth.patientId);

  if (!patient) {
    res.status(404).json({ error: 'Patient record not found.' });
    return;
  }

  // Strictly scoped to auth.patientId, sorted chronologically (newest date first)
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
    .all(auth.patientId) as Array<{ invoice_id: number; [key: string]: unknown }>;

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

  res.json({ patient, archive });
});

app.get('/api/patient/reports/:invoiceId', requirePatient, (req, res) => {
  const auth = (req as express.Request & { patientAuth: PatientTokenPayload }).patientAuth;
  const invoiceId = Number(req.params.invoiceId);

  // Strict ownership check: invoice MUST belong to auth.patientId
  const ownsInvoice = db
    .prepare(`SELECT id FROM invoices WHERE id = ? AND patient_id = ?`)
    .get(invoiceId, auth.patientId);

  if (!ownsInvoice) {
    res.status(404).json({ error: 'Report not found or access denied.' });
    return;
  }

  // Never include doctor commission or portal password secret
  const full = getFullInvoice(invoiceId, false, false);
  if (!full) {
    res.status(404).json({ error: 'Report not found.' });
    return;
  }

  res.json(full);
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n=== Alea Diagnostic Services LIMS ===`);
    console.log(`Local access:   http://localhost:${PORT}`);
    const lanUrls = getLanUrls(PORT);
    for (const url of lanUrls) {
      console.log(`Network (LAN):  ${url}`);
    }
    console.log(`=====================================\n`);
  });
}

startServer();
