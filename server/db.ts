import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createEncryptedPatientQrToken,
  encryptPortalPassword,
  generatePatientQrSecret,
  generatePortalPassword,
  hashPassword,
} from './auth.ts';
import {
  addDaysToIsoDate,
  getCanonicalParameterKey,
  getLocalTimestampStr,
  getTodayDateStr,
  SEED_CATALOG,
} from './clinical-rules.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const DB_PATH = path.join(DATA_DIR, 'alea_lims.db');
export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      sample_type TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (category_id) REFERENCES test_categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS test_parameters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      input_type TEXT NOT NULL DEFAULT 'numeric',
      normal_text TEXT DEFAULT '',
      default_value TEXT DEFAULT '',
      select_options TEXT DEFAULT '',
      abnormal_values TEXT DEFAULT '',
      min_male REAL,
      max_male REAL,
      min_female REAL,
      max_female REAL,
      min_child REAL,
      max_child REAL,
      min_newborn REAL,
      max_newborn REAL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      degree TEXT DEFAULT '',
      hospital TEXT DEFAULT '',
      mobile TEXT DEFAULT '',
      commission_pct REAL NOT NULL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_uid TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      age_years INTEGER DEFAULT 0,
      age_months INTEGER DEFAULT 0,
      age_days INTEGER DEFAULT 0,
      gender TEXT NOT NULL,
      mobile TEXT DEFAULT '',
      address TEXT DEFAULT '',
      portal_password_hash TEXT DEFAULT '',
      portal_password_enc TEXT DEFAULT '',
      qr_secret TEXT DEFAULT '',
      qr_token TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT UNIQUE NOT NULL,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER,
      subtotal REAL NOT NULL,
      discount_type TEXT NOT NULL DEFAULT 'flat',
      discount_value REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      net_total REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      due_amount REAL NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'Due',
      commission_pct REAL NOT NULL DEFAULT 0,
      commission_amount REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by TEXT DEFAULT 'Staff',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS invoice_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      test_id INTEGER NOT NULL,
      test_name TEXT NOT NULL,
      category_name TEXT NOT NULL,
      sample_type TEXT NOT NULL,
      price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'Sample Collected',
      collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
      verified_at TEXT,
      ready_at TEXT,
      verified_by TEXT DEFAULT '',
      consultant_name TEXT DEFAULT '',
      consultant_title TEXT DEFAULT '',
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      FOREIGN KEY (test_id) REFERENCES tests(id)
    );

    CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_test_id INTEGER NOT NULL,
      parameter_id INTEGER NOT NULL,
      parameter_name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      result_value TEXT NOT NULL DEFAULT '',
      reference_range_text TEXT NOT NULL DEFAULT '',
      flag TEXT NOT NULL DEFAULT 'Normal',
      sort_order INTEGER DEFAULT 0,
      UNIQUE(invoice_test_id, parameter_id),
      FOREIGN KEY (invoice_test_id) REFERENCES invoice_tests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS due_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT DEFAULT 'Cash',
      note TEXT DEFAULT '',
      collected_by TEXT DEFAULT 'Staff',
      collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS doctor_commission_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL,
      from_date TEXT DEFAULT '',
      paid_up_to_date TEXT NOT NULL,
      patients_count INTEGER NOT NULL DEFAULT 0,
      total_commission_paid REAL NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      settled_by TEXT DEFAULT 'Admin',
      settled_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      expense_date TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_by TEXT DEFAULT 'Admin',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invoice_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      previous_net_total REAL NOT NULL,
      new_net_total REAL NOT NULL,
      adjustment_delta REAL NOT NULL,
      previous_paid_amount REAL NOT NULL DEFAULT 0,
      new_paid_amount REAL NOT NULL DEFAULT 0,
      refund_amount REAL NOT NULL DEFAULT 0,
      reason TEXT DEFAULT '',
      adjusted_by TEXT DEFAULT 'Admin',
      adjusted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS other_revenues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      category TEXT DEFAULT 'Other Income',
      amount REAL NOT NULL,
      revenue_date TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_by TEXT DEFAULT 'Admin',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_other_revenues_date ON other_revenues(revenue_date);
  `);

  migratePatientPortalColumns();
  migrateDoctorPortalColumns();
  migrateTestParameterDefaults();
  migrateInvoiceTestConsultantColumns();
  migrateCommissionTrackingColumns();
  migrateBillingAndDiscountEnhancements();
  seedDefaultSettings();
  seedCatalogIfEmpty();
  syncExtendedCatalogV2();
  seedInitialOperationalDataIfEmpty();
  migrateCbcParameters();
  migrateUrineReParameters();
  ensurePatientPortalCredentials();
}

function migrateBillingAndDiscountEnhancements() {
  const invCols = new Set(
    (db.prepare(`PRAGMA table_info(invoices)`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!invCols.has('adjustment_amount')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN adjustment_amount REAL NOT NULL DEFAULT 0`);
  }
  if (!invCols.has('adjustment_reason')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN adjustment_reason TEXT DEFAULT ''`);
  }
  if (!invCols.has('adjusted_by')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN adjusted_by TEXT DEFAULT ''`);
  }
  if (!invCols.has('adjusted_at')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN adjusted_at TEXT DEFAULT ''`);
  }
  if (!invCols.has('initial_payment_method')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN initial_payment_method TEXT DEFAULT 'Cash'`);
  }

  const dpCols = new Set(
    (db.prepare(`PRAGMA table_info(due_payments)`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!dpCols.has('entry_type')) {
    db.exec(`ALTER TABLE due_payments ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'payment'`);
  }

  const migratedRow = db
    .prepare(`SELECT value FROM settings WHERE key = 'staff_discount_limit_100_migrated'`)
    .get() as { value: string } | undefined;
  if (migratedRow?.value !== '1') {
    const capRow = db
      .prepare(`SELECT value FROM settings WHERE key = 'max_staff_discount_pct'`)
      .get() as { value: string } | undefined;
    if (!capRow || capRow.value.trim() === '' || capRow.value.trim() === '15') {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('max_staff_discount_pct', '100')`).run();
    }
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('staff_discount_limit_100_migrated', '1')`).run();
  }
}

function migrateCommissionTrackingColumns() {
  const docCols = new Set(
    (db.prepare(`PRAGMA table_info(doctors)`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!docCols.has('last_commission_paid_up_to')) {
    db.exec(`ALTER TABLE doctors ADD COLUMN last_commission_paid_up_to TEXT DEFAULT ''`);
  }
  if (!docCols.has('last_commission_settled_at')) {
    db.exec(`ALTER TABLE doctors ADD COLUMN last_commission_settled_at TEXT DEFAULT ''`);
  }
  if (!docCols.has('last_commission_paid_amount')) {
    db.exec(`ALTER TABLE doctors ADD COLUMN last_commission_paid_amount REAL DEFAULT 0`);
  }

  const invCols = new Set(
    (db.prepare(`PRAGMA table_info(invoices)`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!invCols.has('discount_pct')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN discount_pct REAL NOT NULL DEFAULT 0`);
    db.exec(
      `UPDATE invoices SET discount_pct = CASE WHEN subtotal > 0 THEN ROUND((discount_amount / subtotal) * 100, 2) ELSE 0 END`
    );
  }
  if (!invCols.has('commission_type')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN commission_type TEXT NOT NULL DEFAULT 'percent'`);
  }
  if (!invCols.has('commission_value')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN commission_value REAL NOT NULL DEFAULT 0`);
    db.exec(`UPDATE invoices SET commission_value = commission_pct`);
  }
  if (!invCols.has('commission_paid')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN commission_paid INTEGER NOT NULL DEFAULT 0`);
  }
  if (!invCols.has('commission_paid_at')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN commission_paid_at TEXT DEFAULT ''`);
  }
  if (!invCols.has('commission_payout_id')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN commission_payout_id INTEGER`);
  }

  const itCols = new Set(
    (db.prepare(`PRAGMA table_info(invoice_tests)`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!itCols.has('commission_type')) {
    db.exec(`ALTER TABLE invoice_tests ADD COLUMN commission_type TEXT NOT NULL DEFAULT 'percent'`);
  }
  if (!itCols.has('commission_value')) {
    db.exec(`ALTER TABLE invoice_tests ADD COLUMN commission_value REAL NOT NULL DEFAULT 0`);
  }
  if (!itCols.has('commission_amount')) {
    db.exec(`ALTER TABLE invoice_tests ADD COLUMN commission_amount REAL NOT NULL DEFAULT 0`);
  }
}

function migrateTestParameterDefaults() {
  const cols = db.prepare(`PRAGMA table_info(test_parameters)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('default_value')) {
    db.exec(`ALTER TABLE test_parameters ADD COLUMN default_value TEXT DEFAULT ''`);
  }
  if (!names.has('min_newborn')) {
    db.exec(`ALTER TABLE test_parameters ADD COLUMN min_newborn REAL`);
  }
  if (!names.has('max_newborn')) {
    db.exec(`ALTER TABLE test_parameters ADD COLUMN max_newborn REAL`);
  }
}

function migrateInvoiceTestConsultantColumns() {
  const cols = db.prepare(`PRAGMA table_info(invoice_tests)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('consultant_name')) {
    db.exec(`ALTER TABLE invoice_tests ADD COLUMN consultant_name TEXT DEFAULT ''`);
  }
  if (!names.has('consultant_title')) {
    db.exec(`ALTER TABLE invoice_tests ADD COLUMN consultant_title TEXT DEFAULT ''`);
  }
}

function migratePatientPortalColumns() {
  const cols = db.prepare(`PRAGMA table_info(patients)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('portal_password_hash')) {
    db.exec(`ALTER TABLE patients ADD COLUMN portal_password_hash TEXT DEFAULT ''`);
  }
  if (!names.has('portal_password_enc')) {
    db.exec(`ALTER TABLE patients ADD COLUMN portal_password_enc TEXT DEFAULT ''`);
  }
  if (!names.has('qr_secret')) {
    db.exec(`ALTER TABLE patients ADD COLUMN qr_secret TEXT DEFAULT ''`);
  }
  if (!names.has('qr_token')) {
    db.exec(`ALTER TABLE patients ADD COLUMN qr_token TEXT DEFAULT ''`);
  }
}

function migrateDoctorPortalColumns() {
  const cols = db.prepare(`PRAGMA table_info(doctors)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('portal_username')) {
    db.exec(`ALTER TABLE doctors ADD COLUMN portal_username TEXT DEFAULT ''`);
  }
  if (!names.has('portal_password_hash')) {
    db.exec(`ALTER TABLE doctors ADD COLUMN portal_password_hash TEXT DEFAULT ''`);
  }
  if (!names.has('portal_password_enc')) {
    db.exec(`ALTER TABLE doctors ADD COLUMN portal_password_enc TEXT DEFAULT ''`);
  }
  if (!names.has('portal_enabled')) {
    db.exec(`ALTER TABLE doctors ADD COLUMN portal_enabled INTEGER NOT NULL DEFAULT 1`);
  }
}

function ensurePatientPortalCredentials() {
  const secret = process.env.AUTH_SECRET?.trim() || getSetting('auth_secret');
  if (!secret) return;
  const rows = db
    .prepare(
      `SELECT id, patient_uid, portal_password_hash, portal_password_enc, qr_secret, qr_token
       FROM patients
       WHERE portal_password_hash = '' OR portal_password_hash IS NULL
          OR qr_secret = '' OR qr_secret IS NULL
          OR qr_token = '' OR qr_token IS NULL`
    )
    .all() as Array<{
    id: number;
    patient_uid: string;
    portal_password_hash: string;
    portal_password_enc: string;
    qr_secret: string;
    qr_token: string;
  }>;
  if (rows.length === 0) return;

  const upd = db.prepare(
    `UPDATE patients SET portal_password_hash = ?, portal_password_enc = ?, qr_secret = ?, qr_token = ? WHERE id = ?`
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      let pwHash = r.portal_password_hash;
      let pwEnc = r.portal_password_enc;
      if (!pwHash) {
        const plain = r.patient_uid === 'ALEA-2601' ? 'ALEA61' : generatePortalPassword();
        pwHash = hashPassword(plain);
        pwEnc = encryptPortalPassword(plain, secret);
      }
      const qrSecret = r.qr_secret || generatePatientQrSecret();
      const qrToken = r.qr_token || createEncryptedPatientQrToken(r.id, qrSecret, secret);
      upd.run(pwHash, pwEnc, qrSecret, qrToken, r.id);
    }
  });
  tx();
}

function seedDefaultSettings() {
  const defaults: Record<string, string> = {
    lab_name: 'Alea Diagnostic Services',
    lab_address: 'Bank Mor, Halasa Bazar, Mirpur, Kushtia',
    proprietor_name: 'Md. Mishkatur Rahman',
    lab_phone: '+88 01720 660 824',
    max_staff_discount_pct: '100',
    technologist_name: 'Md. Tariqul Islam, B.Sc (MLT)',
    technologist_title: 'Medical Technologist (Lab)',
    pathologist_name: 'Dr. Farhana Yasmin, MBBS, M.Phil',
    pathologist_title: 'Consultant Pathologist',
    pad_header_margin_in: '1.5',
    pad_footer_margin_in: '0.4',
    admin_password_hash: hashPassword('alea2026'),
    staff_password_hash: hashPassword('staff2026'),
    auth_secret: crypto.randomBytes(32).toString('hex'),
  };

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(defaults)) {
      insertSetting.run(k, v);
    }
  });
  tx();
}

