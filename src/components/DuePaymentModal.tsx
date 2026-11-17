import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard, History, Printer, ShieldCheck, X } from 'lucide-react';
import { apiFetch, formatBDT, formatDateTime } from '../lib/api.ts';
import type { FullInvoice } from '../types.ts';

interface DuePaymentModalProps {
  invoiceId: number | null;
  isAdmin?: boolean;
  onClose: () => void;
  onPaymentRecorded: (updated: FullInvoice) => void;
  onOpenReceipt?: (invoiceId: number) => void;
  onOpenAdminAdjust?: (invoiceId: number) => void;
}

export const DuePaymentModal: React.FC<DuePaymentModalProps> = ({
  invoiceId,
  isAdmin = false,
  onClose,
  onPaymentRecorded,
  onOpenReceipt,
  onOpenAdminAdjust,
}) => {
  const [data, setData] = useState<FullInvoice | null>(null);
  const [loading, setLoading] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [payNote, setPayNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadInvoice = useCallback(async (id: number) => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<FullInvoice>(`/api/invoices/${id}`);
      setData(res);
      setPayAmount(res.invoice.due_amount > 0 ? String(res.invoice.due_amount) : '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoice details.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (invoiceId) {
      setSuccess('');
      setPayNote('');
      setPaymentMethod('Cash');
      void loadInvoice(invoiceId);
    } else {
      setData(null);
    }
  }, [invoiceId, loadInvoice]);

  if (!invoiceId) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data) return;
    const amt = Number(payAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter a payment amount greater than ৳0.');
      return;
    }
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      const updated = await apiFetch<FullInvoice>(`/api/invoices/${data.invoice.id}/due-payment`, {
        method: 'POST',
        body: JSON.stringify({
          amount: amt,
          paymentMethod,
          note: payNote,
        }),
      });
      setData(updated);
      setPayAmount(updated.invoice.due_amount > 0 ? String(updated.invoice.due_amount) : '');
      setPayNote('');
      setSuccess(
        updated.invoice.due_amount <= 0
          ? `Collected ${formatBDT(amt)}. Invoice is now Paid in full!`
          : `Collected ${formatBDT(amt)}. Remaining due: ${formatBDT(updated.invoice.due_amount)}`
      );
      onPaymentRecorded(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record payment.');
    } finally {
      setSubmitting(false);
    }
  };

  const inv = data?.invoice;
  const duePaymentsSum = (data?.duePayments || []).reduce((s, dp) => s + Number(dp.amount || 0), 0);
  const initialBookingPaid = inv ? Math.max(0, Math.round((Number(inv.paid_amount) - duePaymentsSum) * 100) / 100) : 0;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xl w-full max-w-xl overflow-hidden my-6">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3 bg-slate-50">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center shrink-0">
              <CreditCard className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-900 truncate">
                Due Collection & Payment Ledger
              </h2>
              {inv && (
                <p className="text-xs text-slate-600 font-mono truncate">
                  {inv.invoice_no} · {inv.patient_name} ({inv.patient_uid})
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-200 rounded-lg"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[82vh] overflow-y-auto">
          {loading && !inv ? (
            <div className="py-10 text-center text-sm text-slate-500">Loading payment ledger...</div>
          ) : !inv ? (
            <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
              {error || 'Invoice not found.'}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                <div>
                  <div className="text-slate-500">Net Total</div>
                  <div className="font-mono tabular-nums font-bold text-slate-900 mt-0.5">
                    {formatBDT(inv.net_total)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Total Paid</div>
                  <div className="font-mono tabular-nums font-bold text-emerald-700 mt-0.5">
                    {formatBDT(inv.paid_amount)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Pending Due</div>
                  <div
                    className={`font-mono tabular-nums font-bold mt-0.5 ${
                      inv.due_amount > 0 ? 'text-red-700' : 'text-emerald-700'
                    }`}
                  >
                    {formatBDT(inv.due_amount)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Status</div>
                  <div className="mt-0.5">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${
                        inv.payment_status === 'Paid'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : inv.payment_status === 'Partial'
                          ? 'bg-amber-50 text-amber-800 border border-amber-200'
                          : 'bg-red-50 text-red-700 border border-red-200'
                      }`}
                    >
                      {inv.payment_status}
                    </span>
                  </div>
                </div>
              </div>

              {Number(inv.adjustment_amount || 0) !== 0 && (
                <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center justify-between gap-2">
                  <span>
                    Admin Bill Adjustment Applied{inv.adjustment_reason ? `: ${inv.adjustment_reason}` : ''}
                  </span>
                  <span className="font-mono font-bold whitespace-nowrap">
                    {Number(inv.adjustment_amount) > 0
                      ? `-${formatBDT(inv.adjustment_amount)}`
                      : `+${formatBDT(Math.abs(Number(inv.adjustment_amount)))}`}
                  </span>
                </div>
              )}

              {inv.due_amount > 0 ? (
                <form onSubmit={handleSubmit} className="space-y-3 border border-slate-200 rounded-lg p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-slate-800">
                      Collect Payment (Anytime Partial or Full)
                    </label>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setPayAmount(String(Math.round((inv.due_amount / 2) * 100) / 100))}
                        className="px-2 py-0.5 text-[11px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded border border-slate-200"
                      >
                        50%
                      </button>
                      <button
                        type="button"
                        onClick={() => setPayAmount(String(inv.due_amount))}
                        className="px-2 py-0.5 text-[11px] font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 rounded border border-teal-200"
                      >
                        Full Due ({formatBDT(inv.due_amount)})
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">Amount (BDT)</label>
                      <input
                        type="number"
                        min={0.01}
                        max={inv.due_amount}
                        step="any"
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">Method</label>
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
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">Note</label>
                      <input
                        type="text"
                        value={payNote}
                        onChange={(e) => setPayNote(e.target.value)}
                        placeholder="Optional note"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50"
                  >
                    {submitting ? 'Saving Payment...' : 'Record Payment'}
                  </button>
                </form>
              ) : (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-800">
                  No pending due balance on this invoice.
                </div>
              )}

              {error && (
                <div className="p-2.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {error}
                </div>
              )}
              {success && (
                <div className="p-2.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
                  {success}
                </div>
              )}

              <div className="pt-2 border-t border-slate-200 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                  <History className="w-3.5 h-3.5 text-slate-500" />
                  <span>Chronological Payment & Adjustment History</span>
                </div>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg text-xs">
                  <div className="px-3 py-2 flex items-center justify-between gap-2 bg-slate-50/70">
                    <div>
                      <div className="font-medium text-slate-800">
                        Initial Booking Entry ({inv.initial_payment_method || 'Cash'})
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {formatDateTime(inv.created_at)} · By {inv.created_by}
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
                  {(data?.duePayments || []).map((dp) => {
                    const isRefund = dp.entry_type === 'refund' || Number(dp.amount) < 0;
                    return (
                      <div key={dp.id} className="px-3 py-2 flex items-center justify-between gap-2">
                        <div>
                          <div className={`font-medium ${isRefund ? 'text-amber-800' : 'text-slate-800'}`}>
                            {isRefund ? 'Admin Refund' : 'Due Payment'} · {dp.payment_method}
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
                  {(data?.adjustments || []).map((adj) => (
                    <div key={`adj-${adj.id}`} className="px-3 py-2 bg-amber-50/50 flex items-center justify-between gap-2">
                      <div>
                        <div className="font-medium text-amber-900">
                          Admin Bill Adjustment ({formatBDT(adj.previous_net_total)} → {formatBDT(adj.new_net_total)})
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
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {inv && onOpenReceipt && (
              <button
                type="button"
                onClick={() => onOpenReceipt(inv.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
              >
                <Printer className="w-3.5 h-3.5" />
                Print Receipt
              </button>
            )}
            {inv && isAdmin && onOpenAdminAdjust && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenAdminAdjust(inv.id);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                Adjust Bill (Admin)
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
