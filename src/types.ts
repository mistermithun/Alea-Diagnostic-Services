export type UserRole = 'admin' | 'staff';

export type NavTab =
  | 'dashboard'
  | 'billing'
  | 'lab'
  | 'dues'
  | 'catalog'
  | 'doctors'
  | 'payouts'
  | 'expenses'
  | 'balance'
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
  last_commission_paid_up_to?: string;
  last_commission_settled_at?: string;
  last_commission_paid_amount?: number;
  unpaid_referrals_count?: number;
  unpaid_commission_total?: number;
  portal_username?: string;
  portal_password?: string;
  portal_enabled?: number;
  is_active: number;
}

export interface TestCommissionOverride {
  testId: number;
  commissionType: 'percent' | 'flat';
  commissionValue: number;
}

export interface InvoiceTestBadgeItem {
  id: number;
  test_name: string;
  category_name: string;
  status: 'Sample Collected' | 'Processing' | 'Verified' | 'Ready';
  collected_at?: string;
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
  discount_pct?: number;
  net_total: number;
  paid_amount: number;
  due_amount: number;
  payment_status: 'Paid' | 'Partial' | 'Due';
  adjustment_amount?: number;
  adjustment_reason?: string;
  adjusted_by?: string;
  adjusted_at?: string;
  initial_payment_method?: string;
  commission_type?: 'percent' | 'flat' | 'per_test';
  commission_value?: number;
  commission_pct?: number;
  commission_amount?: number;
  commission_paid?: number;
  commission_paid_at?: string;
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
  test_items?: InvoiceTestBadgeItem[];
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
  commission_type?: 'percent' | 'flat';
  commission_value?: number;
  commission_amount?: number;
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
  entry_type?: 'payment' | 'refund';
  payment_method: string;
  note: string;
  collected_by: string;
  collected_at: string;
}

export interface InvoiceAdjustment {
  id: number;
  invoice_id: number;
  previous_net_total: number;
  new_net_total: number;
  adjustment_delta: number;
  previous_paid_amount: number;
  new_paid_amount: number;
  refund_amount: number;
  reason: string;
  adjusted_by: string;
  adjusted_at: string;
}

export interface FullInvoice {
  invoice: InvoiceSummary;
  tests: InvoiceTestItem[];
  duePayments: DuePayment[];
  adjustments?: InvoiceAdjustment[];
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

export interface OtherRevenueItem {
  id: number;
  source: string;
  category: string;
  amount: number;
  revenue_date: string;
  note: string;
  created_by: string;
  created_at: string;
}

export interface BalanceLedgerRow {
  date: string;
  openingBalance: number;
  labRevenue: number;
  otherRevenue: number;
  totalAvailableCash: number;
  operationalExpenses: number;
  ownerWithdrawals: number;
  expensesAndWithdrawals: number;
  closingBalance: number;
  netDayChange: number;
  labPaymentsCount: number;
  otherRevenuesCount: number;
  expensesCount: number;
}

export interface BalanceLedgerResponse {
  from: string;
  to: string;
  today: string;
  priorOpeningBalance: number;
  todaySummary: {
    date: string;
    openingBalance: number;
    labRevenue: number;
    otherRevenue: number;
    totalInflow: number;
    totalAvailable: number;
    operationalExpenses: number;
    ownerWithdrawals: number;
    totalExpensesAndWithdrawals: number;
    closingBalance: number;
  };
  periodTotals: {
    openingBalance: number;
    labRevenue: number;
    otherRevenue: number;
    totalInflow: number;
    operationalExpenses: number;
    ownerWithdrawals: number;
    totalExpensesAndWithdrawals: number;
    netChange: number;
    closingBalance: number;
  };
  rows: BalanceLedgerRow[];
  otherRevenues: OtherRevenueItem[];
  expenses: ExpenseItem[];
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

export interface StaffOverviewPatientGroup {
  invoice_id: number;
  invoice_no: string;
  created_at: string;
  patient_uid: string;
  patient_name: string;
  age_years: number;
  age_months: number;
  age_days: number;
  gender: 'Male' | 'Female' | 'Other';
  patient_mobile?: string;
  doctor_name?: string;
  latest_collected_at: string;
  ready_count: number;
  total_tests: number;
  tests: InvoiceTestBadgeItem[];
}

export interface StaffOverviewData {
  todayPatients: number;
  sampleCollectedCount: number;
  processingCount: number;
  verifiedCount: number;
  pendingTestsCount: number;
  readyReportsCount: number;
  dueInvoicesCount: number;
  recentPatientQueue?: StaffOverviewPatientGroup[];
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
    age_months?: number;
    age_days?: number;
  }>;
}

export interface DoctorStatementReferral {
  id: number;
  invoice_no: string;
  created_at: string;
  subtotal: number;
  discount_type: 'percent' | 'flat';
  discount_value: number;
  discount_pct: number;
  discount_amount: number;
  net_total: number;
  paid_amount: number;
  due_amount: number;
  commission_type: 'percent' | 'flat' | 'per_test';
  commission_value: number;
  commission_pct: number;
  commission_amount: number;
  is_commission_paid: boolean;
  commission_paid_at: string;
  is_accrued_after_last_paid: boolean;
  patient_uid: string;
  patient_name: string;
  test_names: string;
  test_items: Array<{
    id: number;
    test_id: number;
    test_name: string;
    price: number;
    commission_type: 'percent' | 'flat';
    commission_value: number;
    commission_amount: number;
  }>;
}

export interface DoctorPayoutHistoryItem {
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

export interface DoctorStatementResponse {
  doctor: Doctor;
  from: string;
  to: string;
  status: 'unpaid' | 'all' | 'paid';
  suggestedNextFrom: string;
  allTimeUnpaid: {
    count: number;
    amount: number;
  };
  referrals: DoctorStatementReferral[];
  totals: {
    totalPatients: number;
    totalGross: number;
    totalDiscount: number;
    totalNet: number;
    totalPaid: number;
    totalDue: number;
    totalCommission: number;
    unpaidPatients: number;
    unpaidCommission: number;
    paidCommission: number;
  };
  payoutHistory: DoctorPayoutHistoryItem[];
}

export interface DoctorPortalProfile {
  id: number;
  name: string;
  degree: string;
  hospital: string;
  mobile: string;
  commission_pct: number;
  portal_username: string;
  portal_enabled?: number;
  last_commission_paid_up_to?: string;
}

export interface DoctorPortalPatientVisit {
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
  subtotal: number;
  discount_type: 'percent' | 'flat';
  discount_value: number;
  discount_pct: number;
  discount_amount: number;
  net_total: number;
  paid_amount: number;
  due_amount: number;
  payment_status: 'Paid' | 'Partial' | 'Due';
  commission_type: 'percent' | 'flat' | 'per_test';
  commission_value: number;
  commission_pct: number;
  commission_amount: number;
  is_commission_paid: boolean;
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

export interface DoctorPortalDashboardResponse {
  doctor: DoctorPortalProfile;
  from: string;
  to: string;
  summary: {
    totalPatients: number;
    readyReportsCount: number;
    pendingReportsCount: number;
    totalChargedGross: number;
    totalDiscount: number;
    totalNetCharged: number;
    totalCommission: number;
    unpaidCommission: number;
    paidCommission: number;
  };
  patients: DoctorPortalPatientVisit[];
}