export function getSetting(key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : '';
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (
      r.key === 'admin_password_hash' ||
      r.key === 'staff_password_hash' ||
      r.key === 'auth_secret' ||
      r.key === 'catalog_v2_synced' ||
      r.key === 'staff_discount_limit_100_migrated'
    ) {
      continue;
    }
    map[r.key] = r.value;
  }
  return map;
}

interface ParamSeed {
  name: string;
  unit: string;
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
  min_newborn?: number | null;
  max_newborn?: number | null;
}

interface TestSeed {
  code: string;
  name: string;
  price: number;
  sample_type: string;
  parameters: ParamSeed[];
}

function seedCatalogIfEmpty() {
  const catCount = (db.prepare('SELECT COUNT(*) as c FROM test_categories').get() as { c: number }).c;
  if (catCount > 0) return;

  const insCat = db.prepare('INSERT INTO test_categories (name, sort_order) VALUES (?, ?)');
  const insTest = db.prepare('INSERT INTO tests (category_id, code, name, price, sample_type) VALUES (?, ?, ?, ?, ?)');
  const insParam = db.prepare(`
    INSERT INTO test_parameters (
      test_id, name, unit, input_type, normal_text, default_value, select_options, abnormal_values,
      min_male, max_male, min_female, max_female, min_child, max_child, min_newborn, max_newborn, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const group of SEED_CATALOG) {
      const catRes = insCat.run(group.category, group.sort_order);
      const catId = Number(catRes.lastInsertRowid);
      for (const t of group.tests) {
        const testRes = insTest.run(catId, t.code, t.name, t.price, t.sample_type);
        const testId = Number(testRes.lastInsertRowid);
        t.parameters.forEach((p, idx) => {
          insParam.run(
            testId,
            p.name,
            p.unit || '',
            p.input_type || 'numeric',
            p.normal_text || '',
            p.default_value ?? '',
            p.select_options || '',
            p.abnormal_values || '',
            p.min_male ?? null,
            p.max_male ?? null,
            p.min_female ?? p.min_male ?? null,
            p.max_female ?? p.max_male ?? null,
            p.min_child ?? null,
            p.max_child ?? null,
            p.min_newborn ?? null,
            p.max_newborn ?? null,
            idx + 1
          );
        });
      }
    }
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('catalog_v2_synced', '1')`).run();
  });
  tx();
}

