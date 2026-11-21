import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Banknote,
  Calendar,
  CheckCircle2,
  CreditCard,
  FileText,
  FlaskConical,
  Printer,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { apiFetch, formatAge, formatBDT, formatDateTime, getTodayISO } from '../lib/api.ts';
import { OFFLINE_SYNCED_EVENT } from '../lib/offlineEngine.ts';
import { resolveInvoiceDiscountBreakdown } from '../../shared/discountMath.ts';
import type {
  AdminDashboardData,
  InvoiceSummary,
  LabSettings,
  NavTab,
  StaffOverviewData,
  StaffOverviewPatientGroup,
} from '../types.ts';
import { AdminAdjustBillModal } from './AdminAdjustBillModal.tsx';
import { DeletePatientConfirmModal } from './DeletePatientConfirmModal.tsx';
import { DuePaymentModal } from './DuePaymentModal.tsx';
import { SampleTimerControl } from './SampleTimerControl.tsx';

function getTestStatusDotClass(status: string): string {
  switch (status) {
    case 'Ready':
      return 'bg-emerald-500';
    case 'Verified':
      return 'bg-teal-500';
    case 'Processing':
      return 'bg-amber-500';
    default:
      return 'bg-slate-400';
  }
}

function getTestStatusTextClass(status: string): string {
  switch (status) {
    case 'Ready':
      return 'text-emerald-700';
    case 'Verified':
      return 'text-teal-700';
    case 'Processing':
      return 'text-amber-700';
    default:
      return 'text-slate-700';
  }
}

