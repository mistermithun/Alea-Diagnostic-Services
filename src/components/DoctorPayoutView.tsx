import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarCheck2,
  CheckCircle2,
  Printer,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { apiFetch, formatBDT, formatDateTime, getMonthStartISO, getTodayISO } from '../lib/api.ts';
import type {
  Doctor,
  DoctorStatementReferral,
  DoctorStatementResponse,
  LabSettings,
} from '../types.ts';

interface DoctorPayoutViewProps {
  settings: LabSettings;
  initialDoctorId?: number | null;
}

function addDaysISO(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || '').trim());
  if (!m) return getTodayISO();
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate()
  ).padStart(2, '0')}`;
}

function subtractDaysISO(iso: string, days: number): string {
  return addDaysISO(iso, -days);
}

export const DoctorPayoutView: React.FC<DoctorPayoutViewProps> = ({
  settings,
  initialDoctorId,
}) => {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState<number | null>(initialDoctorId ?? null);

  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>(getTodayISO());
  const [statusFilter, setStatusFilter] = useState<'unpaid' | 'all' | 'paid'>('unpaid');

  const [statement, setStatement] = useState<DoctorStatementResponse | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [loadingStmt, setLoadingStmt] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Mark as Paid Up To Date state
  const [paidUpToDate, setPaidUpToDate] = useState<string>(getTodayISO());
  const [settlementNote, setSettlementNote] = useState<string>('');
  const [confirmingSettle, setConfirmingSettle] = useState(false);
  const [settling, setSettling] = useState(false);

  // Per-patient / per-test Commission Override modal state
  const [editingReferral, setEditingReferral] = useState<DoctorStatementReferral | null>(null);
  const [editCommMode, setEditCommMode] = useState<'doctor_default' | 'custom_invoice' | 'custom_per_test'>(
    'doctor_default'
  );
  const [editCustomType, setEditCustomType] = useState<'percent' | 'flat'>('percent');
  const [editCustomValue, setEditCustomValue] = useState<string>('0');
  const [editPerTestMap, setEditPerTestMap] = useState<
    Record<number, { type: 'percent' | 'flat'; value: string }>
  >({});
  const [savingOverride, setSavingOverride] = useState(false);

  const loadDoctors = useCallback(async () => {
    setLoadingDocs(true);
    try {
      const res = await apiFetch<{ doctors: Doctor[] }>('/api/doctors');
      setDoctors(res.doctors);
      setSelectedDoctorId((prev) => {
        if (initialDoctorId && res.doctors.some((d) => d.id === initialDoctorId)) {
          return initialDoctorId;
        }
        if (prev && res.doctors.some((d) => d.id === prev)) {
          return prev;
        }
        const preferred =
          res.doctors.find((d) => (d.unpaid_commission_total || 0) > 0) ||
          res.doctors.find((d) => !d.name.toLowerCase().includes('self')) ||
          res.doctors[0];
        return preferred ? preferred.id : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load doctors list.');
    } finally {
      setLoadingDocs(false);
    }
  }, [initialDoctorId]);

  useEffect(() => {
    loadDoctors();
  }, [loadDoctors]);

  useEffect(() => {
    if (initialDoctorId) {
      setSelectedDoctorId(initialDoctorId);
      setFromDate('');
      setToDate(getTodayISO());
      setStatusFilter('unpaid');
      setConfirmingSettle(false);
    }
  }, [initialDoctorId]);

  const fetchStatement = useCallback(
    async (
      docId: number,
      opts?: { from?: string; to?: string; status?: 'unpaid' | 'all' | 'paid' }
    ) => {
      setLoadingStmt(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (opts?.from) params.set('from', opts.from);
        if (opts?.to) params.set('to', opts.to);
        params.set('status', opts?.status || statusFilter);
        const res = await apiFetch<DoctorStatementResponse>(
          `/api/admin/doctors/${docId}/statement?${params.toString()}`
        );
        setStatement(res);
        setFromDate(res.from);
        setToDate(res.to);
        setPaidUpToDate(res.to || getTodayISO());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load doctor commission statement.');
      } finally {
        setLoadingStmt(false);
      }
    },
    [statusFilter]
  );

  // Load statement automatically whenever selectedDoctorId changes (using auto from based on Last Paid Date)
  useEffect(() => {
    if (selectedDoctorId) {
      fetchStatement(selectedDoctorId, {
        from: undefined,
        to: getTodayISO(),
        status: statusFilter,
      });
    } else {
      setStatement(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDoctorId]);

  const handleDoctorChange = (docId: number) => {
    setSuccessMsg('');
    setConfirmingSettle(false);
    setFromDate('');
    setToDate(getTodayISO());
    setSelectedDoctorId(docId);
  };

  const applyQuickRange = (preset: 'since_last' | '10d' | '15d' | 'month') => {
    if (!selectedDoctorId || !statement) return;
    const today = getTodayISO();
    let nextFrom = getMonthStartISO();
    if (preset === 'since_last') {
      nextFrom = statement.doctor.last_commission_paid_up_to
        ? addDaysISO(statement.doctor.last_commission_paid_up_to, 1)
        : getMonthStartISO();
    } else if (preset === '10d') {
      nextFrom = subtractDaysISO(today, 9);
    } else if (preset === '15d') {
      nextFrom = subtractDaysISO(today, 14);
    } else if (preset === 'month') {
      nextFrom = getMonthStartISO();
    }
    setFromDate(nextFrom);
    setToDate(today);
    fetchStatement(selectedDoctorId, { from: nextFrom, to: today, status: statusFilter });
  };

  const handleStatusChange = (nextStatus: 'unpaid' | 'all' | 'paid') => {
    setStatusFilter(nextStatus);
    if (selectedDoctorId) {
      fetchStatement(selectedDoctorId, {
        from: fromDate || undefined,
        to: toDate || undefined,
        status: nextStatus,
      });
    }
  };

  // Preview how many shown referrals fall on/before paidUpToDate
  const settlementPreview = useMemo(() => {
    if (!statement) return { count: 0, amount: 0 };
    const unpaidEligible = statement.referrals.filter(
      (r) => !r.is_commission_paid && r.created_at.slice(0, 10) <= paidUpToDate
    );
    const amount =
      Math.round(unpaidEligible.reduce((s, r) => s + Number(r.commission_amount || 0), 0) * 100) /
      100;
    return { count: unpaidEligible.length, amount };
  }, [statement, paidUpToDate]);

  const handleSettleCommission = async () => {
    if (!selectedDoctorId || !paidUpToDate) return;
    setSettling(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await apiFetch<{
        success: boolean;
        paidUpToDate: string;
        patientsCount: number;
        totalCommissionPaid: number;
      }>(`/api/admin/doctors/${selectedDoctorId}/settle-commission`, {
        method: 'POST',
        body: JSON.stringify({
          paidUpToDate,
          fromDate: fromDate || undefined,
          note: settlementNote.trim(),
        }),
      });
      setConfirmingSettle(false);
      setSettlementNote('');
      setSuccessMsg(
        `Settled ${res.patientsCount} patient referral(s) totaling ${formatBDT(
          res.totalCommissionPaid
        )} · Marked as Paid up to ${res.paidUpToDate}.`
      );
      await loadDoctors();
      await fetchStatement(selectedDoctorId, {
        from: addDaysISO(res.paidUpToDate, 1),
        to: getTodayISO(),
        status: statusFilter,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to settle commission payout.');
    } finally {
      setSettling(false);
    }
  };

  const openCommissionEditor = (ref: DoctorStatementReferral) => {
    const docDefault = Number(statement?.doctor.commission_pct ?? 0);
    setEditingReferral(ref);
    if (ref.commission_type === 'per_test') {
      setEditCommMode('custom_per_test');
      setEditCustomType('percent');
      setEditCustomValue(String(docDefault));
    } else if (ref.commission_type === 'flat' || Math.abs(ref.commission_value - docDefault) > 0.01) {
      setEditCommMode('custom_invoice');
      setEditCustomType(ref.commission_type === 'flat' ? 'flat' : 'percent');
      setEditCustomValue(String(ref.commission_value));
    } else {
      setEditCommMode('doctor_default');
      setEditCustomType('percent');
      setEditCustomValue(String(docDefault));
    }
    const map: Record<number, { type: 'percent' | 'flat'; value: string }> = {};
    for (const ti of ref.test_items) {
      map[ti.test_id] = {
        type: ti.commission_type === 'flat' ? 'flat' : 'percent',
        value: String(ti.commission_value ?? docDefault),
      };
    }
    setEditPerTestMap(map);
  };

  const saveCommissionOverride = async () => {
    if (!editingReferral || !selectedDoctorId) return;
    setSavingOverride(true);
    setError('');
    try {
      const docDefault = Number(statement?.doctor.commission_pct ?? 0);
      const testCommissions =
        editCommMode === 'custom_per_test'
          ? editingReferral.test_items.map((ti) => {
              const e = editPerTestMap[ti.test_id];
              return {
                testId: ti.test_id,
                commissionType: (e?.type === 'flat' ? 'flat' : 'percent') as 'percent' | 'flat',
                commissionValue: e ? Math.max(0, Number(e.value || 0)) : docDefault,
              };
            })
          : undefined;

      await apiFetch(`/api/admin/invoices/${editingReferral.id}/commission`, {
        method: 'PUT',
        body: JSON.stringify({
          commissionMode: editCommMode,
          commissionType: editCustomType,
          commissionValue: Number(editCustomValue || 0),
          testCommissions,
        }),
      });
      setEditingReferral(null);
      setSuccessMsg(`Updated commission rate for ${editingReferral.invoice_no} (${editingReferral.patient_name}).`);
      await loadDoctors();
      await fetchStatement(selectedDoctorId, {
        from: fromDate || undefined,
        to: toDate || undefined,
        status: statusFilter,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update commission rate.');
    } finally {
      setSavingOverride(false);
    }
  };

  const formatRateLabel = (r: DoctorStatementReferral) => {
    if (r.commission_type === 'per_test') return `Per-Test (${r.commission_pct}%)`;
    if (r.commission_type === 'flat') return `${formatBDT(r.commission_value)} Flat (${r.commission_pct}%)`;
    return `${r.commission_pct}%`;
  };

  const totalPendingAllDoctors = useMemo(
    () =>
      Math.round(
        doctors.reduce((sum, d) => sum + Number(d.unpaid_commission_total || 0), 0) * 100
      ) / 100,
    [doctors]
  );

  return (
    <div className="space-y-6">
      {/* Screen Header & Controls (hidden on print) */}
      <div className="space-y-4 no-print">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
              Doctor Commission Payout &amp; Settlement
            </h1>
            <p className="text-sm text-slate-600 mt-0.5">
              Track unpaid accrued referrals since the last settled date, customize per-patient/test rates, print statements, and settle payouts.
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg px-4 py-2 text-right shrink-0">
            <div className="text-[11px] font-medium text-slate-500">All Doctors Unpaid Accrued</div>
            <div className="text-lg font-bold font-mono tabular-nums text-teal-700">
              {formatBDT(totalPendingAllDoctors)}
            </div>
          </div>
        </div>

        {error && (
          <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {error}
          </div>
        )}
        {successMsg && (
          <div className="p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
            {successMsg}
          </div>
        )}

        {/* Doctor Selector & Date Range Toolbar */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
            <div className="lg:col-span-5">
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Select Referring Doctor
              </label>
              <select
                value={selectedDoctorId ?? ''}
                onChange={(e) => handleDoctorChange(Number(e.target.value))}
                disabled={loadingDocs}
                className="w-full px-3 py-2 text-sm font-medium border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.commission_pct ?? 0}%) — Unpaid: {formatBDT(d.unpaid_commission_total || 0)}
                    {d.last_commission_paid_up_to
                      ? ` · Last Paid: ${d.last_commission_paid_up_to}`
                      : ' · Never Settled'}
                  </option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">From Date</label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div className="lg:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">To Date</label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div className="lg:col-span-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!selectedDoctorId || loadingStmt}
                onClick={() =>
                  selectedDoctorId &&
                  fetchStatement(selectedDoctorId, {
                    from: fromDate || undefined,
                    to: toDate || undefined,
                    status: statusFilter,
                  })
                }
                className="px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                {loadingStmt ? 'Loading...' : 'Apply Filter'}
              </button>
              <button
                type="button"
                disabled={!statement}
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 whitespace-nowrap"
              >
                <Printer className="w-4 h-4" />
                Print Statement
              </button>
            </div>
          </div>

          {/* Quick Range Presets + Status Filter */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-slate-500 font-medium mr-1">Quick Period:</span>
              <button
                type="button"
                onClick={() => applyQuickRange('since_last')}
                className="px-2.5 py-1 font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100"
              >
                Since Last Paid Date
              </button>
              <button
                type="button"
                onClick={() => applyQuickRange('10d')}
                className="px-2.5 py-1 font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200"
              >
                Last 10 Days
              </button>
              <button
                type="button"
                onClick={() => applyQuickRange('15d')}
                className="px-2.5 py-1 font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200"
              >
                Last 15 Days
              </button>
              <button
                type="button"
                onClick={() => applyQuickRange('month')}
                className="px-2.5 py-1 font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200"
              >
                This Month
              </button>
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
              {(
                [
                  { id: 'unpaid', label: 'Unpaid Only' },
                  { id: 'all', label: 'All Referrals' },
                  { id: 'paid', label: 'Settled / Paid' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleStatusChange(opt.id)}
                  className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    statusFilter === opt.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Last Settled Date Tracker + Settlement Cutoff Action */}
        {statement && (
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">
            {/* Last Settled Status Cards */}
            <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="border-b sm:border-b-0 sm:border-r border-slate-200 pb-3 sm:pb-0 sm:pr-4">
                <div className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                  <CalendarCheck2 className="w-3.5 h-3.5 text-teal-700" />
                  <span>Last Settled Date</span>
                </div>
                <div className="text-base font-bold font-mono tabular-nums text-slate-900 mt-1">
                  {statement.doctor.last_commission_paid_up_to || 'Never Settled'}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {statement.doctor.last_commission_paid_up_to
                    ? `Next cycle from ${statement.suggestedNextFrom}`
                    : 'No prior payout cutoff recorded'}
                </div>
              </div>

              <div className="border-b sm:border-b-0 sm:border-r border-slate-200 pb-3 sm:pb-0 sm:pr-4">
                <div className="text-xs font-medium text-slate-500">All-Time Unpaid Accrued</div>
                <div className="text-base font-bold font-mono tabular-nums text-amber-700 mt-1">
                  {formatBDT(statement.allTimeUnpaid.amount)}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {statement.allTimeUnpaid.count} unpaid referral(s) total
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-500">Selected Period Payable</div>
                <div className="text-base font-bold font-mono tabular-nums text-teal-700 mt-1">
                  {formatBDT(statement.totals.unpaidCommission)}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {statement.totals.unpaidPatients} unpaid in {statement.from} → {statement.to}
                </div>
              </div>
            </div>

            {/* Mark as Paid up to Date Settlement Box */}
            <div className="xl:col-span-5 bg-teal-50/70 border border-teal-200 rounded-xl p-4 flex flex-col justify-between gap-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-teal-900">Mark as Paid up to Date</div>
                  <div className="text-[11px] text-teal-800">
                    Settles all unpaid referrals on or before cutoff date &amp; updates Last Settled Date.
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-teal-900 mb-1">
                    Paid Up To Date
                  </label>
                  <input
                    type="date"
                    value={paidUpToDate}
                    onChange={(e) => {
                      setPaidUpToDate(e.target.value);
                      setConfirmingSettle(false);
                    }}
                    className="w-full px-2.5 py-1.5 text-xs font-mono border border-teal-300 rounded-md bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-teal-900 mb-1">
                    Payout Note (Optional)
                  </label>
                  <input
                    type="text"
                    value={settlementNote}
                    onChange={(e) => setSettlementNote(e.target.value)}
                    placeholder="Cash / bKash Ref..."
                    className="w-full px-2.5 py-1.5 text-xs border border-teal-300 rounded-md bg-white"
                  />
                </div>
              </div>

              {!confirmingSettle ? (
                <button
                  type="button"
                  disabled={settling || !paidUpToDate}
                  onClick={() => setConfirmingSettle(true)}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Mark as Paid up to {paidUpToDate}
                </button>
              ) : (
                <div className="bg-white border border-teal-300 rounded-lg p-2.5 space-y-2">
                  <div className="text-[11px] font-medium text-slate-800">
                    Confirm settling{' '}
                    <span className="font-bold text-teal-800">
                      {settlementPreview.count > 0
                        ? `${settlementPreview.count} shown patient(s) (${formatBDT(settlementPreview.amount)})`
                        : `all unpaid referrals up to ${paidUpToDate}`}
                    </span>
                    ?
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={settling}
                      onClick={() => setConfirmingSettle(false)}
                      className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={settling}
                      onClick={handleSettleCommission}
                      className="px-3 py-1 text-xs font-semibold text-white bg-emerald-700 rounded-md hover:bg-emerald-800 disabled:opacity-50"
                    >
                      {settling ? 'Settling...' : 'Confirm Settlement'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Printable Doctor Commission Statement Sheet */}
      {statement && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 shadow-sm print-sheet print-pure-black text-slate-900">
          {/* Statement Letterhead */}
          <div className="border-b-2 border-slate-900 pb-4 flex flex-col sm:flex-row sm:justify-between sm:items-end gap-3">
            <div>
              <h2 className="text-xl font-bold">{settings.lab_name}</h2>
              <p className="text-xs text-slate-600">{settings.lab_address}</p>
              <p className="text-xs text-slate-600">
                Proprietor: {settings.proprietor_name} · {settings.lab_phone}
              </p>
            </div>
            <div className="sm:text-right">
              <div className="text-xs font-bold uppercase tracking-wider text-teal-700">
                Doctor Commission Statement
              </div>
              <div className="text-xs font-mono tabular-nums text-slate-700 mt-1">
                Period: {statement.from} to {statement.to} ({statusFilter.toUpperCase()})
              </div>
              <div className="text-[11px] font-mono tabular-nums text-slate-500 mt-0.5">
                Last Settled Date: {statement.doctor.last_commission_paid_up_to || 'None'}
              </div>
            </div>
          </div>

          {/* Doctor Identity Row */}
          <div className="py-4 border-b border-slate-200 flex flex-wrap justify-between gap-4 text-sm">
            <div>
              <div className="font-bold text-slate-900 text-base">{statement.doctor.name}</div>
              <div className="text-xs text-slate-600">
                {statement.doctor.degree}
                {statement.doctor.hospital ? ` · ${statement.doctor.hospital}` : ''}
                {statement.doctor.mobile ? ` · ${statement.doctor.mobile}` : ''}
              </div>
            </div>
            <div className="sm:text-right text-xs space-y-0.5">
              <div>
                Doctor Default Rate:{' '}
                <span className="font-mono font-bold">{statement.doctor.commission_pct ?? 0}%</span>
              </div>
              <div>
                Total Listed Patients:{' '}
                <span className="font-mono font-bold">{statement.totals.totalPatients}</span>
                {' · '}Payable Unpaid:{' '}
                <span className="font-mono font-bold text-teal-700">
                  {formatBDT(statement.totals.unpaidCommission)}
                </span>
              </div>
            </div>
          </div>

          {/* Patient Referrals Commission Table */}
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-300 bg-slate-50 text-left text-slate-700">
                  <th className="py-2.5 px-2 font-semibold">Date &amp; Inv</th>
                  <th className="py-2.5 px-2 font-semibold">Patient</th>
                  <th className="py-2.5 px-2 font-semibold">Tests Performed</th>
                  <th className="py-2.5 px-2 font-semibold text-right">Total Bill</th>
                  <th className="py-2.5 px-2 font-semibold text-right">Discount</th>
                  <th className="py-2.5 px-2 font-semibold text-right">Net Bill</th>
                  <th className="py-2.5 px-2 font-semibold text-right">Comm. Rate</th>
                  <th className="py-2.5 px-2 font-semibold text-right">Payable Comm.</th>
                  <th className="py-2.5 px-2 font-semibold text-center">Status</th>
                  <th className="py-2.5 px-2 font-semibold text-right no-print">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {statement.referrals.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-10 text-center text-slate-500">
                      No matching patient referrals found in {statement.from} to {statement.to}.
                    </td>
                  </tr>
                ) : (
                  statement.referrals.map((r) => (
                    <tr
                      key={r.id}
                      className={
                        !r.is_commission_paid && r.is_accrued_after_last_paid
                          ? 'bg-amber-50/40'
                          : undefined
                      }
                    >
                      <td className="py-2.5 px-2 font-mono tabular-nums align-top whitespace-nowrap">
                        <div className="font-semibold text-slate-900">{r.invoice_no}</div>
                        <div className="text-[10px] text-slate-500">
                          {formatDateTime(r.created_at).split(',')[0]}
                        </div>
                      </td>
                      <td className="py-2.5 px-2 align-top">
                        <div className="font-semibold text-slate-900">{r.patient_name}</div>
                        <div className="text-[10px] font-mono text-slate-500">{r.patient_uid}</div>
                      </td>
                      <td className="py-2.5 px-2 text-slate-700 align-top max-w-[230px]">
                        <div>{r.test_names}</div>
                        {r.commission_type === 'per_test' && r.test_items.length > 0 && (
                          <div className="mt-1 space-y-0.5 text-[10px] text-slate-500 font-mono">
                            {r.test_items.map((ti) => (
                              <div key={ti.id}>
                                • {ti.test_name}:{' '}
                                {ti.commission_type === 'flat'
                                  ? `${formatBDT(ti.commission_value)} Flat`
                                  : `${ti.commission_value}%`}{' '}
                                = {formatBDT(ti.commission_amount)}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums align-top">
                        {formatBDT(r.subtotal)}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums align-top">
                        {r.discount_amount > 0 ? (
                          <div>
                            <div className="text-amber-700 font-medium">
                              -{formatBDT(r.discount_amount)}
                            </div>
                            <div className="text-[10px] text-slate-500">{r.discount_pct}%</div>
                          </div>
                        ) : (
                          <span className="text-slate-400">0%</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums font-semibold align-top">
                        {formatBDT(r.net_total)}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums align-top whitespace-nowrap">
                        {formatRateLabel(r)}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums font-bold text-teal-800 align-top">
                        {formatBDT(r.commission_amount)}
                      </td>
                      <td className="py-2.5 px-2 text-center align-top">
                        {r.is_commission_paid ? (
                          <span className="inline-block px-2 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded">
                            Paid
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 text-[10px] font-semibold bg-amber-50 text-amber-800 border border-amber-200 rounded">
                            {r.is_accrued_after_last_paid ? 'New Unpaid' : 'Unpaid'}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-right align-top no-print">
                        <button
                          type="button"
                          onClick={() => openCommissionEditor(r)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 bg-slate-100 border border-slate-300 rounded hover:bg-slate-200 whitespace-nowrap"
                        >
                          <SlidersHorizontal className="w-3 h-3" />
                          Customize
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-900 font-bold text-xs bg-slate-50">
                  <td colSpan={3} className="py-3 px-2">
                    Grand Total ({statement.totals.totalPatients} Patients)
                  </td>
                  <td className="py-3 px-2 text-right font-mono tabular-nums">
                    {formatBDT(statement.totals.totalGross)}
                  </td>
                  <td className="py-3 px-2 text-right font-mono tabular-nums text-amber-800">
                    -{formatBDT(statement.totals.totalDiscount)}
                  </td>
                  <td className="py-3 px-2 text-right font-mono tabular-nums">
                    {formatBDT(statement.totals.totalNet)}
                  </td>
                  <td className="py-3 px-2 text-right text-slate-500">Total Payable:</td>
                  <td className="py-3 px-2 text-right font-mono tabular-nums text-teal-800 text-sm">
                    {formatBDT(statement.totals.totalCommission)}
                  </td>
                  <td className="py-3 px-2 text-center text-[10px] font-mono">
                    {statusFilter === 'all' && statement.totals.unpaidCommission > 0
                      ? `Unpaid: ${formatBDT(statement.totals.unpaidCommission)}`
                      : ''}
                  </td>
                  <td className="no-print" />
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Print-only Statement Signatures */}
          <div className="hidden print:grid grid-cols-3 gap-8 pt-14 text-xs text-center">
            <div className="border-t border-slate-400 pt-2">
              <div className="font-semibold">Prepared By</div>
              <div className="text-[10px] text-slate-500">Accounts / Billing Desk</div>
            </div>
            <div className="border-t border-slate-400 pt-2">
              <div className="font-semibold">{settings.proprietor_name}</div>
              <div className="text-[10px] text-slate-500">Proprietor, {settings.lab_name}</div>
            </div>
            <div className="border-t border-slate-400 pt-2">
              <div className="font-semibold">Received By</div>
              <div className="text-[10px] text-slate-500">{statement.doctor.name} / Representative</div>
            </div>
          </div>
        </div>
      )}

      {/* Payout Settlement History (Screen Only) */}
      {statement && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 no-print">
          <h2 className="text-sm font-semibold text-slate-900">
            Settlement &amp; Payout History ({statement.payoutHistory.length})
          </h2>
          {statement.payoutHistory.length === 0 ? (
            <p className="text-xs text-slate-500 py-4">
              No commission payout settlements have been recorded for this doctor yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-2 pr-3 font-medium">Settled On</th>
                    <th className="py-2 pr-3 font-medium">Period Covered</th>
                    <th className="py-2 pr-3 font-medium">Paid Up To Cutoff</th>
                    <th className="py-2 pr-3 font-medium text-right">Patients</th>
                    <th className="py-2 pr-3 font-medium text-right">Commission Paid</th>
                    <th className="py-2 pr-3 font-medium">Settled By</th>
                    <th className="py-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {statement.payoutHistory.map((h) => (
                    <tr key={h.id}>
                      <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-700">
                        {formatDateTime(h.settled_at)}
                      </td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-600">
                        {h.from_date || 'Start'} → {h.paid_up_to_date}
                      </td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums font-bold text-emerald-700">
                        {h.paid_up_to_date}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums">
                        {h.patients_count}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums font-bold text-slate-900">
                        {formatBDT(h.total_commission_paid)}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-600">{h.settled_by || 'Admin'}</td>
                      <td className="py-2.5 text-slate-600">{h.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Customize Commission Rate Modal (Per-Patient / Per-Test) */}
      {editingReferral && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 p-4 flex items-center justify-center no-print">
          <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
            <div className="px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">
                  Customize Commission · {editingReferral.invoice_no}
                </h3>
                <p className="text-[11px] text-slate-300">
                  {editingReferral.patient_name} ({editingReferral.patient_uid}) · Net Bill:{' '}
                  {formatBDT(editingReferral.net_total)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingReferral(null)}
                className="text-slate-400 hover:text-white p-1"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-3 gap-1.5 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setEditCommMode('doctor_default')}
                  className={`py-1.5 px-2 font-semibold rounded-md ${
                    editCommMode === 'doctor_default'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Doctor Default ({statement?.doctor.commission_pct ?? 0}%)
                </button>
                <button
                  type="button"
                  onClick={() => setEditCommMode('custom_invoice')}
                  className={`py-1.5 px-2 font-semibold rounded-md ${
                    editCommMode === 'custom_invoice'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Custom Patient Rate
                </button>
                <button
                  type="button"
                  onClick={() => setEditCommMode('custom_per_test')}
                  className={`py-1.5 px-2 font-semibold rounded-md ${
                    editCommMode === 'custom_per_test'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Per-Test Rates
                </button>
              </div>

              {editCommMode === 'custom_invoice' && (
                <div className="space-y-1.5">
                  <label className="block font-semibold text-slate-700">
                    Patient Commission Rate (% or ৳ Flat)
                  </label>
                  <div className="flex items-center gap-2">
                    <select
                      value={editCustomType}
                      onChange={(e) => setEditCustomType(e.target.value as 'percent' | 'flat')}
                      className="px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="percent">% Percentage of Net Bill</option>
                      <option value="flat">৳ Flat Amount</option>
                    </select>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={editCustomValue}
                      onChange={(e) => setEditCustomValue(e.target.value)}
                      className="w-full px-3 py-2 font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
              )}

              {editCommMode === 'custom_per_test' && (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  <div className="font-semibold text-slate-700">Individual Test Commission Rates</div>
                  {editingReferral.test_items.map((ti) => {
                    const entry = editPerTestMap[ti.test_id] || {
                      type: 'percent' as const,
                      value: String(statement?.doctor.commission_pct ?? 0),
                    };
                    return (
                      <div
                        key={ti.id}
                        className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 truncate">{ti.test_name}</div>
                          <div className="text-[11px] font-mono text-slate-500">
                            Test Price: {formatBDT(ti.price)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <select
                            value={entry.type}
                            onChange={(e) =>
                              setEditPerTestMap((prev) => ({
                                ...prev,
                                [ti.test_id]: {
                                  type: e.target.value as 'percent' | 'flat',
                                  value: prev[ti.test_id]?.value ?? String(statement?.doctor.commission_pct ?? 0),
                                },
                              }))
                            }
                            className="px-1.5 py-1 border border-slate-300 rounded bg-white"
                          >
                            <option value="percent">%</option>
                            <option value="flat">৳ Flat</option>
                          </select>
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={entry.value}
                            onChange={(e) =>
                              setEditPerTestMap((prev) => ({
                                ...prev,
                                [ti.test_id]: {
                                  type: prev[ti.test_id]?.type ?? 'percent',
                                  value: e.target.value,
                                },
                              }))
                            }
                            className="w-20 px-2 py-1 font-mono border border-slate-300 rounded bg-white"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setEditingReferral(null)}
                  className="px-3.5 py-1.5 font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={savingOverride}
                  onClick={saveCommissionOverride}
                  className="px-4 py-1.5 font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50"
                >
                  {savingOverride ? 'Updating...' : 'Save Commission Rate'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
