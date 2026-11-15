import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Calendar,
  CreditCard,
  FileText,
  FlaskConical,
  Printer,
  RefreshCw,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { apiFetch, formatBDT, formatDateTime, getTodayISO } from '../lib/api.ts';
import type { AdminDashboardData, InvoiceSummary, LabSettings, NavTab, StaffOverviewData } from '../types.ts';
import { DeletePatientConfirmModal } from './DeletePatientConfirmModal.tsx';

interface DashboardViewProps {
  isAdmin: boolean;
  settings: LabSettings;
  onNavigate: (tab: NavTab) => void;
  onOpenReceipt: (invoiceId: number) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  isAdmin,
  settings,
  onNavigate,
  onOpenReceipt,
}) => {
  const [fromDate, setFromDate] = useState(getTodayISO());
  const [toDate, setToDate] = useState(getTodayISO());
  const [adminData, setAdminData] = useState<AdminDashboardData | null>(null);
  const [staffData, setStaffData] = useState<StaffOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteBanner, setDeleteBanner] = useState('');
  const [deletingInvoice, setDeletingInvoice] = useState<InvoiceSummary | null>(null);
  const [showDailyClosing, setShowDailyClosing] = useState(false);

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

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <div className="space-y-6">
      {/* Header & Quick Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
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
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap shrink-0"
          >
            <UserPlus className="w-4 h-4" />
            New Patient Entry
          </button>
          <button
            type="button"
            onClick={() => onNavigate('dues')}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <CreditCard className="w-4 h-4 text-slate-600" />
            Due Collection
          </button>
          {isAdmin ? (
            <button
              type="button"
              onClick={() => setShowDailyClosing((v) => !v)}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <FileText className="w-4 h-4" />
              Daily Closing
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('lab')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
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
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 no-print whitespace-nowrap shrink-0"
            >
              <Printer className="w-3.5 h-3.5" />
              Print Closing
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
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
                Gross {formatBDT(adminData.metrics.totalBilled)}
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
              <div className="text-xs text-slate-500 mt-2">
                Calculated on net patient bills
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
              <div className="text-2xl font-bold font-mono tabular-nums text-red-700 mt-1.5">
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

          {/* Department Breakdown & Recent Invoices */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-slate-900 mb-3">Department Test Volume</h2>
              {adminData.departmentBreakdown.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center">No tests billed in selected period.</p>
              ) : (
                <div className="divide-y divide-slate-200">
                  {adminData.departmentBreakdown.map((d) => (
                    <div key={d.category} className="py-2.5 flex items-center justify-between gap-3 text-sm">
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
              <div className="mt-4 pt-3 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
                <span>Expenses in period</span>
                <span className="font-mono font-semibold text-red-700 tabular-nums">
                  {formatBDT(adminData.metrics.totalExpenses)}
                </span>
              </div>
            </div>

            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 overflow-x-auto">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-slate-900">Recent Patient Invoices</h2>
                <button
                  type="button"
                  onClick={() => onNavigate('billing')}
                  className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap shrink-0"
                >
                  View all invoices
                </button>
              </div>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-3 font-medium">Invoice</th>
                    <th className="py-2 pr-3 font-medium">Patient</th>
                    <th className="py-2 pr-3 font-medium text-right">Net Bill</th>
                    <th className="py-2 pr-3 font-medium text-right">Due</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {adminData.recentInvoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50">
                      <td className="py-2.5 pr-3 font-mono tabular-nums text-xs font-semibold text-slate-800">
                        {inv.invoice_no}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-slate-900">{inv.patient_name}</div>
                        <div className="text-xs text-slate-500 font-mono tabular-nums">{inv.patient_uid}</div>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums font-medium">
                        {formatBDT(inv.net_total)}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-red-700 font-medium">
                        {inv.due_amount > 0 ? formatBDT(inv.due_amount) : '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-xs font-semibold">
                        <span
                          className={
                            inv.payment_status === 'Paid'
                              ? 'text-emerald-700'
                              : inv.payment_status === 'Partial'
                              ? 'text-amber-700'
                              : 'text-red-700'
                          }
                        >
                          {inv.payment_status}
                        </span>
                      </td>
                      <td className="py-2.5 text-right">
                        <div className="inline-flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => onOpenReceipt(inv.id)}
                            className="text-xs font-medium text-teal-700 hover:text-teal-900 whitespace-nowrap"
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
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition-colors whitespace-nowrap shrink-0"
                            >
                              <Trash2 className="w-3 h-3" />
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-900">Active Sample & Lab Queue</h2>
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
                  <th className="py-2 pr-3 font-medium">Investigation</th>
                  <th className="py-2 pr-3 font-medium">Collected</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {staffData.recentQueue.map((q) => (
                  <tr key={q.id} className="hover:bg-slate-50">
                    <td className="py-2.5 pr-3 font-mono tabular-nums text-xs">
                      <div className="font-semibold text-slate-800">{q.invoice_no}</div>
                      <div className="text-slate-500">{q.patient_uid}</div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="font-medium text-slate-900">{q.patient_name}</div>
                      <div className="text-xs text-slate-500">
                        {q.age_years}Y · {q.gender}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="font-medium text-slate-900">{q.test_name}</div>
                      <div className="text-xs text-slate-500">{q.category_name}</div>
                    </td>
                    <td className="py-2.5 pr-3 font-mono tabular-nums text-xs text-slate-600">
                      {formatDateTime(q.collected_at)}
                    </td>
                    <td className="py-2.5 text-xs font-semibold">
                      <span
                        className={
                          q.status === 'Ready'
                            ? 'text-emerald-700'
                            : q.status === 'Verified'
                            ? 'text-teal-700'
                            : q.status === 'Processing'
                            ? 'text-amber-700'
                            : 'text-slate-700'
                        }
                      >
                        {q.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
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
    </div>
  );
};