interface DashboardViewProps {
  isAdmin: boolean;
  settings: LabSettings;
  onNavigate: (tab: NavTab) => void;
  onOpenReceipt: (invoiceId: number) => void;
  onOpenDoctorPayout?: (doctorId: number) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  isAdmin,
  settings,
  onNavigate,
  onOpenReceipt,
  onOpenDoctorPayout,
}) => {
  const [fromDate, setFromDate] = useState(getTodayISO());
  const [toDate, setToDate] = useState(getTodayISO());
  const [adminData, setAdminData] = useState<AdminDashboardData | null>(null);
  const [staffData, setStaffData] = useState<StaffOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteBanner, setDeleteBanner] = useState('');
  const [deletingInvoice, setDeletingInvoice] = useState<InvoiceSummary | null>(null);
  const [duePaymentInvoiceId, setDuePaymentInvoiceId] = useState<number | null>(null);
  const [adjustBillInvoiceId, setAdjustBillInvoiceId] = useState<number | null>(null);
  const [showDailyClosing, setShowDailyClosing] = useState(false);

  // Interactive Doctor Commission Manage / Disburse Modal state
  const [commissionModalInvoice, setCommissionModalInvoice] = useState<InvoiceSummary | null>(null);
  const [commissionModalTab, setCommissionModalTab] = useState<'disburse' | 'manage'>('disburse');
  const [disburseNote, setDisburseNote] = useState('');
  const [disbursingCommission, setDisbursingCommission] = useState(false);
  const [editCommMode, setEditCommMode] = useState<'doctor_default' | 'custom_invoice' | 'custom_per_test'>(
    'doctor_default'
  );
  const [editCustomType, setEditCustomType] = useState<'percent' | 'flat'>('percent');
  const [editCustomValue, setEditCustomValue] = useState<string>('0');
  const [editPerTestMap, setEditPerTestMap] = useState<
    Record<number, { type: 'percent' | 'flat'; value: string }>
  >({});
  const [savingCommission, setSavingCommission] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (isAdmin) {
        const res = await apiFetch<AdminDashboardData>(
          `/api/admin/dashboard?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`
        );
        setAdminData(res);
      } else {
        const res = await apiFetch<StaffOverviewData>('/api/staff/overview');
        setStaffData(res);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, fromDate, toDate]);

  const openCommissionModal = (inv: InvoiceSummary, preferredTab: 'disburse' | 'manage') => {
    const docDefault = Number(inv.doctor_default_commission_pct ?? inv.commission_pct ?? 0);
    setCommissionModalInvoice(inv);
    setCommissionModalTab(
      preferredTab === 'disburse' && !inv.is_commission_paid && Number(inv.commission_amount || 0) > 0
        ? 'disburse'
        : 'manage'
    );
    setDisburseNote('');
    if (inv.commission_type === 'per_test') {
      setEditCommMode('custom_per_test');
      setEditCustomType('percent');
      setEditCustomValue(String(docDefault));
    } else if (
      inv.commission_type === 'flat' ||
      Math.abs(Number(inv.commission_value ?? docDefault) - docDefault) > 0.01
    ) {
      setEditCommMode('custom_invoice');
      setEditCustomType(inv.commission_type === 'flat' ? 'flat' : 'percent');
      setEditCustomValue(String(inv.commission_value ?? inv.commission_pct ?? 0));
    } else {
      setEditCommMode('doctor_default');
      setEditCustomType('percent');
      setEditCustomValue(String(docDefault));
    }
    const map: Record<number, { type: 'percent' | 'flat'; value: string }> = {};
    for (const ti of inv.test_items || []) {
      const key = ti.test_id ?? ti.id;
      map[key] = {
        type: ti.commission_type === 'flat' ? 'flat' : 'percent',
        value: String(ti.commission_value ?? docDefault),
      };
    }
    setEditPerTestMap(map);
  };

  const handleDisburseCommission = async () => {
    if (!commissionModalInvoice) return;
    setDisbursingCommission(true);
    setError('');
    try {
      const res = await apiFetch<{
        success: boolean;
        invoiceNo: string;
        doctorName: string;
        commissionAmount: number;
      }>(`/api/admin/invoices/${commissionModalInvoice.id}/disburse-commission`, {
        method: 'POST',
        body: JSON.stringify({ note: disburseNote.trim() }),
      });
      setCommissionModalInvoice(null);
      setDisburseNote('');
      setDeleteBanner(
        `Disbursed ${formatBDT(res.commissionAmount)} commission to ${res.doctorName} for ${res.invoiceNo} · Master commission pool updated.`
      );
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disburse doctor commission.');
    } finally {
      setDisbursingCommission(false);
    }
  };

  const handleSaveCommissionRate = async () => {
    if (!commissionModalInvoice) return;
    setSavingCommission(true);
    setError('');
    try {
      const docDefault = Number(
        commissionModalInvoice.doctor_default_commission_pct ?? commissionModalInvoice.commission_pct ?? 0
      );
      const testCommissions =
        editCommMode === 'custom_per_test'
          ? (commissionModalInvoice.test_items || [])
              .filter((ti) => typeof ti.test_id === 'number')
              .map((ti) => {
                const entry = editPerTestMap[ti.test_id!];
                return {
                  testId: ti.test_id!,
                  commissionType: (entry?.type === 'flat' ? 'flat' : 'percent') as 'percent' | 'flat',
                  commissionValue: entry ? Math.max(0, Number(entry.value || 0)) : docDefault,
                };
              })
          : undefined;

      await apiFetch(`/api/admin/invoices/${commissionModalInvoice.id}/commission`, {
        method: 'PUT',
        body: JSON.stringify({
          commissionMode: editCommMode,
          commissionType: editCustomType,
          commissionValue: Math.max(0, Number(editCustomValue || 0)),
          testCommissions,
        }),
      });
      setCommissionModalInvoice(null);
      setDeleteBanner(
        `Updated doctor commission for ${commissionModalInvoice.invoice_no} (${commissionModalInvoice.patient_name}) · Master commission pool and Net Revenue recalculated.`
      );
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update doctor commission.');
    } finally {
      setSavingCommission(false);
    }
  };

  useEffect(() => {
    loadData();
    const onOfflineSynced = () => {
      void loadData();
    };
    window.addEventListener(OFFLINE_SYNCED_EVENT, onOfflineSynced);
    return () => {
      window.removeEventListener(OFFLINE_SYNCED_EVENT, onOfflineSynced);
    };
  }, [loadData]);

  const groupedSampleQueue = useMemo<StaffOverviewPatientGroup[]>(() => {
    if (!staffData) return [];
    if (Array.isArray(staffData.recentPatientQueue) && staffData.recentPatientQueue.length > 0) {
      return staffData.recentPatientQueue;
    }
    const map = new Map<number, StaffOverviewPatientGroup>();
    for (const q of staffData.recentQueue || []) {
      let grp = map.get(q.invoice_id);
      if (!grp) {
        grp = {
          invoice_id: q.invoice_id,
          invoice_no: q.invoice_no,
          created_at: q.collected_at,
          patient_uid: q.patient_uid,
          patient_name: q.patient_name,
          age_years: q.age_years || 0,
          age_months: q.age_months || 0,
          age_days: q.age_days || 0,
          gender: (q.gender as 'Male' | 'Female' | 'Other') || 'Male',
          latest_collected_at: q.collected_at,
          ready_count: 0,
          total_tests: 0,
          tests: [],
        };
        map.set(q.invoice_id, grp);
      }
      const typedStatus =
        (q.status as 'Sample Collected' | 'Processing' | 'Verified' | 'Ready') || 'Sample Collected';
      grp.tests.push({
        id: q.id,
        test_name: q.test_name,
        category_name: q.category_name,
        status: typedStatus,
        collected_at: q.collected_at,
      });
      grp.total_tests += 1;
      if (typedStatus === 'Ready') grp.ready_count += 1;
      if (q.collected_at && q.collected_at > grp.latest_collected_at) {
        grp.latest_collected_at = q.collected_at;
      }
    }
    return Array.from(map.values());
  }, [staffData]);

  return (
    <div className="space-y-6">
      {/* Header & Quick Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy tracking-tight">
            {isAdmin ? 'Admin Financial & Lab Overview' : 'Reception & Lab Operations'}
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            {settings.lab_name} · {settings.lab_address}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('billing')}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark transition-colors whitespace-nowrap shrink-0"
          >
            <UserPlus className="w-4 h-4" />
            New Patient Entry
          </button>
          <button
            type="button"
            onClick={() => onNavigate('dues')}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-brand-navy bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <CreditCard className="w-4 h-4 text-brand-cyan" />
            Due Collection
          </button>
          {isAdmin ? (
            <button
              type="button"
              onClick={() => setShowDailyClosing((v) => !v)}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-brand-cyan rounded-lg hover:bg-brand-cyan-dark transition-colors whitespace-nowrap shrink-0"
            >
              <FileText className="w-4 h-4" />
              Daily Closing
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('lab')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-brand-cyan rounded-lg hover:bg-brand-cyan-dark transition-colors whitespace-nowrap shrink-0"
            >
              <FlaskConical className="w-4 h-4" />
              Lab Result Entry
            </button>
          )}
        </div>
      </div>

      {/* Admin Date Filter Bar */}
      {isAdmin && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <Calendar className="w-4 h-4 text-slate-500" />
              <span>Period</span>
            </div>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="px-3 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
            <span className="text-slate-400 text-sm">to</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="px-3 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
            <button
              type="button"
              onClick={() => {
                const today = getTodayISO();
                setFromDate(today);
                setToDate(today);
              }}
              className="px-3 py-1.5 text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 transition-colors whitespace-nowrap shrink-0"
            >
              Today
            </button>
          </div>
          <button
            type="button"
            onClick={loadData}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      )}

      {error && (
        <div className="p-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl">{error}</div>
      )}

      {deleteBanner && (
        <div className="p-3.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl">
          {deleteBanner}
        </div>
      )}

      {/* Daily Closing Summary Sheet (Admin) */}
      {isAdmin && showDailyClosing && adminData && (
        <div className="bg-white border border-slate-300 rounded-xl p-6 print-sheet">
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4 mb-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Daily Closing Statement · {settings.lab_name}
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Period: <span className="font-mono tabular-nums">{adminData.from}</span> to{' '}
                <span className="font-mono tabular-nums">{adminData.to}</span> · Proprietor: {settings.proprietor_name}
              </p>
            </div>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark no-print whitespace-nowrap shrink-0"
            >
              <Printer className="w-3.5 h-3.5" />
              Print Closing
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
            <div>
              <div className="text-xs text-slate-500">Gross Billed</div>
              <div className="text-base font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                {formatBDT(adminData.metrics.totalBilled)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Total Less / Discount</div>
              <div className="text-base font-bold font-mono tabular-nums text-amber-700 mt-0.5">
                - {formatBDT(adminData.metrics.totalDiscount)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Total Revenue (Net − Comm.)</div>
              <div className="text-base font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                {formatBDT(adminData.metrics.netRevenue)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Cash Collected (Net + Due Rec.)</div>
              <div className="text-base font-bold font-mono tabular-nums text-teal-700 mt-0.5">
                {formatBDT(adminData.metrics.netCollection)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Lab Expenses</div>
              <div className="text-base font-bold font-mono tabular-nums text-red-700 mt-0.5">
                - {formatBDT(adminData.metrics.totalExpenses)}
              </div>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4 text-sm">
            <div className="text-slate-600">
              Doctor Commission Payable:{' '}
              <span className="font-mono font-semibold tabular-nums text-slate-900">
                {formatBDT(adminData.metrics.doctorCommissionPayable)}
              </span>
            </div>
            <div className="text-slate-900 font-bold">
              Estimated Net Surplus (Cash - Commission - Expense):{' '}
              <span className="font-mono tabular-nums text-teal-700">
                {formatBDT(adminData.metrics.netProfit)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ADMIN KPI GRID */}
      {isAdmin && adminData && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Total Patients</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1.5">
                {adminData.metrics.patientsCount}
              </div>
              <div className="text-xs text-slate-500 mt-2">
                {adminData.metrics.readyReportsInRange} reports finalized in range
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Total Revenue (Net Billed)</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1.5">
                {formatBDT(adminData.metrics.netRevenue)}
              </div>
              <div className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
                Net Billed{' '}
                {formatBDT(
                  adminData.metrics.totalNetBilled ??
                    adminData.metrics.netRevenue + adminData.metrics.doctorCommissionPayable
                )}{' '}
                − Comm. {formatBDT(adminData.metrics.doctorCommissionPayable)} · Gross{' '}
                {formatBDT(adminData.metrics.totalBilled)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Total Discounts (Less)</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-amber-700 mt-1.5">
                {formatBDT(adminData.metrics.totalDiscount)}
              </div>
              <div className="text-xs text-slate-500 mt-2">
                {adminData.metrics.totalBilled > 0
                  ? `${((adminData.metrics.totalDiscount / adminData.metrics.totalBilled) * 100).toFixed(1)}% of gross billing`
                  : '0% of gross billing'}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Doctor Commissions Payable</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1.5">
                {formatBDT(adminData.metrics.doctorCommissionPayable)}
              </div>
              <div className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
                Unpaid in period {formatBDT(adminData.metrics.unpaidCommissionInRange ?? 0)} · Master Pool{' '}
                {formatBDT(adminData.metrics.masterUnpaidCommissionPool ?? 0)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Net Collection (Cash Received)</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-teal-700 mt-1.5">
                {formatBDT(adminData.metrics.netCollection)}
              </div>
              <div className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
                Includes {formatBDT(adminData.metrics.dueRecovered)} due recovered · All-time due {formatBDT(adminData.metrics.allTimeDue)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Pending Reports (All Active)</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-brand-red mt-1.5">
                {adminData.metrics.pendingReports}
              </div>
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => onNavigate('lab')}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:text-teal-800"
                >
                  Open Lab Result Queue <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Patient Invoices Table — Filtered Strictly by Selected Period Date Range */}
          <div className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Patient Invoices ({adminData.recentInvoices.length})
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Showing all patient invoices registered from{' '}
                  <span className="font-mono tabular-nums font-medium text-slate-700">
                    {adminData.from}
                  </span>{' '}
                  to{' '}
                  <span className="font-mono tabular-nums font-medium text-slate-700">
                    {adminData.to}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('billing')}
                className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap shrink-0"
              >
                View all invoices
              </button>
            </div>

            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] leading-tight text-slate-500">
                  <th className="py-2 px-1.5 pl-0 font-semibold">Invoice / Patient Info</th>
                  <th className="py-2 px-1.5 font-semibold">Referred By</th>
                  <th className="py-2 px-1.5 font-semibold">Ordered Tests</th>
                  <th className="py-2 px-1.5 font-semibold text-right">Doctor Less</th>
                  <th className="py-2 px-1.5 font-semibold text-right">Net Bill</th>
                  <th className="py-2 px-1.5 font-semibold text-right">Paid Amount</th>
                  <th className="py-2 px-1.5 font-semibold text-right">Due Amount</th>
                  <th className="py-2 px-1.5 font-semibold text-right">Doctor Commission</th>
                  <th className="py-2 px-1.5 pr-0 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {adminData.recentInvoices.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-10 text-center text-sm text-slate-500">
                      No patient invoices found for the selected period ({adminData.from} to {adminData.to}).
                    </td>
                  </tr>
                ) : (
                  adminData.recentInvoices.map((inv) => {
                    const commAmt = Number(inv.commission_amount || 0);
                    const hasDoctor = Boolean(inv.doctor_id);
                    const isCommPaid = Boolean(inv.is_commission_paid);
                    const commRateLabel =
                      inv.commission_type === 'per_test'
                        ? `Per-Test (${inv.commission_pct ?? 0}%)`
                        : inv.commission_type === 'flat'
                        ? `Flat`
                        : `${inv.commission_pct ?? 0}%`;
                    const discountBd = resolveInvoiceDiscountBreakdown(inv);
                    const hasDoctorLess =
                      discountBd.doctorLessPercent > 0 || discountBd.doctorLessAmount > 0;

                    return (
                      <tr key={inv.id} className="hover:bg-slate-50 align-top">
                        {/* 1. Invoice / Patient Info (Compact stacked layout) */}
                        <td className="py-2 px-1.5 pl-0 max-w-[155px]">
                          <div className="font-mono tabular-nums text-[11px] font-bold text-slate-900 leading-tight">
                            {inv.invoice_no}
                          </div>
                          <div className="text-[11px] leading-snug text-slate-700 mt-0.5 break-words">
                            <span className="font-semibold text-slate-900">{inv.patient_name}</span>
                            <span className="text-slate-400 mx-1">/</span>
                            <span className="font-mono tabular-nums text-[10px] text-slate-500">
                              {inv.patient_uid}
                            </span>
                          </div>
                        </td>

                        {/* 2. Referred By */}
                        <td className="py-2 px-1.5 max-w-[125px]">
                          <div className="font-medium text-slate-900 truncate" title={inv.doctor_name || 'Self'}>
                            {inv.doctor_name || 'Self'}
                          </div>
                          {inv.doctor_degree && (
                            <div
                              className="text-[10px] text-slate-500 truncate mt-0.5"
                              title={inv.doctor_degree}
                            >
                              {inv.doctor_degree}
                            </div>
                          )}
                        </td>

                        {/* 3. Ordered Tests */}
                        <td className="py-2 px-1.5 max-w-[190px]">
                          {inv.test_items && inv.test_items.length > 0 ? (
                            <div className="space-y-0.5">
                              <div className="flex flex-wrap gap-1">
                                {inv.test_items.map((t) => (
                                  <span
                                    key={t.id}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-white border border-slate-200 text-slate-700"
                                  >
                                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${getTestStatusDotClass(t.status)}`} />
                                    <span className="truncate max-w-[95px]" title={t.test_name}>
                                      {t.test_name}
                                    </span>
                                  </span>
                                ))}
                              </div>
                              <div className="text-[10px] font-mono tabular-nums text-slate-500">
                                {inv.ready_tests ?? 0}/{inv.total_tests ?? inv.test_items.length} Ready
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>

                        {/* 4. Doctor Less */}
                        <td className="py-2 px-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                          {hasDoctorLess ? (
                            <div>
                              <div className="font-semibold text-amber-700">
                                {discountBd.doctorLessPercent}%
                              </div>
                              <div className="text-[10px] text-slate-600">
                                {formatBDT(discountBd.doctorLessAmount)}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>

                        {/* 5. Net Bill */}
                        <td className="py-2 px-1.5 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                          <div>{formatBDT(inv.net_total)}</div>
                          {discountBd.flatDiscountAmount > 0 && (
                            <div className="text-[10px] font-normal text-amber-700">
                              Flat: -{formatBDT(discountBd.flatDiscountAmount)}
                            </div>
                          )}
                          {Number(inv.adjustment_amount || 0) !== 0 && (
                            <div className="text-[10px] font-semibold text-amber-700">
                              Adj:{' '}
                              {Number(inv.adjustment_amount) > 0
                                ? `-${formatBDT(inv.adjustment_amount)}`
                                : `+${formatBDT(Math.abs(Number(inv.adjustment_amount)))}`}
                            </div>
                          )}
                        </td>

                        {/* 6. Paid Amount */}
                        <td className="py-2 px-1.5 text-right font-mono tabular-nums font-semibold text-teal-700 whitespace-nowrap">
                          {formatBDT(inv.paid_amount)}
                        </td>

                        {/* 7. Due Amount */}
                        <td className="py-2 px-1.5 text-right font-mono tabular-nums font-semibold whitespace-nowrap">
                          {inv.due_amount > 0 ? (
                            <span className="text-red-700">{formatBDT(inv.due_amount)}</span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>

                        {/* 8. Doctor Commission (interactive disburse / manage) */}
                        <td className="py-2 px-1.5 text-right whitespace-nowrap">
                          {hasDoctor ? (
                            <div className="inline-flex flex-col items-end gap-0.5">
                              <div className="font-mono tabular-nums font-semibold text-slate-900">
                                {formatBDT(commAmt)}
                              </div>
                              <div className="text-[10px] text-slate-500 font-mono tabular-nums">
                                {commRateLabel} ·{' '}
                                <span
                                  className={
                                    isCommPaid ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-700'
                                  }
                                >
                                  {isCommPaid ? 'Paid' : 'Unpaid'}
                                </span>
                              </div>
                              <div className="inline-flex items-center gap-1 mt-0.5">
                                {!isCommPaid && commAmt > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => openCommissionModal(inv, 'disburse')}
                                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100 whitespace-nowrap cursor-pointer"
                                    title="Disburse doctor commission and update master pool"
                                  >
                                    <Banknote className="w-2.5 h-2.5" />
                                    Disburse
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => openCommissionModal(inv, 'manage')}
                                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                                  title="Manage or adjust commission for this patient invoice"
                                >
                                  <SlidersHorizontal className="w-2.5 h-2.5" />
                                  Manage
                                </button>
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>

                        {/* 9. Actions */}
                        <td className="py-2 px-1.5 pr-0 text-right">
                          <div className="inline-flex flex-wrap items-center justify-end gap-1 max-w-[136px]">
                            {inv.due_amount > 0 && (
                              <button
                                type="button"
                                onClick={() => setDuePaymentInvoiceId(inv.id)}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100 whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <CreditCard className="w-3 h-3" />
                                Pay Due
                              </button>
                            )}
                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() => setAdjustBillInvoiceId(inv.id)}
                                title="Adjust or reduce net bill (Admin only)"
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded hover:bg-amber-100 whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <ShieldCheck className="w-3 h-3" />
                                Adjust Bill
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onOpenReceipt(inv.id)}
                              className="px-1.5 py-0.5 text-[11px] font-semibold text-teal-700 bg-teal-50/70 border border-teal-200 rounded hover:bg-teal-100 whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              Print
                            </button>
                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() => {
                                  setDeleteBanner('');
                                  setDeletingInvoice(inv);
                                }}
                                title="Delete patient record (Admin only)"
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <Trash2 className="w-3 h-3" />
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Department Breakdown */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <h2 className="text-sm font-semibold text-slate-900">Department Test Volume</h2>
              <div className="text-xs text-slate-600">
                Expenses in period:{' '}
                <span className="font-mono font-semibold text-red-700 tabular-nums">
                  {formatBDT(adminData.metrics.totalExpenses)}
                </span>
              </div>
            </div>
            {adminData.departmentBreakdown.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">No tests billed in selected period.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {adminData.departmentBreakdown.map((d) => (
                  <div
                    key={d.category}
                    className="p-3 border border-slate-200 rounded-lg flex items-center justify-between gap-3 text-sm"
                  >
                    <div>
                      <div className="font-medium text-slate-800">{d.category}</div>
                      <div className="text-xs text-slate-500 font-mono tabular-nums">{d.testCount} tests</div>
                    </div>
                    <div className="font-mono tabular-nums font-semibold text-slate-900">
                      {formatBDT(d.grossAmount)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* STAFF / RECEPTION OPERATIONS DASHBOARD */}
      {!isAdmin && staffData && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Today&apos;s Registered Patients</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1.5">
                {staffData.todayPatients}
              </div>
              <div className="text-xs text-slate-500 mt-2">Active reception intake</div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Pending Lab Tests</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-amber-700 mt-1.5">
                {staffData.pendingTestsCount}
              </div>
              <div className="text-xs text-slate-500 mt-2">
                {staffData.sampleCollectedCount} collected · {staffData.processingCount} processing
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Ready Reports Today</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-emerald-700 mt-1.5">
                {staffData.readyReportsCount}
              </div>
              <div className="text-xs text-slate-500 mt-2">Verified & ready for delivery</div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Invoices With Pending Due</div>
              <div className="text-2xl font-bold font-mono tabular-nums text-red-700 mt-1.5">
                {staffData.dueInvoicesCount}
              </div>
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => onNavigate('dues')}
                  className="text-xs font-semibold text-teal-700 hover:underline"
                >
                  Open Due Ledger →
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 overflow-x-auto">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Active Sample &amp; Lab Queue ({groupedSampleQueue.length}{' '}
                  {groupedSampleQueue.length === 1 ? 'patient' : 'patients'})
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Grouped per patient invoice with live test status badges.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('lab')}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-700 hover:underline whitespace-nowrap shrink-0"
              >
                <FlaskConical className="w-3.5 h-3.5" />
                Enter Lab Results
              </button>
            </div>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-2 pr-3 font-medium">Invoice / ID</th>
                  <th className="py-2 pr-3 font-medium">Patient</th>
                  <th className="py-2 pr-3 font-medium">Ordered Tests</th>
                  <th className="py-2 pr-3 font-medium">Sample Timer</th>
                  <th className="py-2 pr-3 font-medium">Collected</th>
                  <th className="py-2 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {groupedSampleQueue.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-sm text-slate-500">
                      No active sample queue entries yet.
                    </td>
                  </tr>
                ) : (
                  groupedSampleQueue.map((group) => {
                    const allReady = group.ready_count === group.total_tests && group.total_tests > 0;
                    return (
                      <tr key={group.invoice_id} className="hover:bg-slate-50 align-top">
                        <td className="py-3 pr-3 font-mono tabular-nums text-xs whitespace-nowrap">
                          <div className="font-semibold text-slate-900">{group.invoice_no}</div>
                          <div className="text-slate-500">{group.patient_uid}</div>
                        </td>
                        <td className="py-3 pr-3">
                          <div className="font-semibold text-slate-900">{group.patient_name}</div>
                          <div className="text-xs text-slate-500">
                            {formatAge(group.age_years, group.age_months, group.age_days)} · {group.gender}
                            {group.doctor_name ? ` · ${group.doctor_name}` : ''}
                          </div>
                        </td>
                        <td className="py-3 pr-3">
                          <div className="flex flex-wrap gap-1.5">
                            {group.tests.map((t) => (
                              <span
                                key={t.id}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md bg-white border border-slate-200 text-slate-700"
                              >
                                <span className={`w-1.5 h-1.5 rounded-full ${getTestStatusDotClass(t.status)}`} />
                                <span className="truncate max-w-[160px]">{t.test_name}</span>
                              </span>
                            ))}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-1">
                            {group.total_tests} {group.total_tests === 1 ? 'test' : 'tests'}
                          </div>
                        </td>
                        <td className="py-3 pr-3">
                          <SampleTimerControl
                            compact
                            alignRight={false}
                            invoiceId={group.invoice_id}
                            invoiceNo={group.invoice_no}
                            patientUid={group.patient_uid}
                            patientName={group.patient_name}
                            tests={group.tests}
                          />
                        </td>
                        <td className="py-3 pr-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                          {formatDateTime(group.latest_collected_at)}
                        </td>
                        <td className="py-3 text-right text-xs font-semibold whitespace-nowrap">
                          <span
                            className={
                              allReady
                                ? 'text-emerald-700'
                                : group.tests.length === 1
                                ? getTestStatusTextClass(group.tests[0].status)
                                : 'text-amber-700'
                            }
                          >
                            {group.tests.length === 1
                              ? group.tests[0].status
                              : allReady
                              ? 'All Ready'
                              : `${group.ready_count}/${group.total_tests} Ready`}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <DuePaymentModal
        invoiceId={duePaymentInvoiceId}
        isAdmin={isAdmin}
        onClose={() => setDuePaymentInvoiceId(null)}
        onOpenReceipt={onOpenReceipt}
        onOpenAdminAdjust={isAdmin ? (invId) => setAdjustBillInvoiceId(invId) : undefined}
        onPaymentRecorded={async (updated) => {
          setDeleteBanner(
            `Payment recorded for ${updated.invoice.invoice_no} (${updated.invoice.patient_name}) · Due: ${formatBDT(updated.invoice.due_amount)}`
          );
          await loadData();
        }}
      />

      {isAdmin && (
        <AdminAdjustBillModal
          invoiceId={adjustBillInvoiceId}
          onClose={() => setAdjustBillInvoiceId(null)}
          onAdjusted={async (updated) => {
            setDeleteBanner(
              `Admin adjusted bill for ${updated.invoice.invoice_no} (${updated.invoice.patient_name}) · New Net: ${formatBDT(updated.invoice.net_total)} · Due: ${formatBDT(updated.invoice.due_amount)}`
            );
            await loadData();
          }}
        />
      )}

      <DeletePatientConfirmModal
        target={deletingInvoice}
        onClose={() => setDeletingInvoice(null)}
        onDeleted={async (result) => {
          setDeletingInvoice(null);
          setDeleteBanner(
            `Deleted ${result.invoiceNo} (${result.patientName})${
              result.patientDeleted ? ' and patient profile' : ''
            } · ${result.deletedTestsCount} test record(s) removed.`
          );
          await loadData();
        }}
      />

      {/* Interactive Doctor Commission Disburse & Manage Modal */}
      {isAdmin && commissionModalInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[2px]">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Doctor Commission · {commissionModalInvoice.invoice_no}
                </h3>
                <p className="text-xs text-slate-600 mt-0.5">
                  Patient: <span className="font-medium text-slate-800">{commissionModalInvoice.patient_name}</span>{' '}
                  · Ref: <span className="font-medium text-slate-800">{commissionModalInvoice.doctor_name || 'Doctor'}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCommissionModalInvoice(null)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                aria-label="Close commission modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Summary Strip */}
            <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 grid grid-cols-3 gap-3 text-xs">
              <div>
                <div className="text-slate-500">Net Bill</div>
                <div className="font-mono tabular-nums font-bold text-slate-900 mt-0.5">
                  {formatBDT(commissionModalInvoice.net_total)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Commission</div>
                <div className="font-mono tabular-nums font-bold text-teal-700 mt-0.5">
                  {formatBDT(commissionModalInvoice.commission_amount || 0)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-slate-500">Pool Status</div>
                <div
                  className={`font-semibold mt-0.5 ${
                    commissionModalInvoice.is_commission_paid ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {commissionModalInvoice.is_commission_paid ? 'Paid / Settled' : 'Unpaid in Pool'}
                </div>
              </div>
            </div>

            {/* Modal Mode Tabs */}
            <div className="px-5 pt-3 flex items-center gap-2 border-b border-slate-200">
              {!commissionModalInvoice.is_commission_paid &&
                Number(commissionModalInvoice.commission_amount || 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => setCommissionModalTab('disburse')}
                    className={`pb-2.5 px-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                      commissionModalTab === 'disburse'
                        ? 'border-teal-600 text-teal-700'
                        : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Disburse Commission
                  </button>
                )}
              <button
                type="button"
                onClick={() => setCommissionModalTab('manage')}
                className={`pb-2.5 px-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                  commissionModalTab === 'manage'
                    ? 'border-teal-600 text-teal-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                Adjust Rate / Amount
              </button>
            </div>

            <div className="p-5 space-y-4">
              {commissionModalTab === 'disburse' && !commissionModalInvoice.is_commission_paid ? (
                <>
                  <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-1">
                    <div className="font-semibold flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                      <span>
                        Confirm disbursement of {formatBDT(commissionModalInvoice.commission_amount || 0)}
                      </span>
                    </div>
                    <p className="text-emerald-800 leading-relaxed">
                      This marks this patient&apos;s referral commission as Paid, logs a settlement entry for{' '}
                      {commissionModalInvoice.doctor_name}, and subtracts{' '}
                      {formatBDT(commissionModalInvoice.commission_amount || 0)} from the master unpaid commission pool.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Settlement Note (Optional)
                    </label>
                    <input
                      type="text"
                      value={disburseNote}
                      onChange={(e) => setDisburseNote(e.target.value)}
                      placeholder={`e.g. Paid cash for ${commissionModalInvoice.invoice_no}`}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                    {commissionModalInvoice.doctor_id && onOpenDoctorPayout ? (
                      <button
                        type="button"
                        onClick={() => {
                          const docId = commissionModalInvoice.doctor_id!;
                          setCommissionModalInvoice(null);
                          onOpenDoctorPayout(docId);
                        }}
                        className="text-xs font-semibold text-teal-700 hover:underline cursor-pointer"
                      >
                        Open Full Doctor Payout Pool →
                      </button>
                    ) : (
                      <span />
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setCommissionModalInvoice(null)}
                        className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={disbursingCommission}
                        onClick={handleDisburseCommission}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                      >
                        <Banknote className="w-3.5 h-3.5" />
                        {disbursingCommission
                          ? 'Disbursing...'
                          : `Disburse ${formatBDT(commissionModalInvoice.commission_amount || 0)}`}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-2.5">
                    <label className="block text-xs font-semibold text-slate-700">Commission Mode</label>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setEditCommMode('doctor_default')}
                        className={`py-2 px-2.5 rounded-lg border font-medium cursor-pointer ${
                          editCommMode === 'doctor_default'
                            ? 'bg-brand-navy text-white border-brand-navy'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        Doctor Default ({commissionModalInvoice.doctor_default_commission_pct ?? 0}%)
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditCommMode('custom_invoice')}
                        className={`py-2 px-2.5 rounded-lg border font-medium cursor-pointer ${
                          editCommMode === 'custom_invoice'
                            ? 'bg-brand-navy text-white border-brand-navy'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        Custom Invoice
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditCommMode('custom_per_test')}
                        className={`py-2 px-2.5 rounded-lg border font-medium cursor-pointer ${
                          editCommMode === 'custom_per_test'
                            ? 'bg-brand-navy text-white border-brand-navy'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        Per-Test Override
                      </button>
                    </div>
                  </div>

                  {editCommMode === 'custom_invoice' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">Type</label>
                        <select
                          value={editCustomType}
                          onChange={(e) => setEditCustomType(e.target.value as 'percent' | 'flat')}
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                        >
                          <option value="percent">Percentage (%)</option>
                          <option value="flat">Flat Amount (৳)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          {editCustomType === 'percent' ? 'Rate (%)' : 'Amount (৳)'}
                        </label>
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={editCustomValue}
                          onChange={(e) => setEditCustomValue(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                        />
                      </div>
                    </div>
                  )}

                  {editCommMode === 'custom_per_test' && (
                    <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-200">
                      {(commissionModalInvoice.test_items || []).map((ti) => {
                        const key = ti.test_id ?? ti.id;
                        const entry = editPerTestMap[key] || { type: 'percent', value: '0' };
                        return (
                          <div key={ti.id} className="p-2.5 flex items-center justify-between gap-2 text-xs">
                            <div className="min-w-0">
                              <div className="font-medium text-slate-900 truncate">{ti.test_name}</div>
                              <div className="text-slate-500 font-mono tabular-nums">
                                Fee: {formatBDT(ti.price || 0)}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <select
                                value={entry.type}
                                onChange={(e) =>
                                  setEditPerTestMap((prev) => ({
                                    ...prev,
                                    [key]: { ...entry, type: e.target.value as 'percent' | 'flat' },
                                  }))
                                }
                                className="px-2 py-1 border border-slate-300 rounded bg-white"
                              >
                                <option value="percent">%</option>
                                <option value="flat">৳</option>
                              </select>
                              <input
                                type="number"
                                min={0}
                                step="any"
                                value={entry.value}
                                onChange={(e) =>
                                  setEditPerTestMap((prev) => ({
                                    ...prev,
                                    [key]: { ...entry, value: e.target.value },
                                  }))
                                }
                                className="w-20 px-2 py-1 font-mono tabular-nums border border-slate-300 rounded text-right"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200">
                    {commissionModalInvoice.doctor_id && onOpenDoctorPayout ? (
                      <button
                        type="button"
                        onClick={() => {
                          const docId = commissionModalInvoice.doctor_id!;
                          setCommissionModalInvoice(null);
                          onOpenDoctorPayout(docId);
                        }}
                        className="text-xs font-semibold text-teal-700 hover:underline cursor-pointer"
                      >
                        Open Doctor Payout Pool →
                      </button>
                    ) : (
                      <span />
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setCommissionModalInvoice(null)}
                        className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={savingCommission}
                        onClick={handleSaveCommissionRate}
                        className="px-4 py-2 text-xs font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark disabled:opacity-50 cursor-pointer"
                      >
                        {savingCommission ? 'Saving...' : 'Save & Update Pool'}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