function syncExtendedCatalogV2() {
  const flagRow = db.prepare(`SELECT value FROM settings WHERE key = 'catalog_v2_synced'`).get() as
    | { value: string }
    | undefined;
  if (flagRow?.value === '1') return;

  const getCatByName = db.prepare('SELECT id FROM test_categories WHERE LOWER(name) = LOWER(?)');
  const insCat = db.prepare('INSERT INTO test_categories (name, sort_order) VALUES (?, ?)');
  const findTestByCodeOrName = db.prepare(
    'SELECT id FROM tests WHERE LOWER(code) = LOWER(?) OR LOWER(name) = LOWER(?)'
  );
  const insTest = db.prepare(
    'INSERT INTO tests (category_id, code, name, price, sample_type, is_active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  const insParam = db.prepare(`
    INSERT INTO test_parameters (
      test_id, name, unit, input_type, normal_text, default_value, select_options, abnormal_values,
      min_male, max_male, min_female, max_female, min_child, max_child, min_newborn, max_newborn, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const group of SEED_CATALOG) {
      let catRow = getCatByName.get(group.category) as { id: number } | undefined;
      if (!catRow) {
        const res = insCat.run(group.category, group.sort_order);
        catRow = { id: Number(res.lastInsertRowid) };
      }

      for (const t of group.tests) {
        const existing = findTestByCodeOrName.get(t.code, t.name) as { id: number } | undefined;
        if (existing) continue;

        const testRes = insTest.run(catRow.id, t.code, t.name, t.price, t.sample_type);
        const testId = Number(testRes.lastInsertRowid);
        t.parameters.forEach((p, idx) => {
          insParam.run(
            testId,
            p.name,
            p.unit || '',
            p.input_type || 'numeric',
            p.normal_text || '',
            p.default_value ?? '',
            p.select_options || '',
            p.abnormal_values || '',
            p.min_male ?? null,
            p.max_male ?? null,
            p.min_female ?? p.min_male ?? null,
            p.max_female ?? p.max_male ?? null,
            p.min_child ?? null,
            p.max_child ?? null,
            p.min_newborn ?? null,
            p.max_newborn ?? null,
            idx + 1
          );
        });
      }
    }
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('catalog_v2_synced', '1')`).run();
  });
  tx();
}

function seedInitialOperationalDataIfEmpty() {
  const docCount = (db.prepare('SELECT COUNT(*) as c FROM doctors').get() as { c: number }).c;
  if (docCount > 0) return;

  const nowTs = getLocalTimestampStr();
  const insDoc = db.prepare(
    'INSERT INTO doctors (name, degree, hospital, mobile, commission_pct, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const d1 = Number(insDoc.run('Dr. Kamrul Hasan', 'MBBS, BCS (Health), FCPS (Medicine)', 'Kushtia General Hospital', '01711-234561', 20, nowTs).lastInsertRowid);
  const d2 = Number(insDoc.run('Dr. Nusrat Jahan', 'MBBS, DGO (Gynae & Obs)', 'Mirpur Upazila Health Complex', '01712-987654', 25, nowTs).lastInsertRowid);
  const d3 = Number(insDoc.run('Dr. Mahfuzur Rahman', 'MBBS, MD (Cardiology)', 'Halasa Specialized Clinic', '01819-445566', 20, nowTs).lastInsertRowid);
  insDoc.run('Self / Walk-in Patient', 'Direct Visit', 'Alea Diagnostic Services', '', 0, nowTs);

  const todayStr = getTodayDateStr();
  const insPatient = db.prepare(
    'INSERT INTO patients (patient_uid, name, age_years, age_months, age_days, gender, mobile, address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insInvoice = db.prepare(`
    INSERT INTO invoices (
      invoice_no, patient_id, doctor_id, subtotal, discount_type, discount_value, discount_amount,
      net_total, paid_amount, due_amount, payment_status, commission_pct, commission_amount, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insInvTest = db.prepare(`
    INSERT INTO invoice_tests (invoice_id, test_id, test_name, category_name, sample_type, price, status, collected_at, verified_at, ready_at, verified_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insResult = db.prepare(`
    INSERT INTO test_results (invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getTestByCode = (code: string) =>
    db
      .prepare(
        `SELECT t.*, c.name as category_name FROM tests t JOIN test_categories c ON c.id = t.category_id WHERE t.code = ?`
      )
      .get(code) as { id: number; name: string; category_name: string; sample_type: string; price: number };

  const getParams = (testId: number) =>
    db.prepare('SELECT * FROM test_parameters WHERE test_id = ? ORDER BY sort_order ASC').all(testId) as Array<{
      id: number;
      name: string;
      unit: string;
      normal_text: string;
      sort_order: number;
    }>;

  const tx = db.transaction(() => {
    // Patient 1 - Ready report with abnormal CBC & FBS values
    const p1 = Number(
      insPatient.run('ALEA-2601', 'Md. Rafiqul Islam', 46, 0, 0, 'Male', '01715-882211', 'Halasa Bazar, Mirpur', `${todayStr} 09:15:00+06:00`).lastInsertRowid
    );
    const inv1 = Number(
      insInvoice.run('INV-26001', p1, d1, 650, 'flat', 50, 50, 600, 600, 0, 'Paid', 20, 120, 'Staff', `${todayStr} 09:16:00+06:00`).lastInsertRowid
    );

    const cbc = getTestByCode('HEM-01');
    const it1 = Number(
      insInvTest.run(inv1, cbc.id, cbc.name, cbc.category_name, cbc.sample_type, cbc.price, 'Ready', `${todayStr} 09:20:00+06:00`, `${todayStr} 10:45:00+06:00`, `${todayStr} 11:00:00+06:00`, 'Md. Tariqul Islam, B.Sc (MLT)').lastInsertRowid
    );
    const cbcSampleValues: Record<string, { val: string; flag: string }> = {
      'Hemoglobin (Hb)': { val: '11.4', flag: 'Low' },
      'ESR (Erythrocyte Sedimentation Rate)': { val: '28', flag: 'High' },
      'Total WBC Count': { val: '13200', flag: 'High' },
      'Total RBC Count': { val: '4.6', flag: 'Normal' },
      'Platelet Count': { val: '265000', flag: 'Normal' },
      Neutrophils: { val: '78', flag: 'High' },
      Lymphocytes: { val: '16', flag: 'Low' },
      Eosinophils: { val: '2', flag: 'Normal' },
      Monocytes: { val: '4', flag: 'Normal' },
      Basophils: { val: '0', flag: 'Normal' },
      'Total Circulating Eosinophil Count': { val: '264', flag: 'Normal' },
      'PCV / HCT': { val: '35.5', flag: 'Low' },
      MCV: { val: '86', flag: 'Normal' },
      MCH: { val: '28.5', flag: 'Normal' },
      MCHC: { val: '33.2', flag: 'Normal' },
    };
    for (const param of getParams(cbc.id)) {
      const sample = cbcSampleValues[param.name] || { val: '', flag: 'Normal' };
      insResult.run(it1, param.id, param.name, param.unit, sample.val, param.normal_text || '13.0 - 17.0', sample.flag, param.sort_order);
    }

    const fbs = getTestByCode('BIO-01');
    const it2 = Number(
      insInvTest.run(inv1, fbs.id, fbs.name, fbs.category_name, fbs.sample_type, fbs.price, 'Ready', `${todayStr} 09:20:00+06:00`, `${todayStr} 10:45:00+06:00`, `${todayStr} 11:00:00+06:00`, 'Md. Tariqul Islam').lastInsertRowid
    );
    for (const param of getParams(fbs.id)) {
      insResult.run(it2, param.id, param.name, param.unit, '158', '70 - 100', 'High', param.sort_order);
    }

    // Historical visit for Patient 1 (12 days ago) for Date-Wise Medical History archive
    const pastDate = addDaysToIsoDate(todayStr, -12);
    const inv1Past = Number(
      insInvoice.run('INV-25984', p1, d3, 1000, 'flat', 0, 0, 1000, 1000, 0, 'Paid', 20, 200, 'Staff', `${pastDate} 10:30:00+06:00`).lastInsertRowid
    );
    const lipidPast = getTestByCode('BIO-04');
    const it1Past = Number(
      insInvTest.run(inv1Past, lipidPast.id, lipidPast.name, lipidPast.category_name, lipidPast.sample_type, lipidPast.price, 'Ready', `${pastDate} 10:35:00+06:00`, `${pastDate} 13:10:00+06:00`, `${pastDate} 13:30:00+06:00`, 'Md. Tariqul Islam').lastInsertRowid
    );
    const lipidSample: Record<string, { val: string; flag: string }> = {
      'Total Cholesterol': { val: '234', flag: 'High' },
      'Triglycerides (TG)': { val: '188', flag: 'High' },
      'HDL Cholesterol': { val: '38', flag: 'Low' },
      'LDL Cholesterol': { val: '158', flag: 'High' },
    };
    for (const param of getParams(lipidPast.id)) {
      const sample = lipidSample[param.name] || { val: '', flag: 'Normal' };
      insResult.run(it1Past, param.id, param.name, param.unit, sample.val, param.normal_text || '', sample.flag, param.sort_order);
    }

    // Patient 2 - Partial payment (Due) + Processing status
    const p2 = Number(
      insPatient.run('ALEA-2602', 'Mst. Amena Khatun', 32, 0, 0, 'Female', '01914-334455', 'Bank Mor, Mirpur', `${todayStr} 10:10:00+06:00`).lastInsertRowid
    );
    const inv2 = Number(
      insInvoice.run('INV-26002', p2, d2, 1300, 'percent', 10, 130, 1170, 700, 470, 'Partial', 25, 292.5, 'Staff', `${todayStr} 10:12:00+06:00`).lastInsertRowid
    );
    const lft = getTestByCode('BIO-05');
    const it3 = Number(
      insInvTest.run(inv2, lft.id, lft.name, lft.category_name, lft.sample_type, lft.price, 'Processing', `${todayStr} 10:20:00+06:00`, null, null, '').lastInsertRowid
    );
    for (const param of getParams(lft.id)) {
      insResult.run(it3, param.id, param.name, param.unit, '', param.normal_text, 'Normal', param.sort_order);
    }
    const hbsag = getTestByCode('SER-01');
    const it4 = Number(
      insInvTest.run(inv2, hbsag.id, hbsag.name, hbsag.category_name, hbsag.sample_type, hbsag.price, 'Sample Collected', `${todayStr} 10:20:00+06:00`, null, null, '').lastInsertRowid
    );
    for (const param of getParams(hbsag.id)) {
      insResult.run(it4, param.id, param.name, param.unit, '', param.normal_text, 'Normal', param.sort_order);
    }

    // Patient 3 - Sample Collected + Paid
    const p3 = Number(
      insPatient.run('ALEA-2603', 'Md. Sohag Ali', 28, 0, 0, 'Male', '01788-556677', 'Poradaha, Mirpur', `${todayStr} 11:05:00+06:00`).lastInsertRowid
    );
    const inv3 = Number(
      insInvoice.run('INV-26003', p3, d3, 1800, 'flat', 0, 0, 1800, 1800, 0, 'Paid', 20, 360, 'Staff', `${todayStr} 11:06:00+06:00`).lastInsertRowid
    );
    const lipid = getTestByCode('BIO-04');
    const it5 = Number(
      insInvTest.run(inv3, lipid.id, lipid.name, lipid.category_name, lipid.sample_type, lipid.price, 'Sample Collected', `${todayStr} 11:12:00+06:00`, null, null, '').lastInsertRowid
    );
    for (const param of getParams(lipid.id)) {
      insResult.run(it5, param.id, param.name, param.unit, '', param.normal_text, 'Normal', param.sort_order);
    }
    const kft = getTestByCode('BIO-06');
    const it6 = Number(
      insInvTest.run(inv3, kft.id, kft.name, kft.category_name, kft.sample_type, kft.price, 'Verified', `${todayStr} 11:12:00+06:00`, `${todayStr} 12:15:00+06:00`, null, 'Md. Tariqul Islam').lastInsertRowid
    );
    for (const param of getParams(kft.id)) {
      const val = param.name === 'Serum Creatinine' ? '1.1' : param.name === 'Blood Urea' ? '32' : '5.8';
      insResult.run(it6, param.id, param.name, param.unit, val, param.normal_text, 'Normal', param.sort_order);
    }

    // Initial expenses
    const insExp = db.prepare('INSERT INTO expenses (title, category, amount, expense_date, note, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insExp.run('CBC & Biochemistry Reagents Restock', 'Reagents & Kits', 1450, todayStr, 'Mindray diluent & glucose reagent', nowTs);
    insExp.run('Sample Collection Tubes & Needles', 'Consumables', 420, todayStr, 'EDTA & Clot activator tubes', nowTs);
  });
  tx();
}

function migrateCbcParameters() {
  const cbcTest = db
    .prepare(`SELECT id FROM tests WHERE code = 'HEM-01' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!cbcTest) return;

  const desiredParams: Array<ParamSeed & { sort_order: number }> = [
    { name: 'Hemoglobin (Hb)', unit: 'g/dL', min_male: 13.0, max_male: 17.0, min_female: 12.0, max_female: 15.5, min_child: 11.0, max_child: 14.5, min_newborn: 14.0, max_newborn: 22.0, normal_text: 'M: 13.0–17.0 | F: 12.0–15.5\nChild: 11.0–14.5 | Newborn: 14.0–22.0', sort_order: 1 },
    { name: 'ESR (Erythrocyte Sedimentation Rate)', unit: 'mm/1st hr', min_male: 0, max_male: 15, min_female: 0, max_female: 20, min_child: 0, max_child: 10, min_newborn: 0, max_newborn: 2, normal_text: 'M: 0–15 | F: 0–20\nChild: 0–10 | Newborn: 0–2', sort_order: 2 },
    { name: 'Total WBC Count', unit: '/cumm', min_male: 4000, max_male: 11000, min_female: 4000, max_female: 11000, min_child: 5000, max_child: 13500, min_newborn: 9000, max_newborn: 30000, normal_text: 'Adult (M/F): 4,000–11,000\nChild: 5,000–13,500 | Newborn: 9,000–30,000', sort_order: 3 },
    { name: 'Total RBC Count', unit: 'million/cumm', min_male: 4.5, max_male: 5.9, min_female: 4.0, max_female: 5.2, min_child: 4.0, max_child: 5.3, min_newborn: 4.8, max_newborn: 7.1, normal_text: 'M: 4.5–5.9 | F: 4.0–5.2\nChild: 4.0–5.3 | Newborn: 4.8–7.1', sort_order: 4 },
    { name: 'Platelet Count', unit: '/cumm', min_male: 150000, max_male: 450000, min_female: 150000, max_female: 450000, min_child: 150000, max_child: 450000, min_newborn: 150000, max_newborn: 450000, normal_text: '150,000 - 450,000', sort_order: 5 },
    { name: 'Neutrophils', unit: '%', min_male: 40, max_male: 75, min_female: 40, max_female: 75, min_child: 35, max_child: 65, min_newborn: 45, max_newborn: 80, normal_text: 'Adult (M/F): 40–75 | Child: 35–65\nNewborn: 45–80', sort_order: 6 },
    { name: 'Lymphocytes', unit: '%', min_male: 20, max_male: 45, min_female: 20, max_female: 45, min_child: 25, max_child: 55, min_newborn: 20, max_newborn: 40, normal_text: 'Adult (M/F): 20–45 | Child: 25–55\nNewborn: 20–40', sort_order: 7 },
    { name: 'Eosinophils', unit: '%', min_male: 1, max_male: 6, min_female: 1, max_female: 6, min_child: 1, max_child: 6, min_newborn: 1, max_newborn: 6, normal_text: '1 - 6', sort_order: 8 },
    { name: 'Monocytes', unit: '%', min_male: 2, max_male: 10, min_female: 2, max_female: 10, min_child: 2, max_child: 10, min_newborn: 2, max_newborn: 10, normal_text: '2 - 10', sort_order: 9 },
    { name: 'Basophils', unit: '%', min_male: 0, max_male: 1, min_female: 0, max_female: 1, min_child: 0, max_child: 1, min_newborn: 0, max_newborn: 1, normal_text: '0 - 1', sort_order: 10 },
    { name: 'Total Circulating Eosinophil Count', unit: '/cumm', min_male: 40, max_male: 440, min_female: 40, max_female: 440, min_child: 40, max_child: 440, min_newborn: 40, max_newborn: 440, normal_text: '40 - 440', sort_order: 11 },
    { name: 'PCV / HCT', unit: '%', min_male: 40, max_male: 54, min_female: 36, max_female: 48, min_child: 32, max_child: 44, min_newborn: 44, max_newborn: 64, normal_text: 'M: 40–54 | F: 36–48\nChild: 32–44 | Newborn: 44–64', sort_order: 12 },
    { name: 'MCV', unit: 'fL', min_male: 80, max_male: 100, min_female: 80, max_female: 100, min_child: 75, max_child: 95, min_newborn: 95, max_newborn: 120, normal_text: 'Adult (M/F): 80–100 | Child: 75–95\nNewborn: 95–120', sort_order: 13 },
    { name: 'MCH', unit: 'pg', min_male: 27, max_male: 32, min_female: 27, max_female: 32, min_child: 25, max_child: 31, min_newborn: 31, max_newborn: 37, normal_text: 'Adult (M/F): 27–32 | Child: 25–31\nNewborn: 31–37', sort_order: 14 },
    { name: 'MCHC', unit: 'g/dL', min_male: 32, max_male: 36, min_female: 32, max_female: 36, min_child: 32, max_child: 36, min_newborn: 32, max_newborn: 36, normal_text: '32 - 36', sort_order: 15 },
  ];

  const existingParams = db
    .prepare(`SELECT id, name FROM test_parameters WHERE test_id = ?`)
    .all(cbcTest.id) as Array<{ id: number; name: string }>;

  const findExistingParam = (targetName: string) => {
    const targetCanon = getCanonicalParameterKey(targetName);
    return existingParams.find((p) => {
      const pCanon = getCanonicalParameterKey(p.name);
      return pCanon !== '' && pCanon === targetCanon;
    });
  };

  const insParam = db.prepare(`
    INSERT INTO test_parameters (
      test_id, name, unit, input_type, normal_text, select_options, abnormal_values,
      min_male, max_male, min_female, max_female, min_child, max_child, min_newborn, max_newborn, sort_order
    ) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updParam = db.prepare(`
    UPDATE test_parameters
    SET name = ?, unit = ?, normal_text = ?, min_male = ?, max_male = ?, min_female = ?, max_female = ?,
        min_child = ?, max_child = ?, min_newborn = ?, max_newborn = ?, sort_order = ?
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    for (const dp of desiredParams) {
      const found = findExistingParam(dp.name);
      if (!found) {
        insParam.run(
          cbcTest.id,
          dp.name,
          dp.unit,
          'numeric',
          dp.normal_text || '',
          dp.min_male ?? null,
          dp.max_male ?? null,
          dp.min_female ?? dp.min_male ?? null,
          dp.max_female ?? dp.max_male ?? null,
          dp.min_child ?? null,
          dp.max_child ?? null,
          dp.min_newborn ?? null,
          dp.max_newborn ?? null,
          dp.sort_order
        );
      } else {
        updParam.run(
          dp.name,
          dp.unit,
          dp.normal_text || '',
          dp.min_male ?? null,
          dp.max_male ?? null,
          dp.min_female ?? dp.min_male ?? null,
          dp.max_female ?? dp.max_male ?? null,
          dp.min_child ?? null,
          dp.max_child ?? null,
          dp.min_newborn ?? null,
          dp.max_newborn ?? null,
          dp.sort_order,
          found.id
        );
      }
    }

    // Remove obsolete RDW parameter & results from CBC (HEM-01)
    const rdwParams = existingParams.filter((p) => p.name.trim().toLowerCase().startsWith('rdw'));
    if (rdwParams.length > 0) {
      const delResByParam = db.prepare(
        `DELETE FROM test_results WHERE parameter_id = ? AND invoice_test_id IN (SELECT id FROM invoice_tests WHERE test_id = ?)`
      );
      const delParam = db.prepare(`DELETE FROM test_parameters WHERE id = ?`);
      for (const rp of rdwParams) {
        delResByParam.run(rp.id, cbcTest.id);
        delParam.run(rp.id);
      }
    }
    db.prepare(
      `DELETE FROM test_results WHERE LOWER(TRIM(parameter_name)) LIKE 'rdw%' AND invoice_test_id IN (SELECT id FROM invoice_tests WHERE test_id = ?)`
    ).run(cbcTest.id);

    // Backfill any missing CBC parameters & sync order/names into existing invoice_tests for HEM-01
    const cbcParams = db
      .prepare(`SELECT * FROM test_parameters WHERE test_id = ? ORDER BY sort_order ASC, id ASC`)
      .all(cbcTest.id) as Array<{
      id: number;
      name: string;
      unit: string;
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
      sort_order: number;
    }>;

    const cbcInvoiceTests = db
      .prepare(
        `SELECT it.id as invoice_test_id, it.status, i.invoice_no, p.gender, p.age_years, p.age_months, p.age_days
         FROM invoice_tests it
         JOIN invoices i ON i.id = it.invoice_id
         JOIN patients p ON p.id = i.patient_id
         WHERE it.test_id = ?`
      )
      .all(cbcTest.id) as Array<{
      invoice_test_id: number;
      status: string;
      invoice_no: string;
      gender: string;
      age_years: number;
      age_months: number;
      age_days: number;
    }>;

    const insResult = db.prepare(
      `INSERT OR IGNORE INTO test_results (
        invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updResultMeta = db.prepare(
      `UPDATE test_results SET parameter_name = ?, unit = ?, reference_range_text = ?, sort_order = ? WHERE invoice_test_id = ? AND parameter_id = ?`
    );

    for (const cit of cbcInvoiceTests) {
      const existingRows = db
        .prepare(`SELECT id, parameter_id, parameter_name, result_value, sort_order FROM test_results WHERE invoice_test_id = ? ORDER BY sort_order ASC, id ASC`)
        .all(cit.invoice_test_id) as Array<{ id: number; parameter_id: number; parameter_name: string; result_value: string; sort_order: number }>;

      // Remove any duplicate test_results rows sharing the same canonical parameter key (keeping filled result over Pending)
      const bestByCanon = new Map<string, typeof existingRows[number]>();
      const delDupRow = db.prepare(`DELETE FROM test_results WHERE id = ?`);
      for (const er of existingRows) {
        const key = getCanonicalParameterKey(er.parameter_name) || `pid:${er.parameter_id}`;
        const prev = bestByCanon.get(key);
        if (!prev) {
          bestByCanon.set(key, er);
        } else {
          const curHasVal = Boolean(er.result_value && er.result_value.trim() !== '' && er.result_value.trim().toLowerCase() !== 'pending');
          const prevHasVal = Boolean(prev.result_value && prev.result_value.trim() !== '' && prev.result_value.trim().toLowerCase() !== 'pending');
          if (curHasVal && !prevHasVal) {
            delDupRow.run(prev.id);
            bestByCanon.set(key, er);
          } else {
            delDupRow.run(er.id);
          }
        }
      }

      const dedupedRows = Array.from(bestByCanon.values());
      const existingByParamId = new Map(dedupedRows.map((r) => [r.parameter_id, r]));
      const existingByCanonKey = new Map(dedupedRows.map((r) => [getCanonicalParameterKey(r.parameter_name), r]));
      const wbcRow = dedupedRows.find((r) => r.parameter_name.toLowerCase().includes('total wbc'));
      const eosRow = dedupedRows.find(
        (r) =>
          r.parameter_name.toLowerCase().startsWith('eosinophil') &&
          !r.parameter_name.toLowerCase().includes('circulating')
      );

      for (const param of cbcParams) {
        const canonKey = getCanonicalParameterKey(param.name);
        const matchedRow = existingByParamId.get(param.id) || (canonKey ? existingByCanonKey.get(canonKey) : undefined);

        if (!matchedRow) {
          let initialVal = '';
          const pLower = param.name.toLowerCase();

          if (pLower.includes('circulating eosinophil') && wbcRow?.result_value && eosRow?.result_value) {
            const wbc = Number(wbcRow.result_value.replace(/,/g, ''));
            const eos = Number(eosRow.result_value.replace(/,/g, ''));
            if (!Number.isNaN(wbc) && !Number.isNaN(eos)) {
              initialVal = String(Math.round(((wbc * eos) / 100) * 100) / 100);
            }
          } else if (cit.invoice_no === 'INV-26001' && cit.status === 'Ready') {
            if (pLower.includes('pcv') || pLower.includes('hematocrit') || pLower.includes('hct')) initialVal = '35.5';
            if (pLower.startsWith('esr')) initialVal = '28';
          }

          const evalRes = evaluateResultFlag(initialVal, param, cit.gender, cit.age_years, cit.age_months, cit.age_days);
          insResult.run(
            cit.invoice_test_id,
            param.id,
            param.name,
            param.unit,
            initialVal,
            param.normal_text || evalRes.rangeLabel,
            evalRes.flag,
            param.sort_order
          );
          if (canonKey) {
            existingByCanonKey.set(canonKey, {
              id: -1,
              parameter_id: param.id,
              parameter_name: param.name,
              result_value: initialVal,
              sort_order: param.sort_order,
            });
          }
        } else {
          const evalRes = evaluateResultFlag('', param, cit.gender, cit.age_years, cit.age_months, cit.age_days);
          updResultMeta.run(
            param.name,
            param.unit,
            param.normal_text || evalRes.rangeLabel,
            param.sort_order,
            cit.invoice_test_id,
            matchedRow.parameter_id
          );
        }
      }
    }
  });
  tx();
}

function migrateUrineReParameters() {
  const urineTest = db
    .prepare(`SELECT id FROM tests WHERE code = 'CLP-01' LIMIT 1`)
    .get() as { id: number } | undefined;

  if (urineTest) {
    const desiredUrine: Array<ParamSeed & { sort_order: number }> = [
      { name: 'Color', unit: '', input_type: 'text', normal_text: 'Pale Yellow', default_value: 'Pale Yellow', sort_order: 1 },
      { name: 'Appearance', unit: '', input_type: 'select', select_options: 'Clear,Slightly Turbid,Turbid', abnormal_values: 'Slightly Turbid,Turbid', normal_text: 'Clear', default_value: 'Clear', sort_order: 2 },
      { name: 'Sediment', unit: '', input_type: 'select', select_options: 'Nil,Trace,Present (+),Present (++)', abnormal_values: 'Present (+),Present (++)', normal_text: 'Nil', default_value: 'Nil', sort_order: 3 },
      { name: 'Specific Gravity', unit: '', input_type: 'numeric', min_male: 1.005, max_male: 1.03, min_female: 1.005, max_female: 1.03, normal_text: '1.005 - 1.030', default_value: '1.015', sort_order: 4 },
      { name: 'Reaction (pH)', unit: '', input_type: 'numeric', min_male: 4.5, max_male: 8.0, min_female: 4.5, max_female: 8.0, normal_text: '4.5 - 8.0', default_value: '6.0', sort_order: 5 },
      { name: 'Albumin (Protein)', unit: '', input_type: 'select', select_options: 'Nil,Trace,+,++,+++', abnormal_values: 'Trace,+,++,+++', normal_text: 'Nil', default_value: 'Nil', sort_order: 6 },
      { name: 'Sugar (Glucose)', unit: '', input_type: 'select', select_options: 'Nil,Trace,+,++,+++', abnormal_values: 'Trace,+,++,+++', normal_text: 'Nil', default_value: 'Nil', sort_order: 7 },
      { name: 'Ketone Bodies', unit: '', input_type: 'select', select_options: 'Absent,Trace,Present (+),Present (++)', abnormal_values: 'Trace,Present (+),Present (++)', normal_text: 'Absent', default_value: 'Absent', sort_order: 8 },
      { name: 'Bilirubin (Bile Pigment)', unit: '', input_type: 'select', select_options: 'Absent,Present', abnormal_values: 'Present', normal_text: 'Absent', default_value: 'Absent', sort_order: 9 },
      { name: 'Urobilinogen', unit: '', input_type: 'select', select_options: 'Normal,Increased', abnormal_values: 'Increased', normal_text: 'Normal', default_value: 'Normal', sort_order: 10 },
      { name: 'Nitrite', unit: '', input_type: 'select', select_options: 'Negative,Positive', abnormal_values: 'Positive', normal_text: 'Negative', default_value: 'Negative', sort_order: 11 },
      { name: 'Leukocyte Esterase', unit: '', input_type: 'select', select_options: 'Negative,Trace,Positive (+),Positive (++)', abnormal_values: 'Trace,Positive (+),Positive (++)', normal_text: 'Negative', default_value: 'Negative', sort_order: 12 },
      { name: 'Blood (Occult / Hemoglobin)', unit: '', input_type: 'select', select_options: 'Absent,Trace,Present (+),Present (++)', abnormal_values: 'Trace,Present (+),Present (++)', normal_text: 'Absent', default_value: 'Absent', sort_order: 13 },
      { name: 'Pus Cells', unit: '/HPF', input_type: 'numeric', min_male: 0, max_male: 5, min_female: 0, max_female: 5, normal_text: '0 - 5', default_value: '', sort_order: 14 },
      { name: 'Epithelial Cells', unit: '/HPF', input_type: 'numeric', min_male: 0, max_male: 5, min_female: 0, max_female: 5, normal_text: '0 - 5', default_value: '', sort_order: 15 },
      { name: 'RBCs', unit: '/HPF', input_type: 'numeric', min_male: 0, max_male: 2, min_female: 0, max_female: 2, normal_text: '0 - 2', default_value: '0', sort_order: 16 },
      { name: 'Casts', unit: '/LPF', input_type: 'select', select_options: 'Nil,Hyaline Casts,Granular Casts,WBC Casts,RBC Casts', abnormal_values: 'Granular Casts,WBC Casts,RBC Casts', normal_text: 'Nil', default_value: 'Nil', sort_order: 17 },
      { name: 'Crystals', unit: '', input_type: 'select', select_options: 'Nil,Calcium Oxalate,Uric Acid,Amorphous Urates,Triple Phosphate', abnormal_values: 'Calcium Oxalate,Uric Acid,Triple Phosphate', normal_text: 'Nil', default_value: 'Nil', sort_order: 18 },
      { name: 'Bacteria / Yeast Cells', unit: '', input_type: 'select', select_options: 'Nil,Few (+),Moderate (++),Plenty (+++)', abnormal_values: 'Few (+),Moderate (++),Plenty (+++)', normal_text: 'Nil', default_value: 'Nil', sort_order: 19 },
      { name: 'Mucus Threads', unit: '', input_type: 'select', select_options: 'Nil,Few,Moderate,Plenty', abnormal_values: 'Plenty', normal_text: 'Nil', default_value: 'Nil', sort_order: 20 },
      { name: 'Spermatozoa / Trichomonas', unit: '', input_type: 'select', select_options: 'Absent,Present', abnormal_values: 'Present', normal_text: 'Absent', default_value: 'Absent', sort_order: 21 },
    ];

    const existingUrine = db
      .prepare(`SELECT id, name FROM test_parameters WHERE test_id = ?`)
      .all(urineTest.id) as Array<{ id: number; name: string }>;

    const insParam = db.prepare(`
      INSERT INTO test_parameters (
        test_id, name, unit, input_type, normal_text, default_value, select_options, abnormal_values,
        min_male, max_male, min_female, max_female, min_child, max_child, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updParam = db.prepare(`UPDATE test_parameters SET default_value = ?, sort_order = ? WHERE id = ?`);

    const tx = db.transaction(() => {
      for (const dp of desiredUrine) {
        const found = existingUrine.find((p) => p.name.toLowerCase() === dp.name.toLowerCase());
        if (!found) {
          insParam.run(
            urineTest.id,
            dp.name,
            dp.unit,
            dp.input_type || 'numeric',
            dp.normal_text || '',
            dp.default_value ?? '',
            dp.select_options || '',
            dp.abnormal_values || '',
            dp.min_male ?? null,
            dp.max_male ?? null,
            dp.min_female ?? dp.min_male ?? null,
            dp.max_female ?? dp.max_male ?? null,
            dp.min_child ?? null,
            dp.max_child ?? null,
            dp.sort_order
          );
        } else {
          updParam.run(dp.default_value ?? '', dp.sort_order, found.id);
        }
      }

      // Backfill any pending/in-progress Urine R/E invoice_tests with new parameters & defaults
      const urineParams = db
        .prepare(`SELECT * FROM test_parameters WHERE test_id = ? ORDER BY sort_order ASC, id ASC`)
        .all(urineTest.id) as Array<{
        id: number;
        name: string;
        unit: string;
        input_type: string;
        abnormal_values: string;
        normal_text: string;
        default_value: string;
        min_male: number | null;
        max_male: number | null;
        min_female: number | null;
        max_female: number | null;
        min_child: number | null;
        max_child: number | null;
        sort_order: number;
      }>;

      const urineInvoiceTests = db
        .prepare(
          `SELECT it.id as invoice_test_id, it.status, p.gender, p.age_years
           FROM invoice_tests it
           JOIN invoices i ON i.id = it.invoice_id
           JOIN patients p ON p.id = i.patient_id
           WHERE it.test_id = ?`
        )
        .all(urineTest.id) as Array<{
        invoice_test_id: number;
        status: string;
        gender: string;
        age_years: number;
      }>;

      const insResult = db.prepare(
        `INSERT OR IGNORE INTO test_results (
          invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const updResultSort = db.prepare(
        `UPDATE test_results SET sort_order = ? WHERE invoice_test_id = ? AND parameter_id = ?`
      );
      const updBlankResult = db.prepare(
        `UPDATE test_results SET result_value = ?, flag = ?, reference_range_text = ? WHERE invoice_test_id = ? AND parameter_id = ? AND result_value = ''`
      );

      for (const uit of urineInvoiceTests) {
        const existingRows = db
          .prepare(`SELECT id, parameter_id, parameter_name, result_value FROM test_results WHERE invoice_test_id = ? ORDER BY sort_order ASC, id ASC`)
          .all(uit.invoice_test_id) as Array<{ id: number; parameter_id: number; parameter_name: string; result_value: string }>;

        const bestByCanon = new Map<string, typeof existingRows[number]>();
        const delDupRow = db.prepare(`DELETE FROM test_results WHERE id = ?`);
        for (const er of existingRows) {
          const key = getCanonicalParameterKey(er.parameter_name) || `pid:${er.parameter_id}`;
          const prev = bestByCanon.get(key);
          if (!prev) {
            bestByCanon.set(key, er);
          } else {
            const curHasVal = Boolean(er.result_value && er.result_value.trim() !== '' && er.result_value.trim().toLowerCase() !== 'pending');
            const prevHasVal = Boolean(prev.result_value && prev.result_value.trim() !== '' && prev.result_value.trim().toLowerCase() !== 'pending');
            if (curHasVal && !prevHasVal) {
              delDupRow.run(prev.id);
              bestByCanon.set(key, er);
            } else {
              delDupRow.run(er.id);
            }
          }
        }

        const dedupedRows = Array.from(bestByCanon.values());
        const existingIds = new Set(dedupedRows.map((r) => r.parameter_id));
        const existingCanon = new Map(dedupedRows.map((r) => [getCanonicalParameterKey(r.parameter_name), r]));

        for (const param of urineParams) {
          const canonKey = getCanonicalParameterKey(param.name);
          const defVal = uit.status !== 'Ready' ? param.default_value || '' : '';
          const evalRes = evaluateResultFlag(defVal, param, uit.gender, uit.age_years);
          const matched = existingIds.has(param.id)
            ? dedupedRows.find((r) => r.parameter_id === param.id)
            : existingCanon.get(canonKey);

          if (!matched) {
            insResult.run(
              uit.invoice_test_id,
              param.id,
              param.name,
              param.unit,
              defVal,
              evalRes.rangeLabel,
              evalRes.flag,
              param.sort_order
            );
            existingIds.add(param.id);
            if (canonKey) {
              existingCanon.set(canonKey, {
                id: -1,
                parameter_id: param.id,
                parameter_name: param.name,
                result_value: defVal,
              });
            }
          } else {
            updResultSort.run(param.sort_order, uit.invoice_test_id, matched.parameter_id);
            if (defVal) {
              updBlankResult.run(defVal, evalRes.flag, evalRes.rangeLabel, uit.invoice_test_id, matched.parameter_id);
            }
          }
        }
      }
    });
    tx();
  }

  // Also ensure Stool R/E defaults (keeping Pus Cells blank)
  const stoolTest = db
    .prepare(`SELECT id FROM tests WHERE code = 'CLP-02' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (stoolTest) {
    const stoolDefaults: Record<string, string> = {
      Color: 'Brownish',
      Consistency: 'Soft / Formed',
      Mucus: 'Absent',
      'Occult / Frank Blood': 'Absent',
      'Pus Cells': '',
      RBCs: '0',
      'Ova / Parasites': 'Not Found',
      Cyst: 'Not Found',
    };
    const updStool = db.prepare(`UPDATE test_parameters SET default_value = ? WHERE test_id = ? AND name = ?`);
    const txStool = db.transaction(() => {
      for (const [name, def] of Object.entries(stoolDefaults)) {
        updStool.run(def, stoolTest.id, name);
      }
    });
    txStool();
  }
}

export function resolveReferenceRange(
  param: {
    normal_text: string;
    min_male: number | null;
    max_male: number | null;
    min_female: number | null;
    max_female: number | null;
    min_child: number | null;
    max_child: number | null;
    min_newborn?: number | null;
    max_newborn?: number | null;
    input_type: string;
  },
  gender: string,
  ageYears: number,
  ageMonths = 0,
  ageDays = 0
): { min: number | null; max: number | null; label: string } {
  if (param.input_type !== 'numeric') {
    return { min: null, max: null, label: param.normal_text || '-' };
  }

  let min: number | null = param.min_male;
  let max: number | null = param.max_male;

  const isNewborn = ageYears === 0 && ageMonths === 0 && ageDays <= 28;
  const minNb = param.min_newborn ?? null;
  const maxNb = param.max_newborn ?? null;

  if (isNewborn && (minNb !== null || maxNb !== null)) {
    min = minNb;
    max = maxNb;
  } else if (ageYears < 12 && (param.min_child !== null || param.max_child !== null)) {
    min = param.min_child;
    max = param.max_child;
  } else if (gender.toLowerCase() === 'female' && (param.min_female !== null || param.max_female !== null)) {
    min = param.min_female;
    max = param.max_female;
  }

  let label = param.normal_text || '';
  if (
    param.normal_text &&
    (param.normal_text.includes('Newborn:') || param.normal_text.includes('Child:') || param.normal_text.includes('\n'))
  ) {
    label = param.normal_text;
  } else if (min !== null && max !== null) {
    label = `${min} - ${max}`;
  } else if (max !== null) {
    label = `< ${max}`;
  } else if (min !== null) {
    label = `> ${min}`;
  }

  return { min, max, label };
}

export function evaluateResultFlag(
  value: string,
  param: {
    input_type: string;
    abnormal_values: string;
    normal_text: string;
    min_male: number | null;
    max_male: number | null;
    min_female: number | null;
    max_female: number | null;
    min_child: number | null;
    max_child: number | null;
    min_newborn?: number | null;
    max_newborn?: number | null;
  },
  gender: string,
  ageYears: number,
  ageMonths = 0,
  ageDays = 0
): { flag: 'Normal' | 'High' | 'Low' | 'Abnormal'; rangeLabel: string } {
  const trimmed = value.trim();
  const resolved = resolveReferenceRange(param, gender, ageYears, ageMonths, ageDays);

  if (!trimmed) {
    return { flag: 'Normal', rangeLabel: resolved.label };
  }

  if (param.input_type === 'numeric') {
    const num = Number(trimmed.replace(/,/g, ''));
    if (!Number.isNaN(num)) {
      if (resolved.min !== null && num < resolved.min) {
        return { flag: 'Low', rangeLabel: resolved.label };
      }
      if (resolved.max !== null && num > resolved.max) {
        return { flag: 'High', rangeLabel: resolved.label };
      }
      return { flag: 'Normal', rangeLabel: resolved.label };
    }
  }

  if (param.abnormal_values) {
    const abnormalList = param.abnormal_values
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (abnormalList.includes(trimmed.toLowerCase())) {
      return { flag: 'Abnormal', rangeLabel: resolved.label };
    }
  }

  return { flag: 'Normal', rangeLabel: resolved.label };
}
