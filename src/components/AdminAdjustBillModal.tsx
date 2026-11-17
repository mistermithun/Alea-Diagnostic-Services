import React, { useCallback, useEffect, useState } from 'react';
import { History, ShieldCheck, X } from 'lucide-react';
import { apiFetch, formatBDT, formatDateTime } from '../lib/api.ts';
import type { FullInvoice } from '../types.ts';

interface AdminAdjustBillModalProps {
  invoiceId: number | null;
  onClose: () => void;
  onAdjusted: (updated: FullInvoice) => void;
}

export const AdminAdjustBillModal: React.FC<AdminAdjustBillModalProps> = ({
  invoiceId,
  onClose,
  onAdjusted,
}) => {
  const [data, setData] = useState<FullInvoice | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'target' | 'reduction'>('target');
  const [targetNetInput, setTargetNetInput] = useState('');
  const [reductionInput, setReductionInput] = useState('');
  const [reason, setReason] = useState('');
  const [refundExcess, setRefundExcess] = useState(true);
  const [refundMethod, setRefundMethod] = useState('Cash');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const loadInvoice = useCallback(async (id: number) => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<FullInvoice>(`/api/invoices/${id}`);
      setData(res);
      setTargetNetInput(String(res.invoice.net_total));
      setReductionInput('0');
      setReason(res.invoice.adjustment_reason || '');
      setRefundExcess(true);
      setRefundMethod('Cash');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoice.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (invoiceId) {
      setMode('target');
      void loadInvoice(invoiceId);
    } else {
      setData(null);
    }
  }, [invoiceId, loadInvoice]);

  if (!invoiceId) return null;

  const inv = data?.invoice;
  const currentNet = Number(inv?.net_total || 0);
  const prevPaid = Number(inv?.paid_amount || 0);

  const computedTargetNet = (() => {
    if (!inv) return 0;
    if (mode === 'target') {
      const val = Number(targetNetInput);
      return Number.isFinite(val) && val >= 0 ? Math.round(val * 100) / 100 : currentNet;
    }
    const red = Number(reductionInput);
    const cleanRed = Number.isFinite(red) && red >= 0 ? red : 0;
    return Math.max(0, Math.round((currentNet - cleanRed) * 100) / 100);
  })();

  const excessOverpaid = Math.max(0, Math.round((prevPaid - computedTargetNet) * 100) / 100);
  const projectedRefund = excessOverpaid > 0 && refundExcess ? excessOverpaid : 0;
  const projectedPaid = excessOverpaid > 0 ? (refundExcess ? computedTargetNet : prevPaid) : prevPaid;
  const projectedDue = Math.max(0, Math.round((computedTargetNet - projectedPaid) * 100) / 100);
  const baseAfterDiscount = inv
    ? Math.max(0, Math.round((Number(inv.subtotal) - Number(inv.discount_amount)) * 100) / 100)
    : 0;
  const projectedTotalAdjustment = Math.round((baseAfterDiscount - computedTargetNet) * 100) / 100;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inv) return;
    setError('');
    if (mode === 'target' && (targetNetInput.trim() === '' || Number(targetNetInput) < 0)) {
      setError('Adjusted Net Bill must be 0 or greater.');
      return;
    }
    if (mode === 'reduction' && (reductionInput.trim() === '' || Number(reductionInput) < 0)) {
      setError('Reduction amount must be 0 or greater.');
      return;
    }

    setSubmitting(true);
    try {
      const bodyPayload =
        mode === 'target'
          ? {
              targetNetTotal: computedTargetNet,
              reason: reason.trim(),
              refundExcess,
              refundMethod,
            }
          : {
              reductionAmount: Number(reductionInput || 0),
              reason: reason.trim(),
              refundExcess,
              refundMethod,
            };

      const updated = await apiFetch<FullInvoice>(`/api/admin/invoices/${inv.id}/adjust-bill`, {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      });
      onAdjusted(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to adjust invoice bill.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xl w-full max-w-xl overflow-hidden my-6">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3 bg-amber-50/70">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-900 truncate">
                Admin Post-Payment Bill Adjustment
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
            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-amber-100 rounded-lg"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          {loading && !inv ? (
            <div className="py-10 text-center text-sm text-slate-500">Loading invoice details...</div>
          ) : !inv ? (
            <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
              {error || 'Invoice not found.'}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                <div>
                  <div className="text-slate-500">Test Subtotal</div>
                  <div className="font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
                    {formatBDT(inv.subtotal)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Discount</div>
                  <div className="font-mono tabular-nums font-semibold text-amber-700 mt-0.5">
                    -{formatBDT(inv.discount_amount)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Current Net Bill</div>
                  <div className="font-mono tabular-nums font-bold text-slate-900 mt-0.5">
                    {formatBDT(inv.net_total)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Already Paid</div>
                  <div className="font-mono tabular-nums font-bold text-emerald-700 mt-0.5">
                    {formatBDT(inv.paid_amount)}
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setMode('target');
                        setTargetNetInput(String(computedTargetNet));
                      }}
                      className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                        mode === 'target' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      Set New Net Bill
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMode('reduction');
                        setReductionInput(
                          String(Math.max(0, Math.round((currentNet - computedTargetNet) * 100) / 100))
                        );
                      }}
                      className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                        mode === 'reduction' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      Subtract Reduction (৳)
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {[10, 20, 50].map((pct) => {
                      const nextNet = Math.max(0, Math.round(currentNet * (1 - pct / 100) * 100) / 100);
                      return (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => {
                            setMode('target');
                            setTargetNetInput(String(nextNet));
                          }}
                          className="px-2 py-1 text-[11px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded border border-slate-200"
                        >
                          -{pct}%
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => {
                        setMode('target');
                        setTargetNetInput('0');
                      }}
                      className="px-2 py-1 text-[11px] font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 rounded border border-amber-200"
                    >
                      ৳0 Free
                    </button>
                  </div>
                </div>

                {mode === 'target' ? (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Adjusted Final Net Bill (BDT)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={targetNetInput}
                      onChange={(e) => setTargetNetInput(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500"
                      required
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Amount to Reduce from Current Net Bill (BDT)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={currentNet}
                      step="any"
                      value={reductionInput}
                      onChange={(e) => setReductionInput(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500"
                      required
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Adjustment Reason / Audit Note
                  </label>
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g., Post-payment special concession, staff family discount, billing correction"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
              </div>

              {excessOverpaid > 0 && (
                <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 space-y-2.5">
                  <div className="flex items-start justify-between gap-2 text-xs">
                    <div>
                      <div className="font-semibold text-amber-900">
                        Overpayment Detected: {formatBDT(excessOverpaid)}
                      </div>
                      <p className="text-amber-800 mt-0.5">
                        Patient already paid {formatBDT(prevPaid)}, which is {formatBDT(excessOverpaid)} higher than
                        the new Net Bill ({formatBDT(computedTargetNet)}).
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-1 border-t border-amber-200/80">
                    <label className="flex items-center gap-2 text-xs font-medium text-amber-950 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={refundExcess}
                        onChange={(e) => setRefundExcess(e.target.checked)}
                        className="rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                      />
                      <span>Refund / Adjust Paid Amount (-{formatBDT(excessOverpaid)})</span>
                    </label>
                    {refundExcess && (
                      <select
                        value={refundMethod}
                        onChange={(e) => setRefundMethod(e.target.value)}
                        className="px-2.5 py-1.5 text-xs border border-amber-300 rounded-md bg-white text-slate-800"
                      >
                        <option value="Cash">Refund via Cash</option>
                        <option value="bKash">Refund via bKash</option>
                        <option value="Nagad">Refund via Nagad</option>
                        <option value="Bank">Refund via Bank</option>
                      </select>
                    )}
                  </div>
                </div>
              )}

              <div className="p-3 bg-slate-900 text-white rounded-lg grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div>
                  <div className="text-slate-400">New Net Bill</div>
                  <div className="font-mono tabular-nums font-bold text-sm mt-0.5">
                    {formatBDT(computedTargetNet)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Total Adjustment</div>
                  <div className="font-mono tabular-nums font-bold text-sm text-amber-300 mt-0.5">
                    {projectedTotalAdjustment >= 0
                      ? `-${formatBDT(projectedTotalAdjustment)}`
                      : `+${formatBDT(Math.abs(projectedTotalAdjustment))}`}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">New Paid Total</div>
                  <div className="font-mono tabular-nums font-bold text-sm text-emerald-300 mt-0.5">
                    {formatBDT(projectedPaid)}
                    {projectedRefund > 0 ? ` (-${formatBDT(projectedRefund)})` : ''}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">New Due Balance</div>
                  <div className="font-mono tabular-nums font-bold text-sm text-red-300 mt-0.5">
                    {formatBDT(projectedDue)}
                  </div>
                </div>
              </div>

              {error && (
                <div className="p-2.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {error}
                </div>
              )}

              {(data?.adjustments || []).length > 0 && (
                <div className="pt-2 border-t border-slate-200 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                    <History className="w-3.5 h-3.5 text-slate-500" />
                    <span>Previous Admin Bill Adjustments</span>
                  </div>
                  <div className="space-y-1 max-h-32 overflow-y-auto text-xs">
                    {(data?.adjustments || []).map((adj) => (
                      <div
                        key={adj.id}
                        className="px-2.5 py-1.5 rounded bg-slate-50 border border-slate-200 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-slate-800 truncate">
                            {formatBDT(adj.previous_net_total)} → {formatBDT(adj.new_net_total)}
                            {adj.reason ? ` · ${adj.reason}` : ''}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {formatDateTime(adj.adjusted_at)} · By {adj.adjusted_by}
                            {adj.refund_amount > 0 ? ` · Refunded ${formatBDT(adj.refund_amount)}` : ''}
                          </div>
                        </div>
                        <span className="font-mono font-semibold text-amber-700 whitespace-nowrap">
                          {adj.adjustment_delta >= 0
                            ? `-${formatBDT(adj.adjustment_delta)}`
                            : `+${formatBDT(Math.abs(adj.adjustment_delta))}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-2 flex items-center justify-end gap-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-xs font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50"
                >
                  {submitting ? 'Applying Adjustment...' : 'Save Admin Bill Adjustment'}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
};
