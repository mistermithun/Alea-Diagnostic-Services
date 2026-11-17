import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Download,
  ExternalLink,
  Plus,
  Printer,
  Trash2,
} from 'lucide-react';
import { apiFetch, formatBDT, getMonthStartISO, getTodayISO } from '../lib/api.ts';
import type {
  BalanceLedgerResponse,
  BalanceLedgerRow,
  LabSettings,
  NavTab,
} from '../types.ts';

interface BalanceLedgerViewProps {
  settings: LabSettings;
  onNavigate: (tab: NavTab) => void;
}

const OTHER_REVENUE_CATEGORIES = [
  'Other Income',
  'Home Collection Fee',
  'Report / Envelope Charge',
  'Owner Cash Deposit',
  'Equipment / Scrap Sale',
  'Miscellaneous',
];

const QUICK_EXPENSE_CATEGORIES = [
  'Owner Withdrawal',
  'Reagents & Kits',
  'Consumables',
  'Staff Salary & Allowance',
  'Electricity & Utilities',
  'Rent & Maintenance',
  'Equipment Repair',
  'General',
];

function shiftIsoDays(isoDate: string, deltaDays: number): string {
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3) return getTodayISO();
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + deltaDays));
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatReadableDate(iso: string): string {
  const parts = iso.split('-').map(Number);
  if (parts.length !== 3) return iso;
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return dt.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function isWithdrawalCategory(cat: string): boolean {
  const lower = (cat || '').toLowerCase();
  return (
    lower.includes('withdrawal') ||
    lower.includes('proprietor draw') ||
    lower.includes('owner draw')
  );
}

export const BalanceLedgerView: React.FC<BalanceLedgerViewProps> = ({ settings, onNavigate }) => {
  const todayIso = getTodayISO();
  const [fromDate, setFromDate] = useState<string>(getMonthStartISO());
  const [toDate, setToDate] = useState<string>(todayIso);
  const [activeDaysOnly, setActiveDaysOnly] = useState<boolean>(false);

  const [ledger, setLedger] = useState<BalanceLedgerResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  // Revenue from Others form state
  const [revDate, setRevDate] = useState<string>(todayIso);
  const [revSource, setRevSource] = useState<string>('');
  const [revCategory, setRevCategory] = useState<string>(OTHER_REVENUE_CATEGORIES[0]);
  const [revAmount, setRevAmount] = useState<string>('');
  const [revNote, setRevNote] = useState<string>('');
  const [savingRev, setSavingRev] = useState<boolean>(false);

  // Quick Owner Withdrawal / Expense form state
  const [showQuickExpenseForm, setShowQuickExpenseForm] = useState<boolean>(false);
  const [expDate, setExpDate] = useState<string>(todayIso);
  const [expTitle, setExpTitle] = useState<string>('');
  const [expCategory, setExpCategory] = useState<string>('Owner Withdrawal');
  const [expAmount, setExpAmount] = useState<string>('');
  const [expNote, setExpNote] = useState<string>('');
  const [savingExp, setSavingExp] = useState<boolean>(false);

  const loadLedger = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<BalanceLedgerResponse>(
        `/api/admin/balance-ledger?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`
      );
      setLedger(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load daily cash ledger.');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    loadLedger();
  }, [loadLedger]);

  const displayedRows = useMemo<BalanceLedgerRow[]>(() => {
    if (!ledger) return [];
    if (!activeDaysOnly) return ledger.rows;
    return ledger.rows.filter(
      (r) =>
        r.date === ledger.today ||
        Math.abs(r.labRevenue) > 0.001 ||
        Math.abs(r.otherRevenue) > 0.001 ||
        Math.abs(r.expensesAndWithdrawals) > 0.001
    );
  }, [ledger, activeDaysOnly]);

  const handleAddOtherRevenue = async (e: React.FormEvent) => {
    e.preventDefault();
    const numericAmt = Number(revAmount);
    if (!revSource.trim() || !Number.isFinite(numericAmt) || numericAmt <= 0) {
      setError('Please enter a valid income source description and positive amount.');
      return;
    }
    setSavingRev(true);
    setError('');
    try {
      await apiFetch('/api/admin/other-revenues', {
        method: 'POST',
        body: JSON.stringify({
          revenue_date: revDate,
          source: revSource.trim(),
          category: revCategory,
          amount: numericAmt,
          note: revNote.trim(),
        }),
      });
      setRevSource('');
      setRevAmount('');
      setRevNote('');
      await loadLedger();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record income entry.');
    } finally {
      setSavingRev(false);
    }
  };

  const handleDeleteOtherRevenue = async (id: number) => {
    setError('');
    try {
      await apiFetch(`/api/admin/other-revenues/${id}`, { method: 'DELETE' });
      await loadLedger();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete income entry.');
    }
  };

  const handleAddQuickExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const numericAmt = Number(expAmount);
    if (!expTitle.trim() || !Number.isFinite(numericAmt) || numericAmt <= 0) {
      setError('Please enter a description and positive amount for expense/withdrawal.');
      return;
    }
    setSavingExp(true);
    setError('');
    try {
      await apiFetch('/api/admin/expenses', {
        method: 'POST',
        body: JSON.stringify({
          title: expTitle.trim(),
          category: expCategory,
          amount: numericAmt,
          expense_date: expDate,
          note: expNote.trim(),
        }),
      });
      setExpTitle('');
      setExpAmount('');
      setExpNote('');
      setShowQuickExpenseForm(false);
      await loadLedger();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record expense/withdrawal.');
    } finally {
      setSavingExp(false);
    }
  };

  const handleDeleteExpense = async (id: number) => {
    setError('');
    try {
      await apiFetch(`/api/admin/expenses/${id}`, { method: 'DELETE' });
      await loadLedger();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete expense entry.');
    }
  };

  const handleExportCsv = () => {
    if (!ledger) return;
    const headers = [
      'Date',
      'Opening Balance (Prev Closing)',
      'Lab Test Revenue',
      'Revenue from Others',
      'Total Available Cash',
      'Operational Expenses',
      'Owner Withdrawals',
      'Total Expenses & Withdrawals',
      'Net Closing Balance',
    ];
    const csvRows = [headers.join(',')];
    for (const r of displayedRows) {
      csvRows.push(
        [
          r.date,
          r.openingBalance.toFixed(2),
          r.labRevenue.toFixed(2),
          r.otherRevenue.toFixed(2),
          r.totalAvailableCash.toFixed(2),
          r.operationalExpenses.toFixed(2),
          r.ownerWithdrawals.toFixed(2),
          r.expensesAndWithdrawals.toFixed(2),
          r.closingBalance.toFixed(2),
        ].join(',')
      );
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Daily_Cash_Balance_Ledger_${ledger.from}_to_${ledger.to}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handlePrintLedger = () => {
    const prevTitle = document.title;
    document.title = `Daily_Cash_Balance_Ledger_${fromDate}_to_${toDate}`;
    window.print();
    setTimeout(() => {
      document.title = prevTitle;
    }, 800);
  };

  const todaySummary = ledger?.todaySummary;
  const periodTotals = ledger?.periodTotals;

  return (
    <div className="space-y-6 print:p-[12mm] print:space-y-4">
      {/* Print-Only Official Ledger Letterhead */}
      <div className="hidden print:block border-b-2 border-black pb-3 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-black">{settings.lab_name}</h1>
            <p className="text-xs text-black">{settings.lab_address}</p>
            <p className="text-xs text-black font-mono">{settings.lab_phone}</p>
          </div>
          <div className="text-right">
            <div className="text-sm font-bold text-black">Daily Cash Balance Ledger</div>
            <div className="text-xs font-mono text-black">
              Period: {formatReadableDate(fromDate)} – {formatReadableDate(toDate)}
            </div>
            <div className="text-[11px] text-black">
              Printed on {formatReadableDate(todayIso)}
            </div>
          </div>
        </div>
      </div>

      {/* Screen Header */}
      <div className="no-print flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Balance &amp; Daily Cash Ledger
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Track daily opening carry-forward, collected lab revenue, non-lab income, and operational expenses or owner withdrawals.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={!ledger || displayedRows.length === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            onClick={handlePrintLedger}
            disabled={!ledger}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Printer className="w-4 h-4" />
            <span>Print Ledger</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="no-print p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
          {error}
        </div>
      )}

      {/* Top 4 Summary Cards — Live Today Cash Position */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">
            Today&apos;s Opening Balance
          </div>
          <div className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-slate-900">
            {loading && !todaySummary ? '—' : formatBDT(todaySummary?.openingBalance ?? 0)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Carried forward from yesterday
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">Today&apos;s Total Inflow</span>
            <ArrowUpRight className="w-4 h-4 text-emerald-600 shrink-0" />
          </div>
          <div className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-emerald-700">
            {loading && !todaySummary ? '—' : formatBDT(todaySummary?.totalInflow ?? 0)}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Lab {formatBDT(todaySummary?.labRevenue ?? 0)} · Other{' '}
            {formatBDT(todaySummary?.otherRevenue ?? 0)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">
              Today&apos;s Expense &amp; Withdrawal
            </span>
            <ArrowDownRight className="w-4 h-4 text-red-600 shrink-0" />
          </div>
          <div className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-red-700">
            {loading && !todaySummary
              ? '—'
              : formatBDT(todaySummary?.totalExpensesAndWithdrawals ?? 0)}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Ops {formatBDT(todaySummary?.operationalExpenses ?? 0)} · Draw{' '}
            {formatBDT(todaySummary?.ownerWithdrawals ?? 0)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">
            Current Closing Balance
          </div>
          <div
            className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
              (todaySummary?.closingBalance ?? 0) < 0 ? 'text-red-700' : 'text-teal-700'
            }`}
          >
            {loading && !todaySummary ? '—' : formatBDT(todaySummary?.closingBalance ?? 0)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Available cash as of {formatReadableDate(todaySummary?.date || todayIso)}
          </div>
        </div>
      </div>

      {/* Date Range & View Filter Bar */}
      <div className="no-print bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-700 mr-1">Date Range:</span>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg bg-white"
            aria-label="Ledger From Date"
          />
          <span className="text-xs text-slate-400">to</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg bg-white"
            aria-label="Ledger To Date"
          />

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg ml-1">
            <button
              type="button"
              onClick={() => {
                setFromDate(todayIso);
                setToDate(todayIso);
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                fromDate === todayIso && toDate === todayIso
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => {
                setFromDate(shiftIsoDays(todayIso, -6));
                setToDate(todayIso);
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                fromDate === shiftIsoDays(todayIso, -6) && toDate === todayIso
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Last 7 Days
            </button>
            <button
              type="button"
              onClick={() => {
                setFromDate(getMonthStartISO());
                setToDate(todayIso);
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                fromDate === getMonthStartISO() && toDate === todayIso
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              This Month
            </button>
            <button
              type="button"
              onClick={() => {
                setFromDate(shiftIsoDays(todayIso, -29));
                setToDate(todayIso);
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                fromDate === shiftIsoDays(todayIso, -29) && toDate === todayIso
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Last 30 Days
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={activeDaysOnly}
              onChange={(e) => setActiveDaysOnly(e.target.checked)}
              className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            <span>Active Days Only</span>
          </label>
        </div>
      </div>

      {/* Main Chronological Daily Cash Ledger Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden print:border-slate-300 print:rounded-none">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50/70 print:bg-white">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Chronological Daily Cash Flow Ledger
            </h2>
            <p className="text-xs text-slate-500">
              Closing Balance = (Opening Balance + Lab Test Revenue + Revenue from Others) − Daily Expenses &amp; Withdrawals
            </p>
          </div>
          {ledger && (
            <div className="text-xs text-slate-600 font-mono tabular-nums">
              Opening Carry-Forward ({formatReadableDate(ledger.from)}):{' '}
              <span className="font-bold text-slate-900">
                {formatBDT(ledger.priorOpeningBalance)}
              </span>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-600 print:bg-slate-100">
                <th className="py-2.5 pl-5 pr-3 font-semibold whitespace-nowrap">Date</th>
                <th className="py-2.5 px-3 font-semibold text-right whitespace-nowrap">
                  Opening Balance
                </th>
                <th className="py-2.5 px-3 font-semibold text-right whitespace-nowrap">
                  Lab Test Revenue
                </th>
                <th className="py-2.5 px-3 font-semibold text-right whitespace-nowrap">
                  Revenue from Others
                </th>
                <th className="py-2.5 px-3 font-semibold text-right whitespace-nowrap">
                  Total Available Cash
                </th>
                <th className="py-2.5 px-3 font-semibold text-right whitespace-nowrap">
                  Expenses &amp; Withdrawals
                </th>
                <th className="py-2.5 pl-3 pr-5 font-semibold text-right whitespace-nowrap">
                  Net Closing Balance
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-200">
              {loading && !ledger ? (
                Array.from({ length: 5 }).map((_, idx) => (
                  <tr key={idx}>
                    <td colSpan={7} className="py-3 px-5">
                      <div className="h-4 bg-slate-100 rounded animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : displayedRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 px-5 text-center text-sm text-slate-500">
                    No ledger days match the selected filter. Adjust the date range or uncheck &ldquo;Active Days Only&rdquo;.
                  </td>
                </tr>
              ) : (
                displayedRows.map((row) => {
                  const isToday = row.date === ledger?.today;
                  const hasActivity =
                    Math.abs(row.labRevenue) > 0.001 ||
                    Math.abs(row.otherRevenue) > 0.001 ||
                    Math.abs(row.expensesAndWithdrawals) > 0.001;

                  return (
                    <tr
                      key={row.date}
                      className={`print-row-avoid transition-colors ${
                        isToday
                          ? 'bg-teal-50/40 hover:bg-teal-50/70'
                          : hasActivity
                          ? 'hover:bg-slate-50'
                          : 'text-slate-500 hover:bg-slate-50/70'
                      }`}
                    >
                      <td className="py-2.5 pl-5 pr-3 whitespace-nowrap">
                        <div className="font-mono tabular-nums text-xs font-semibold text-slate-900">
                          {formatReadableDate(row.date)}
                        </div>
                        <div className="text-[11px] font-mono tabular-nums text-slate-400">
                          {row.date}
                          {isToday ? ' · Today' : ''}
                        </div>
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                        {formatBDT(row.openingBalance)}
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-xs whitespace-nowrap">
                        <span
                          className={
                            row.labRevenue > 0
                              ? 'font-semibold text-emerald-700'
                              : row.labRevenue < 0
                              ? 'font-semibold text-red-700'
                              : 'text-slate-400'
                          }
                        >
                          {formatBDT(row.labRevenue)}
                        </span>
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-xs whitespace-nowrap">
                        <span
                          className={
                            row.otherRevenue > 0
                              ? 'font-semibold text-teal-700'
                              : 'text-slate-400'
                          }
                        >
                          {formatBDT(row.otherRevenue)}
                        </span>
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-xs font-semibold text-slate-900 whitespace-nowrap">
                        {formatBDT(row.totalAvailableCash)}
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-xs whitespace-nowrap">
                        <div
                          className={
                            row.expensesAndWithdrawals > 0
                              ? 'font-semibold text-red-700'
                              : 'text-slate-400'
                          }
                        >
                          {formatBDT(row.expensesAndWithdrawals)}
                        </div>
                        {row.ownerWithdrawals > 0 && (
                          <div className="text-[10px] text-amber-700">
                            incl. Draw {formatBDT(row.ownerWithdrawals)}
                          </div>
                        )}
                      </td>

                      <td className="py-2.5 pl-3 pr-5 text-right font-mono tabular-nums text-xs whitespace-nowrap">
                        <span
                          className={`font-bold ${
                            row.closingBalance < 0 ? 'text-red-700' : 'text-slate-900'
                          }`}
                        >
                          {formatBDT(row.closingBalance)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>

            {periodTotals && displayedRows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold text-xs text-slate-900">
                  <td className="py-3 pl-5 pr-3 whitespace-nowrap">Period Total / Closing</td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                    {formatBDT(periodTotals.openingBalance)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums text-emerald-700 whitespace-nowrap">
                    {formatBDT(periodTotals.labRevenue)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums text-teal-700 whitespace-nowrap">
                    {formatBDT(periodTotals.otherRevenue)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                    {formatBDT(periodTotals.openingBalance + periodTotals.totalInflow)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums text-red-700 whitespace-nowrap">
                    {formatBDT(periodTotals.totalExpensesAndWithdrawals)}
                  </td>
                  <td
                    className={`py-3 pl-3 pr-5 text-right font-mono tabular-nums text-sm font-bold whitespace-nowrap ${
                      periodTotals.closingBalance < 0 ? 'text-red-700' : 'text-teal-700'
                    }`}
                  >
                    {formatBDT(periodTotals.closingBalance)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Interactive Entry & Breakdown Section (Hidden when Printing) */}
      <div className="no-print grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: "Revenue from Others" Entry Form & Log */}
        <div className="xl:col-span-6 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Record &ldquo;Revenue from Others&rdquo;
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Add non-lab income (home collection fees, report charges, owner capital deposits, etc.) directly into that day&apos;s cash balance.
            </p>
          </div>

          <form onSubmit={handleAddOtherRevenue} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Date</label>
                <input
                  type="date"
                  value={revDate}
                  onChange={(e) => setRevDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
                <select
                  value={revCategory}
                  onChange={(e) => setRevCategory(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {OTHER_REVENUE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Source / Description
                </label>
                <input
                  type="text"
                  value={revSource}
                  onChange={(e) => setRevSource(e.target.value)}
                  placeholder="e.g. Home sample visit fee or cash deposit"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Amount (BDT ৳)
                </label>
                <input
                  type="number"
                  min={0.01}
                  step="any"
                  value={revAmount}
                  onChange={(e) => setRevAmount(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                  required
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Note (Optional)
                </label>
                <input
                  type="text"
                  value={revNote}
                  onChange={(e) => setRevNote(e.target.value)}
                  placeholder="Reference or remarks"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <button
                type="submit"
                disabled={savingRev}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>{savingRev ? 'Adding...' : 'Add Income'}</span>
              </button>
            </div>
          </form>

          <div className="pt-3 border-t border-slate-200">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-slate-700">
                Other Income Entries in Range ({ledger?.otherRevenues.length || 0})
              </h3>
              <span className="text-xs font-mono tabular-nums font-bold text-teal-700">
                {formatBDT(periodTotals?.otherRevenue ?? 0)}
              </span>
            </div>

            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-2 pr-2 font-medium">Date</th>
                    <th className="py-2 pr-2 font-medium">Source</th>
                    <th className="py-2 pr-2 font-medium text-right">Amount</th>
                    <th className="py-2 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {!ledger || ledger.otherRevenues.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-slate-500">
                        No other revenue recorded in this range.
                      </td>
                    </tr>
                  ) : (
                    ledger.otherRevenues.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50">
                        <td className="py-2 pr-2 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {item.revenue_date}
                        </td>
                        <td className="py-2 pr-2">
                          <div className="font-medium text-slate-900">{item.source}</div>
                          <div className="text-[11px] text-slate-500">
                            {item.category}
                            {item.note ? ` · ${item.note}` : ''}
                          </div>
                        </td>
                        <td className="py-2 pr-2 text-right font-mono tabular-nums font-semibold text-teal-700 whitespace-nowrap">
                          {formatBDT(item.amount)}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleDeleteOtherRevenue(item.id)}
                            className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                            aria-label={`Delete ${item.source}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right: Synced Expenses & Owner Withdrawals from Expense Tracker */}
        <div className="xl:col-span-6 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Synced Expenses &amp; Owner Withdrawals
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Automatically pulled from Expense Tracker. Both operational costs and proprietor cash withdrawals reduce closing cash.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowQuickExpenseForm((v) => !v)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{showQuickExpenseForm ? 'Cancel' : 'Quick Withdrawal / Expense'}</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('expenses')}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap cursor-pointer"
              >
                <span>Open Tracker</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {showQuickExpenseForm && (
            <form
              onSubmit={handleAddQuickExpense}
              className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Date</label>
                  <input
                    type="date"
                    value={expDate}
                    onChange={(e) => setExpDate(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg bg-white"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
                  <select
                    value={expCategory}
                    onChange={(e) => setExpCategory(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    {QUICK_EXPENSE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    value={expTitle}
                    onChange={(e) => setExpTitle(e.target.value)}
                    placeholder="e.g. Proprietor Cash Withdrawal"
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Amount (BDT ৳)
                  </label>
                  <input
                    type="number"
                    min={0.01}
                    step="any"
                    value={expAmount}
                    onChange={(e) => setExpAmount(e.target.value)}
                    placeholder="0"
                    className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-lg bg-white"
                    required
                  />
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
                <input
                  type="text"
                  value={expNote}
                  onChange={(e) => setExpNote(e.target.value)}
                  placeholder="Optional voucher or note"
                  className="flex-1 px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                />
                <button
                  type="submit"
                  disabled={savingExp}
                  className="px-4 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                >
                  {savingExp ? 'Saving...' : 'Save Deduction'}
                </button>
              </div>
            </form>
          )}

          {/* Split Summary Strip */}
          <div className="grid grid-cols-3 gap-3 py-2.5 px-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
            <div>
              <div className="text-slate-500">Operational Exp.</div>
              <div className="font-mono tabular-nums font-bold text-slate-900 mt-0.5">
                {formatBDT(periodTotals?.operationalExpenses ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Owner Withdrawals</div>
              <div className="font-mono tabular-nums font-bold text-amber-700 mt-0.5">
                {formatBDT(periodTotals?.ownerWithdrawals ?? 0)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-slate-500">Total Deducted</div>
              <div className="font-mono tabular-nums font-bold text-red-700 mt-0.5">
                {formatBDT(periodTotals?.totalExpensesAndWithdrawals ?? 0)}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-2 pr-2 font-medium">Date</th>
                  <th className="py-2 pr-2 font-medium">Description / Category</th>
                  <th className="py-2 pr-2 font-medium text-right">Amount</th>
                  <th className="py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {!ledger || ledger.expenses.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-slate-500">
                      No expenses or withdrawals recorded in this range.
                    </td>
                  </tr>
                ) : (
                  ledger.expenses.map((ex) => {
                    const isDraw = isWithdrawalCategory(ex.category);
                    return (
                      <tr key={ex.id} className="hover:bg-slate-50">
                        <td className="py-2 pr-2 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {ex.expense_date}
                        </td>
                        <td className="py-2 pr-2">
                          <div className="font-medium text-slate-900">{ex.title}</div>
                          <div className="text-[11px] text-slate-500">
                            <span className={isDraw ? 'font-semibold text-amber-700' : ''}>
                              {ex.category}
                            </span>
                            {ex.note ? ` · ${ex.note}` : ''}
                          </div>
                        </td>
                        <td className="py-2 pr-2 text-right font-mono tabular-nums font-semibold text-red-700 whitespace-nowrap">
                          {formatBDT(ex.amount)}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleDeleteExpense(ex.id)}
                            className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                            aria-label={`Delete ${ex.title}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
