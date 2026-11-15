import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encryptPortalPassword, generatePortalPassword, hashPassword } from './auth.ts';

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
  `);

  migratePatientPortalColumns();
  migrateTestParameterDefaults();
  seedDefaultSettings();
  seedCatalogIfEmpty();
  seedInitialOperationalDataIfEmpty();
  migrateCbcParameters();
  migrateUrineReParameters();
  ensurePatientPortalCredentials();
}

function migrateTestParameterDefaults() {
  const cols = db.prepare(`PRAGMA table_info(test_parameters)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('default_value')) {
    db.exec(`ALTER TABLE test_parameters ADD COLUMN default_value TEXT DEFAULT ''`);
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
}

function ensurePatientPortalCredentials() {
  const secret = getSetting('auth_secret');
  if (!secret) return;
  const rows = db
    .prepare(`SELECT id, patient_uid FROM patients WHERE portal_password_hash = '' OR portal_password_hash IS NULL`)
    .all() as Array<{ id: number; patient_uid: string }>;
  if (rows.length === 0) return;

  const upd = db.prepare(`UPDATE patients SET portal_password_hash = ?, portal_password_enc = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const plain = r.patient_uid === 'ALEA-2601' ? 'ALEA61' : generatePortalPassword();
      upd.run(hashPassword(plain), encryptPortalPassword(plain, secret), r.id);
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
    max_staff_discount_pct: '15',
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
      r.key === 'auth_secret'
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

  const catalog: Array<{ category: string; sort_order: number; tests: TestSeed[] }> = [
    {
      category: 'Hematology',
      sort_order: 1,
      tests: [
        {
          code: 'HEM-01',
          name: 'CBC (Complete Blood Count)',
          price: 500,
          sample_type: 'Whole Blood (EDTA)',
          parameters: [
            { name: 'Hemoglobin (Hb)', unit: 'g/dL', min_male: 13.0, max_male: 17.0, min_female: 12.0, max_female: 15.5, min_child: 11.0, max_child: 14.5, normal_text: 'M: 13.0-17.0 | F: 12.0-15.5' },
            { name: 'PCV (Hematocrit)', unit: '%', min_male: 40, max_male: 54, min_female: 36, max_female: 48, min_child: 32, max_child: 44, normal_text: 'M: 40-54 | F: 36-48' },
            { name: 'Total WBC Count', unit: '/cumm', min_male: 4000, max_male: 11000, min_female: 4000, max_female: 11000, min_child: 5000, max_child: 13000, normal_text: '4,000 - 11,000' },
            { name: 'Total RBC Count', unit: 'million/cumm', min_male: 4.5, max_male: 5.9, min_female: 4.0, max_female: 5.2, min_child: 4.0, max_child: 5.3, normal_text: 'M: 4.5-5.9 | F: 4.0-5.2' },
            { name: 'Platelet Count', unit: '/cumm', min_male: 150000, max_male: 450000, min_female: 150000, max_female: 450000, min_child: 150000, max_child: 450000, normal_text: '150,000 - 450,000' },
            { name: 'MCV', unit: 'fL', min_male: 80, max_male: 100, min_female: 80, max_female: 100, min_child: 75, max_child: 95, normal_text: '80 - 100' },
            { name: 'MCH', unit: 'pg', min_male: 27, max_male: 32, min_female: 27, max_female: 32, min_child: 25, max_child: 31, normal_text: '27 - 32' },
            { name: 'MCHC', unit: 'g/dL', min_male: 32, max_male: 36, min_female: 32, max_female: 36, min_child: 32, max_child: 36, normal_text: '32 - 36' },
            { name: 'Neutrophils', unit: '%', min_male: 40, max_male: 75, min_female: 40, max_female: 75, min_child: 35, max_child: 65, normal_text: '40 - 75' },
            { name: 'Lymphocytes', unit: '%', min_male: 20, max_male: 45, min_female: 20, max_female: 45, min_child: 25, max_child: 55, normal_text: '20 - 45' },
            { name: 'Monocytes', unit: '%', min_male: 2, max_male: 10, min_female: 2, max_female: 10, min_child: 2, max_child: 10, normal_text: '2 - 10' },
            { name: 'Eosinophils', unit: '%', min_male: 1, max_male: 6, min_female: 1, max_female: 6, min_child: 1, max_child: 6, normal_text: '1 - 6' },
            { name: 'Basophils', unit: '%', min_male: 0, max_male: 1, min_female: 0, max_female: 1, min_child: 0, max_child: 1, normal_text: '0 - 1' },
            { name: 'Total Circulating Eosinophil Count', unit: '/cumm', min_male: 40, max_male: 440, min_female: 40, max_female: 440, min_child: 40, max_child: 440, normal_text: '40 - 440' },
            { name: 'ESR (1st Hour)', unit: 'mm/1st hr', min_male: 0, max_male: 15, min_female: 0, max_female: 20, min_child: 0, max_child: 10, normal_text: 'M: 0-15 | F: 0-20' },
          ],
        },
        {
          code: 'HEM-02',
          name: 'ESR (Westergren)',
          price: 150,
          sample_type: 'Whole Blood (EDTA)',
          parameters: [
            { name: 'ESR (1st Hour)', unit: 'mm/1st hr', min_male: 0, max_male: 15, min_female: 0, max_female: 20, min_child: 0, max_child: 10, normal_text: 'M: 0-15 | F: 0-20' },
          ],
        },
        {
          code: 'HEM-03',
          name: 'Blood Grouping & Rh Typing',
          price: 150,
          sample_type: 'Whole Blood',
          parameters: [
            { name: 'ABO Blood Group', unit: '', input_type: 'select', select_options: 'A,B,AB,O', normal_text: 'Qualitative' },
            { name: 'Rh (D) Factor', unit: '', input_type: 'select', select_options: 'Positive,Negative', normal_text: 'Qualitative' },
          ],
        },
      ],
    },
    {
      category: 'Biochemistry',
      sort_order: 2,
      tests: [
        {
          code: 'BIO-01',
          name: 'Fasting Blood Sugar (FBS)',
          price: 150,
          sample_type: 'Fluoride Plasma / Serum',
          parameters: [
            { name: 'Fasting Plasma Glucose', unit: 'mg/dL', min_male: 70, max_male: 100, min_female: 70, max_female: 100, min_child: 70, max_child: 100, normal_text: '70 - 100' },
          ],
        },
        {
          code: 'BIO-02',
          name: 'Random Blood Sugar (RBS)',
          price: 150,
          sample_type: 'Fluoride Plasma / Serum',
          parameters: [
            { name: 'Random Plasma Glucose', unit: 'mg/dL', min_male: 70, max_male: 140, min_female: 70, max_female: 140, min_child: 70, max_child: 140, normal_text: '70 - 140' },
          ],
        },
        {
          code: 'BIO-03',
          name: 'HbA1c (Glycated Hemoglobin)',
          price: 900,
          sample_type: 'Whole Blood (EDTA)',
          parameters: [
            { name: 'HbA1c', unit: '%', min_male: 4.0, max_male: 5.6, min_female: 4.0, max_female: 5.6, min_child: 4.0, max_child: 5.6, normal_text: '4.0 - 5.6 (Non-Diabetic)' },
          ],
        },
        {
          code: 'BIO-04',
          name: 'Lipid Profile',
          price: 1000,
          sample_type: 'Serum (Fasting)',
          parameters: [
            { name: 'Total Cholesterol', unit: 'mg/dL', min_male: 0, max_male: 200, min_female: 0, max_female: 200, normal_text: '< 200' },
            { name: 'Triglycerides (TG)', unit: 'mg/dL', min_male: 0, max_male: 150, min_female: 0, max_female: 150, normal_text: '< 150' },
            { name: 'HDL Cholesterol', unit: 'mg/dL', min_male: 40, max_male: 100, min_female: 50, max_female: 100, normal_text: 'M: >40 | F: >50' },
            { name: 'LDL Cholesterol', unit: 'mg/dL', min_male: 0, max_male: 100, min_female: 0, max_female: 100, normal_text: '< 100' },
          ],
        },
        {
          code: 'BIO-05',
          name: 'Liver Function Test (LFT)',
          price: 900,
          sample_type: 'Serum',
          parameters: [
            { name: 'SGPT (ALT)', unit: 'U/L', min_male: 0, max_male: 41, min_female: 0, max_female: 33, normal_text: 'M: <41 | F: <33' },
            { name: 'SGOT (AST)', unit: 'U/L', min_male: 0, max_male: 40, min_female: 0, max_female: 32, normal_text: 'M: <40 | F: <32' },
            { name: 'Serum Bilirubin (Total)', unit: 'mg/dL', min_male: 0.2, max_male: 1.2, min_female: 0.2, max_female: 1.2, normal_text: '0.2 - 1.2' },
            { name: 'Alkaline Phosphatase (ALP)', unit: 'U/L', min_male: 44, max_male: 147, min_female: 44, max_female: 147, normal_text: '44 - 147' },
          ],
        },
        {
          code: 'BIO-06',
          name: 'Kidney Function Test (KFT)',
          price: 800,
          sample_type: 'Serum',
          parameters: [
            { name: 'Serum Creatinine', unit: 'mg/dL', min_male: 0.7, max_male: 1.3, min_female: 0.6, max_female: 1.1, min_child: 0.3, max_child: 0.7, normal_text: 'M: 0.7-1.3 | F: 0.6-1.1' },
            { name: 'Blood Urea', unit: 'mg/dL', min_male: 15, max_male: 45, min_female: 15, max_female: 45, normal_text: '15 - 45' },
            { name: 'Serum Uric Acid', unit: 'mg/dL', min_male: 3.5, max_male: 7.2, min_female: 2.6, max_female: 6.0, normal_text: 'M: 3.5-7.2 | F: 2.6-6.0' },
          ],
        },
      ],
    },
    {
      category: 'Serology & Immunology',
      sort_order: 3,
      tests: [
        {
          code: 'SER-01',
          name: 'HBsAg (Screening / ICT)',
          price: 400,
          sample_type: 'Serum',
          parameters: [
            { name: 'HBsAg (ICT)', unit: '', input_type: 'select', select_options: 'Non-Reactive,Reactive', abnormal_values: 'Reactive', normal_text: 'Non-Reactive' },
          ],
        },
        {
          code: 'SER-02',
          name: 'Anti-HCV (ICT)',
          price: 600,
          sample_type: 'Serum',
          parameters: [
            { name: 'Anti-HCV', unit: '', input_type: 'select', select_options: 'Non-Reactive,Reactive', abnormal_values: 'Reactive', normal_text: 'Non-Reactive' },
          ],
        },
        {
          code: 'SER-03',
          name: 'Widal Test',
          price: 400,
          sample_type: 'Serum',
          parameters: [
            { name: 'S. Typhi "O" Antigen', unit: 'Titre', input_type: 'select', select_options: '< 1:80,1:80,1:160,1:320', abnormal_values: '1:160,1:320', normal_text: '< 1:80' },
            { name: 'S. Typhi "H" Antigen', unit: 'Titre', input_type: 'select', select_options: '< 1:80,1:80,1:160,1:320', abnormal_values: '1:160,1:320', normal_text: '< 1:80' },
            { name: 'S. Paratyphi "AH"', unit: 'Titre', input_type: 'select', select_options: '< 1:80,1:80,1:160,1:320', abnormal_values: '1:160,1:320', normal_text: '< 1:80' },
            { name: 'S. Paratyphi "BH"', unit: 'Titre', input_type: 'select', select_options: '< 1:80,1:80,1:160,1:320', abnormal_values: '1:160,1:320', normal_text: '< 1:80' },
          ],
        },
        {
          code: 'SER-04',
          name: 'CRP (C-Reactive Protein)',
          price: 500,
          sample_type: 'Serum',
          parameters: [
            { name: 'CRP (Quantitative)', unit: 'mg/L', min_male: 0, max_male: 6.0, min_female: 0, max_female: 6.0, normal_text: '< 6.0' },
          ],
        },
        {
          code: 'SER-05',
          name: 'RA Factor (Rheumatoid Factor)',
          price: 450,
          sample_type: 'Serum',
          parameters: [
            { name: 'RA Factor', unit: 'IU/mL', min_male: 0, max_male: 14.0, min_female: 0, max_female: 14.0, normal_text: '< 14.0' },
          ],
        },
        {
          code: 'SER-06',
          name: 'Dengue Panel (NS1, IgM, IgG)',
          price: 1200,
          sample_type: 'Serum',
          parameters: [
            { name: 'Dengue NS1 Antigen', unit: '', input_type: 'select', select_options: 'Negative,Positive', abnormal_values: 'Positive', normal_text: 'Negative' },
            { name: 'Dengue IgM Antibody', unit: '', input_type: 'select', select_options: 'Negative,Positive', abnormal_values: 'Positive', normal_text: 'Negative' },
            { name: 'Dengue IgG Antibody', unit: '', input_type: 'select', select_options: 'Negative,Positive', abnormal_values: 'Positive', normal_text: 'Negative' },
          ],
        },
      ],
    },
    {
      category: 'Clinical Pathology',
      sort_order: 4,
      tests: [
        {
          code: 'CLP-01',
          name: 'Urine R/E (Routine Examination)',
          price: 200,
          sample_type: 'Mid-stream Urine',
          parameters: [
            { name: 'Color', unit: '', input_type: 'text', normal_text: 'Pale Yellow', default_value: 'Pale Yellow' },
            { name: 'Appearance', unit: '', input_type: 'select', select_options: 'Clear,Slightly Turbid,Turbid', abnormal_values: 'Slightly Turbid,Turbid', normal_text: 'Clear', default_value: 'Clear' },
            { name: 'Sediment', unit: '', input_type: 'select', select_options: 'Nil,Trace,Present (+),Present (++)', abnormal_values: 'Present (+),Present (++)', normal_text: 'Nil', default_value: 'Nil' },
            { name: 'Specific Gravity', unit: '', min_male: 1.005, max_male: 1.03, min_female: 1.005, max_female: 1.03, normal_text: '1.005 - 1.030', default_value: '1.015' },
            { name: 'Reaction (pH)', unit: '', min_male: 4.5, max_male: 8.0, min_female: 4.5, max_female: 8.0, normal_text: '4.5 - 8.0', default_value: '6.0' },
            { name: 'Albumin (Protein)', unit: '', input_type: 'select', select_options: 'Nil,Trace,+,++,+++', abnormal_values: 'Trace,+,++,+++', normal_text: 'Nil', default_value: 'Nil' },
            { name: 'Sugar (Glucose)', unit: '', input_type: 'select', select_options: 'Nil,Trace,+,++,+++', abnormal_values: 'Trace,+,++,+++', normal_text: 'Nil', default_value: 'Nil' },
            { name: 'Ketone Bodies', unit: '', input_type: 'select', select_options: 'Absent,Trace,Present (+),Present (++)', abnormal_values: 'Trace,Present (+),Present (++)', normal_text: 'Absent', default_value: 'Absent' },
            { name: 'Bilirubin (Bile Pigment)', unit: '', input_type: 'select', select_options: 'Absent,Present', abnormal_values: 'Present', normal_text: 'Absent', default_value: 'Absent' },
            { name: 'Urobilinogen', unit: '', input_type: 'select', select_options: 'Normal,Increased', abnormal_values: 'Increased', normal_text: 'Normal', default_value: 'Normal' },
            { name: 'Nitrite', unit: '', input_type: 'select', select_options: 'Negative,Positive', abnormal_values: 'Positive', normal_text: 'Negative', default_value: 'Negative' },
            { name: 'Leukocyte Esterase', unit: '', input_type: 'select', select_options: 'Negative,Trace,Positive (+),Positive (++)', abnormal_values: 'Trace,Positive (+),Positive (++)', normal_text: 'Negative', default_value: 'Negative' },
            { name: 'Blood (Occult / Hemoglobin)', unit: '', input_type: 'select', select_options: 'Absent,Trace,Present (+),Present (++)', abnormal_values: 'Trace,Present (+),Present (++)', normal_text: 'Absent', default_value: 'Absent' },
            { name: 'Pus Cells', unit: '/HPF', min_male: 0, max_male: 5, min_female: 0, max_female: 5, normal_text: '0 - 5', default_value: '' },
            { name: 'Epithelial Cells', unit: '/HPF', min_male: 0, max_male: 5, min_female: 0, max_female: 5, normal_text: '0 - 5', default_value: '' },
            { name: 'RBCs', unit: '/HPF', min_male: 0, max_male: 2, min_female: 0, max_female: 2, normal_text: '0 - 2', default_value: '0' },
            { name: 'Casts', unit: '/LPF', input_type: 'select', select_options: 'Nil,Hyaline Casts,Granular Casts,WBC Casts,RBC Casts', abnormal_values: 'Granular Casts,WBC Casts,RBC Casts', normal_text: 'Nil', default_value: 'Nil' },
            { name: 'Crystals', unit: '', input_type: 'select', select_options: 'Nil,Calcium Oxalate,Uric Acid,Amorphous Urates,Triple Phosphate', abnormal_values: 'Calcium Oxalate,Uric Acid,Triple Phosphate', normal_text: 'Nil', default_value: 'Nil' },
            { name: 'Bacteria / Yeast Cells', unit: '', input_type: 'select', select_options: 'Nil,Few (+),Moderate (++),Plenty (+++)', abnormal_values: 'Few (+),Moderate (++),Plenty (+++)', normal_text: 'Nil', default_value: 'Nil' },
            { name: 'Mucus Threads', unit: '', input_type: 'select', select_options: 'Nil,Few,Moderate,Plenty', abnormal_values: 'Plenty', normal_text: 'Nil', default_value: 'Nil' },
            { name: 'Spermatozoa / Trichomonas', unit: '', input_type: 'select', select_options: 'Absent,Present', abnormal_values: 'Present', normal_text: 'Absent', default_value: 'Absent' },
          ],
        },
        {
          code: 'CLP-02',
          name: 'Stool R/E (Routine Examination)',
          price: 200,
          sample_type: 'Fresh Stool',
          parameters: [
            { name: 'Color', unit: '', input_type: 'text', normal_text: 'Brownish', default_value: 'Brownish' },
            { name: 'Consistency', unit: '', input_type: 'select', select_options: 'Soft / Formed,Loose,Watery,Hard', abnormal_values: 'Watery,Loose', normal_text: 'Soft / Formed', default_value: 'Soft / Formed' },
            { name: 'Mucus', unit: '', input_type: 'select', select_options: 'Absent,Present (+),Present (++)', abnormal_values: 'Present (+),Present (++)', normal_text: 'Absent', default_value: 'Absent' },
            { name: 'Occult / Frank Blood', unit: '', input_type: 'select', select_options: 'Absent,Present', abnormal_values: 'Present', normal_text: 'Absent', default_value: 'Absent' },
            { name: 'Pus Cells', unit: '/HPF', min_male: 0, max_male: 3, min_female: 0, max_female: 3, normal_text: '0 - 3', default_value: '' },
            { name: 'RBCs', unit: '/HPF', min_male: 0, max_male: 1, min_female: 0, max_female: 1, normal_text: '0 - 1', default_value: '0' },
            { name: 'Ova / Parasites', unit: '', input_type: 'select', select_options: 'Not Found,Found', abnormal_values: 'Found', normal_text: 'Not Found', default_value: 'Not Found' },
            { name: 'Cyst', unit: '', input_type: 'select', select_options: 'Not Found,Found', abnormal_values: 'Found', normal_text: 'Not Found', default_value: 'Not Found' },
          ],
        },
      ],
    },
  ];

  const insCat = db.prepare('INSERT INTO test_categories (name, sort_order) VALUES (?, ?)');
  const insTest = db.prepare('INSERT INTO tests (category_id, code, name, price, sample_type) VALUES (?, ?, ?, ?, ?)');
  const insParam = db.prepare(`
    INSERT INTO test_parameters (
      test_id, name, unit, input_type, normal_text, default_value, select_options, abnormal_values,
      min_male, max_male, min_female, max_female, min_child, max_child, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const group of catalog) {
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
            idx + 1
          );
        });
      }
    }
  });
  tx();
}

