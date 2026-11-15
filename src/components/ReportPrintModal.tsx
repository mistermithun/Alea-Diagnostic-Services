import React, { useEffect, useMemo, useState } from 'react';
import { Printer, ShieldCheck, X } from 'lucide-react';
import QRCode from 'qrcode';
import { formatAge, formatDateTime } from '../lib/api.ts';
import type { FullInvoice, InvoiceTestItem, LabSettings } from '../types.ts';

interface ReportPrintModalProps {
  data: FullInvoice | null;
  settings: LabSettings;
  focusTestId?: number | null;
  portalMode?: boolean;
  onClose: () => void;
}

/** Deterministic clean verification barcode SVG (Code-style bars) from invoice string */
const VerificationBarcode: React.FC<{ code: string }> = ({ code }) => {
  const bars = useMemo(() => {
    const out: Array<{ x: number; w: number }> = [];
    let x = 2;
    const str = code || 'ALEA-REPORT';
    // Guard bars
    out.push({ x, w: 1.5 });
    x += 3;
    out.push({ x, w: 1.5 });
    x += 4;
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      for (let b = 0; b < 4; b++) {
        const bit = (charCode >> b) & 1;
        const w = bit ? 2.4 : 1.1;
        out.push({ x, w });
        x += w + (b % 2 === 0 ? 1.5 : 2.1);
      }
    }
    out.push({ x, w: 1.5 });
    x += 3;
    out.push({ x, w: 1.5 });
    return { items: out, totalWidth: x + 2 };
  }, [code]);

  return (
    <div className="inline-flex flex-col items-center">
      <svg
        width={bars.totalWidth}
        height={28}
        viewBox={`0 0 ${bars.totalWidth} 28`}
        className="text-slate-900"
        aria-label={`Verification barcode ${code}`}
      >
        {bars.items.map((bar, idx) => (
          <rect key={idx} x={bar.x} y={0} width={bar.w} height={28} fill="currentColor" />
        ))}
      </svg>
      <span className="text-[9px] font-mono tracking-widest text-slate-600 mt-0.5">{code}</span>
    </div>
  );
};

