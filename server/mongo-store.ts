import crypto from 'node:crypto';
import { type Collection, type Db, MongoClient } from 'mongodb';
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
  CBC_DESIRED_PARAMS,
  computeInvoiceCommission,
  evaluateResultFlag,
  getLocalTimestampStr,
  getTodayDateStr,
  roundCurrency,
  SEED_CATALOG,
  type ParamSeed,
  URINE_DESIRED_PARAMS,
} from './clinical-rules.ts';
import {
  type CreateInvoicePayload,
  type LimsStore,
  type ParamPayload,
  StoreError,
  type TestCommissionOverride,
  type UpdateInvoicePayload,
  type UpdateLabResultsPayload,
} from './store-types.ts';

interface CounterDoc {
  _id: string;
  seq: number;
}

interface SettingDoc {
  key: string;
  value: string;
}

interface CategoryDoc {
  id: number;
  name: string;
  sort_order: number;
}

interface TestDoc {
  id: number;
  category_id: number;
  code: string;
  name: string;
  price: number;
  sample_type: string;
  is_active: number;
}

interface TestParameterDoc {
  id: number;
  test_id: number;
  name: string;
  unit: string;
  input_type: 'numeric' | 'text' | 'select';
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
}

interface DoctorDoc {
  id: number;
  name: string;
  degree: string;
  hospital: string;
  mobile: string;
  commission_pct: number;
  last_commission_paid_up_to?: string;
  last_commission_settled_at?: string;
  last_commission_paid_amount?: number;
  is_active: number;
  created_at: string;
}

interface DoctorCommissionPayoutDoc {
  id: number;
  doctor_id: number;
  from_date: string;
  paid_up_to_date: string;
  patients_count: number;
  total_commission_paid: number;
  note: string;
  settled_by: string;
  settled_at: string;
}

interface PatientDoc {
  id: number;
  patient_uid: string;
  name: string;
  age_years: number;
  age_months: number;
  age_days: number;
  gender: 'Male' | 'Female' | 'Other';
  mobile: string;
  address: string;
  portal_password_hash: string;
  portal_password_enc: string;
  qr_secret?: string;
  qr_token?: string;
  created_at: string;
}

interface InvoiceDoc {
  id: number;
  invoice_no: string;
  patient_id: number;
  doctor_id: number | null;
  subtotal: number;
  discount_type: 'percent' | 'flat';
  discount_value: number;
  discount_amount: number;
  discount_pct?: number;
  net_total: number;
  paid_amount: number;
  due_amount: number;
  payment_status: 'Paid' | 'Partial' | 'Due';
  commission_pct: number;
  commission_amount: number;
  commission_type?: 'percent' | 'flat' | 'per_test';
  commission_value?: number;
  commission_paid?: number;
  commission_paid_at?: string;
  commission_payout_id?: number | null;
  notes: string;
  created_by: string;
  created_at: string;
}

interface InvoiceTestDoc {
  id: number;
  invoice_id: number;
  test_id: number;
  test_name: string;
  category_name: string;
  sample_type: string;
  price: number;
  commission_type?: 'percent' | 'flat';
  commission_value?: number;
  commission_amount?: number;
  status: 'Sample Collected' | 'Processing' | 'Verified' | 'Ready';
  collected_at: string;
  verified_at: string | null;
  ready_at: string | null;
  verified_by: string;
  consultant_name: string;
  consultant_title: string;
}

interface TestResultDoc {
  id: number;
  invoice_test_id: number;
  parameter_id: number;
  parameter_name: string;
  unit: string;
  result_value: string;
  reference_range_text: string;
  flag: 'Normal' | 'High' | 'Low' | 'Abnormal';
  sort_order: number;
}

interface DuePaymentDoc {
  id: number;
  invoice_id: number;
  amount: number;
  payment_method: string;
  note: string;
  collected_by: string;
  collected_at: string;
}

interface ExpenseDoc {
  id: number;
  title: string;
  category: string;
  amount: number;
  expense_date: string;
  note: string;
  created_by: string;
  created_at: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function datePart(ts: string | null | undefined): string {
  return String(ts || '').slice(0, 10);
}

export class MongoLimsStore implements LimsStore {
  readonly mode = 'mongodb' as const;
  readonly label = 'MongoDB Atlas (Persistent Cloud)';

  private client: MongoClient;
  private db!: Db;
  private dbNameOverride?: string;
  private cachedAuthSecret = '';

  private counters!: Collection<CounterDoc>;
  private settingsCol!: Collection<SettingDoc>;
  private categoriesCol!: Collection<CategoryDoc>;
  private testsCol!: Collection<TestDoc>;
  private paramsCol!: Collection<TestParameterDoc>;
  private doctorsCol!: Collection<DoctorDoc>;
  private patientsCol!: Collection<PatientDoc>;
  private invoicesCol!: Collection<InvoiceDoc>;
  private invoiceTestsCol!: Collection<InvoiceTestDoc>;
  private testResultsCol!: Collection<TestResultDoc>;
  private duePaymentsCol!: Collection<DuePaymentDoc>;
  private payoutsCol!: Collection<DoctorCommissionPayoutDoc>;
  private expensesCol!: Collection<ExpenseDoc>;

