export type UserRole = 'admin' | 'staff';

export type NavTab =
  | 'dashboard'
  | 'billing'
  | 'lab'
  | 'dues'
  | 'catalog'
  | 'doctors'
  | 'expenses'
  | 'settings';

export interface LabSettings {
  lab_name: string;
  lab_address: string;
  proprietor_name: string;
  lab_phone: string;
  max_staff_discount_pct: string;
  technologist_name: string;
  technologist_title: string;
  pathologist_name: string;
  pathologist_title: string;
  pad_header_margin_in: string;
  pad_footer_margin_in: string;
}

export interface SystemInfo {
  settings: LabSettings;
  port: number;
  lanUrls: string[];
  serverDate: string;
  publicBaseUrl?: string;
  storageMode?: 'mongodb' | 'sqlite';
  storageLabel?: string;
  storageWarning?: string;
}

export interface TestCategory {
  id: number;
  name: string;
  sort_order: number;
}

export interface TestParameter {
  id: number;
  test_id: number;
  name: string;
  unit: string;
  input_type: 'numeric' | 'text' | 'select';
  normal_text: string;
  default_value?: string;
  select_options: string;
  abnormal_values: string;
  min_male: number | null;
  max_male: number | null;
  min_female: number | null;
  max_female: number | null;
  min_child: number | null;
  max_child: number | null;
  min_newborn?: number | null;
  max_newborn?: number | null;
  sort_order: number;
}

export interface DiagnosticTest {
  id: number;
  category_id: number;
  category_name: string;
  code: string;
  name: string;
  price: number;
  sample_type: string;
  is_active: number;
  parameters: TestParameter[];
}

export interface Doctor {
  id: number;
  name: string;
  degree: string;
  hospital: string;
  mobile: string;
  commission_pct?: number;
  is_active: number;
}

export interface InvoiceSummary {
  id: number;
  invoice_no: string;
  patient_id: number;
  doctor_id: number | null;
  subtotal: number;
  discount_type: 'percent' | 'flat';
  discount_value: number;
  discount_amount: number;
  net_total: number;
  paid_amount: number;
  due_amount: number;
  payment_status: 'Paid' | 'Partial' | 'Due';
  commission_pct?: number;
  commission_amount?: number;
  notes: string;
  created_by: string;
  created_at: string;
  patient_uid: string;
  patient_name: string;
  age_years: number;
  age_months: number;
  age_days: number;
  gender: 'Male' | 'Female' | 'Other';
  patient_mobile: string;
  patient_address?: string;
  patient_portal_password?: string;
  patient_qr_token?: string;
  doctor_name?: string;
  doctor_degree?: string;
  doctor_hospital?: string;
  total_tests?: number;
  ready_tests?: number;
  is_today?: number;
}

export interface PatientProfile {
  id: number;
  patient_uid: string;
  name: string;
  age_years: number;
  age_months: number;
  age_days: number;
  gender: 'Male' | 'Female' | 'Other';
  mobile: string;
  address: string;
  created_at: string;
}

export interface PatientPortalArchiveVisit {
  invoice_id: number;
  invoice_no: string;
  created_at: string;
  net_total: number;
  paid_amount: number;
  due_amount: number;
  payment_status: 'Paid' | 'Partial' | 'Due';
  doctor_name?: string;
  doctor_degree?: string;
  total_tests: number;
  ready_tests: number;
  abnormal_count: number;
  tests: Array<{
    id: number;
    test_name: string;
    category_name: string;
    sample_type: string;
    status: 'Sample Collected' | 'Processing' | 'Verified' | 'Ready';
    collected_at: string;
    verified_at: string | null;
    ready_at: string | null;
  }>;
}

export interface TestResultRow {
  id: number;
  invoice_test_id: number;
  parameter_id: number;
  parameter_name: string;
  unit: string;
  result_value: string;
  reference_range_text: string;
  flag: 'Normal' | 'High' | 'Low' | 'Abnormal';
  sort_order: number;
  input_type?: 'numeric' | 'text' | 'select';
  select_options?: string;
  abnormal_values?: string;
  normal_text?: string;
  min_male?: number | null;
  max_male?: number | null;
  min_female?: number | null;
  max_female?: number | null;
  min_child?: number | null;
  max_child?: number | null;
  min_newborn?: number | null;
  max_newborn?: number | null;
}

export interface InvoiceTestItem {
  id: number;
  invoice_id: number;
  test_id: number;
  test_name: string;
  category_name: string;
  sample_type: string;
  price: number;
  status: 'Sample Collected' | 'Processing' | 'Verified' | 'Ready';
  collected_at: string;
  verified_at: string | null;
  ready_at: string | null;
  verified_by: string;
  consultant_name?: string;
  consultant_title?: string;
  results?: TestResultRow[];
}

export interface DuePayment {
  id: number;
  invoice_id: number;
  amount: number;
  payment_method: string;
  note: string;
  collected_by: string;
  collected_at: string;
}

export interface FullInvoice {
  invoice: InvoiceSummary;
  tests: InvoiceTestItem[];
  duePayments: DuePayment[];
}

export interface LabQueueItem extends InvoiceTestItem {
  invoice_no: string;
  invoice_date: string;
  patient_uid: string;
  patient_name: string;
  age_years: number;
  age_months: number;
  age_days: number;
  gender: 'Male' | 'Female' | 'Other';
  patient_mobile: string;
  doctor_name?: string;
  total_params: number;
  filled_params: number;
  abnormal_count: number;
}

export interface ExpenseItem {
  id: number;
  title: string;
  category: string;
  amount: number;
  expense_date: string;
  note: string;
  created_by: string;
  created_at: string;
}

export interface AdminDashboardData {
  from: string;
  to: string;
  metrics: {
    patientsCount: number;
    totalBilled: number;
    totalDiscount: number;
    netRevenue: number;
    netCollection: number;
    dueRecovered: number;
    pendingDueInRange: number;
    doctorCommissionPayable: number;
    totalExpenses: number;
    netProfit: number;
    pendingReports: number;
    readyReportsInRange: number;
    allTimeDue: number;
    allTimeDueCount: number;
  };
  departmentBreakdown: Array<{
    category: string;
    testCount: number;
    grossAmount: number;
  }>;
  recentInvoices: InvoiceSummary[];
}

export interface StaffOverviewData {
  todayPatients: number;
  sampleCollectedCount: number;
  processingCount: number;
  verifiedCount: number;
  pendingTestsCount: number;
  readyReportsCount: number;
  dueInvoicesCount: number;
  recentQueue: Array<{
    id: number;
    test_name: string;
    category_name: string;
    status: string;
    collected_at: string;
    invoice_id: number;
    invoice_no: string;
    patient_uid: string;
    patient_name: string;
    gender: string;
    age_years: number;
  }>;
}