export const ReportPrintModal: React.FC<ReportPrintModalProps> = ({
  data,
  settings,
  focusTestId,
  portalMode = false,
  onClose,
}) => {
  const [selectedTestOnly, setSelectedTestOnly] = useState<boolean>(Boolean(focusTestId));
  const [qrSvgDataUrl, setQrSvgDataUrl] = useState<string>('');

  const topMarginIn = Math.max(0, Number(settings.pad_header_margin_in || 1.5) || 1.5);
  const bottomMarginIn = Math.max(0, Number(settings.pad_footer_margin_in || 0.4) || 0.4);

  useEffect(() => {
    if (!data || !portalMode) {
      setQrSvgDataUrl('');
      return;
    }
    const payload = [
      `LAB:${settings.lab_name}`,
      `INV:${data.invoice.invoice_no}`,
      `PID:${data.invoice.patient_uid}`,
      `NAME:${data.invoice.patient_name}`,
      `DATE:${data.invoice.created_at}`,
    ].join('|');

    QRCode.toDataURL(payload, {
      width: 96,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((url) => setQrSvgDataUrl(url))
      .catch(() => setQrSvgDataUrl(''));
  }, [data, portalMode, settings.lab_name]);

  if (!data) return null;

  const { invoice, tests } = data;
  const displayTests: InvoiceTestItem[] =
    selectedTestOnly && focusTestId ? tests.filter((t) => t.id === focusTestId) : tests;

  const byDepartment = new Map<string, InvoiceTestItem[]>();
  for (const t of displayTests) {
    const arr = byDepartment.get(t.category_name) || [];
    arr.push(t);
    byDepartment.set(t.category_name, arr);
  }

  const primaryCollectedAt = displayTests[0]?.collected_at || invoice.created_at;
  const primaryReportedAt =
    displayTests.find((t) => t.ready_at)?.ready_at ||
    displayTests.find((t) => t.verified_at)?.verified_at ||
    new Date().toISOString();

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/75 overflow-y-auto p-4 sm:p-6 flex flex-col items-center print:static print:overflow-visible print:p-0 print:bg-white">
      {/* Dynamic configurable pad margins for Lab Internal Print Mode */}
      {!portalMode && (
        <style>{`@media print { @page report-pad { size: A4 portrait; margin: ${topMarginIn}in 12mm ${bottomMarginIn}in 12mm; } }`}</style>
      )}

      {/* Print Controls Toolbar */}
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-xl px-4 py-3 mb-4 flex flex-wrap items-center justify-between gap-3 no-print shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs font-semibold text-slate-800">
            {portalMode ? (
              <span className="inline-flex items-center gap-1.5 text-teal-800">
                <ShieldCheck className="w-4 h-4 text-teal-600" />
                Digital PDF Report · Full Official Letterhead &amp; Verification
              </span>
            ) : (
              <span>
                Lab Internal Print Mode · Pre-Printed Pad ({topMarginIn}&quot; top / {bottomMarginIn}&quot; bottom blank)
              </span>
            )}
          </div>

          {focusTestId && tests.length > 1 && (
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setSelectedTestOnly(true)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  selectedTestOnly ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Selected Test Only
              </button>
              <button
                type="button"
                onClick={() => setSelectedTestOnly(false)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  !selectedTestOnly ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All Tests ({tests.length})
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap shrink-0"
          >
            <Printer className="w-4 h-4" />
            {portalMode ? 'Download / Print Digital PDF' : 'Print on Pre-Printed Pad'}
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

      {/* A4 Report Sheet */}
      <div
        className={`w-full max-w-4xl bg-white border border-slate-200 rounded-xl shadow-lg text-slate-900 ${
          portalMode ? 'p-8 sm:p-10 print-digital-report' : 'px-8 sm:px-10 py-0 print-report-pad'
        }`}
      >
        {/* TOP HEADER: Blank spacer on Lab Pad vs Full Official Letterhead on Patient Portal */}
        {!portalMode ? (
          <div
            style={{ height: `${topMarginIn}in` }}
            className="border-b border-dashed border-slate-300 flex items-center justify-center text-xs text-slate-400 no-print"
          >
            Blank Header Area ({topMarginIn} inch — Reserved for Pre-Printed Offset Pad)
          </div>
        ) : (
          <header className="border-b-2 border-teal-700 pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              {/* Crisp Geometric Medical Diagnostic Emblem */}
              <svg
                width="46"
                height="46"
                viewBox="0 0 46 46"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="shrink-0"
                aria-hidden="true"
              >
                <rect width="46" height="46" rx="10" fill="#0F172A" />
                <path d="M20 11H26V20H35V26H26V35H20V26H11V20H20V11Z" fill="#0D9488" />
                <circle cx="23" cy="23" r="3.5" fill="#FFFFFF" />
              </svg>
              <div>
                <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{settings.lab_name}</h1>
                <p className="text-sm text-slate-700">{settings.lab_address}</p>
                <p className="text-xs font-medium text-teal-800 mt-0.5">
                  Department of Pathology &amp; Clinical Diagnostics · Digital Verified Report
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4 sm:justify-end">
              <div className="text-right">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Official Test Report
                </div>
                <div className="text-xs font-mono font-bold tabular-nums text-slate-900 mt-0.5">
                  {invoice.invoice_no}
                </div>
                <div className="mt-1">
                  <VerificationBarcode code={`${invoice.invoice_no}`} />
                </div>
              </div>
              {qrSvgDataUrl && (
                <div className="p-1 border border-slate-200 rounded bg-white shrink-0">
                  <img
                    src={qrSvgDataUrl}
                    alt={`Verification QR code for ${invoice.invoice_no}`}
                    className="w-16 h-16 block"
                  />
                </div>
              )}
            </div>
          </header>
        )}

        {/* Patient Demographics & Specimen Timeline (Shown in Both Modes) */}
        <section
          className={`${
            portalMode ? 'my-5' : 'mt-3 mb-5'
          } p-4 bg-slate-50 border border-slate-200 rounded-lg grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 text-xs`}
        >
          <div className="flex gap-2">
            <span className="text-slate-500 w-28 shrink-0">Patient Name</span>
            <span className="font-bold text-slate-900 text-sm">{invoice.patient_name}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-slate-500 w-28 shrink-0">Invoice / ID</span>
            <span className="font-mono font-semibold tabular-nums text-slate-900">
              {invoice.invoice_no} · {invoice.patient_uid}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-slate-500 w-28 shrink-0">Age / Gender</span>
            <span className="font-medium text-slate-800 tabular-nums">
              {formatAge(invoice.age_years, invoice.age_months, invoice.age_days)} / {invoice.gender}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-slate-500 w-28 shrink-0">Sample Collected</span>
            <span className="font-mono tabular-nums text-slate-800">{formatDateTime(primaryCollectedAt)}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-slate-500 w-28 shrink-0">Referred By</span>
            <span className="font-medium text-slate-800">
              {invoice.doctor_name
                ? `${invoice.doctor_name}${invoice.doctor_degree ? ` (${invoice.doctor_degree})` : ''}`
                : 'Self'}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-slate-500 w-28 shrink-0">Reporting Time</span>
            <span className="font-mono tabular-nums text-slate-800">{formatDateTime(primaryReportedAt)}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-slate-500 w-28 shrink-0">Contact</span>
            <span className="font-mono tabular-nums text-slate-800">{invoice.patient_mobile || '—'}</span>
          </div>
        </section>

        {/* Departmental Test Results */}
        <div className="space-y-6">
          {Array.from(byDepartment.entries()).map(([dept, deptTests]) => (
            <section key={dept} className="space-y-3.5">
              <div className="border-b border-slate-300 pb-1 flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900">{dept}</h2>
                <span className="text-xs text-slate-500">
                  Specimen: {Array.from(new Set(deptTests.map((t) => t.sample_type))).join(', ')}
                </span>
              </div>

              {deptTests.map((t) => (
                <div key={t.id} className="page-break-avoid">
                  <div className="flex items-center justify-between mb-1.5">
                    <h3 className="text-sm font-semibold text-slate-900">{t.test_name}</h3>
                    <span className="text-xs text-slate-500">Status: {t.status}</span>
                  </div>

                  <table className="w-full text-xs border-collapse border border-slate-200">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                        <th className="py-2 px-3 font-semibold">Parameter / Investigation</th>
                        <th className="py-2 px-3 font-semibold text-right w-36">Result</th>
                        <th className="py-2 px-3 font-semibold w-28">Unit</th>
                        <th className="py-2 px-3 font-semibold">Reference Range</th>
                        <th className="py-2 px-3 font-semibold w-20 text-center">Flag</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {(t.results || []).map((r) => {
                        const isAbnormal = r.flag && r.flag !== 'Normal' && r.result_value.trim() !== '';
                        return (
                          <tr key={r.id}>
                            <td className="py-2 px-3 font-medium text-slate-900">{r.parameter_name}</td>
                            <td
                              className={`py-2 px-3 text-right font-mono tabular-nums ${
                                isAbnormal ? 'font-bold text-red-600' : 'font-semibold text-slate-900'
                              }`}
                            >
                              {r.result_value || 'Pending'}
                            </td>
                            <td className="py-2 px-3 text-slate-600">{r.unit || '—'}</td>
                            <td className="py-2 px-3 font-mono tabular-nums text-slate-600">
                              {r.reference_range_text || '—'}
                            </td>
                            <td
                              className={`py-2 px-3 text-center font-semibold ${
                                isAbnormal ? 'text-red-600 font-bold' : 'text-slate-500'
                              }`}
                            >
                              {r.result_value ? (isAbnormal ? r.flag.toUpperCase() : 'Normal') : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </section>
          ))}
        </div>

        {/* BOTTOM FOOTER & SIGNATURES: Hidden in Lab Internal Pad Mode; Full Signatures + Footer in Patient Portal Digital PDF Mode */}
        {!portalMode ? (
          <div
            style={{ height: `${bottomMarginIn}in` }}
            className="mt-8 border-t border-dashed border-slate-300 flex items-center justify-center text-[11px] text-slate-400 no-print"
          >
            Blank Footer &amp; Signatures Area ({bottomMarginIn} inch — Reserved for Pre-Printed Offset Pad)
          </div>
        ) : (
          <>
            <footer className="mt-14 pt-6 border-t border-slate-200 grid grid-cols-2 gap-12 page-break-avoid">
              <div>
                <div className="h-10" />
                <div className="border-t border-slate-400 pt-1.5">
                  <p className="text-xs font-bold text-slate-900">{settings.technologist_name}</p>
                  <p className="text-[11px] text-slate-600">{settings.technologist_title}</p>
                </div>
              </div>
              <div className="text-right">
                <div className="h-10" />
                <div className="border-t border-slate-400 pt-1.5 inline-block min-w-[220px] text-left">
                  <p className="text-xs font-bold text-slate-900">{settings.pathologist_name}</p>
                  <p className="text-[11px] text-slate-600">{settings.pathologist_title}</p>
                </div>
              </div>
            </footer>
            <div className="mt-6 pt-3 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-2 text-[10px] text-slate-500">
              <span>
                Digitally verified report · {settings.lab_name}, {settings.lab_address}
              </span>
              <span className="font-mono tabular-nums">
                Verification ID: {invoice.invoice_no}-{invoice.patient_uid}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
