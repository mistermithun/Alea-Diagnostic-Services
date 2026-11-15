export type StorageMode = 'mongodb' | 'sqlite';

export class StoreError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface ParamPayload {
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
  min_newborn?: number | null;
  max_newborn?: number | null;
}

export interface CreateInvoicePayload {
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
  isAdmin: boolean;
}

export interface UpdateInvoicePayload {
  invoiceId: number;
  isAdmin: boolean;
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
}

export interface UpdateLabResultsPayload {
  invoiceTestId: number;
  results: Array<{ parameterId: number; value: string }>;
  status: 'Sample Collected' | 'Processing' | 'Verified' | 'Ready';
  verifiedBy?: string;
  consultantName?: string;
  consultantTitle?: string;
}

export interface LimsStore {
  readonly mode: StorageMode;
  readonly label: string;
  readonly warning?: string;
  init(): Promise<void>;
  ping(): Promise<boolean>;
  getAuthSecret(): string;
  getSetting(key: string): Promise<string>;
  setSetting(key: string, value: string): Promise<void>;
  getAllSettings(): Promise<Record<string, string>>;
  updateSettings(updates: Record<string, string | number>, allowedKeys: string[]): Promise<Record<string, string>>;

  // Overviews & Analytics
  getStaffOverview(): Promise<Record<string, unknown>>;
  getAdminDashboard(from: string, to: string): Promise<Record<string, unknown>>;

  // Catalog
  getCatalog(includeInactive: boolean): Promise<{ categories: unknown[]; tests: unknown[] }>;
  createCategory(name: string): Promise<{ id: number; name: string }>;
  deleteCategory(id: number): Promise<void>;
  createTest(payload: {
    category_id: number;
    code: string;
    name: string;
    price: number;
    sample_type: string;
    parameters?: ParamPayload[];
  }): Promise<{ id: number }>;
  updateTest(
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
  ): Promise<void>;
  deleteTest(id: number): Promise<{ success: boolean; softDeleted?: boolean }>;

  // Doctors
  listDoctors(includeCommission: boolean): Promise<unknown[]>;
  createDoctor(payload: {
    name: string;
    degree?: string;
    hospital?: string;
    mobile?: string;
    commission_pct?: number;
  }): Promise<{ id: number }>;
  updateDoctor(
    id: number,
    payload: {
      name: string;
      degree?: string;
      hospital?: string;
      mobile?: string;
      commission_pct?: number;
    }
  ): Promise<void>;
  softDeleteDoctor(id: number): Promise<void>;
  getDoctorStatement(id: number, from: string, to: string): Promise<Record<string, unknown>>;

  // Patients & Invoices
  listInvoices(filters: {
    search?: string;
    dueOnly?: boolean;
    todayOnly?: boolean;
    date?: string;
    includeCommission: boolean;
  }): Promise<unknown[]>;
  searchPatients(q: string): Promise<unknown[]>;
  getFullInvoice(
    invoiceId: number,
    includeCommission: boolean,
    includePortalPassword?: boolean
  ): Promise<Record<string, unknown> | null>;
  createInvoice(payload: CreateInvoicePayload): Promise<Record<string, unknown>>;
  updateInvoice(payload: UpdateInvoicePayload): Promise<Record<string, unknown>>;
  addDuePayment(payload: {
    invoiceId: number;
    amount: number;
    paymentMethod?: string;
    note?: string;
    isAdmin: boolean;
  }): Promise<Record<string, unknown>>;

  // Lab Queue & Results
  getLabQueue(filters: { search?: string; status?: string }): Promise<unknown[]>;
  getLabTestDetail(invoiceTestId: number): Promise<{ item: unknown; results: unknown[] } | null>;
  updateLabTestResults(payload: UpdateLabResultsPayload): Promise<{ item: unknown; results: unknown[] }>;

  // Expenses
  listExpenses(from: string, to: string): Promise<{ from: string; to: string; expenses: unknown[]; total: number }>;
  createExpense(payload: {
    title: string;
    category?: string;
    amount: number;
    expense_date?: string;
    note?: string;
  }): Promise<{ id: number }>;
  deleteExpense(id: number): Promise<void>;

  // Patient Portal (Strictly Isolated)
  findPatientByUid(normalizedUid: string): Promise<{
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
  } | null>;
  findPatientPublicById(patientId: number): Promise<Record<string, unknown> | null>;
  findPatientByQrSecret(patientId: number, qrSecret: string): Promise<Record<string, unknown> | null>;
  getPatientPortalProfile(patientId: number): Promise<{
    patient: Record<string, unknown>;
    archive: unknown[];
  } | null>;
  getPatientReportIfOwned(invoiceId: number, patientId: number): Promise<Record<string, unknown> | null>;

  // Backup
  createBackupPayload(): Promise<
    | { type: 'sqlite-file'; filePath: string; filename: string }
    | { type: 'json'; filename: string; data: Record<string, unknown> }
  >;
}
