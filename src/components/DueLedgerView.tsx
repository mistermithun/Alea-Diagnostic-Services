import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard, History, Printer, Search, ShieldCheck } from 'lucide-react';
import { apiFetch, formatBDT, formatDateTime } from '../lib/api.ts';
import type { FullInvoice, InvoiceSummary } from '../types.ts';
import { AdminAdjustBillModal } from './AdminAdjustBillModal.tsx';

interface DueLedgerViewProps {
  isAdmin?: boolean;
  onOpenReceipt: (invoiceId: number) => void;
}

export const DueLedgerView: React.FC<DueLedgerViewProps> = ({ isAdmin = false, onOpenReceipt }) => {
  const [search, setSearch] = useState('');
  const [dueFilter, setDueFilter] = useState<'due' | 'all'>('due');
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedInvoice, setSelectedInvoice] = useState<FullInvoice | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [payNote, setPayNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [adjustModalInvoiceId, setAdjustModalInvoiceId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadDueInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ invoices: InvoiceSummary[] }>(
        `/api/invoices?dueOnly=${dueFilter === 'due' ? '1' : '0'}&search=${encodeURIComponent(search)}`
      );
      setInvoices(res.invoices);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [search, dueFilter]);

  useEffect(() => {
    loadDueInvoices();
  }, [loadDueInvoices]);

  const selectForPayment = async (invoiceId: number) => {
    setError('');
    setSuccess('');
    try {
      const full = await apiFetch<FullInvoice>(`/api/invoices/${invoiceId}`);
      setSelectedInvoice(full);
      setPayAmount(full.invoice.due_amount > 0 ? String(full.invoice.due_amount) : '');
      setPayNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoice.');
    }
  };

  const handleCollectDue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedInvoice) return;
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const collectedNum = Number(payAmount);
      const updated = await apiFetch<FullInvoice>(
        `/api/invoices/${selectedInvoice.invoice.id}/due-payment`,
        {
          method: 'POST',
          body: JSON.stringify({
            amount: collectedNum,
            paymentMethod,
            note: payNote,
          }),
        }
      );
      setSelectedInvoice(updated);
      setPayAmount(updated.invoice.due_amount > 0 ? String(updated.invoice.due_amount) : '');
      setPayNote('');
      setSuccess(
        `Collected ${formatBDT(collectedNum)}. Remaining due: ${formatBDT(updated.invoice.due_amount)}`
      );
      await loadDueInvoices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const totalPending = invoices.reduce((sum, i) => sum + Number(i.due_amount), 0);
  const duePaymentsSum = (selectedInvoice?.duePayments || []).reduce(
    (s, dp) => s + Number(dp.amount || 0),
    0
  );
  const initialBookingPaid = selectedInvoice
    ? Math.max(0, Math.round((Number(selectedInvoice.invoice.paid_amount) - duePaymentsSum) * 100) / 100)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy tracking-tight">Due Collection & Payment Ledger</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Track pending patient balances, collect anytime partial or full payments, and review full payment history.
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-2 text-right">
          <div className="text-xs text-slate-500">Total Receivable Shown</div>
          <div className="text-lg font-bold font-mono tabular-nums text-brand-red">{formatBDT(totalPending)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search invoices by number, patient name, ID, or mobile..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start shrink-0">
              <button
                type="button"
                onClick={() => setDueFilter('due')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  dueFilter === 'due' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Pending Dues
              </button>
              <button
                type="button"
                onClick={() => setDueFilter('all')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  dueFilter === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All Invoices & Ledger
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-2 pr-3 font-medium">Invoice</th>
                  <th className="py-2 pr-3 font-medium">Patient</th>
                  <th className="py-2 pr-3 font-medium text-right">Net Bill</th>
                  <th className="py-2 pr-3 font-medium text-right">Due</th>
                  <th className="py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-sm text-slate-500">
                      Loading ledger...
                    </td>
                  </tr>
                ) : invoices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-sm text-slate-500">
                      {dueFilter === 'due' ? 'No pending due invoices found.' : 'No invoices found.'}
                    </td>
                  </tr>
                ) : (
                  invoices.map((inv) => (
                    <tr
                      key={inv.id}
                      className={`hover:bg-slate-50 align-top ${
                        selectedInvoice?.invoice.id === inv.id ? 'bg-teal-50/40' : ''
                      }`}
                    >
                      <td className="py-3 pr-3 font-mono tabular-nums text-xs whitespace-nowrap">
                        <div className="font-semibold text-slate-900">{inv.invoice_no}</div>
                        <div className="text-slate-500">{formatDateTime(inv.created_at).split(',')[0]}</div>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="font-medium text-slate-900">{inv.patient_name}</div>
                        <div className="text-xs text-slate-500 font-mono tabular-nums">
                          {inv.patient_mobile || inv.patient_uid}
                        </div>
                        {inv.test_items && inv.test_items.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {inv.test_items.map((t) => (
                              <span
                                key={t.id}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md bg-white border border-slate-200 text-slate-700"
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    t.status === 'Ready'
                                      ? 'bg-emerald-500'
                                      : t.status === 'Verified'
                                      ? 'bg-teal-500'
                                      : t.status === 'Processing'
                                      ? 'bg-amber-500'
                                      : 'bg-slate-400'
                                  }`}
                                />
                                <span className="truncate max-w-[130px]">{t.test_name}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-3 text-right font-mono tabular-nums">
                        <div>{formatBDT(inv.net_total)}</div>
                        {Number(inv.adjustment_amount || 0) !== 0 && (
                          <div className="text-[11px] font-semibold text-amber-700">
                            Adj: {Number(inv.adjustment_amount) > 0 ? `-${formatBDT(inv.adjustment_amount)}` : `+${formatBDT(Math.abs(Number(inv.adjustment_amount)))}`}
                          </div>
                        )}
                      </td>
                      <td
                        className={`py-3 pr-3 text-right font-mono tabular-nums font-bold ${
                          inv.due_amount > 0 ? 'text-red-700' : 'text-emerald-700'
                        }`}
                      >
                        {inv.due_amount > 0 ? formatBDT(inv.due_amount) : 'Paid'}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={() => selectForPayment(inv.id)}
                          className={`px-3 py-1.5 text-xs font-semibold rounded-md whitespace-nowrap ${
                            inv.due_amount > 0
                              ? 'text-white bg-teal-600 hover:bg-teal-700'
                              : 'text-slate-700 bg-slate-100 border border-slate-300 hover:bg-slate-200'
                          }`}
                        >
                          {inv.due_amount > 0 ? 'Collect Due' : 'View Ledger'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-xl p-5">
          {!selectedInvoice ? (
            <div className="py-14 text-center space-y-2">
              <CreditCard className="w-8 h-8 text-slate-400 mx-auto" />
              <h3 className="text-sm font-semibold text-slate-800">Select an Invoice to Manage Payment</h3>
              <p className="text-xs text-slate-500">
                Choose any invoice from the ledger to collect due payments, review history, or adjust bills (Admin).
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="pb-3 border-b border-slate-200 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-mono tabular-nums text-slate-500">
                    {selectedInvoice.invoice.invoice_no} · {selectedInvoice.invoice.patient_uid}
                  </div>
                  <h2 className="text-base font-bold text-slate-900 mt-0.5">
                    {selectedInvoice.invoice.patient_name}
                  </h2>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => setAdjustModalInvoiceId(selectedInvoice.invoice.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100 whitespace-nowrap"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Adjust / Reduce Bill
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenReceipt(selectedInvoice.invoice.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    Print Receipt
                  </button>
                </div>
              </div>

              {selectedInvoice.tests.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selectedInvoice.tests.map((t) => (
                    <span
                      key={t.id}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md bg-slate-50 border border-slate-200 text-slate-700"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          t.status === 'Ready'
                            ? 'bg-emerald-500'
                            : t.status === 'Verified'
                            ? 'bg-teal-500'
                            : t.status === 'Processing'
                            ? 'bg-amber-500'
                            : 'bg-slate-400'
                        }`}
                      />
                      <span>{t.test_name}</span>
                    </span>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-3 gap-3 text-center p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                <div>
                  <div className="text-slate-500">Net Total</div>
                  <div className="font-mono tabular-nums font-bold text-slate-900 mt-0.5">
                    {formatBDT(selectedInvoice.invoice.net_total)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Paid</div>
                  <div className="font-mono tabular-nums font-bold text-emerald-700 mt-0.5">
                    {formatBDT(selectedInvoice.invoice.paid_amount)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Due Balance</div>
                  <div
                    className={`font-mono tabular-nums font-bold mt-0.5 ${
                      selectedInvoice.invoice.due_amount > 0 ? 'text-red-700' : 'text-emerald-700'
                    }`}
                  >
                    {formatBDT(selectedInvoice.invoice.due_amount)}
                  </div>
                </div>
              </div>

              {Number(selectedInvoice.invoice.adjustment_amount || 0) !== 0 && (
                <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center justify-between gap-2">
                  <span>
                    Admin Bill Adjustment
                    {selectedInvoice.invoice.adjustment_reason
                      ? `: ${selectedInvoice.invoice.adjustment_reason}`
                      : ''}
                  </span>
                  <span className="font-mono font-bold whitespace-nowrap">
                    {Number(selectedInvoice.invoice.adjustment_amount) > 0
                      ? `-${formatBDT(selectedInvoice.invoice.adjustment_amount)}`
                      : `+${formatBDT(Math.abs(Number(selectedInvoice.invoice.adjustment_amount)))}`}
                  </span>
                </div>
              )}

              {selectedInvoice.invoice.due_amount > 0 ? (
                <form onSubmit={handleCollectDue} className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="block text-xs font-medium text-slate-700">
                        Amount Collecting Now (BDT)
                      </label>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setPayAmount(
                              String(Math.round((selectedInvoice.invoice.due_amount / 2) * 100) / 100)
                            )
                          }
                          className="px-2 py-0.5 text-[11px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded border border-slate-200"
                        >
                          50%
                        </button>
                        <button
                          type="button"
                          onClick={() => setPayAmount(String(selectedInvoice.invoice.due_amount))}
                          className="px-2 py-0.5 text-[11px] font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 rounded border border-teal-200"
                        >
                          Full Due
                        </button>
                      </div>
                    </div>
                    <input
                      type="number"
                      min={0.01}
                      max={selectedInvoice.invoice.due_amount}
                      step="any"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Method</label>
                      <select
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                      >
                        <option value="Cash">Cash</option>
                        <option value="bKash">bKash</option>
                        <option value="Nagad">Nagad</option>
                        <option value="Bank">Bank / Card</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Note</label>
                      <input
                        type="text"
                        value={payNote}
                        onChange={(e) => setPayNote(e.target.value)}
                        placeholder="Optional remark"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50"
                  >
                    {submitting ? 'Recording Payment...' : 'Record Due Payment'}
                  </button>
                </form>
              ) : (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-800">
                  Invoice is Paid in full. {isAdmin ? 'As Admin, you can still use "Adjust / Reduce Bill" above to apply post-payment concessions or refunds.' : ''}
                </div>
              )}

              {error && (
                <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {error}
                </div>
              )}
              {success && (
                <div className="p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
                  {success}
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                  <History className="w-3.5 h-3.5 text-slate-500" />
                  <span>Payment & Adjustment History</span>
                </div>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg text-xs">
                  <div className="px-3 py-2 flex items-center justify-between gap-2 bg-slate-50/70">
                    <div>
                      <div className="font-medium text-slate-800">
                        Initial Booking ({selectedInvoice.invoice.initial_payment_method || 'Cash'})
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {formatDateTime(selectedInvoice.invoice.created_at)}
                      </div>
                    </div>
                    <span
                      className={`font-mono tabular-nums font-semibold ${
                        initialBookingPaid > 0 ? 'text-emerald-700' : 'text-slate-500'
                      }`}
                    >
                      {initialBookingPaid > 0 ? formatBDT(initialBookingPaid) : '৳ 0 (Credit)'}
                    </span>
                  </div>

                  {selectedInvoice.duePayments.map((dp) => {
                    const isRefund = dp.entry_type === 'refund' || Number(dp.amount) < 0;
                    return (
                      <div key={dp.id} className="px-3 py-2 flex items-center justify-between gap-2">
                        <div>
                          <div className={`font-medium ${isRefund ? 'text-amber-800' : 'text-slate-800'}`}>
                            {isRefund ? 'Admin Refund' : 'Due Collection'} · {dp.payment_method}
                            {dp.note ? <span className="text-slate-500 font-normal"> — {dp.note}</span> : null}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {formatDateTime(dp.collected_at)} · By {dp.collected_by}
                          </div>
                        </div>
                        <span
                          className={`font-mono tabular-nums font-semibold whitespace-nowrap ${
                            isRefund ? 'text-amber-700' : 'text-emerald-700'
                          }`}
                        >
                          {isRefund ? `-${formatBDT(Math.abs(dp.amount))}` : formatBDT(dp.amount)}
                        </span>
                      </div>
                    );
                  })}

                  {(selectedInvoice.adjustments || []).map((adj) => (
                    <div
                      key={`adj-${adj.id}`}
                      className="px-3 py-2 bg-amber-50/50 flex items-center justify-between gap-2"
                    >
                      <div>
                        <div className="font-medium text-amber-900">
                          Admin Adjustment ({formatBDT(adj.previous_net_total)} → {formatBDT(adj.new_net_total)})
                        </div>
                        <div className="text-[11px] text-slate-600">
                          {formatDateTime(adj.adjusted_at)} · By {adj.adjusted_by}
                          {adj.reason ? ` · ${adj.reason}` : ''}
                        </div>
                      </div>
                      <span className="font-mono tabular-nums font-semibold text-amber-800 whitespace-nowrap">
                        {adj.adjustment_delta >= 0
                          ? `-${formatBDT(adj.adjustment_delta)}`
                          : `+${formatBDT(Math.abs(adj.adjustment_delta))}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {isAdmin && (
        <AdminAdjustBillModal
          invoiceId={adjustModalInvoiceId}
          onClose={() => setAdjustModalInvoiceId(null)}
          onAdjusted={async (updated) => {
            setSelectedInvoice(updated);
            setPayAmount(updated.invoice.due_amount > 0 ? String(updated.invoice.due_amount) : '');
            setSuccess(
              `Admin bill adjustment saved. New Net Total: ${formatBDT(updated.invoice.net_total)} · Paid: ${formatBDT(updated.invoice.paid_amount)} · Due: ${formatBDT(updated.invoice.due_amount)}`
            );
            await loadDueInvoices();
          }}
        />
      )}
    </div>
  );
};