function seedInitialOperationalDataIfEmpty() {
  const docCount = (db.prepare('SELECT COUNT(*) as c FROM doctors').get() as { c: number }).c;
  if (docCount > 0) return;

  const insDoc = db.prepare(
    'INSERT INTO doctors (name, degree, hospital, mobile, commission_pct) VALUES (?, ?, ?, ?, ?)'
  );
  const d1 = Number(insDoc.run('Dr. Kamrul Hasan', 'MBBS, BCS (Health), FCPS (Medicine)', 'Kushtia General Hospital', '01711-234561', 20).lastInsertRowid);
  const d2 = Number(insDoc.run('Dr. Nusrat Jahan', 'MBBS, DGO (Gynae & Obs)', 'Mirpur Upazila Health Complex', '01712-987654', 25).lastInsertRowid);
  const d3 = Number(insDoc.run('Dr. Mahfuzur Rahman', 'MBBS, MD (Cardiology)', 'Halasa Specialized Clinic', '01819-445566', 20).lastInsertRowid);
  insDoc.run('Self / Walk-in Patient', 'Direct Visit', 'Alea Diagnostic Services', '', 0);

  const todayStr = new Date().toISOString().slice(0, 10);
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
      insPatient.run('ALEA-2601', 'Md. Rafiqul Islam', 46, 0, 0, 'Male', '01715-882211', 'Halasa Bazar, Mirpur', `${todayStr} 09:15:00`).lastInsertRowid
    );
    const inv1 = Number(
      insInvoice.run('INV-26001', p1, d1, 650, 'flat', 50, 50, 600, 600, 0, 'Paid', 20, 120, 'Staff', `${todayStr} 09:16:00`).lastInsertRowid
    );

    const cbc = getTestByCode('HEM-01');
    const it1 = Number(
      insInvTest.run(inv1, cbc.id, cbc.name, cbc.category_name, cbc.sample_type, cbc.price, 'Ready', `${todayStr} 09:20:00`, `${todayStr} 10:45:00`, `${todayStr} 11:00:00`, 'Md. Tariqul Islam').lastInsertRowid
    );
    const cbcSampleValues: Record<string, { val: string; flag: string }> = {
      'Hemoglobin (Hb)': { val: '11.4', flag: 'Low' },
      'PCV (Hematocrit)': { val: '35.5', flag: 'Low' },
      'Total WBC Count': { val: '13200', flag: 'High' },
      'Total RBC Count': { val: '4.6', flag: 'Normal' },
      'Platelet Count': { val: '265000', flag: 'Normal' },
      MCV: { val: '86', flag: 'Normal' },
      MCH: { val: '28.5', flag: 'Normal' },
      MCHC: { val: '33.2', flag: 'Normal' },
      Neutrophils: { val: '78', flag: 'High' },
      Lymphocytes: { val: '16', flag: 'Low' },
      Monocytes: { val: '4', flag: 'Normal' },
      Eosinophils: { val: '2', flag: 'Normal' },
      Basophils: { val: '0', flag: 'Normal' },
      'Total Circulating Eosinophil Count': { val: '264', flag: 'Normal' },
      'ESR (1st Hour)': { val: '28', flag: 'High' },
    };
    for (const param of getParams(cbc.id)) {
      const sample = cbcSampleValues[param.name] || { val: '', flag: 'Normal' };
      insResult.run(it1, param.id, param.name, param.unit, sample.val, param.normal_text || '13.0 - 17.0', sample.flag, param.sort_order);
    }

    const fbs = getTestByCode('BIO-01');
    const it2 = Number(
      insInvTest.run(inv1, fbs.id, fbs.name, fbs.category_name, fbs.sample_type, fbs.price, 'Ready', `${todayStr} 09:20:00`, `${todayStr} 10:45:00`, `${todayStr} 11:00:00`, 'Md. Tariqul Islam').lastInsertRowid
    );
    for (const param of getParams(fbs.id)) {
      insResult.run(it2, param.id, param.name, param.unit, '158', '70 - 100', 'High', param.sort_order);
    }

    // Historical visit for Patient 1 (12 days ago) for Date-Wise Medical History archive
    const pastDate = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
    const inv1Past = Number(
      insInvoice.run('INV-25984', p1, d3, 1000, 'flat', 0, 0, 1000, 1000, 0, 'Paid', 20, 200, 'Staff', `${pastDate} 10:30:00`).lastInsertRowid
    );
    const lipidPast = getTestByCode('BIO-04');
    const it1Past = Number(
      insInvTest.run(inv1Past, lipidPast.id, lipidPast.name, lipidPast.category_name, lipidPast.sample_type, lipidPast.price, 'Ready', `${pastDate} 10:35:00`, `${pastDate} 13:10:00`, `${pastDate} 13:30:00`, 'Md. Tariqul Islam').lastInsertRowid
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
      insPatient.run('ALEA-2602', 'Mst. Amena Khatun', 32, 0, 0, 'Female', '01914-334455', 'Bank Mor, Mirpur', `${todayStr} 10:10:00`).lastInsertRowid
    );
    const inv2 = Number(
      insInvoice.run('INV-26002', p2, d2, 1300, 'percent', 10, 130, 1170, 700, 470, 'Partial', 25, 292.5, 'Staff', `${todayStr} 10:12:00`).lastInsertRowid
    );
    const lft = getTestByCode('BIO-05');
    const it3 = Number(
      insInvTest.run(inv2, lft.id, lft.name, lft.category_name, lft.sample_type, lft.price, 'Processing', `${todayStr} 10:20:00`, null, null, '').lastInsertRowid
    );
    for (const param of getParams(lft.id)) {
      insResult.run(it3, param.id, param.name, param.unit, '', param.normal_text, 'Normal', param.sort_order);
    }
    const hbsag = getTestByCode('SER-01');
    const it4 = Number(
      insInvTest.run(inv2, hbsag.id, hbsag.name, hbsag.category_name, hbsag.sample_type, hbsag.price, 'Sample Collected', `${todayStr} 10:20:00`, null, null, '').lastInsertRowid
    );
    for (const param of getParams(hbsag.id)) {
      insResult.run(it4, param.id, param.name, param.unit, '', param.normal_text, 'Normal', param.sort_order);
    }

    // Patient 3 - Sample Collected + Paid
    const p3 = Number(
      insPatient.run('ALEA-2603', 'Md. Sohag Ali', 28, 0, 0, 'Male', '01788-556677', 'Poradaha, Mirpur', `${todayStr} 11:05:00`).lastInsertRowid
    );
    const inv3 = Number(
      insInvoice.run('INV-26003', p3, d3, 1800, 'flat', 0, 0, 1800, 1800, 0, 'Paid', 20, 360, 'Staff', `${todayStr} 11:06:00`).lastInsertRowid
    );
    const lipid = getTestByCode('BIO-04');
    const it5 = Number(
      insInvTest.run(inv3, lipid.id, lipid.name, lipid.category_name, lipid.sample_type, lipid.price, 'Sample Collected', `${todayStr} 11:12:00`, null, null, '').lastInsertRowid
    );
    for (const param of getParams(lipid.id)) {
      insResult.run(it5, param.id, param.name, param.unit, '', param.normal_text, 'Normal', param.sort_order);
    }
    const kft = getTestByCode('BIO-06');
    const it6 = Number(
      insInvTest.run(inv3, kft.id, kft.name, kft.category_name, kft.sample_type, kft.price, 'Verified', `${todayStr} 11:12:00`, `${todayStr} 12:15:00`, null, 'Md. Tariqul Islam').lastInsertRowid
    );
    for (const param of getParams(kft.id)) {
      const val = param.name === 'Serum Creatinine' ? '1.1' : param.name === 'Blood Urea' ? '32' : '5.8';
      insResult.run(it6, param.id, param.name, param.unit, val, param.normal_text, 'Normal', param.sort_order);
    }

    // Initial expenses
    const insExp = db.prepare('INSERT INTO expenses (title, category, amount, expense_date, note) VALUES (?, ?, ?, ?, ?)');
    insExp.run('CBC & Biochemistry Reagents Restock', 'Reagents & Kits', 1450, todayStr, 'Mindray diluent & glucose reagent');
    insExp.run('Sample Collection Tubes & Needles', 'Consumables', 420, todayStr, 'EDTA & Clot activator tubes');
  });
  tx();
}

