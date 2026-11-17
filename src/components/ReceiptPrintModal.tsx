import React, { useEffect, useState } from 'react';
import { Printer, X } from 'lucide-react';
import QRCode from 'qrcode';
import {
  buildPatientReportQrUrl,
  formatAge,
  formatBDT,
  formatDateTime,
  resolvePublicBaseUrl,
} from '../lib/api.ts';
import type { FullInvoice, LabSettings } from '../types.ts';

interface ReceiptPrintModalProps {
  data: FullInvoice | null;
  settings: LabSettings;
  publicBaseUrl?: string;
  onClose: () => void;
}

export const ReceiptPrintModal: React.FC<ReceiptPrintModalProps> = ({
  data,
  settings,
  publicBaseUrl,
  onClose,
}) => {
  const [format, setFormat] = useState<'a4' | 'thermal'>('a4');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const portalWebsiteUrl = resolvePublicBaseUrl(publicBaseUrl);

  useEffect(() => {
    const token = data?.invoice?.patient_qr_token;
    const uid = data?.invoice?.patient_uid;
    const invId = data?.invoice?.id;
    if (!token || !invId) {
      setQrDataUrl('');
      return;
    }
    const url = buildPatientReportQrUrl(token, uid, invId, null, publicBaseUrl);
    QRCode.toDataURL(url, {
      width: 160,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((res) => setQrDataUrl(res))
      .catch(() => setQrDataUrl(''));
  }, [data?.invoice?.id, data?.invoice?.patient_qr_token, data?.invoice?.patient_uid, publicBaseUrl]);

  if (!data) return null;

  const { invoice, tests, duePayments } = data;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/70 overflow-y-auto p-4 sm:p-6 flex flex-col items-center print:block print:static print:inset-auto print:h-auto print:min-h-0 print:overflow-visible print:p-0 print:bg-white">
      {/* Toolbar - hidden during print */}
      <div className="w-full max-w-3xl bg-white border border-slate-200 rounded-xl px-4 py-3 mb-4 flex flex-wrap items-center justify-between gap-3 no-print shadow-sm">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => setFormat('a4')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              format === 'a4' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            A4 Cash Memo
          </button>
          <button
            type="button"
            onClick={() => setFormat('thermal')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              format === 'thermal' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            80mm Thermal POS
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap shrink-0"
          >
            <Printer className="w-4 h-4" />
            Print Receipt
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            <X className="w-4 h-4" />
            Close
          </button>
        </div>
      </div>

      {/* Printable Sheet */}
      {format === 'a4' ? (
        <div className="w-full max-w-3xl bg-white border border-slate-200 rounded-xl p-8 shadow-lg print-sheet text-slate-900">
          {/* Official Lab Header */}
          <div className="border-b-2 border-slate-900 pb-4 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{settings.lab_name}</h1>
              <p className="text-sm text-slate-700 mt-0.5">{settings.lab_address}</p>
              <p className="text-xs text-slate-600 mt-1">
                Proprietor: <span className="font-medium text-slate-800">{settings.proprietor_name}</span>
                <span className="mx-2" aria-hidden="true">·</span>
                Contact: <span className="font-mono tabular-nums font-medium text-slate-800">{settings.lab_phone}</span>
              </p>
            </div>
            <div className="sm:text-right">
              <div className="text-xs font-semibold tracking-wider text-teal-700 uppercase">Official Money Receipt</div>
              <div className="text-lg font-bold font-mono tabular-nums text-slate-900 mt-0.5">{invoice.invoice_no}</div>
              <div className="text-xs text-slate-600 font-mono tabular-nums">{formatDateTime(invoice.created_at)}</div>
            </div>
          </div>

          {/* Patient & Referral Metadata */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4 border-b border-slate-200 text-sm">
            <div className="space-y-1">
              <div className="flex gap-2">
                <span className="text-slate-500 w-24 shrink-0">Patient ID:</span>
                <span className="font-mono font-semibold tabular-nums">{invoice.patient_uid}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-slate-500 w-24 shrink-0">Patient Name:</span>
                <span className="font-semibold">{invoice.patient_name}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-slate-500 w-24 shrink-0">Age / Gender:</span>
                <span className="tabular-nums">
                  {formatAge(invoice.age_years, invoice.age_months, invoice.age_days)} / {invoice.gender}
                </span>
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex gap-2">
                <span className="text-slate-500 w-24 shrink-0">Mobile:</span>
                <span className="font-mono tabular-nums">{invoice.patient_mobile || '—'}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-slate-500 w-24 shrink-0">Referred By:</span>
                <span className="font-medium">{invoice.doctor_name || 'Self / Walk-in'}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-slate-500 w-24 shrink-0">Status:</span>
                <span
                  className={`font-semibold ${
                    invoice.payment_status === 'Paid'
                      ? 'text-emerald-700'
                      : invoice.payment_status === 'Partial'
                      ? 'text-amber-700'
                      : 'text-red-700'
                  }`}
                >
                  {invoice.payment_status}
                </span>
              </div>
            </div>
          </div>

          {/* Tests Table */}
          <table className="w-full text-sm mt-4 border-collapse">
            <thead>
              <tr className="border-b border-slate-300 text-left text-xs text-slate-600">
                <th className="py-2 font-semibold w-10">#</th>
                <th className="py-2 font-semibold">Investigation / Test Name</th>
                <th className="py-2 font-semibold">Department</th>
                <th className="py-2 font-semibold">Sample</th>
                <th className="py-2 font-semibold text-right">Fee (BDT)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {tests.map((t, idx) => (
                <tr key={t.id}>
                  <td className="py-2.5 font-mono tabular-nums text-slate-500">{idx + 1}</td>
                  <td className="py-2.5 font-medium text-slate-900">{t.test_name}</td>
                  <td className="py-2.5 text-slate-600">{t.category_name}</td>
                  <td className="py-2.5 text-slate-600">{t.sample_type}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums font-medium">{formatBDT(t.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Summary & Payment Breakdown */}
          <div className="mt-6 pt-4 border-t border-slate-300 flex flex-col sm:flex-row justify-between gap-6">
            <div className="text-xs text-slate-600 space-y-2.5 max-w-md flex-1">
              {(invoice.patient_portal_password || qrDataUrl) && (
                <div className="p-3 bg-slate-50 border border-slate-300 rounded-lg flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">Online Report &amp; QR Access</p>
                    <div className="mt-1 text-[11px] text-slate-800 break-all">
                      Website:{' '}
                      <span className="font-mono font-semibold text-teal-800 print:text-black">
                        {portalWebsiteUrl}
                      </span>
                    </div>
                    {invoice.patient_portal_password && (
                      <div className="mt-1 font-mono tabular-nums text-slate-800 space-y-0.5">
                        <div>Patient ID: <span className="font-bold">{invoice.patient_uid}</span></div>
                        <div>Password: <span className="font-bold">{invoice.patient_portal_password}</span></div>
                      </div>
                    )}
                    <p className="text-[11px] text-slate-600 mt-1.5 leading-snug">
                      Scan the QR code for instant digital PDF report access, or visit the website above to log in with your ID &amp; password.
                    </p>
                  </div>
                  {qrDataUrl && (
                    <div className="shrink-0 flex flex-col items-center p-1.5 bg-white border border-slate-300 rounded">
                      <img
                        src={qrDataUrl}
                        alt={`Patient Report QR for ${invoice.patient_uid}`}
                        className="w-[74px] h-[74px] block"
                      />
                      <span className="text-[9px] font-bold uppercase tracking-tight text-slate-900 mt-1 leading-none">
                        Scan for Report
                      </span>
                    </div>
                  )}
                </div>
              )}
              {duePayments.length > 0 && (
                <div>
                  <p className="font-semibold text-slate-800 mb-1">Payment &amp; Refund History</p>
                  {duePayments.map((dp) => {
                    const isRefund = dp.entry_type === 'refund' || Number(dp.amount) < 0;
                    return (
                      <div key={dp.id} className="font-mono tabular-nums text-slate-600">
                        {formatDateTime(dp.collected_at)} ·{' '}
                        {isRefund
                          ? `Refund -${formatBDT(Math.abs(dp.amount))}`
                          : formatBDT(dp.amount)}{' '}
                        ({dp.payment_method})
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="pt-1 text-slate-500">
                Please bring this receipt when collecting your pathology report.
              </p>
            </div>

            <div className="w-full sm:w-64 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">Subtotal</span>
                <span className="font-mono tabular-nums">{formatBDT(invoice.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">
                  Less / Discount {invoice.discount_type === 'percent' && invoice.discount_value > 0 ? `(${invoice.discount_value}%)` : ''}
                </span>
                <span className="font-mono tabular-nums">- {formatBDT(invoice.discount_amount)}</span>
              </div>
              {Number(invoice.adjustment_amount || 0) !== 0 && (
                <div className="flex justify-between text-amber-800">
                  <span>Bill Adjustment</span>
                  <span className="font-mono tabular-nums">
                    {Number(invoice.adjustment_amount) > 0
                      ? `- ${formatBDT(invoice.adjustment_amount)}`
                      : `+ ${formatBDT(Math.abs(Number(invoice.adjustment_amount)))}`}
                  </span>
                </div>
              )}
              <div className="flex justify-between font-semibold text-slate-900 pt-1.5 border-t border-slate-200">
                <span>Net Payable</span>
                <span className="font-mono tabular-nums">{formatBDT(invoice.net_total)}</span>
              </div>
              <div className="flex justify-between text-emerald-700 font-medium">
                <span>Paid Amount</span>
                <span className="font-mono tabular-nums">{formatBDT(invoice.paid_amount)}</span>
              </div>
              <div className={`flex justify-between font-bold pt-1 border-t border-slate-200 ${invoice.due_amount > 0 ? 'text-red-700' : 'text-slate-900'}`}>
                <span>Due Balance</span>
                <span className="font-mono tabular-nums">{formatBDT(invoice.due_amount)}</span>
              </div>
            </div>
          </div>

          <div className="mt-10 pt-4 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
            <span>Prepared By: {invoice.created_by}</span>
            <span>Authorized Signature ({settings.lab_name})</span>
          </div>
        </div>
      ) : (
        /* 80mm Thermal POS Format */
        <div className="w-[320px] bg-white border border-slate-200 rounded-lg p-5 shadow-lg print-sheet print-thermal text-slate-900 font-mono text-xs">
          <div className="text-center border-b border-dashed border-slate-400 pb-3">
            <div className="text-sm font-bold">{settings.lab_name}</div>
            <div className="text-[11px] text-slate-700 mt-0.5">{settings.lab_address}</div>
            <div className="text-[11px] text-slate-700">Prop: {settings.proprietor_name}</div>
            <div className="text-[11px] text-slate-700">Tel: {settings.lab_phone}</div>
            <div className="mt-2 font-bold border-t border-dashed border-slate-300 pt-1.5">CASH MEMO</div>
          </div>

          <div className="py-2.5 border-b border-dashed border-slate-400 space-y-0.5 text-[11px]">
            <div className="flex justify-between">
              <span>Inv: {invoice.invoice_no}</span>
              <span>ID: {invoice.patient_uid}</span>
            </div>
            <div>Date: {formatDateTime(invoice.created_at)}</div>
            <div className="font-bold pt-1">Patient: {invoice.patient_name}</div>
            <div>
              Age/Sex: {formatAge(invoice.age_years, invoice.age_months, invoice.age_days)} / {invoice.gender}
            </div>
            {invoice.patient_mobile && <div>Mob: {invoice.patient_mobile}</div>}
            <div>Ref: {invoice.doctor_name || 'Self'}</div>
          </div>

          <div className="py-2.5 border-b border-dashed border-slate-400">
            <div className="flex justify-between font-bold pb-1 border-b border-slate-200">
              <span>Test</span>
              <span>Amt</span>
            </div>
            <div className="divide-y divide-slate-100">
              {tests.map((t) => (
                <div key={t.id} className="py-1 flex justify-between gap-2">
                  <span className="truncate">{t.test_name}</span>
                  <span className="shrink-0 tabular-nums">{t.price}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="py-2.5 space-y-1 text-[11px] border-b border-dashed border-slate-400">
            <div className="flex justify-between">
              <span>Subtotal:</span>
              <span className="tabular-nums">{formatBDT(invoice.subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span>Discount:</span>
              <span className="tabular-nums">- {formatBDT(invoice.discount_amount)}</span>
            </div>
            {Number(invoice.adjustment_amount || 0) !== 0 && (
              <div className="flex justify-between">
                <span>Adjustment:</span>
                <span className="tabular-nums">
                  {Number(invoice.adjustment_amount) > 0
                    ? `- ${formatBDT(invoice.adjustment_amount)}`
                    : `+ ${formatBDT(Math.abs(Number(invoice.adjustment_amount)))}`}
                </span>
              </div>
            )}
            <div className="flex justify-between font-bold text-xs pt-1">
              <span>Net Total:</span>
              <span className="tabular-nums">{formatBDT(invoice.net_total)}</span>
            </div>
            <div className="flex justify-between">
              <span>Paid:</span>
              <span className="tabular-nums">{formatBDT(invoice.paid_amount)}</span>
            </div>
            <div className="flex justify-between font-bold">
              <span>Due:</span>
              <span className="tabular-nums">{formatBDT(invoice.due_amount)}</span>
            </div>
          </div>

          <div className="pt-3 text-center text-[10px] text-slate-600 space-y-1">
            <div className="font-bold uppercase">Status: {invoice.payment_status}</div>
            {(invoice.patient_portal_password || qrDataUrl) && (
              <div className="border-t border-b border-dashed border-slate-300 py-2 my-1 text-slate-900 space-y-1">
                <div className="font-bold">ONLINE REPORT PORTAL</div>
                <div className="text-[9px] break-all">{portalWebsiteUrl}</div>
                {invoice.patient_portal_password && (
                  <div>ID: {invoice.patient_uid} | PW: {invoice.patient_portal_password}</div>
                )}
                {qrDataUrl && (
                  <div className="flex flex-col items-center pt-1">
                    <img
                      src={qrDataUrl}
                      alt={`QR Code for ${invoice.patient_uid}`}
                      className="w-[88px] h-[88px] block border border-slate-300 p-0.5 bg-white"
                    />
                    <span className="text-[9px] font-bold mt-1">Scan QR for Instant Report</span>
                  </div>
                )}
              </div>
            )}
            <div>Thank you for choosing {settings.lab_name}</div>
          </div>
        </div>
      )}
    </div>
  );
};
