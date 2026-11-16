import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard, Printer, Search } from 'lucide-react';
import { apiFetch, formatBDT, formatDateTime } from '../lib/api.ts';
import type { FullInvoice, InvoiceSummary } from '../types.ts';

interface DueLedgerViewProps {
  onOpenReceipt: (invoiceId: number) => void;
}

export const DueLedgerView: React.FC<DueLedgerViewProps> = ({ onOpenReceipt }) => {
  const [search, setSearch] = useState('');
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedInvoice, setSelectedInvoice] = useState<FullInvoice | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [payNote, setPayNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadDueInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ invoices: InvoiceSummary[] }>(
        `/api/invoices?dueOnly=1&search=${encodeURIComponent(search)}`
      );
      setInvoices(res.invoices);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    loadDueInvoices();
  }, [loadDueInvoices]);

  const selectForPayment = async (invoiceId: number) => {
    setError('');
    setSuccess('');
    try {
      const full = await apiFetch<FullInvoice>(`/api/invoices/${invoiceId}`);
      setSelectedInvoice(full);
      setPayAmount(String(full.invoice.due_amount));
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
      const updated = await apiFetch<FullInvoice>(
        `/api/invoices/${selectedInvoice.invoice.id}/due-payment`,
        {
          method: 'POST',
          body: JSON.stringify({
            amount: Number(payAmount),
            paymentMethod,
            note: payNote,
          }),
        }
      );
      setSelectedInvoice(updated);
      setPayAmount(String(updated.invoice.due_amount));
      setSuccess(
        `Collected ${formatBDT(Number(payAmount))}. Remaining due: ${formatBDT(updated.invoice.due_amount)}`
      );
      await loadDueInvoices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const totalPending = invoices.reduce((sum, i) => sum + Number(i.due_amount), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Due Collection Ledger</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Track pending patient balances, collect partial or full payments, and reprint updated receipts.
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-2 text-right">
          <div className="text-xs text-slate-500">Total Receivable Shown</div>
          <div className="text-lg font-bold font-mono tabular-nums text-red-700">{formatBDT(totalPending)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pending invoices by number, patient name, or mobile..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
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
                      Loading pending dues...
                    </td>
                  </tr>
                ) : invoices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-sm text-slate-500">
                      No pending due invoices found.
                    </td>
                  </tr>
                ) : (
                  invoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50 align-top">
                      <td className="py-3 pr-3 font-mono tabular-nums text-xs whitespace-nowrap">
                        <div className="font-semibold text-slate-900">{inv.invoice_no}</div>
                        <div className="text-slate-500">{formatDateTime(inv.created_at).split(',')[0]}</div>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="font-medium text-slate-900">{inv.patient_name}</div>
                        <div className="text-xs text-slate-500 font-mono tabular-nums">{inv.patient_mobile || inv.patient_uid}</div>
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
                        {formatBDT(inv.net_total)}
                      </td>
                      <td className="py-3 pr-3 text-right font-mono tabular-nums font-bold text-red-700">
                        {formatBDT(inv.due_amount)}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={() => selectForPayment(inv.id)}
                          className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 rounded-md hover:bg-teal-700 whitespace-nowrap"
                        >
                          Collect Due
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
              <h3 className="text-sm font-semibold text-slate-800">Select an Invoice to Collect Payment</h3>
              <p className="text-xs text-slate-500">
                Choose any pending invoice from the ledger to record a due payment.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="pb-3 border-b border-slate-200 flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-mono tabular-nums text-slate-500">
                    {selectedInvoice.invoice.invoice_no} · {selectedInvoice.invoice.patient_uid}
                  </div>
                  <h2 className="text-base font-bold text-slate-900 mt-0.5">
                    {selectedInvoice.invoice.patient_name}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenReceipt(selectedInvoice.invoice.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Print Receipt
                </button>
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
                  <div className="font-mono tabular-nums font-bold text-red-700 mt-0.5">
                    {formatBDT(selectedInvoice.invoice.due_amount)}
                  </div>
                </div>
              </div>

              {selectedInvoice.invoice.due_amount > 0 && (
                <form onSubmit={handleCollectDue} className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Amount Collecting Now (BDT)
                    </label>
                    <input
                      type="number"
                      min={1}
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

              {selectedInvoice.duePayments.length > 0 && (
                <div className="pt-3 border-t border-slate-200">
                  <h3 className="text-xs font-semibold text-slate-800 mb-2">Previous Due Collections</h3>
                  <div className="space-y-1.5 text-xs">
                    {selectedInvoice.duePayments.map((dp) => (
                      <div key={dp.id} className="flex justify-between font-mono tabular-nums text-slate-600">
                        <span>{formatDateTime(dp.collected_at)} · {dp.payment_method}</span>
                        <span className="font-semibold text-emerald-700">{formatBDT(dp.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