function migrateCbcParameters() {
  const cbcTest = db
    .prepare(`SELECT id FROM tests WHERE code = 'HEM-01' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!cbcTest) return;

  const desiredParams: Array<ParamSeed & { sort_order: number }> = [
    { name: 'Hemoglobin (Hb)', unit: 'g/dL', min_male: 13.0, max_male: 17.0, min_female: 12.0, max_female: 15.5, min_child: 11.0, max_child: 14.5, normal_text: 'M: 13.0-17.0 | F: 12.0-15.5', sort_order: 1 },
    { name: 'PCV (Hematocrit)', unit: '%', min_male: 40, max_male: 54, min_female: 36, max_female: 48, min_child: 32, max_child: 44, normal_text: 'M: 40-54 | F: 36-48', sort_order: 2 },
    { name: 'Total WBC Count', unit: '/cumm', min_male: 4000, max_male: 11000, min_female: 4000, max_female: 11000, min_child: 5000, max_child: 13000, normal_text: '4,000 - 11,000', sort_order: 3 },
    { name: 'Total RBC Count', unit: 'million/cumm', min_male: 4.5, max_male: 5.9, min_female: 4.0, max_female: 5.2, min_child: 4.0, max_child: 5.3, normal_text: 'M: 4.5-5.9 | F: 4.0-5.2', sort_order: 4 },
    { name: 'Platelet Count', unit: '/cumm', min_male: 150000, max_male: 450000, min_female: 150000, max_female: 450000, min_child: 150000, max_child: 450000, normal_text: '150,000 - 450,000', sort_order: 5 },
    { name: 'MCV', unit: 'fL', min_male: 80, max_male: 100, min_female: 80, max_female: 100, min_child: 75, max_child: 95, normal_text: '80 - 100', sort_order: 6 },
    { name: 'MCH', unit: 'pg', min_male: 27, max_male: 32, min_female: 27, max_female: 32, min_child: 25, max_child: 31, normal_text: '27 - 32', sort_order: 7 },
    { name: 'MCHC', unit: 'g/dL', min_male: 32, max_male: 36, min_female: 32, max_female: 36, min_child: 32, max_child: 36, normal_text: '32 - 36', sort_order: 8 },
    { name: 'Neutrophils', unit: '%', min_male: 40, max_male: 75, min_female: 40, max_female: 75, min_child: 35, max_child: 65, normal_text: '40 - 75', sort_order: 9 },
    { name: 'Lymphocytes', unit: '%', min_male: 20, max_male: 45, min_female: 20, max_female: 45, min_child: 25, max_child: 55, normal_text: '20 - 45', sort_order: 10 },
    { name: 'Monocytes', unit: '%', min_male: 2, max_male: 10, min_female: 2, max_female: 10, min_child: 2, max_child: 10, normal_text: '2 - 10', sort_order: 11 },
    { name: 'Eosinophils', unit: '%', min_male: 1, max_male: 6, min_female: 1, max_female: 6, min_child: 1, max_child: 6, normal_text: '1 - 6', sort_order: 12 },
    { name: 'Basophils', unit: '%', min_male: 0, max_male: 1, min_female: 0, max_female: 1, min_child: 0, max_child: 1, normal_text: '0 - 1', sort_order: 13 },
    { name: 'Total Circulating Eosinophil Count', unit: '/cumm', min_male: 40, max_male: 440, min_female: 40, max_female: 440, min_child: 40, max_child: 440, normal_text: '40 - 440', sort_order: 14 },
    { name: 'ESR (1st Hour)', unit: 'mm/1st hr', min_male: 0, max_male: 15, min_female: 0, max_female: 20, min_child: 0, max_child: 10, normal_text: 'M: 0-15 | F: 0-20', sort_order: 15 },
  ];

  const existingParams = db
    .prepare(`SELECT id, name FROM test_parameters WHERE test_id = ?`)
    .all(cbcTest.id) as Array<{ id: number; name: string }>;

  const findExistingParam = (targetName: string) => {
    const lower = targetName.toLowerCase();
    return existingParams.find((p) => {
      const pn = p.name.toLowerCase();
      if (pn === lower) return true;
      if (lower.startsWith('pcv') && (pn.includes('pcv') || pn.includes('hematocrit'))) return true;
      if (lower.includes('circulating eosinophil') && pn.includes('circulating eosinophil')) return true;
      if (lower.startsWith('esr') && pn.startsWith('esr')) return true;
      return false;
    });
  };

  const insParam = db.prepare(`
    INSERT INTO test_parameters (
      test_id, name, unit, input_type, normal_text, select_options, abnormal_values,
      min_male, max_male, min_female, max_female, min_child, max_child, sort_order
    ) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?)
  `);
  const updSort = db.prepare(`UPDATE test_parameters SET sort_order = ? WHERE id = ?`);

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
          dp.sort_order
        );
      } else {
        updSort.run(dp.sort_order, found.id);
      }
    }

    // Backfill any missing CBC parameters into existing invoice_tests for HEM-01
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
      sort_order: number;
    }>;

    const cbcInvoiceTests = db
      .prepare(
        `SELECT it.id as invoice_test_id, it.status, i.invoice_no, p.gender, p.age_years
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
    }>;

    const insResult = db.prepare(
      `INSERT OR IGNORE INTO test_results (
        invoice_test_id, parameter_id, parameter_name, unit, result_value, reference_range_text, flag, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updResultSort = db.prepare(
      `UPDATE test_results SET sort_order = ? WHERE invoice_test_id = ? AND parameter_id = ?`
    );

    for (const cit of cbcInvoiceTests) {
      const existingRows = db
        .prepare(`SELECT parameter_id, parameter_name, result_value FROM test_results WHERE invoice_test_id = ?`)
        .all(cit.invoice_test_id) as Array<{ parameter_id: number; parameter_name: string; result_value: string }>;

      const existingByParamId = new Map(existingRows.map((r) => [r.parameter_id, r]));
      const wbcRow = existingRows.find((r) => r.parameter_name.toLowerCase().includes('total wbc'));
      const eosRow = existingRows.find(
        (r) =>
          r.parameter_name.toLowerCase().startsWith('eosinophil') &&
          !r.parameter_name.toLowerCase().includes('circulating')
      );

      for (const param of cbcParams) {
        if (!existingByParamId.has(param.id)) {
          let initialVal = '';
          const pLower = param.name.toLowerCase();

          if (pLower.includes('circulating eosinophil') && wbcRow?.result_value && eosRow?.result_value) {
            const wbc = Number(wbcRow.result_value.replace(/,/g, ''));
            const eos = Number(eosRow.result_value.replace(/,/g, ''));
            if (!Number.isNaN(wbc) && !Number.isNaN(eos)) {
              initialVal = String(Math.round(((wbc * eos) / 100) * 100) / 100);
            }
          } else if (cit.invoice_no === 'INV-26001' && cit.status === 'Ready') {
            if (pLower.includes('pcv') || pLower.includes('hematocrit')) initialVal = '35.5';
            if (pLower.startsWith('esr')) initialVal = '28';
          }

          const evalRes = evaluateResultFlag(initialVal, param, cit.gender, cit.age_years);
          insResult.run(
            cit.invoice_test_id,
            param.id,
            param.name,
            param.unit,
            initialVal,
            evalRes.rangeLabel,
            evalRes.flag,
            param.sort_order
          );
        } else {
          updResultSort.run(param.sort_order, cit.invoice_test_id, param.id);
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
          .prepare(`SELECT parameter_id, result_value FROM test_results WHERE invoice_test_id = ?`)
          .all(uit.invoice_test_id) as Array<{ parameter_id: number; result_value: string }>;
        const existingIds = new Set(existingRows.map((r) => r.parameter_id));

        for (const param of urineParams) {
          const defVal = uit.status !== 'Ready' ? param.default_value || '' : '';
          const evalRes = evaluateResultFlag(defVal, param, uit.gender, uit.age_years);
          if (!existingIds.has(param.id)) {
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
          } else {
            updResultSort.run(param.sort_order, uit.invoice_test_id, param.id);
            if (defVal) {
              updBlankResult.run(defVal, evalRes.flag, evalRes.rangeLabel, uit.invoice_test_id, param.id);
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
    input_type: string;
  },
  gender: string,
  ageYears: number
): { min: number | null; max: number | null; label: string } {
  if (param.input_type !== 'numeric') {
    return { min: null, max: null, label: param.normal_text || '-' };
  }

  let min: number | null = param.min_male;
  let max: number | null = param.max_male;

  if (ageYears < 12 && (param.min_child !== null || param.max_child !== null)) {
    min = param.min_child;
    max = param.max_child;
  } else if (gender.toLowerCase() === 'female' && (param.min_female !== null || param.max_female !== null)) {
    min = param.min_female;
    max = param.max_female;
  }

  let label = param.normal_text || '';
  if (min !== null && max !== null) {
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
  },
  gender: string,
  ageYears: number
): { flag: 'Normal' | 'High' | 'Low' | 'Abnormal'; rangeLabel: string } {
  const trimmed = value.trim();
  const resolved = resolveReferenceRange(param, gender, ageYears);

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