  constructor(mongoUri: string, dbNameOverride?: string) {
    this.client = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      family: 4,
    });
    this.dbNameOverride = dbNameOverride?.trim() || undefined;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
  }

  async init(): Promise<void> {
    await this.client.connect();

    if (this.dbNameOverride) {
      this.db = this.client.db(this.dbNameOverride);
    } else {
      const defaultDb = this.client.db();
      this.db = defaultDb.databaseName === 'test' ? this.client.db('alea_lims') : defaultDb;
    }

    this.counters = this.db.collection<CounterDoc>('counters');
    this.settingsCol = this.db.collection<SettingDoc>('settings');
    this.categoriesCol = this.db.collection<CategoryDoc>('test_categories');
    this.testsCol = this.db.collection<TestDoc>('tests');
    this.paramsCol = this.db.collection<TestParameterDoc>('test_parameters');
    this.doctorsCol = this.db.collection<DoctorDoc>('doctors');
    this.patientsCol = this.db.collection<PatientDoc>('patients');
    this.invoicesCol = this.db.collection<InvoiceDoc>('invoices');
    this.invoiceTestsCol = this.db.collection<InvoiceTestDoc>('invoice_tests');
    this.testResultsCol = this.db.collection<TestResultDoc>('test_results');
    this.duePaymentsCol = this.db.collection<DuePaymentDoc>('due_payments');
    this.payoutsCol = this.db.collection<DoctorCommissionPayoutDoc>('doctor_commission_payouts');
    this.expensesCol = this.db.collection<ExpenseDoc>('expenses');

    await this.ensureIndexes();
    await this.seedDefaultSettings();
    await this.seedCatalogIfEmpty();
    await this.seedInitialOperationalDataIfEmpty();
    await this.migrateCbcParameters();
    await this.migrateUrineReParameters();
    await this.ensurePatientPortalCredentials();

    const envSecret = process.env.AUTH_SECRET?.trim();
    if (envSecret) {
      this.cachedAuthSecret = envSecret;
    } else {
      this.cachedAuthSecret = await this.getSetting('auth_secret');
    }
  }

  async ping(): Promise<boolean> {
    await this.db.command({ ping: 1 });
    return true;
  }

  getAuthSecret(): string {
    return this.cachedAuthSecret;
  }

  private async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.settingsCol.createIndex({ key: 1 }, { unique: true }),
      this.categoriesCol.createIndex({ id: 1 }, { unique: true }),
      this.categoriesCol.createIndex({ name: 1 }, { unique: true }),
      this.testsCol.createIndex({ id: 1 }, { unique: true }),
      this.testsCol.createIndex({ category_id: 1, code: 1 }),
      this.paramsCol.createIndex({ id: 1 }, { unique: true }),
      this.paramsCol.createIndex({ test_id: 1, sort_order: 1 }),
      this.doctorsCol.createIndex({ id: 1 }, { unique: true }),
      this.patientsCol.createIndex({ id: 1 }, { unique: true }),
      this.patientsCol.createIndex({ patient_uid: 1 }, { unique: true }),
      this.patientsCol.createIndex({ mobile: 1 }),
      this.invoicesCol.createIndex({ id: 1 }, { unique: true }),
      this.invoicesCol.createIndex({ invoice_no: 1 }, { unique: true }),
      this.invoicesCol.createIndex({ patient_id: 1, created_at: -1 }),
      this.invoicesCol.createIndex({ doctor_id: 1, created_at: -1 }),
      this.invoicesCol.createIndex({ created_at: -1 }),
      this.invoiceTestsCol.createIndex({ id: 1 }, { unique: true }),
      this.invoiceTestsCol.createIndex({ invoice_id: 1 }),
      this.invoiceTestsCol.createIndex({ test_id: 1 }),
      this.invoiceTestsCol.createIndex({ status: 1 }),
      this.testResultsCol.createIndex({ id: 1 }, { unique: true }),
      this.testResultsCol.createIndex({ invoice_test_id: 1, parameter_id: 1 }, { unique: true }),
      this.duePaymentsCol.createIndex({ id: 1 }, { unique: true }),
      this.duePaymentsCol.createIndex({ invoice_id: 1 }),
      this.payoutsCol.createIndex({ id: 1 }, { unique: true }),
      this.payoutsCol.createIndex({ doctor_id: 1, settled_at: -1 }),
      this.expensesCol.createIndex({ id: 1 }, { unique: true }),
      this.expensesCol.createIndex({ expense_date: -1 }),
    ]);
  }

  private async nextSeq(name: string): Promise<number> {
    const res = await this.counters.findOneAndUpdate(
      { _id: name },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    return Number(res?.seq || 1);
  }

  private async seedDefaultSettings(): Promise<void> {
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
      auth_secret: process.env.AUTH_SECRET?.trim() || crypto.randomBytes(32).toString('hex'),
    };

    const ops = Object.entries(defaults).map(([key, value]) => ({
      updateOne: {
        filter: { key },
        update: { $setOnInsert: { key, value } },
        upsert: true,
      },
    }));
    await this.settingsCol.bulkWrite(ops);
  }

  async getSetting(key: string): Promise<string> {
    const row = await this.settingsCol.findOne({ key }, { projection: { _id: 0 } });
    return row ? row.value : '';
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.settingsCol.updateOne({ key }, { $set: { key, value } }, { upsert: true });
    if (key === 'auth_secret' && !process.env.AUTH_SECRET?.trim()) {
      this.cachedAuthSecret = value;
    }
  }

  async getAllSettings(): Promise<Record<string, string>> {
    const rows = await this.settingsCol.find({}, { projection: { _id: 0 } }).toArray();
    const map: Record<string, string> = {};
    for (const r of rows) {
      if (
        r.key === 'admin_password_hash' ||
        r.key === 'staff_password_hash' ||
        r.key === 'auth_secret' ||
        r.key === 'initial_seed_done'
      ) {
        continue;
      }
      map[r.key] = r.value;
    }
    return map;
  }

  async updateSettings(
    updates: Record<string, string | number>,
    allowedKeys: string[]
  ): Promise<Record<string, string>> {
    const ops = allowedKeys
      .filter((k) => updates[k] !== undefined && updates[k] !== null)
      .map((k) => ({
        updateOne: {
          filter: { key: k },
          update: { $set: { key: k, value: String(updates[k]).trim() } },
          upsert: true,
        },
      }));
    if (ops.length > 0) {
      await this.settingsCol.bulkWrite(ops);
    }
    return this.getAllSettings();
  }

  private async seedCatalogIfEmpty(): Promise<void> {
    const catCount = await this.categoriesCol.countDocuments();
    if (catCount > 0) return;

    for (const group of SEED_CATALOG) {
      const catId = await this.nextSeq('test_categories');
      await this.categoriesCol.insertOne({
        id: catId,
        name: group.category,
        sort_order: group.sort_order,
      });

      for (const t of group.tests) {
        const testId = await this.nextSeq('tests');
        await this.testsCol.insertOne({
          id: testId,
          category_id: catId,
          code: t.code,
          name: t.name,
          price: t.price,
          sample_type: t.sample_type,
          is_active: 1,
        });

        for (let idx = 0; idx < t.parameters.length; idx++) {
          const p = t.parameters[idx];
          const paramId = await this.nextSeq('test_parameters');
          await this.paramsCol.insertOne({
            id: paramId,
            test_id: testId,
            name: p.name,
            unit: p.unit || '',
            input_type: p.input_type || 'numeric',
            normal_text: p.normal_text || '',
            default_value: p.default_value ?? '',
            select_options: p.select_options || '',
            abnormal_values: p.abnormal_values || '',
            min_male: p.min_male ?? null,
            max_male: p.max_male ?? null,
            min_female: p.min_female ?? p.min_male ?? null,
            max_female: p.max_female ?? p.max_male ?? null,
            min_child: p.min_child ?? null,
            max_child: p.max_child ?? null,
            min_newborn: p.min_newborn ?? null,
            max_newborn: p.max_newborn ?? null,
            sort_order: idx + 1,
          });
        }
      }
    }
  }

  private async seedInitialOperationalDataIfEmpty(): Promise<void> {
    const seedFlag = await this.getSetting('initial_seed_done');
    if (seedFlag === '1') return;

    const [docCount, patientCount, invoiceCount] = await Promise.all([
      this.doctorsCol.countDocuments(),
      this.patientsCol.countDocuments(),
      this.invoicesCol.countDocuments(),
    ]);
    if (docCount > 0 || patientCount > 0 || invoiceCount > 0) {
      await this.setSetting('initial_seed_done', '1');
      return;
    }

    const nowTs = getLocalTimestampStr();
    const d1 = await this.nextSeq('doctors');
    const d2 = await this.nextSeq('doctors');
    const d3 = await this.nextSeq('doctors');
    const d4 = await this.nextSeq('doctors');
    await this.doctorsCol.insertMany([
      { id: d1, name: 'Dr. Kamrul Hasan', degree: 'MBBS, BCS (Health), FCPS (Medicine)', hospital: 'Kushtia General Hospital', mobile: '01711-234561', commission_pct: 20, is_active: 1, created_at: nowTs },
      { id: d2, name: 'Dr. Nusrat Jahan', degree: 'MBBS, DGO (Gynae & Obs)', hospital: 'Mirpur Upazila Health Complex', mobile: '01712-987654', commission_pct: 25, is_active: 1, created_at: nowTs },
      { id: d3, name: 'Dr. Mahfuzur Rahman', degree: 'MBBS, MD (Cardiology)', hospital: 'Halasa Specialized Clinic', mobile: '01819-445566', commission_pct: 20, is_active: 1, created_at: nowTs },
      { id: d4, name: 'Self / Walk-in Patient', degree: 'Direct Visit', hospital: 'Alea Diagnostic Services', mobile: '', commission_pct: 0, is_active: 1, created_at: nowTs },
    ]);

    const todayStr = getTodayDateStr();
    const pastDate = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);

    const getTestByCode = async (code: string) => {
      const t = await this.testsCol.findOne({ code }, { projection: { _id: 0 } });
      if (!t) return null;
      const cat = await this.categoriesCol.findOne({ id: t.category_id }, { projection: { _id: 0 } });
      const params = await this.paramsCol
        .find({ test_id: t.id }, { projection: { _id: 0 } })
        .sort({ sort_order: 1, id: 1 })
        .toArray();
      return { ...t, category_name: cat?.name || '', params };
    };

    const secret = process.env.AUTH_SECRET?.trim() || (await this.getSetting('auth_secret'));
    const mkPatient = async (
      uid: string,
      name: string,
      ageYears: number,
      gender: 'Male' | 'Female' | 'Other',
      mobile: string,
      address: string,
      createdAt: string,
      plainPw?: string
    ) => {
      const id = await this.nextSeq('patients');
      const pw = plainPw || generatePortalPassword();
      const qrSecret = generatePatientQrSecret();
      const qrToken = createEncryptedPatientQrToken(id, qrSecret, secret);
      await this.patientsCol.insertOne({
        id,
        patient_uid: uid,
        name,
        age_years: ageYears,
        age_months: 0,
        age_days: 0,
        gender,
        mobile,
        address,
        portal_password_hash: hashPassword(pw),
        portal_password_enc: encryptPortalPassword(pw, secret),
        qr_secret: qrSecret,
        qr_token: qrToken,
        created_at: createdAt,
      });
      return id;
    };

    const p1 = await mkPatient('ALEA-2601', 'Md. Rafiqul Islam', 46, 'Male', '01715-882211', 'Halasa Bazar, Mirpur', `${todayStr} 09:15:00`, 'ALEA61');
    const p2 = await mkPatient('ALEA-2602', 'Mst. Amena Khatun', 32, 'Female', '01914-334455', 'Bank Mor, Mirpur', `${todayStr} 10:10:00`);
    const p3 = await mkPatient('ALEA-2603', 'Md. Sohag Ali', 28, 'Male', '01788-556677', 'Poradaha, Mirpur', `${todayStr} 11:05:00`);

    const createInv = async (doc: Omit<InvoiceDoc, 'id'>) => {
      const id = await this.nextSeq('invoices');
      await this.invoicesCol.insertOne({ id, ...doc });
      return id;
    };

    const createInvTest = async (doc: Omit<InvoiceTestDoc, 'id'>) => {
      const id = await this.nextSeq('invoice_tests');
      await this.invoiceTestsCol.insertOne({ id, ...doc });
      return id;
    };

    const createRes = async (doc: Omit<TestResultDoc, 'id'>) => {
      const id = await this.nextSeq('test_results');
      await this.testResultsCol.insertOne({ id, ...doc });
    };

    const inv1 = await createInv({
      invoice_no: 'INV-26001',
      patient_id: p1,
      doctor_id: d1,
      subtotal: 650,
      discount_type: 'flat',
      discount_value: 50,
      discount_amount: 50,
      net_total: 600,
      paid_amount: 600,
      due_amount: 0,
      payment_status: 'Paid',
      commission_pct: 20,
      commission_amount: 120,
      notes: '',
      created_by: 'Staff',
      created_at: `${todayStr} 09:16:00`,
    });

    const cbc = await getTestByCode('HEM-01');
    if (cbc) {
      const it1 = await createInvTest({
        invoice_id: inv1,
        test_id: cbc.id,
        test_name: cbc.name,
        category_name: cbc.category_name,
        sample_type: cbc.sample_type,
        price: cbc.price,
        status: 'Ready',
        collected_at: `${todayStr} 09:20:00`,
        verified_at: `${todayStr} 10:45:00`,
        ready_at: `${todayStr} 11:00:00`,
        verified_by: 'Md. Tariqul Islam, B.Sc (MLT)',
        consultant_name: '',
        consultant_title: '',
      });
      const cbcSampleValues: Record<string, { val: string; flag: 'Normal' | 'High' | 'Low' }> = {
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
        RDW: { val: '13.4', flag: 'Normal' },
      };
      for (const param of cbc.params) {
        const sample = cbcSampleValues[param.name] || { val: '', flag: 'Normal' as const };
        await createRes({
          invoice_test_id: it1,
          parameter_id: param.id,
          parameter_name: param.name,
          unit: param.unit,
          result_value: sample.val,
          reference_range_text: param.normal_text || '13.0 - 17.0',
          flag: sample.flag,
          sort_order: param.sort_order,
        });
      }
    }

    const fbs = await getTestByCode('BIO-01');
    if (fbs) {
      const it2 = await createInvTest({
        invoice_id: inv1,
        test_id: fbs.id,
        test_name: fbs.name,
        category_name: fbs.category_name,
        sample_type: fbs.sample_type,
        price: fbs.price,
        status: 'Ready',
        collected_at: `${todayStr} 09:20:00`,
        verified_at: `${todayStr} 10:45:00`,
        ready_at: `${todayStr} 11:00:00`,
        verified_by: 'Md. Tariqul Islam',
        consultant_name: '',
        consultant_title: '',
      });
      for (const param of fbs.params) {
        await createRes({
          invoice_test_id: it2,
          parameter_id: param.id,
          parameter_name: param.name,
          unit: param.unit,
          result_value: '158',
          reference_range_text: '70 - 100',
          flag: 'High',
          sort_order: param.sort_order,
        });
      }
    }

    const inv1Past = await createInv({
      invoice_no: 'INV-25984',
      patient_id: p1,
      doctor_id: d3,
      subtotal: 1000,
      discount_type: 'flat',
      discount_value: 0,
      discount_amount: 0,
      net_total: 1000,
      paid_amount: 1000,
      due_amount: 0,
      payment_status: 'Paid',
      commission_pct: 20,
      commission_amount: 200,
      notes: '',
      created_by: 'Staff',
      created_at: `${pastDate} 10:30:00`,
    });

    const lipid = await getTestByCode('BIO-04');
    if (lipid) {
      const it1Past = await createInvTest({
        invoice_id: inv1Past,
        test_id: lipid.id,
        test_name: lipid.name,
        category_name: lipid.category_name,
        sample_type: lipid.sample_type,
        price: lipid.price,
        status: 'Ready',
        collected_at: `${pastDate} 10:35:00`,
        verified_at: `${pastDate} 13:10:00`,
        ready_at: `${pastDate} 13:30:00`,
        verified_by: 'Md. Tariqul Islam',
        consultant_name: '',
        consultant_title: '',
      });
      const lipidSample: Record<string, { val: string; flag: 'High' | 'Low' | 'Normal' }> = {
        'Total Cholesterol': { val: '234', flag: 'High' },
        'Triglycerides (TG)': { val: '188', flag: 'High' },
        'HDL Cholesterol': { val: '38', flag: 'Low' },
        'LDL Cholesterol': { val: '158', flag: 'High' },
      };
      for (const param of lipid.params) {
        const s = lipidSample[param.name] || { val: '', flag: 'Normal' as const };
        await createRes({
          invoice_test_id: it1Past,
          parameter_id: param.id,
          parameter_name: param.name,
          unit: param.unit,
          result_value: s.val,
          reference_range_text: param.normal_text || '',
          flag: s.flag,
          sort_order: param.sort_order,
        });
      }
    }

    const inv2 = await createInv({
      invoice_no: 'INV-26002',
      patient_id: p2,
      doctor_id: d2,
      subtotal: 1300,
      discount_type: 'percent',
      discount_value: 10,
      discount_amount: 130,
      net_total: 1170,
      paid_amount: 700,
      due_amount: 470,
      payment_status: 'Partial',
      commission_pct: 25,
      commission_amount: 292.5,
      notes: '',
      created_by: 'Staff',
      created_at: `${todayStr} 10:12:00`,
    });

    const lft = await getTestByCode('BIO-05');
    if (lft) {
      const it3 = await createInvTest({
        invoice_id: inv2,
        test_id: lft.id,
        test_name: lft.name,
        category_name: lft.category_name,
        sample_type: lft.sample_type,
        price: lft.price,
        status: 'Processing',
        collected_at: `${todayStr} 10:20:00`,
        verified_at: null,
        ready_at: null,
        verified_by: '',
        consultant_name: '',
        consultant_title: '',
      });
      for (const param of lft.params) {
        await createRes({
          invoice_test_id: it3,
          parameter_id: param.id,
          parameter_name: param.name,
          unit: param.unit,
          result_value: '',
          reference_range_text: param.normal_text,
          flag: 'Normal',
          sort_order: param.sort_order,
        });
      }
    }

    const hbsag = await getTestByCode('SER-01');
    if (hbsag) {
      const it4 = await createInvTest({
        invoice_id: inv2,
        test_id: hbsag.id,
        test_name: hbsag.name,
        category_name: hbsag.category_name,
        sample_type: hbsag.sample_type,
        price: hbsag.price,
        status: 'Sample Collected',
        collected_at: `${todayStr} 10:20:00`,
        verified_at: null,
        ready_at: null,
        verified_by: '',
        consultant_name: '',
        consultant_title: '',
      });
      for (const param of hbsag.params) {
        await createRes({
          invoice_test_id: it4,
          parameter_id: param.id,
          parameter_name: param.name,
          unit: param.unit,
          result_value: '',
          reference_range_text: param.normal_text,
          flag: 'Normal',
          sort_order: param.sort_order,
        });
      }
    }

    const inv3 = await createInv({
      invoice_no: 'INV-26003',
      patient_id: p3,
      doctor_id: d3,
      subtotal: 1800,
      discount_type: 'flat',
      discount_value: 0,
      discount_amount: 0,
      net_total: 1800,
      paid_amount: 1800,
      due_amount: 0,
      payment_status: 'Paid',
      commission_pct: 20,
      commission_amount: 360,
      notes: '',
      created_by: 'Staff',
      created_at: `${todayStr} 11:06:00`,
    });

    if (lipid) {
      const it5 = await createInvTest({
        invoice_id: inv3,
        test_id: lipid.id,
        test_name: lipid.name,
        category_name: lipid.category_name,
        sample_type: lipid.sample_type,
        price: lipid.price,
        status: 'Sample Collected',
        collected_at: `${todayStr} 11:12:00`,
        verified_at: null,
        ready_at: null,
        verified_by: '',
        consultant_name: '',
        consultant_title: '',
      });
      for (const param of lipid.params) {
        await createRes({
          invoice_test_id: it5,
          parameter_id: param.id,
          parameter_name: param.name,
          unit: param.unit,
          result_value: '',
          reference_range_text: param.normal_text,
          flag: 'Normal',
          sort_order: param.sort_order,
        });
      }
    }

    const kft = await getTestByCode('BIO-06');
    if (kft) {
      const it6 = await createInvTest({
        invoice_id: inv3,
        test_id: kft.id,
        test_name: kft.name,
        category_name: kft.category_name,
        sample_type: kft.sample_type,
        price: kft.price,
        status: 'Verified',
        collected_at: `${todayStr} 11:12:00`,
        verified_at: `${todayStr} 12:15:00`,
        ready_at: null,
        verified_by: 'Md. Tariqul Islam',
        consultant_name: '',
        consultant_title: '',
      });
      for (const param of kft.params) {
        const val = param.name === 'Serum Creatinine' ? '1.1' : param.name === 'Blood Urea' ? '32' : '5.8';
        await createRes({
          invoice_test_id: it6,
          parameter_id: param.id,
          parameter_name: param.name,
          unit: param.unit,
          result_value: val,
          reference_range_text: param.normal_text,
          flag: 'Normal',
          sort_order: param.sort_order,
        });
      }
    }

    const exp1 = await this.nextSeq('expenses');
    const exp2 = await this.nextSeq('expenses');
    await this.expensesCol.insertMany([
      {
        id: exp1,
        title: 'CBC & Biochemistry Reagents Restock',
        category: 'Reagents & Kits',
        amount: 1450,
        expense_date: todayStr,
        note: 'Mindray diluent & glucose reagent',
        created_by: 'Admin',
        created_at: nowTs,
      },
      {
        id: exp2,
        title: 'Sample Collection Tubes & Needles',
        category: 'Consumables',
        amount: 420,
        expense_date: todayStr,
        note: 'EDTA & Clot activator tubes',
        created_by: 'Admin',
        created_at: nowTs,
      },
    ]);

    await this.setSetting('initial_seed_done', '1');
  }

  private async ensurePatientPortalCredentials(): Promise<void> {
    const secret = process.env.AUTH_SECRET?.trim() || (await this.getSetting('auth_secret'));
    if (!secret) return;
    const missing = await this.patientsCol
      .find({
        $or: [
          { portal_password_hash: '' },
          { portal_password_hash: { $exists: false } },
          { qr_secret: '' },
          { qr_secret: { $exists: false } },
          { qr_token: '' },
          { qr_token: { $exists: false } },
        ],
      })
      .toArray();
    for (const p of missing) {
      const updates: Partial<PatientDoc> = {};
      if (!p.portal_password_hash) {
        const plain = p.patient_uid === 'ALEA-2601' ? 'ALEA61' : generatePortalPassword();
        updates.portal_password_hash = hashPassword(plain);
        updates.portal_password_enc = encryptPortalPassword(plain, secret);
      }
      const qrSecret = p.qr_secret || generatePatientQrSecret();
      if (!p.qr_secret) updates.qr_secret = qrSecret;
      if (!p.qr_token) updates.qr_token = createEncryptedPatientQrToken(p.id, qrSecret, secret);
      if (Object.keys(updates).length > 0) {
        await this.patientsCol.updateOne({ id: p.id }, { $set: updates });
      }
    }
  }

  private async migrateCbcParameters(): Promise<void> {
    const cbcTest = await this.testsCol.findOne({ code: 'HEM-01' }, { projection: { _id: 0 } });
    if (!cbcTest) return;

    const existingParams = await this.paramsCol.find({ test_id: cbcTest.id }).toArray();
    const findExistingParam = (targetName: string) => {
      const lower = targetName.toLowerCase();
      return existingParams.find((p) => {
        const pn = p.name.toLowerCase();
        if (pn === lower) return true;
        if (lower.startsWith('pcv') && (pn.includes('pcv') || pn.includes('hematocrit') || pn.includes('hct'))) return true;
        if (lower.includes('circulating eosinophil') && pn.includes('circulating eosinophil')) return true;
        if (lower.startsWith('esr') && pn.startsWith('esr')) return true;
        if (lower === 'rdw' && pn.startsWith('rdw')) return true;
        return false;
      });
    };

    for (const dp of CBC_DESIRED_PARAMS) {
      const found = findExistingParam(dp.name);
      if (!found) {
        const id = await this.nextSeq('test_parameters');
        await this.paramsCol.insertOne({
          id,
          test_id: cbcTest.id,
          name: dp.name,
          unit: dp.unit,
          input_type: 'numeric',
          normal_text: dp.normal_text || '',
          default_value: '',
          select_options: '',
          abnormal_values: '',
          min_male: dp.min_male ?? null,
          max_male: dp.max_male ?? null,
          min_female: dp.min_female ?? dp.min_male ?? null,
          max_female: dp.max_female ?? dp.max_male ?? null,
          min_child: dp.min_child ?? null,
          max_child: dp.max_child ?? null,
          min_newborn: dp.min_newborn ?? null,
          max_newborn: dp.max_newborn ?? null,
          sort_order: dp.sort_order,
        });
      } else if (
        found.name !== dp.name ||
        found.sort_order !== dp.sort_order ||
        found.min_newborn !== (dp.min_newborn ?? null) ||
        found.max_newborn !== (dp.max_newborn ?? null)
      ) {
        await this.paramsCol.updateOne(
          { id: found.id },
          {
            $set: {
              name: dp.name,
              unit: dp.unit,
              normal_text: dp.normal_text || '',
              min_male: dp.min_male ?? null,
              max_male: dp.max_male ?? null,
              min_female: dp.min_female ?? dp.min_male ?? null,
              max_female: dp.max_female ?? dp.max_male ?? null,
              min_child: dp.min_child ?? null,
              max_child: dp.max_child ?? null,
              min_newborn: dp.min_newborn ?? null,
              max_newborn: dp.max_newborn ?? null,
              sort_order: dp.sort_order,
            },
          }
        );
      }
    }

    const cbcParams = await this.paramsCol
      .find({ test_id: cbcTest.id }, { projection: { _id: 0 } })
      .sort({ sort_order: 1, id: 1 })
      .toArray();
    const cbcInvoiceTests = await this.invoiceTestsCol.find({ test_id: cbcTest.id }).toArray();
    for (const cit of cbcInvoiceTests) {
      const inv = await this.invoicesCol.findOne({ id: cit.invoice_id });
      const pat = inv ? await this.patientsCol.findOne({ id: inv.patient_id }) : null;
      if (!pat) continue;
      const existingRows = await this.testResultsCol.find({ invoice_test_id: cit.id }).toArray();
      const existingByParamId = new Map(existingRows.map((r) => [r.parameter_id, r]));

      for (const param of cbcParams) {
        if (!existingByParamId.has(param.id)) {
          const evalRes = evaluateResultFlag('', param, pat.gender, pat.age_years, pat.age_months, pat.age_days);
          const id = await this.nextSeq('test_results');
          await this.testResultsCol.insertOne({
            id,
            invoice_test_id: cit.id,
            parameter_id: param.id,
            parameter_name: param.name,
            unit: param.unit,
            result_value: '',
            reference_range_text: param.normal_text || evalRes.rangeLabel,
            flag: evalRes.flag,
            sort_order: param.sort_order,
          });
        }
      }
    }
  }

  private async migrateUrineReParameters(): Promise<void> {
    const urineTest = await this.testsCol.findOne({ code: 'CLP-01' }, { projection: { _id: 0 } });
    if (!urineTest) return;

    const existingUrine = await this.paramsCol.find({ test_id: urineTest.id }).toArray();
    for (const dp of URINE_DESIRED_PARAMS) {
      const found = existingUrine.find((p) => p.name.toLowerCase() === dp.name.toLowerCase());
      if (!found) {
        const id = await this.nextSeq('test_parameters');
        await this.paramsCol.insertOne({
          id,
          test_id: urineTest.id,
          name: dp.name,
          unit: dp.unit,
          input_type: dp.input_type || 'numeric',
          normal_text: dp.normal_text || '',
          default_value: dp.default_value ?? '',
          select_options: dp.select_options || '',
          abnormal_values: dp.abnormal_values || '',
          min_male: dp.min_male ?? null,
          max_male: dp.max_male ?? null,
          min_female: dp.min_female ?? dp.min_male ?? null,
          max_female: dp.max_female ?? dp.max_male ?? null,
          min_child: dp.min_child ?? null,
          max_child: dp.max_child ?? null,
          min_newborn: null,
          max_newborn: null,
          sort_order: dp.sort_order,
        });
      }
    }
  }

  async getStaffOverview(): Promise<Record<string, unknown>> {
    const today = getTodayDateStr();
    const [
      todayPatients,
      sampleCollectedCount,
      processingCount,
      verifiedCount,
      readyReportsCount,
      dueInvoicesCount,
      recentItems,
    ] = await Promise.all([
      this.invoicesCol.countDocuments({ created_at: { $gte: today, $lte: `${today}\uffff` } }),
      this.invoiceTestsCol.countDocuments({ status: 'Sample Collected' }),
      this.invoiceTestsCol.countDocuments({ status: 'Processing' }),
      this.invoiceTestsCol.countDocuments({ status: 'Verified' }),
      this.invoiceTestsCol.countDocuments({
        status: 'Ready',
        collected_at: { $gte: today, $lte: `${today}\uffff` },
      }),
      this.invoicesCol.countDocuments({ due_amount: { $gt: 0 } }),
      this.invoiceTestsCol
        .find({}, { projection: { _id: 0 } })
        .sort({ id: -1 })
        .limit(10)
        .toArray(),
    ]);

    const invIds = Array.from(new Set(recentItems.map((it) => it.invoice_id)));
    const invs = await this.invoicesCol.find({ id: { $in: invIds } }).toArray();
    const invMap = new Map(invs.map((i) => [i.id, i]));
    const patIds = Array.from(new Set(invs.map((i) => i.patient_id)));
    const pats = await this.patientsCol.find({ id: { $in: patIds } }).toArray();
    const patMap = new Map(pats.map((p) => [p.id, p]));

    const recentQueue = recentItems.map((it) => {
      const inv = invMap.get(it.invoice_id);
      const pat = inv ? patMap.get(inv.patient_id) : undefined;
      return {
        id: it.id,
        test_name: it.test_name,
        category_name: it.category_name,
        status: it.status,
        collected_at: it.collected_at,
        invoice_id: inv?.id || 0,
        invoice_no: inv?.invoice_no || '',
        patient_uid: pat?.patient_uid || '',
        patient_name: pat?.name || '',
        gender: pat?.gender || '',
        age_years: pat?.age_years || 0,
      };
    });

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
    const rangeFilter = { $gte: from, $lte: `${to}\uffff` };

    const [
      invoicesInRange,
      duePaymentsInRange,
      expensesInRange,
      pendingReports,
      readyReportsInRange,
      allDueInvoices,
      recentInvDocs,
    ] = await Promise.all([
      this.invoicesCol.find({ created_at: rangeFilter }, { projection: { _id: 0 } }).toArray(),
      this.duePaymentsCol.find({ collected_at: rangeFilter }, { projection: { _id: 0 } }).toArray(),
      this.expensesCol.find({ expense_date: { $gte: from, $lte: to } }, { projection: { _id: 0 } }).toArray(),
      this.invoiceTestsCol.countDocuments({ status: { $ne: 'Ready' } }),
      this.invoiceTestsCol.countDocuments({ status: 'Ready', collected_at: rangeFilter }),
      this.invoicesCol.find({ due_amount: { $gt: 0 } }, { projection: { due_amount: 1 } }).toArray(),
      this.invoicesCol.find({}, { projection: { _id: 0 } }).sort({ id: -1 }).limit(8).toArray(),
    ]);

    const rangeInvIds = invoicesInRange.map((i) => i.id);
    const [allDuePaymentsForRangeInvoices, rangeInvoiceTests] = await Promise.all([
      rangeInvIds.length > 0
        ? this.duePaymentsCol.find({ invoice_id: { $in: rangeInvIds } }).toArray()
        : Promise.resolve([]),
      rangeInvIds.length > 0
        ? this.invoiceTestsCol.find({ invoice_id: { $in: rangeInvIds } }).toArray()
        : Promise.resolve([]),
    ]);

    const dpSumByInvoice = new Map<number, number>();
    for (const dp of allDuePaymentsForRangeInvoices) {
      dpSumByInvoice.set(dp.invoice_id, (dpSumByInvoice.get(dp.invoice_id) || 0) + Number(dp.amount));
    }

    let totalBilled = 0;
    let totalDiscount = 0;
    let netRevenue = 0;
    let pendingDueInRange = 0;
    let doctorCommissionPayable = 0;
    let initialPaid = 0;

    for (const inv of invoicesInRange) {
      totalBilled += Number(inv.subtotal);
      totalDiscount += Number(inv.discount_amount);
      netRevenue += Number(inv.net_total);
      pendingDueInRange += Number(inv.due_amount);
      doctorCommissionPayable += Number(inv.commission_amount);
      initialPaid += Number(inv.paid_amount) - (dpSumByInvoice.get(inv.id) || 0);
    }

    const dueRecovered = duePaymentsInRange.reduce((s, d) => s + Number(d.amount), 0);
    const totalExpenses = expensesInRange.reduce((s, e) => s + Number(e.amount), 0);
    const netCollection = initialPaid + dueRecovered;
    const netProfit = netCollection - doctorCommissionPayable - totalExpenses;
    const allTimeDue = allDueInvoices.reduce((s, i) => s + Number(i.due_amount), 0);

    const deptMap = new Map<string, { category: string; testCount: number; grossAmount: number }>();
    for (const it of rangeInvoiceTests) {
      const cur = deptMap.get(it.category_name) || { category: it.category_name, testCount: 0, grossAmount: 0 };
      cur.testCount += 1;
      cur.grossAmount += Number(it.price);
      deptMap.set(it.category_name, cur);
    }
    const departmentBreakdown = Array.from(deptMap.values()).sort((a, b) => b.grossAmount - a.grossAmount);

    const recentPatIds = Array.from(new Set(recentInvDocs.map((i) => i.patient_id)));
    const recentDocIds = Array.from(new Set(recentInvDocs.map((i) => i.doctor_id).filter((id): id is number => id !== null)));
    const [pats, docs] = await Promise.all([
      this.patientsCol.find({ id: { $in: recentPatIds } }).toArray(),
      recentDocIds.length > 0 ? this.doctorsCol.find({ id: { $in: recentDocIds } }).toArray() : Promise.resolve([]),
    ]);
    const patMap = new Map(pats.map((p) => [p.id, p]));
    const docMap = new Map(docs.map((d) => [d.id, d]));

    const recentInvoices = recentInvDocs.map((inv) => {
      const p = patMap.get(inv.patient_id);
      const d = inv.doctor_id ? docMap.get(inv.doctor_id) : undefined;
      return {
        ...inv,
        patient_uid: p?.patient_uid || '',
        patient_name: p?.name || '',
        patient_mobile: p?.mobile || '',
        doctor_name: d?.name,
      };
    });

    return {
      from,
      to,
      metrics: {
        patientsCount: invoicesInRange.length,
        totalBilled,
        totalDiscount,
        netRevenue,
        netCollection,
        dueRecovered,
        pendingDueInRange,
        doctorCommissionPayable,
        totalExpenses,
        netProfit,
        pendingReports,
        readyReportsInRange,
        allTimeDue,
        allTimeDueCount: allDueInvoices.length,
      },
      departmentBreakdown,
      recentInvoices,
    };
  }

  async getCatalog(includeInactive: boolean): Promise<{ categories: unknown[]; tests: unknown[] }> {
    const categories = await this.categoriesCol
      .find({}, { projection: { _id: 0 } })
      .sort({ sort_order: 1, id: 1 })
      .toArray();
    const catMap = new Map(categories.map((c) => [c.id, c]));

    const tests = await this.testsCol
      .find(includeInactive ? {} : { is_active: 1 }, { projection: { _id: 0 } })
      .toArray();

    tests.sort((a, b) => {
      const sa = catMap.get(a.category_id)?.sort_order ?? 999;
      const sb = catMap.get(b.category_id)?.sort_order ?? 999;
      if (sa !== sb) return sa - sb;
      if (a.code !== b.code) return a.code.localeCompare(b.code);
      return a.id - b.id;
    });

    const params = await this.paramsCol
      .find({}, { projection: { _id: 0 } })
      .sort({ sort_order: 1, id: 1 })
      .toArray();

    const paramsByTest = new Map<number, TestParameterDoc[]>();
    for (const p of params) {
      const list = paramsByTest.get(p.test_id) || [];
      list.push(p);
      paramsByTest.set(p.test_id, list);
    }

    const enrichedTests = tests.map((t) => ({
      ...t,
      category_name: catMap.get(t.category_id)?.name || '',
      parameters: paramsByTest.get(t.id) || [],
    }));

    return { categories, tests: enrichedTests };
  }

  async createCategory(name: string): Promise<{ id: number; name: string }> {
    const clean = name.trim();
    if (!clean) throw new StoreError(400, 'Category name is required.');
    const existing = await this.categoriesCol.findOne({ name: clean });
    if (existing) throw new StoreError(409, 'Category already exists.');
    const lastCat = await this.categoriesCol.find().sort({ sort_order: -1 }).limit(1).toArray();
    const maxSort = lastCat[0]?.sort_order || 0;
    const id = await this.nextSeq('test_categories');
    await this.categoriesCol.insertOne({ id, name: clean, sort_order: maxSort + 1 });
    return { id, name: clean };
  }

  async deleteCategory(id: number): Promise<void> {
    const testCount = await this.testsCol.countDocuments({ category_id: id, is_active: 1 });
    if (testCount > 0) {
      throw new StoreError(400, 'Cannot delete a category with active tests. Remove or move tests first.');
    }
    await this.categoriesCol.deleteOne({ id });
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
    const testId = await this.nextSeq('tests');
    await this.testsCol.insertOne({
      id: testId,
      category_id: Number(payload.category_id),
      code: testCode,
      name: payload.name.trim(),
      price: Number(payload.price),
      sample_type: payload.sample_type.trim(),
      is_active: 1,
    });

    const list: ParamPayload[] =
      payload.parameters && payload.parameters.length > 0
        ? payload.parameters
        : [{ name: payload.name.trim(), unit: '', input_type: 'text', normal_text: '', default_value: '' }];

    for (let idx = 0; idx < list.length; idx++) {
      const p = list[idx];
      const pid = await this.nextSeq('test_parameters');
      await this.paramsCol.insertOne({
        id: pid,
        test_id: testId,
        name: p.name.trim(),
        unit: p.unit?.trim() || '',
        input_type: p.input_type || 'numeric',
        normal_text: p.normal_text?.trim() || '',
        default_value: p.default_value?.trim() || '',
        select_options: p.select_options?.trim() || '',
        abnormal_values: p.abnormal_values?.trim() || '',
        min_male: p.min_male ?? null,
        max_male: p.max_male ?? null,
        min_female: p.min_female ?? null,
        max_female: p.max_female ?? null,
        min_child: p.min_child ?? null,
        max_child: p.max_child ?? null,
        min_newborn: p.min_newborn ?? null,
        max_newborn: p.max_newborn ?? null,
        sort_order: idx + 1,
      });
    }

    return { id: testId };
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
    await this.testsCol.updateOne(
      { id },
      {
        $set: {
          category_id: Number(payload.category_id),
          code: payload.code?.trim() || '',
          name: payload.name.trim(),
          price: Number(payload.price),
          sample_type: payload.sample_type.trim(),
          is_active: payload.is_active ?? 1,
        },
      }
    );

    if (Array.isArray(payload.parameters)) {
      await this.paramsCol.deleteMany({ test_id: id });
      for (let idx = 0; idx < payload.parameters.length; idx++) {
        const p = payload.parameters[idx];
        if (!p.name?.trim()) continue;
        const pid = await this.nextSeq('test_parameters');
        await this.paramsCol.insertOne({
          id: pid,
          test_id: id,
          name: p.name.trim(),
          unit: p.unit?.trim() || '',
          input_type: p.input_type || 'numeric',
          normal_text: p.normal_text?.trim() || '',
          default_value: p.default_value?.trim() || '',
          select_options: p.select_options?.trim() || '',
          abnormal_values: p.abnormal_values?.trim() || '',
          min_male: p.min_male ?? null,
          max_male: p.max_male ?? null,
          min_female: p.min_female ?? null,
          max_female: p.max_female ?? null,
          min_child: p.min_child ?? null,
          max_child: p.max_child ?? null,
          min_newborn: p.min_newborn ?? null,
          max_newborn: p.max_newborn ?? null,
          sort_order: idx + 1,
        });
      }
    }
  }

  async deleteTest(id: number): Promise<{ success: boolean; softDeleted?: boolean }> {
    const usedCount = await this.invoiceTestsCol.countDocuments({ test_id: id });
    if (usedCount > 0) {
      await this.testsCol.updateOne({ id }, { $set: { is_active: 0 } });
      return { success: true, softDeleted: true };
    }
    await this.paramsCol.deleteMany({ test_id: id });
    await this.testsCol.deleteOne({ id });
    return { success: true };
  }

  async listDoctors(includeCommission: boolean): Promise<unknown[]> {
    const projection: Record<string, number> = {
      _id: 0,
      id: 1,
      name: 1,
      degree: 1,
      hospital: 1,
      mobile: 1,
      is_active: 1,
      created_at: 1,
    };
    if (includeCommission) {
      projection.commission_pct = 1;
      projection.last_commission_paid_up_to = 1;
      projection.last_commission_settled_at = 1;
      projection.last_commission_paid_amount = 1;
    }
    const docs = await this.doctorsCol.find({ is_active: 1 }, { projection }).sort({ name: 1 }).toArray();
    if (!includeCommission) return docs;

    const docIds = docs.map((d) => d.id);
    const allRefInvoices = docIds.length
      ? await this.invoicesCol
          .find(
            { doctor_id: { $in: docIds } },
            { projection: { _id: 0, doctor_id: 1, created_at: 1, commission_amount: 1, commission_paid: 1 } }
          )
          .toArray()
      : [];

    const docMap = new Map(docs.map((d) => [d.id, d]));
    const unpaidStats = new Map<number, { count: number; amount: number }>();
    for (const inv of allRefInvoices) {
      if (!inv.doctor_id) continue;
      const doc = docMap.get(inv.doctor_id);
      const lastPaidUpTo = doc?.last_commission_paid_up_to || '';
      const isPaid =
        inv.commission_paid === 1 || (Boolean(lastPaidUpTo) && datePart(inv.created_at) <= lastPaidUpTo);
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
    const id = await this.nextSeq('doctors');
    await this.doctorsCol.insertOne({
      id,
      name: payload.name.trim(),
      degree: payload.degree?.trim() || '',
      hospital: payload.hospital?.trim() || '',
      mobile: payload.mobile?.trim() || '',
      commission_pct: Number(payload.commission_pct || 0),
      last_commission_paid_up_to: '',
      last_commission_settled_at: '',
      last_commission_paid_amount: 0,
      is_active: 1,
      created_at: getLocalTimestampStr(),
    });
    return { id };
  }

  async updateDoctor(
    id: number,
    payload: {
      name: string;
      degree?: string;
      hospital?: string;
      mobile?: string;
      commission_pct?: number;
    }
  ): Promise<void> {
    await this.doctorsCol.updateOne(
      { id },
      {
        $set: {
          name: payload.name.trim(),
          degree: payload.degree?.trim() || '',
          hospital: payload.hospital?.trim() || '',
          mobile: payload.mobile?.trim() || '',
          commission_pct: Number(payload.commission_pct || 0),
        },
      }
    );
  }

  async softDeleteDoctor(id: number): Promise<void> {
    await this.doctorsCol.updateOne({ id }, { $set: { is_active: 0 } });
  }

  async getDoctorStatement(
    id: number,
    fromArg?: string,
    toArg?: string,
    status: 'unpaid' | 'all' | 'paid' = 'all'
  ): Promise<Record<string, unknown>> {
    const doctor = await this.doctorsCol.findOne({ id }, { projection: { _id: 0 } });
    if (!doctor) throw new StoreError(404, 'Doctor not found.');

    const lastPaidUpTo = (doctor.last_commission_paid_up_to || '').trim();
    const today = getTodayDateStr();
    const defaultFrom = lastPaidUpTo ? addDaysToIsoDate(lastPaidUpTo, 1) : `${today.slice(0, 7)}-01`;
    const from = (fromArg || '').trim() || defaultFrom;
    const to = (toArg || '').trim() || today;

    const [invs, allDoctorInvs, payoutHistory] = await Promise.all([
      this.invoicesCol
        .find(
          { doctor_id: id, created_at: { $gte: from, $lte: `${to}\uffff` } },
          { projection: { _id: 0 } }
        )
        .sort({ created_at: -1 })
        .toArray(),
      this.invoicesCol
        .find(
          { doctor_id: id },
          { projection: { _id: 0, id: 1, created_at: 1, commission_amount: 1, commission_paid: 1 } }
        )
        .toArray(),
      this.payoutsCol
        .find({ doctor_id: id }, { projection: { _id: 0 } })
        .sort({ id: -1 })
        .limit(20)
        .toArray(),
    ]);

    const patIds = Array.from(new Set(invs.map((i) => i.patient_id)));
    const invIds = invs.map((i) => i.id);
    const [pats, invTests] = await Promise.all([
      patIds.length > 0 ? this.patientsCol.find({ id: { $in: patIds } }).toArray() : Promise.resolve([]),
      invIds.length > 0 ? this.invoiceTestsCol.find({ invoice_id: { $in: invIds } }).toArray() : Promise.resolve([]),
    ]);
    const patMap = new Map(pats.map((p) => [p.id, p]));
    const testsByInv = new Map<number, InvoiceTestDoc[]>();
    for (const it of invTests) {
      const list = testsByInv.get(it.invoice_id) || [];
      list.push(it);
      testsByInv.set(it.invoice_id, list);
    }

    const mapped = invs.map((i) => {
      const p = patMap.get(i.patient_id);
      const its = testsByInv.get(i.id) || [];
      const invDate = datePart(i.created_at);
      const isPaid = i.commission_paid === 1 || (Boolean(lastPaidUpTo) && invDate <= lastPaidUpTo);
      const isAfterLastPaid = Boolean(lastPaidUpTo) && invDate > lastPaidUpTo;
      const discountPct =
        typeof i.discount_pct === 'number'
          ? i.discount_pct
          : i.subtotal > 0
          ? roundCurrency((i.discount_amount / i.subtotal) * 100)
          : 0;
      const commType = i.commission_type || 'percent';
      const commVal = typeof i.commission_value === 'number' ? i.commission_value : i.commission_pct;

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
        patient_uid: p?.patient_uid || '',
        patient_name: p?.name || '',
        test_names: its.map((t) => t.test_name).join(', '),
        test_items: its.map((t) => ({
          id: t.id,
          test_id: t.test_id,
          test_name: t.test_name,
          price: t.price,
          commission_type: t.commission_type || 'percent',
          commission_value:
            typeof t.commission_value === 'number' ? t.commission_value : Number(i.commission_pct || 0),
          commission_amount:
            typeof t.commission_amount === 'number'
              ? t.commission_amount
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

    const allTimeUnpaid = allDoctorInvs.reduce(
      (acc, inv) => {
        const isPaid =
          inv.commission_paid === 1 || (Boolean(lastPaidUpTo) && datePart(inv.created_at) <= lastPaidUpTo);
        if (!isPaid) {
          acc.count += 1;
          acc.amount = roundCurrency(acc.amount + Number(inv.commission_amount || 0));
        }
        return acc;
      },
      { count: 0, amount: 0 }
    );

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
    const doctor = await this.doctorsCol.findOne({ id: payload.doctorId });
    if (!doctor) throw new StoreError(404, 'Doctor not found.');

    const cutoff = (payload.paidUpToDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
      throw new StoreError(400, 'Valid Paid Up To Date (YYYY-MM-DD) is required.');
    }

    const lastPaidUpTo = (doctor.last_commission_paid_up_to || '').trim();
    const candidateInvs = await this.invoicesCol
      .find({
        doctor_id: payload.doctorId,
        created_at: { $lte: `${cutoff}\uffff` },
      })
      .toArray();

    const unpaidInvs = candidateInvs.filter(
      (inv) => !(inv.commission_paid === 1 || (Boolean(lastPaidUpTo) && datePart(inv.created_at) <= lastPaidUpTo))
    );

    const totalCommissionPaid = roundCurrency(
      unpaidInvs.reduce((sum, inv) => sum + Number(inv.commission_amount || 0), 0)
    );
    const nowTs = getLocalTimestampStr();
    const payoutId = await this.nextSeq('doctor_commission_payouts');

    const effectiveFrom =
      (payload.fromDate || '').trim() ||
      (lastPaidUpTo ? addDaysToIsoDate(lastPaidUpTo, 1) : unpaidInvs.length > 0 ? datePart(unpaidInvs[unpaidInvs.length - 1].created_at) : cutoff);

    await this.payoutsCol.insertOne({
      id: payoutId,
      doctor_id: payload.doctorId,
      from_date: effectiveFrom,
      paid_up_to_date: cutoff,
      patients_count: unpaidInvs.length,
      total_commission_paid: totalCommissionPaid,
      note: payload.note?.trim() || '',
      settled_by: payload.settledBy?.trim() || 'Admin',
      settled_at: nowTs,
    });

    if (unpaidInvs.length > 0) {
      const invIds = unpaidInvs.map((i) => i.id);
      await this.invoicesCol.updateMany(
        { id: { $in: invIds } },
        {
          $set: {
            commission_paid: 1,
            commission_paid_at: nowTs,
            commission_payout_id: payoutId,
          },
        }
      );
    }

    const nextCutoff = !lastPaidUpTo || cutoff > lastPaidUpTo ? cutoff : lastPaidUpTo;
    await this.doctorsCol.updateOne(
      { id: payload.doctorId },
      {
        $set: {
          last_commission_paid_up_to: nextCutoff,
          last_commission_settled_at: nowTs,
          last_commission_paid_amount: totalCommissionPaid,
        },
      }
    );

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
    const inv = await this.invoicesCol.findOne({ id: payload.invoiceId });
    if (!inv) throw new StoreError(404, 'Invoice not found.');

    const doc = inv.doctor_id ? await this.doctorsCol.findOne({ id: inv.doctor_id }) : null;
    const invTests = await this.invoiceTestsCol
      .find({ invoice_id: payload.invoiceId })
      .sort({ id: 1 })
      .toArray();

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

    await this.invoicesCol.updateOne(
      { id: payload.invoiceId },
      {
        $set: {
          commission_type: computed.invoiceCommissionType,
          commission_value: computed.invoiceCommissionValue,
          commission_pct: computed.invoiceCommissionPct,
          commission_amount: computed.invoiceCommissionAmount,
        },
      }
    );

    for (const it of invTests) {
      const tc = computed.perTestMap.get(it.test_id);
      if (tc) {
        await this.invoiceTestsCol.updateOne(
          { id: it.id },
          {
            $set: {
              commission_type: tc.commission_type,
              commission_value: tc.commission_value,
              commission_amount: tc.commission_amount,
            },
          }
        );
      }
    }

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
    const query: Record<string, unknown> = {};

    if (filters.dueOnly) query.due_amount = { $gt: 0 };
    if (filters.todayOnly) {
      query.created_at = { $gte: todayStr, $lte: `${todayStr}\uffff` };
    } else if (filters.date) {
      query.created_at = { $gte: filters.date, $lte: `${filters.date}\uffff` };
    }

    if (filters.search?.trim()) {
      const rx = new RegExp(escapeRegex(filters.search.trim()), 'i');
      const matchedPatients = await this.patientsCol
        .find({ $or: [{ patient_uid: rx }, { name: rx }, { mobile: rx }] }, { projection: { id: 1 } })
        .toArray();
      const patIds = matchedPatients.map((p) => p.id);
      query.$or = [{ invoice_no: rx }, { patient_id: { $in: patIds } }];
    }

    const invoices = await this.invoicesCol
      .find(query, { projection: { _id: 0 } })
      .sort({ id: -1 })
      .limit(200)
      .toArray();

    const patIds = Array.from(new Set(invoices.map((i) => i.patient_id)));
    const docIds = Array.from(new Set(invoices.map((i) => i.doctor_id).filter((id): id is number => id !== null)));
    const invIds = invoices.map((i) => i.id);

    const [pats, docs, invTests] = await Promise.all([
      patIds.length > 0 ? this.patientsCol.find({ id: { $in: patIds } }).toArray() : Promise.resolve([]),
      docIds.length > 0 ? this.doctorsCol.find({ id: { $in: docIds } }).toArray() : Promise.resolve([]),
      invIds.length > 0 ? this.invoiceTestsCol.find({ invoice_id: { $in: invIds } }).toArray() : Promise.resolve([]),
    ]);

    const patMap = new Map(pats.map((p) => [p.id, p]));
    const docMap = new Map(docs.map((d) => [d.id, d]));
    const testStats = new Map<number, { total: number; ready: number }>();
    for (const it of invTests) {
      const cur = testStats.get(it.invoice_id) || { total: 0, ready: 0 };
      cur.total += 1;
      if (it.status === 'Ready') cur.ready += 1;
      testStats.set(it.invoice_id, cur);
    }

    return invoices.map((i) => {
      const p = patMap.get(i.patient_id);
      const d = i.doctor_id ? docMap.get(i.doctor_id) : undefined;
      const stats = testStats.get(i.id) || { total: 0, ready: 0 };
      const out: Record<string, unknown> = {
        id: i.id,
        invoice_no: i.invoice_no,
        patient_id: i.patient_id,
        doctor_id: i.doctor_id,
        subtotal: i.subtotal,
        discount_type: i.discount_type,
        discount_value: i.discount_value,
        discount_amount: i.discount_amount,
        discount_pct:
          typeof i.discount_pct === 'number'
            ? i.discount_pct
            : i.subtotal > 0
            ? roundCurrency((i.discount_amount / i.subtotal) * 100)
            : 0,
        net_total: i.net_total,
        paid_amount: i.paid_amount,
        due_amount: i.due_amount,
        payment_status: i.payment_status,
        notes: i.notes,
        created_by: i.created_by,
        created_at: i.created_at,
        is_today: datePart(i.created_at) === todayStr ? 1 : 0,
        patient_uid: p?.patient_uid || '',
        patient_name: p?.name || '',
        age_years: p?.age_years || 0,
        age_months: p?.age_months || 0,
        age_days: p?.age_days || 0,
        gender: p?.gender || 'Male',
        patient_mobile: p?.mobile || '',
        doctor_name: d?.name,
        doctor_degree: d?.degree,
        total_tests: stats.total,
        ready_tests: stats.ready,
      };
      if (filters.includeCommission) {
        out.commission_pct = i.commission_pct;
        out.commission_amount = i.commission_amount;
        out.commission_type = i.commission_type || 'percent';
        out.commission_value = typeof i.commission_value === 'number' ? i.commission_value : i.commission_pct;
        out.commission_paid = i.commission_paid === 1 ? 1 : 0;
      }
      return out;
    });
  }

  async searchPatients(q: string): Promise<unknown[]> {
    const clean = q.trim();
    if (!clean) return [];
    const rx = new RegExp(escapeRegex(clean), 'i');
    return this.patientsCol
      .find(
        { $or: [{ patient_uid: rx }, { name: rx }, { mobile: rx }] },
        {
          projection: {
            _id: 0,
            id: 1,
            patient_uid: 1,
            name: 1,
            age_years: 1,
            age_months: 1,
            age_days: 1,
            gender: 1,
            mobile: 1,
            address: 1,
            created_at: 1,
          },
        }
      )
      .sort({ id: -1 })
      .limit(12)
      .toArray();
  }

  async getFullInvoice(
    invoiceId: number,
    includeCommission: boolean,
    includePortalPassword = true
  ): Promise<Record<string, unknown> | null> {
    const inv = await this.invoicesCol.findOne({ id: invoiceId }, { projection: { _id: 0 } });
    if (!inv) return null;

    const [patient, doctor, tests, duePayments] = await Promise.all([
      this.patientsCol.findOne({ id: inv.patient_id }, { projection: { _id: 0 } }),
      inv.doctor_id ? this.doctorsCol.findOne({ id: inv.doctor_id }, { projection: { _id: 0 } }) : Promise.resolve(null),
      this.invoiceTestsCol.find({ invoice_id: invoiceId }, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
      this.duePaymentsCol.find({ invoice_id: invoiceId }, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
    ]);

    const itIds = tests.map((t) => t.id);
    const allResults = itIds.length
      ? await this.testResultsCol
          .find({ invoice_test_id: { $in: itIds } }, { projection: { _id: 0 } })
          .sort({ sort_order: 1, id: 1 })
          .toArray()
      : [];
    const paramIds = Array.from(new Set(allResults.map((r) => r.parameter_id)));
    const allParams = paramIds.length
      ? await this.paramsCol.find({ id: { $in: paramIds } }, { projection: { _id: 0 } }).toArray()
      : [];
    const paramMap = new Map(allParams.map((p) => [p.id, p]));

    const resultsByTest = new Map<number, unknown[]>();
    for (const r of allResults) {
      const tp = paramMap.get(r.parameter_id);
      const list = resultsByTest.get(r.invoice_test_id) || [];
      list.push({
        ...r,
        input_type: tp?.input_type,
        normal_text: tp?.normal_text,
        min_male: tp?.min_male,
        max_male: tp?.max_male,
        min_female: tp?.min_female,
        max_female: tp?.max_female,
        min_child: tp?.min_child,
        max_child: tp?.max_child,
        min_newborn: tp?.min_newborn,
        max_newborn: tp?.max_newborn,
      });
      resultsByTest.set(r.invoice_test_id, list);
    }

    const todayStr = getTodayDateStr();
    const invoiceOut: Record<string, unknown> = {
      id: inv.id,
      invoice_no: inv.invoice_no,
      patient_id: inv.patient_id,
      doctor_id: inv.doctor_id,
      subtotal: inv.subtotal,
      discount_type: inv.discount_type,
      discount_value: inv.discount_value,
      discount_amount: inv.discount_amount,
      discount_pct:
        typeof inv.discount_pct === 'number'
          ? inv.discount_pct
          : inv.subtotal > 0
          ? roundCurrency((inv.discount_amount / inv.subtotal) * 100)
          : 0,
      net_total: inv.net_total,
      paid_amount: inv.paid_amount,
      due_amount: inv.due_amount,
      payment_status: inv.payment_status,
      notes: inv.notes,
      created_by: inv.created_by,
      created_at: inv.created_at,
      is_today: datePart(inv.created_at) === todayStr ? 1 : 0,
      patient_uid: patient?.patient_uid || '',
      patient_name: patient?.name || '',
      age_years: patient?.age_years || 0,
      age_months: patient?.age_months || 0,
      age_days: patient?.age_days || 0,
      gender: patient?.gender || 'Male',
      patient_mobile: patient?.mobile || '',
      patient_address: patient?.address || '',
      doctor_name: doctor?.name,
      doctor_degree: doctor?.degree,
      doctor_hospital: doctor?.hospital,
    };

    if (patient) {
      let qrToken = patient.qr_token || '';
      if (!qrToken) {
        const qrSecret = patient.qr_secret || generatePatientQrSecret();
        qrToken = createEncryptedPatientQrToken(patient.id, qrSecret, this.getAuthSecret());
        await this.patientsCol.updateOne(
          { id: patient.id },
          { $set: { qr_secret: qrSecret, qr_token: qrToken } }
        );
      }
      invoiceOut.patient_qr_token = qrToken;
    }

    if (includeCommission) {
      invoiceOut.commission_pct = inv.commission_pct;
      invoiceOut.commission_amount = inv.commission_amount;
      invoiceOut.commission_type = inv.commission_type || 'percent';
      invoiceOut.commission_value =
        typeof inv.commission_value === 'number' ? inv.commission_value : inv.commission_pct;
      invoiceOut.commission_paid = inv.commission_paid === 1 ? 1 : 0;
      invoiceOut.commission_paid_at = inv.commission_paid_at || '';
    }

    if (includePortalPassword) {
      const enc = patient?.portal_password_enc || '';
      invoiceOut.patient_portal_password = enc ? decryptPortalPassword(enc, this.getAuthSecret()) : '';
    }

    const enrichedTests = tests.map((t) => {
      const outTest: Record<string, unknown> = {
        ...t,
        results: resultsByTest.get(t.id) || [],
      };
      if (!includeCommission) {
        delete outTest.commission_type;
        delete outTest.commission_value;
        delete outTest.commission_amount;
      }
      return outTest;
    });

    return {
      invoice: invoiceOut,
      tests: enrichedTests,
      duePayments,
    };
  }

  async createInvoice(payload: CreateInvoicePayload): Promise<Record<string, unknown>> {
    const selectedTestDocs = await this.testsCol
      .find({ id: { $in: payload.testIds.map(Number) }, is_active: 1 }, { projection: { _id: 0 } })
      .toArray();
    if (selectedTestDocs.length === 0) {
      throw new StoreError(400, 'Selected tests were not found.');
    }

    const cats = await this.categoriesCol.find({}, { projection: { _id: 0 } }).toArray();
    const catMap = new Map(cats.map((c) => [c.id, c.name]));

    const subtotal = selectedTestDocs.reduce((sum, t) => sum + Number(t.price), 0);
    const dType = payload.discountType === 'percent' ? 'percent' : 'flat';
    const dVal = Math.max(0, Number(payload.discountValue || 0));
    let discountAmount = dType === 'percent' ? (subtotal * dVal) / 100 : dVal;
    discountAmount = Math.min(subtotal, Math.round(discountAmount * 100) / 100);

    const maxStaffPct = Number((await this.getSetting('max_staff_discount_pct')) || '15');
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
      const doc = await this.doctorsCol.findOne({ id: Number(payload.doctorId) });
      if (doc) docCommissionPct = Number(doc.commission_pct || 0);
    }

    const computedComm = computeInvoiceCommission({
      tests: selectedTestDocs.map((t) => ({ test_id: t.id, price: Number(t.price) })),
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

    let patientId = 0;
    if (payload.existingPatientId) {
      const existing = await this.patientsCol.findOne({ id: Number(payload.existingPatientId) });
      if (existing) {
        patientId = existing.id;
        await this.patientsCol.updateOne(
          { id: patientId },
          {
            $set: {
              name: payload.patient.name.trim(),
              age_years: Number(payload.patient.ageYears || 0),
              age_months: Number(payload.patient.ageMonths || 0),
              age_days: Number(payload.patient.ageDays || 0),
              gender: payload.patient.gender,
              mobile: payload.patient.mobile?.trim() || '',
              address: payload.patient.address?.trim() || '',
            },
          }
        );
      }
    }

    if (!patientId) {
      patientId = await this.nextSeq('patients');
      const patientUid = `ALEA-${2600 + patientId}`;
      const plainPortalPw = generatePortalPassword();
      const secret = this.getAuthSecret();
      const qrSecret = generatePatientQrSecret();
      const qrToken = createEncryptedPatientQrToken(patientId, qrSecret, secret);
      await this.patientsCol.insertOne({
        id: patientId,
        patient_uid: patientUid,
        name: payload.patient.name.trim(),
        age_years: Number(payload.patient.ageYears || 0),
        age_months: Number(payload.patient.ageMonths || 0),
        age_days: Number(payload.patient.ageDays || 0),
        gender: payload.patient.gender,
        mobile: payload.patient.mobile?.trim() || '',
        address: payload.patient.address?.trim() || '',
        portal_password_hash: hashPassword(plainPortalPw),
        portal_password_enc: encryptPortalPassword(plainPortalPw, secret),
        qr_secret: qrSecret,
        qr_token: qrToken,
        created_at: nowTs,
      });
    }

    const invoiceId = await this.nextSeq('invoices');
    const invoiceNo = `INV-${26000 + invoiceId}`;

    await this.invoicesCol.insertOne({
      id: invoiceId,
      invoice_no: invoiceNo,
      patient_id: patientId,
      doctor_id: payload.doctorId ? Number(payload.doctorId) : null,
      subtotal,
      discount_type: dType,
      discount_value: dVal,
      discount_amount: discountAmount,
      discount_pct: discountPct,
      net_total: netTotal,
      paid_amount: paid,
      due_amount: due,
      payment_status: paymentStatus,
      commission_pct: computedComm.invoiceCommissionPct,
      commission_amount: computedComm.invoiceCommissionAmount,
      commission_type: computedComm.invoiceCommissionType,
      commission_value: computedComm.invoiceCommissionValue,
      commission_paid: 0,
      commission_paid_at: '',
      commission_payout_id: null,
      notes: payload.notes?.trim() || '',
      created_by: payload.isAdmin ? 'Admin' : 'Staff',
      created_at: nowTs,
    });

    for (const t of selectedTestDocs) {
      const invoiceTestId = await this.nextSeq('invoice_tests');
      const tc = computedComm.perTestMap.get(t.id);
      await this.invoiceTestsCol.insertOne({
        id: invoiceTestId,
        invoice_id: invoiceId,
        test_id: t.id,
        test_name: t.name,
        category_name: catMap.get(t.category_id) || '',
        sample_type: t.sample_type,
        price: t.price,
        commission_type: tc?.commission_type || 'percent',
        commission_value: tc?.commission_value ?? docCommissionPct,
        commission_amount: tc?.commission_amount ?? 0,
        status: 'Sample Collected',
        collected_at: nowTs,
        verified_at: null,
        ready_at: null,
        verified_by: '',
        consultant_name: '',
        consultant_title: '',
      });

      const params = await this.paramsCol
        .find({ test_id: t.id }, { projection: { _id: 0 } })
        .sort({ sort_order: 1, id: 1 })
        .toArray();
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
        const resId = await this.nextSeq('test_results');
        await this.testResultsCol.insertOne({
          id: resId,
          invoice_test_id: invoiceTestId,
          parameter_id: param.id,
          parameter_name: param.name,
          unit: param.unit,
          result_value: initialVal,
          reference_range_text: evalRes.rangeLabel,
          flag: evalRes.flag,
          sort_order: param.sort_order,
        });
      }
    }

    const full = await this.getFullInvoice(invoiceId, payload.isAdmin, true);
    return full!;
  }

  async updateInvoice(payload: UpdateInvoicePayload): Promise<Record<string, unknown>> {
    const existingInv = await this.invoicesCol.findOne({ id: payload.invoiceId }, { projection: { _id: 0 } });
    if (!existingInv) throw new StoreError(404, 'Invoice not found.');

    const todayStr = getTodayDateStr();
    if (!payload.isAdmin && datePart(existingInv.created_at) !== todayStr) {
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

    const existingInvTests = await this.invoiceTestsCol
      .find({ invoice_id: payload.invoiceId }, { projection: { _id: 0 } })
      .toArray();
    const existingTestIds = new Set(existingInvTests.map((r) => r.test_id));
    const newTestIds = requestedIds.filter((id) => !existingTestIds.has(id));

    const testsToAdd = newTestIds.length
      ? await this.testsCol.find({ id: { $in: newTestIds }, is_active: 1 }, { projection: { _id: 0 } }).toArray()
      : [];
    const cats = await this.categoriesCol.find({}, { projection: { _id: 0 } }).toArray();
    const catMap = new Map(cats.map((c) => [c.id, c.name]));

    const newSubtotal =
      existingInvTests.reduce((sum, r) => sum + Number(r.price), 0) +
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
      const maxStaffPct = Number((await this.getSetting('max_staff_discount_pct')) || '15');
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
      const doc = await this.doctorsCol.findOne({ id: Number(nextDoctorId) });
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
        : existingInvTests.map((it) => ({
            testId: it.test_id,
            commissionType: it.commission_type === 'flat' ? 'flat' : 'percent',
            commissionValue:
              typeof it.commission_value === 'number' ? it.commission_value : docCommissionPct,
          }));

    const allCombinedTests = [
      ...existingInvTests.map((r) => ({ test_id: r.test_id, price: Number(r.price) })),
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
    const newStatus: 'Paid' | 'Partial' | 'Due' = newDue <= 0 ? 'Paid' : newPaid > 0 ? 'Partial' : 'Due';
    const nowTs = getLocalTimestampStr();

    await this.patientsCol.updateOne(
      { id: existingInv.patient_id },
      {
        $set: {
          name: payload.patient.name.trim(),
          age_years: Number(payload.patient.ageYears || 0),
          age_months: Number(payload.patient.ageMonths || 0),
          age_days: Number(payload.patient.ageDays || 0),
          gender: payload.patient.gender,
          mobile: payload.patient.mobile?.trim() || '',
          address: payload.patient.address?.trim() || '',
        },
      }
    );

    const existingItIds = existingInvTests.map((t) => t.id);
    if (existingItIds.length > 0) {
      const existingResults = await this.testResultsCol
        .find({ invoice_test_id: { $in: existingItIds } })
        .toArray();
      const paramIds = Array.from(new Set(existingResults.map((r) => r.parameter_id)));
      const params = paramIds.length
        ? await this.paramsCol.find({ id: { $in: paramIds } }).toArray()
        : [];
      const paramMap = new Map(params.map((p) => [p.id, p]));
      for (const er of existingResults) {
        const tp = paramMap.get(er.parameter_id);
        if (tp) {
          const reEval = evaluateResultFlag(
            er.result_value || '',
            tp,
            payload.patient.gender,
            Number(payload.patient.ageYears || 0),
            Number(payload.patient.ageMonths || 0),
            Number(payload.patient.ageDays || 0)
          );
          await this.testResultsCol.updateOne(
            { id: er.id },
            { $set: { reference_range_text: reEval.rangeLabel, flag: reEval.flag } }
          );
        }
      }
    }

    for (const t of testsToAdd) {
      const invoiceTestId = await this.nextSeq('invoice_tests');
      const tc = computedComm.perTestMap.get(t.id);
      await this.invoiceTestsCol.insertOne({
        id: invoiceTestId,
        invoice_id: payload.invoiceId,
        test_id: t.id,
        test_name: t.name,
        category_name: catMap.get(t.category_id) || '',
        sample_type: t.sample_type,
        price: t.price,
        commission_type: tc?.commission_type || 'percent',
        commission_value: tc?.commission_value ?? docCommissionPct,
        commission_amount: tc?.commission_amount ?? 0,
        status: 'Sample Collected',
        collected_at: nowTs,
        verified_at: null,
        ready_at: null,
        verified_by: '',
        consultant_name: '',
        consultant_title: '',
      });

      const params = await this.paramsCol
        .find({ test_id: t.id }, { projection: { _id: 0 } })
        .sort({ sort_order: 1, id: 1 })
        .toArray();
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
        const resId = await this.nextSeq('test_results');
        await this.testResultsCol.insertOne({
          id: resId,
          invoice_test_id: invoiceTestId,
          parameter_id: param.id,
          parameter_name: param.name,
          unit: param.unit,
          result_value: initialVal,
          reference_range_text: evalRes.rangeLabel,
          flag: evalRes.flag,
          sort_order: param.sort_order,
        });
      }
    }

    for (const existingIt of existingInvTests) {
      const tc = computedComm.perTestMap.get(existingIt.test_id);
      if (tc) {
        await this.invoiceTestsCol.updateOne(
          { id: existingIt.id },
          {
            $set: {
              commission_type: tc.commission_type,
              commission_value: tc.commission_value,
              commission_amount: tc.commission_amount,
            },
          }
        );
      }
    }

    if (appliedExtraPay > 0) {
      const dpId = await this.nextSeq('due_payments');
      await this.duePaymentsCol.insertOne({
        id: dpId,
        invoice_id: payload.invoiceId,
        amount: appliedExtraPay,
        payment_method: payload.paymentMethod?.trim() || 'Cash',
        note: testsToAdd.length > 0 ? 'Payment on added tests' : 'Updated invoice payment',
        collected_by: payload.isAdmin ? 'Admin' : 'Staff',
        collected_at: nowTs,
      });
    }

    await this.invoicesCol.updateOne(
      { id: payload.invoiceId },
      {
        $set: {
          doctor_id: nextDoctorId || null,
          subtotal: newSubtotal,
          discount_type: dType,
          discount_value: dVal,
          discount_amount: discountAmount,
          discount_pct: discountPct,
          net_total: netTotal,
          paid_amount: newPaid,
          due_amount: newDue,
          payment_status: newStatus,
          commission_pct: computedComm.invoiceCommissionPct,
          commission_amount: computedComm.invoiceCommissionAmount,
          commission_type: computedComm.invoiceCommissionType,
          commission_value: computedComm.invoiceCommissionValue,
          notes: payload.notes !== undefined ? payload.notes.trim() : existingInv.notes,
        },
      }
    );

    const full = await this.getFullInvoice(payload.invoiceId, payload.isAdmin, true);
    return full!;
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

    const inv = await this.invoicesCol.findOne({ id: payload.invoiceId });
    if (!inv) throw new StoreError(404, 'Invoice not found.');
    if (payAmt > inv.due_amount + 0.01) {
      throw new StoreError(400, `Payment exceeds current due of ৳${inv.due_amount}.`);
    }

    const newPaid = Math.round((inv.paid_amount + payAmt) * 100) / 100;
    const newDue = Math.max(0, Math.round((inv.net_total - newPaid) * 100) / 100);
    const newStatus: 'Paid' | 'Partial' = newDue <= 0 ? 'Paid' : 'Partial';
    const nowTs = getLocalTimestampStr();

    const dpId = await this.nextSeq('due_payments');
    await this.duePaymentsCol.insertOne({
      id: dpId,
      invoice_id: payload.invoiceId,
      amount: payAmt,
      payment_method: payload.paymentMethod?.trim() || 'Cash',
      note: payload.note?.trim() || '',
      collected_by: payload.isAdmin ? 'Admin' : 'Staff',
      collected_at: nowTs,
    });

    await this.invoicesCol.updateOne(
      { id: payload.invoiceId },
      { $set: { paid_amount: newPaid, due_amount: newDue, payment_status: newStatus } }
    );

    const full = await this.getFullInvoice(payload.invoiceId, payload.isAdmin, true);
    return full!;
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
    const inv = await this.invoicesCol.findOne({ id: invoiceId });
    if (!inv) {
      throw new StoreError(404, 'Patient invoice record not found.');
    }

    const patient = await this.patientsCol.findOne({ id: inv.patient_id });
    const invTests = await this.invoiceTestsCol
      .find({ invoice_id: invoiceId }, { projection: { id: 1 } })
      .toArray();
    const itIds = invTests.map((it) => it.id);

    let deletedResultsCount = 0;
    if (itIds.length > 0) {
      const resDel = await this.testResultsCol.deleteMany({
        invoice_test_id: { $in: itIds },
      });
      deletedResultsCount = resDel.deletedCount;
    }

    await this.duePaymentsCol.deleteMany({ invoice_id: invoiceId });
    const testsDel = await this.invoiceTestsCol.deleteMany({ invoice_id: invoiceId });
    await this.invoicesCol.deleteOne({ id: invoiceId });

    const remainingInvoices = await this.invoicesCol.countDocuments({
      patient_id: inv.patient_id,
    });
    let patientDeleted = false;
    if (remainingInvoices === 0) {
      const patDel = await this.patientsCol.deleteOne({ id: inv.patient_id });
      patientDeleted = patDel.deletedCount > 0;
    }

    return {
      success: true,
      deletedInvoiceId: invoiceId,
      invoiceNo: inv.invoice_no,
      deletedPatientId: inv.patient_id,
      patientUid: patient?.patient_uid || '',
      patientName: patient?.name || '',
      patientDeleted,
      deletedTestsCount: testsDel.deletedCount,
      deletedResultsCount,
    };
  }

  async getLabQueue(filters: { search?: string; status?: string }): Promise<unknown[]> {
    const query: Record<string, unknown> = {};
    if (filters.status && filters.status !== 'All') {
      query.status = filters.status === 'Pending' ? { $ne: 'Ready' } : filters.status;
    }

    let items = await this.invoiceTestsCol.find(query, { projection: { _id: 0 } }).toArray();

    const invIds = Array.from(new Set(items.map((it) => it.invoice_id)));
    const invs = invIds.length ? await this.invoicesCol.find({ id: { $in: invIds } }).toArray() : [];
    const invMap = new Map(invs.map((i) => [i.id, i]));

    const patIds = Array.from(new Set(invs.map((i) => i.patient_id)));
    const docIds = Array.from(new Set(invs.map((i) => i.doctor_id).filter((id): id is number => id !== null)));
    const [pats, docs] = await Promise.all([
      patIds.length ? this.patientsCol.find({ id: { $in: patIds } }).toArray() : Promise.resolve([]),
      docIds.length ? this.doctorsCol.find({ id: { $in: docIds } }).toArray() : Promise.resolve([]),
    ]);
    const patMap = new Map(pats.map((p) => [p.id, p]));
    const docMap = new Map(docs.map((d) => [d.id, d]));

    if (filters.search?.trim()) {
      const qLower = filters.search.trim().toLowerCase();
      items = items.filter((it) => {
        const inv = invMap.get(it.invoice_id);
        const pat = inv ? patMap.get(inv.patient_id) : undefined;
        return (
          it.test_name.toLowerCase().includes(qLower) ||
          (inv?.invoice_no || '').toLowerCase().includes(qLower) ||
          (pat?.patient_uid || '').toLowerCase().includes(qLower) ||
          (pat?.name || '').toLowerCase().includes(qLower)
        );
      });
    }

    const statusOrder: Record<string, number> = {
      'Sample Collected': 1,
      Processing: 2,
      Verified: 3,
      Ready: 4,
    };

    items.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 4;
      const sb = statusOrder[b.status] ?? 4;
      if (sa !== sb) return sa - sb;
      return b.id - a.id;
    });
    items = items.slice(0, 200);

    const slicedIds = items.map((i) => i.id);
    const resRows = slicedIds.length
      ? await this.testResultsCol.find({ invoice_test_id: { $in: slicedIds } }).toArray()
      : [];
    const statsMap = new Map<number, { total: number; filled: number; abnormal: number }>();
    for (const r of resRows) {
      const cur = statsMap.get(r.invoice_test_id) || { total: 0, filled: 0, abnormal: 0 };
      cur.total += 1;
      if (r.result_value !== '') cur.filled += 1;
      if (r.flag !== 'Normal') cur.abnormal += 1;
      statsMap.set(r.invoice_test_id, cur);
    }

    return items.map((it) => {
      const inv = invMap.get(it.invoice_id);
      const pat = inv ? patMap.get(inv.patient_id) : undefined;
      const doc = inv?.doctor_id ? docMap.get(inv.doctor_id) : undefined;
      const st = statsMap.get(it.id) || { total: 0, filled: 0, abnormal: 0 };
      return {
        ...it,
        invoice_no: inv?.invoice_no || '',
        invoice_date: inv?.created_at || '',
        patient_uid: pat?.patient_uid || '',
        patient_name: pat?.name || '',
        age_years: pat?.age_years || 0,
        age_months: pat?.age_months || 0,
        age_days: pat?.age_days || 0,
        gender: pat?.gender || 'Male',
        patient_mobile: pat?.mobile || '',
        doctor_name: doc?.name,
        total_params: st.total,
        filled_params: st.filled,
        abnormal_count: st.abnormal,
      };
    });
  }

  async getLabTestDetail(invoiceTestId: number): Promise<{ item: unknown; results: unknown[] } | null> {
    const it = await this.invoiceTestsCol.findOne({ id: invoiceTestId }, { projection: { _id: 0 } });
    if (!it) return null;
    const inv = await this.invoicesCol.findOne({ id: it.invoice_id }, { projection: { _id: 0 } });
    const pat = inv ? await this.patientsCol.findOne({ id: inv.patient_id }, { projection: { _id: 0 } }) : null;
    const doc = inv?.doctor_id ? await this.doctorsCol.findOne({ id: inv.doctor_id }, { projection: { _id: 0 } }) : null;

    const resultsRaw = await this.testResultsCol
      .find({ invoice_test_id: invoiceTestId }, { projection: { _id: 0 } })
      .sort({ sort_order: 1, id: 1 })
      .toArray();
    const paramIds = resultsRaw.map((r) => r.parameter_id);
    const params = paramIds.length
      ? await this.paramsCol.find({ id: { $in: paramIds } }, { projection: { _id: 0 } }).toArray()
      : [];
    const paramMap = new Map(params.map((p) => [p.id, p]));

    const results = resultsRaw.map((r) => {
      const tp = paramMap.get(r.parameter_id);
      return {
        ...r,
        input_type: tp?.input_type,
        select_options: tp?.select_options,
        abnormal_values: tp?.abnormal_values,
        normal_text: tp?.normal_text,
        min_male: tp?.min_male,
        max_male: tp?.max_male,
        min_female: tp?.min_female,
        max_female: tp?.max_female,
        min_child: tp?.min_child,
        max_child: tp?.max_child,
        min_newborn: tp?.min_newborn,
        max_newborn: tp?.max_newborn,
      };
    });

    return {
      item: {
        ...it,
        invoice_no: inv?.invoice_no || '',
        invoice_date: inv?.created_at || '',
        patient_uid: pat?.patient_uid || '',
        patient_name: pat?.name || '',
        age_years: pat?.age_years || 0,
        age_months: pat?.age_months || 0,
        age_days: pat?.age_days || 0,
        gender: pat?.gender || 'Male',
        patient_mobile: pat?.mobile || '',
        doctor_name: doc?.name,
      },
      results,
    };
  }

  async updateLabTestResults(payload: UpdateLabResultsPayload): Promise<{ item: unknown; results: unknown[] }> {
    const it = await this.invoiceTestsCol.findOne({ id: payload.invoiceTestId }, { projection: { _id: 0 } });
    if (!it) throw new StoreError(404, 'Lab test entry not found.');

    const inv = await this.invoicesCol.findOne({ id: it.invoice_id });
    const pat = inv ? await this.patientsCol.findOne({ id: inv.patient_id }) : null;
    if (!pat) throw new StoreError(404, 'Patient record not found.');

    const validStatuses = ['Sample Collected', 'Processing', 'Verified', 'Ready'] as const;
    const nextStatus = validStatuses.includes(payload.status) ? payload.status : 'Processing';
    const nowTs = getLocalTimestampStr();

    const testResultMeta = await this.testResultsCol
      .find({ invoice_test_id: payload.invoiceTestId }, { projection: { _id: 0 } })
      .toArray();

    const submittedMap = new Map<number, string>();
    for (const r of testResultMeta) {
      submittedMap.set(r.parameter_id, r.result_value ?? '');
    }
    if (Array.isArray(payload.results)) {
      for (const r of payload.results) {
        submittedMap.set(r.parameterId, String(r.value ?? '').trim());
      }
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

    const paramIds = Array.from(submittedMap.keys());
    const params = paramIds.length
      ? await this.paramsCol.find({ id: { $in: paramIds } }).toArray()
      : [];
    const paramMap = new Map(params.map((p) => [p.id, p]));

    for (const [parameterId, value] of submittedMap.entries()) {
      const param = paramMap.get(parameterId);
      let flag: 'Normal' | 'High' | 'Low' | 'Abnormal' = 'Normal';
      let rangeLabel = '';
      if (param) {
        const evalRes = evaluateResultFlag(
          String(value ?? ''),
          param,
          pat.gender,
          pat.age_years,
          pat.age_months,
          pat.age_days
        );
        flag = evalRes.flag;
        rangeLabel = evalRes.rangeLabel;
      }
      await this.testResultsCol.updateOne(
        { invoice_test_id: payload.invoiceTestId, parameter_id: parameterId },
        {
          $set: {
            result_value: String(value ?? '').trim(),
            reference_range_text: rangeLabel,
            flag,
          },
        }
      );
    }

    const verifiedAt = nextStatus === 'Verified' || nextStatus === 'Ready' ? it.verified_at || nowTs : null;
    const readyAt = nextStatus === 'Ready' ? it.ready_at || nowTs : null;
    const techDefault = await this.getSetting('technologist_name');
    const verifier = payload.verifiedBy?.trim() || techDefault || 'Medical Technologist';
    const nextConsultantName =
      payload.consultantName !== undefined ? payload.consultantName.trim() : it.consultant_name || '';
    const nextConsultantTitle =
      payload.consultantTitle !== undefined ? payload.consultantTitle.trim() : it.consultant_title || '';

    await this.invoiceTestsCol.updateOne(
      { id: payload.invoiceTestId },
      {
        $set: {
          status: nextStatus,
          verified_at: verifiedAt,
          ready_at: readyAt,
          verified_by: nextStatus === 'Verified' || nextStatus === 'Ready' ? verifier : '',
          consultant_name: nextConsultantName,
          consultant_title: nextConsultantTitle,
        },
      }
    );

    const [updatedItem, updatedResults] = await Promise.all([
      this.invoiceTestsCol.findOne({ id: payload.invoiceTestId }, { projection: { _id: 0 } }),
      this.testResultsCol
        .find({ invoice_test_id: payload.invoiceTestId }, { projection: { _id: 0 } })
        .sort({ sort_order: 1, id: 1 })
        .toArray(),
    ]);

    return { item: updatedItem, results: updatedResults };
  }

  async listExpenses(
    from: string,
    to: string
  ): Promise<{ from: string; to: string; expenses: unknown[]; total: number }> {
    const expenses = await this.expensesCol
      .find({ expense_date: { $gte: from, $lte: to } }, { projection: { _id: 0 } })
      .sort({ expense_date: -1, id: -1 })
      .toArray();
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
    const id = await this.nextSeq('expenses');
    await this.expensesCol.insertOne({
      id,
      title: payload.title.trim(),
      category: payload.category?.trim() || 'General',
      amount: Number(payload.amount),
      expense_date: payload.expense_date || getTodayDateStr(),
      note: payload.note?.trim() || '',
      created_by: 'Admin',
      created_at: getLocalTimestampStr(),
    });
    return { id };
  }

  async deleteExpense(id: number): Promise<void> {
    await this.expensesCol.deleteOne({ id });
  }

  async findPatientByUid(normalizedUid: string) {
    const rx = new RegExp(`^${escapeRegex(normalizedUid)}$`, 'i');
    const p = await this.patientsCol.findOne({ patient_uid: rx }, { projection: { _id: 0 } });
    if (!p) return null;
    return p;
  }

  async findPatientPublicById(patientId: number): Promise<Record<string, unknown> | null> {
    const p = await this.patientsCol.findOne(
      { id: patientId },
      {
        projection: {
          _id: 0,
          id: 1,
          patient_uid: 1,
          name: 1,
          age_years: 1,
          age_months: 1,
          age_days: 1,
          gender: 1,
          mobile: 1,
          address: 1,
          created_at: 1,
        },
      }
    );
    return p || null;
  }

  async findPatientByQrSecret(patientId: number, qrSecret: string): Promise<Record<string, unknown> | null> {
    const p = await this.patientsCol.findOne(
      { id: patientId },
      {
        projection: {
          _id: 0,
          id: 1,
          patient_uid: 1,
          name: 1,
          age_years: 1,
          age_months: 1,
          age_days: 1,
          gender: 1,
          mobile: 1,
          address: 1,
          qr_secret: 1,
          created_at: 1,
        },
      }
    );
    if (!p || !verifyQrSecretMatch(p.qr_secret, qrSecret)) {
      return null;
    }
    const { qr_secret: _removed, ...publicPatient } = p;
    return publicPatient;
  }

  async getPatientPortalProfile(patientId: number): Promise<{
    patient: Record<string, unknown>;
    archive: unknown[];
  } | null> {
    const patient = await this.findPatientPublicById(patientId);
    if (!patient) return null;

    const visits = await this.invoicesCol
      .find({ patient_id: patientId }, { projection: { _id: 0 } })
      .sort({ created_at: -1, id: -1 })
      .toArray();

    const invIds = visits.map((v) => v.id);
    const docIds = Array.from(new Set(visits.map((v) => v.doctor_id).filter((id): id is number => id !== null)));
    const [docs, invTests] = await Promise.all([
      docIds.length ? this.doctorsCol.find({ id: { $in: docIds } }).toArray() : Promise.resolve([]),
      invIds.length ? this.invoiceTestsCol.find({ invoice_id: { $in: invIds } }).sort({ id: 1 }).toArray() : Promise.resolve([]),
    ]);
    const docMap = new Map(docs.map((d) => [d.id, d]));

    const itIds = invTests.map((t) => t.id);
    const results = itIds.length
      ? await this.testResultsCol.find({ invoice_test_id: { $in: itIds } }).toArray()
      : [];
    const abnByIt = new Map<number, number>();
    for (const r of results) {
      if (r.flag !== 'Normal' && r.result_value !== '') {
        abnByIt.set(r.invoice_test_id, (abnByIt.get(r.invoice_test_id) || 0) + 1);
      }
    }

    const testsByInv = new Map<number, InvoiceTestDoc[]>();
    for (const it of invTests) {
      const list = testsByInv.get(it.invoice_id) || [];
      list.push(it);
      testsByInv.set(it.invoice_id, list);
    }

    const archive = visits.map((v) => {
      const d = v.doctor_id ? docMap.get(v.doctor_id) : undefined;
      const vTests = testsByInv.get(v.id) || [];
      const readyTests = vTests.filter((t) => t.status === 'Ready').length;
      const abnormalCount = vTests.reduce((sum, t) => sum + (abnByIt.get(t.id) || 0), 0);
      return {
        invoice_id: v.id,
        invoice_no: v.invoice_no,
        created_at: v.created_at,
        net_total: v.net_total,
        paid_amount: v.paid_amount,
        due_amount: v.due_amount,
        payment_status: v.payment_status,
        doctor_name: d?.name,
        doctor_degree: d?.degree,
        total_tests: vTests.length,
        ready_tests: readyTests,
        abnormal_count: abnormalCount,
        tests: vTests.map((t) => ({
          id: t.id,
          test_name: t.test_name,
          category_name: t.category_name,
          sample_type: t.sample_type,
          status: t.status,
          collected_at: t.collected_at,
          verified_at: t.verified_at,
          ready_at: t.ready_at,
        })),
      };
    });

    return { patient, archive };
  }

  async getPatientReportIfOwned(invoiceId: number, patientId: number): Promise<Record<string, unknown> | null> {
    const owns = await this.invoicesCol.findOne({ id: invoiceId, patient_id: patientId }, { projection: { id: 1 } });
    if (!owns) return null;
    return this.getFullInvoice(invoiceId, false, false);
  }

  async createBackupPayload() {
    const [
      settings,
      test_categories,
      tests,
      test_parameters,
      doctors,
      patients,
      invoices,
      invoice_tests,
      test_results,
      due_payments,
      expenses,
    ] = await Promise.all([
      this.getAllSettings(),
      this.categoriesCol.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
      this.testsCol.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
      this.paramsCol.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
      this.doctorsCol.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
      this.patientsCol
        .find({}, { projection: { _id: 0, portal_password_hash: 0, portal_password_enc: 0, qr_secret: 0 } })
        .sort({ id: 1 })
        .toArray(),
      this.invoicesCol.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
      this.invoiceTestsCol.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
      this.testResultsCol.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
      this.duePaymentsCol.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
      this.expensesCol.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray(),
    ]);

    return {
      type: 'json' as const,
      filename: `alea_diagnostic_cloud_backup_${getTodayDateStr()}.json`,
      data: {
        exported_at: new Date().toISOString(),
        storage: 'mongodb',
        settings,
        test_categories,
        tests,
        test_parameters,
        doctors,
        patients,
        invoices,
        invoice_tests,
        test_results,
        due_payments,
        expenses,
      },
    };
  }
}
