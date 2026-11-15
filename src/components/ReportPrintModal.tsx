import React, { useEffect, useMemo, useState } from 'react';
import { Printer, ShieldCheck, X } from 'lucide-react';
import QRCode from 'qrcode';
import { formatAge, formatDateTime } from '../lib/api.ts';
import type { FullInvoice, InvoiceTestItem, LabSettings, TestResultRow } from '../types.ts';

interface ReportPrintModalProps {
  data: FullInvoice | null;
  settings: LabSettings;
  focusTestId?: number | null;
  portalMode?: boolean;
  onClose: () => void;
}

function isCbcTest(test: InvoiceTestItem): boolean {
  const n = test.test_name.toLowerCase();
  return n.includes('cbc') || n.includes('complete blood count');
}

const CBC_ORDER_KEYS: Array<{
  match: (name: string) => boolean;
  section?: string;
}> = [
  { match: (n) => n.includes('hemoglobin') || n === 'hb' || n.includes('(hb)') },
  { match: (n) => n.startsWith('esr') || n.includes('sedimentation') },
  { match: (n) => n.includes('total wbc'), section: 'Total Counts' },
  { match: (n) => n.includes('total rbc'), section: 'Total Counts' },
  { match: (n) => n.includes('platelet'), section: 'Total Counts' },
  { match: (n) => n.startsWith('neutrophil'), section: 'WBC Differential Panel' },
  { match: (n) => n.startsWith('lymphocyte'), section: 'WBC Differential Panel' },
  {
    match: (n) => n.startsWith('eosinophil') && !n.includes('circulating'),
    section: 'WBC Differential Panel',
  },
  { match: (n) => n.startsWith('monocyte'), section: 'WBC Differential Panel' },
  { match: (n) => n.startsWith('basophil'), section: 'WBC Differential Panel' },
  { match: (n) => n.includes('circulating eosinophil'), section: 'WBC Differential Panel' },
  {
    match: (n) => n.includes('pcv') || n.includes('hct') || n.includes('hematocrit'),
    section: 'RBC Indices & Parameters',
  },
  { match: (n) => n === 'mcv' || n.startsWith('mcv '), section: 'RBC Indices & Parameters' },
  { match: (n) => n === 'mch' || n.startsWith('mch '), section: 'RBC Indices & Parameters' },
  { match: (n) => n === 'mchc' || n.startsWith('mchc '), section: 'RBC Indices & Parameters' },
  { match: (n) => n.startsWith('rdw'), section: 'RBC Indices & Parameters' },
];

function getCbcSequenceMeta(paramName: string): { order: number; section?: string } {
  const lower = paramName.trim().toLowerCase();
  for (let i = 0; i < CBC_ORDER_KEYS.length; i++) {
    if (CBC_ORDER_KEYS[i].match(lower)) {
      return { order: i, section: CBC_ORDER_KEYS[i].section };
    }
  }
  return { order: 999 };
}

function getOrderedCbcRows(rows: TestResultRow[]): Array<{ row: TestResultRow; section?: string }> {
  const indexed = rows.map((row, idx) => {
    const meta = getCbcSequenceMeta(row.parameter_name);
    return { row, idx, order: meta.order, section: meta.section };
  });
  indexed.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.idx - b.idx));
  return indexed.map(({ row, section }) => ({ row, section }));
}

/** Deterministic clean verification barcode SVG rendered in pure black ink */
const VerificationBarcode: React.FC<{ code: string }> = ({ code }) => {
  const bars = useMemo(() => {
    const out: Array<{ x: number; w: number }> = [];
    let x = 2;
    const str = code || 'ALEA-REPORT';
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
        className="text-black"
        aria-label={`Verification barcode ${code}`}
      >
        {bars.items.map((bar, idx) => (
          <rect key={idx} x={bar.x} y={0} width={bar.w} height={28} fill="#000000" />
        ))}
      </svg>
      <span className="text-[9px] font-mono tracking-widest text-black mt-0.5">{code}</span>
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
  const [activeTestId, setActiveTestId] = useState<number | null>(focusTestId ?? null);
  const [blankConsultantOverride, setBlankConsultantOverride] = useState<boolean>(false);
  const [qrSvgDataUrl, setQrSvgDataUrl] = useState<string>('');

  const topMarginIn = Math.max(0, Number(settings.pad_header_margin_in || 1.5) || 1.5);
  const bottomMarginIn = Math.max(0, Number(settings.pad_footer_margin_in || 0.4) || 0.4);

  // Always re-sync isolated active test whenever modal opens or focusTestId changes
  useEffect(() => {
    if (!data) {
      setActiveTestId(null);
      setBlankConsultantOverride(false);
      return;
    }
    if (focusTestId && data.tests.some((t) => t.id === focusTestId)) {
      setActiveTestId(focusTestId);
    } else {
      setActiveTestId(data.tests[0]?.id ?? null);
    }
    setBlankConsultantOverride(false);
  }, [data, focusTestId]);

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
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => setQrSvgDataUrl(url))
      .catch(() => setQrSvgDataUrl(''));
  }, [data, portalMode, settings.lab_name]);

  if (!data) return null;

  const { invoice, tests } = data;

  // Strict Single-Test Isolation: print ONLY the selected/focused test
  const isolatedTest: InvoiceTestItem | undefined =
    (focusTestId ? tests.find((t) => t.id === focusTestId) : undefined) ||
    tests.find((t) => t.id === activeTestId) ||
    tests[0];

  const displayTests: InvoiceTestItem[] = isolatedTest ? [isolatedTest] : [];
  const activeIsCbc = isolatedTest ? isCbcTest(isolatedTest) : false;
  const tableColCount = activeIsCbc ? 4 : 5;

  const primaryCollectedAt = isolatedTest?.collected_at || invoice.created_at;
  const primaryReportedAt =
    isolatedTest?.ready_at || isolatedTest?.verified_at || new Date().toISOString();

  // Resolve Prepared / Tested By (Technologist with full academic qualification & designation)
  const techRaw = (isolatedTest?.verified_by || '').trim();
  const techDefaultName = (settings.technologist_name || '').trim();
  const resolvedTechName =
    techRaw && techDefaultName && techDefaultName.toLowerCase().startsWith(techRaw.toLowerCase())
      ? techDefaultName
      : techRaw || techDefaultName;
  const resolvedTechTitle = (settings.technologist_title || 'Medical Technologist (Lab)').trim();

  // Resolve Consultant / Pathologist with Conditional Rule
  const testConsultantName = (isolatedTest?.consultant_name || '').trim();
  const testConsultantTitle = (isolatedTest?.consultant_title || '').trim();
  const settingsPathologistName = (settings.pathologist_name || '').trim();
  const settingsPathologistTitle = (settings.pathologist_title || '').trim();
  const referralDocName = (invoice.doctor_name || '').trim();
  const hasRealReferralDoc =
    Boolean(referralDocName) && !referralDocName.toLowerCase().includes('self');

  let resolvedConsultantName = '';
  let resolvedConsultantTitle = '';

  if (!blankConsultantOverride && testConsultantName !== '__BLANK__') {
    if (testConsultantName) {
      resolvedConsultantName = testConsultantName;
      resolvedConsultantTitle = testConsultantTitle || settingsPathologistTitle || 'Consultant Pathologist';
    } else if (settingsPathologistName) {
      resolvedConsultantName = settingsPathologistName;
      resolvedConsultantTitle = settingsPathologistTitle || 'Consultant Pathologist';
    } else if (hasRealReferralDoc) {
      resolvedConsultantName = referralDocName;
      resolvedConsultantTitle = (invoice.doctor_degree || '').trim();
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/75 overflow-y-auto p-4 sm:p-6 flex flex-col items-center print:block print:static print:inset-auto print:h-auto print:min-h-0 print:overflow-visible print:p-0 print:bg-white">
      {/* Print Controls Toolbar (Hidden on Paper) */}
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-xl px-4 py-3 mb-4 space-y-2.5 no-print shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-xs font-semibold text-slate-800">
              {portalMode ? (
                <span className="inline-flex items-center gap-1.5 text-teal-800">
                  <ShieldCheck className="w-4 h-4 text-teal-600" />
                  Digital PDF Report · Isolated Single Test · Pure Black Ink
                </span>
              ) : (
                <span>
                  Lab Internal Print Mode · Pre-Printed Pad ({topMarginIn}&quot; top / {bottomMarginIn}&quot; bottom blank)
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!portalMode && (
              <button
                type="button"
                onClick={() => setBlankConsultantOverride((v) => !v)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                  blankConsultantOverride
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {blankConsultantOverride ? 'Doctor Sign: Blank Line' : 'Doctor Sign: Assigned / Auto'}
              </button>
            )}
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap shrink-0"
            >
              <Printer className="w-4 h-4" />
              {portalMode ? 'Download / Print Digital PDF' : 'Print Isolated Test Report'}
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

        {/* Isolated Single-Test Switcher when opened from Invoice with multiple tests */}
        {!focusTestId && tests.length > 1 && (
          <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-slate-500 mr-1">
              Select Isolated Report to Print:
            </span>
            {tests.map((t) => {
              const active = isolatedTest?.id === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTestId(t.id)}
                  className={`px-3 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  {t.test_name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* A4 Report Sheet — Strictly Pure Black Ink */}
      <div
        className={`w-full max-w-4xl bg-white border border-slate-300 rounded-xl shadow-lg text-black print-pure-black ${
          portalMode ? 'p-8 sm:p-10 print-digital-report' : 'px-8 sm:px-10 py-0 print-report-pad'
        }`}
      >
        <table className="w-full border-collapse print-layout-table text-black">
          <colgroup>
            <col />
            <col className="w-28" />
            <col className="w-28" />
            <col className={activeIsCbc ? 'w-56' : 'w-44'} />
            {!activeIsCbc && <col className="w-24" />}
          </colgroup>

          {/* Repeating top & bottom blank margins across every printed page (keeps @page margin: 0) */}
          <thead className="hidden print:table-header-group print-spacer-head">
            <tr>
              <td
                colSpan={tableColCount}
                style={{ height: portalMode ? '10mm' : `${topMarginIn}in` }}
                className="p-0 border-0"
              />
            </tr>
          </thead>

          <tfoot className="hidden print:table-footer-group print-spacer-foot">
            <tr>
              <td
                colSpan={tableColCount}
                style={{ height: portalMode ? '10mm' : `${bottomMarginIn}in` }}
                className="p-0 border-0"
              />
            </tr>
          </tfoot>

          {/* Header & Patient Demographics */}
          <tbody>
            <tr>
              <td colSpan={tableColCount} className="p-0 border-0 align-top">
                {!portalMode ? (
                  <div
                    style={{ height: `${topMarginIn}in` }}
                    className="border-b border-dashed border-slate-300 flex items-center justify-center text-xs text-slate-400 no-print"
                  >
                    Blank Header Area ({topMarginIn} inch — Reserved for Pre-Printed Offset Pad)
                  </div>
                ) : (
                  <header className="border-b-2 border-black pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-3.5">
                      <svg
                        width="46"
                        height="46"
                        viewBox="0 0 46 46"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        className="shrink-0"
                        aria-hidden="true"
                      >
                        <rect width="46" height="46" rx="10" fill="#000000" />
                        <path d="M20 11H26V20H35V26H26V35H20V26H11V20H20V11Z" fill="#FFFFFF" />
                        <circle cx="23" cy="23" r="3.5" fill="#000000" />
                      </svg>
                      <div>
                        <h1 className="text-2xl font-bold text-black tracking-tight">{settings.lab_name}</h1>
                        <p className="text-sm text-black">{settings.lab_address}</p>
                        <p className="text-xs font-semibold text-black mt-0.5">
                          Department of Pathology &amp; Clinical Diagnostics · Digital Verified Report
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 sm:justify-end">
                      <div className="text-right">
                        <div className="text-[11px] font-bold uppercase tracking-wider text-black">
                          Official Test Report
                        </div>
                        <div className="text-xs font-mono font-bold tabular-nums text-black mt-0.5">
                          {invoice.invoice_no}
                        </div>
                        <div className="mt-1">
                          <VerificationBarcode code={`${invoice.invoice_no}`} />
                        </div>
                      </div>
                      {qrSvgDataUrl && (
                        <div className="p-1 border border-black rounded bg-white shrink-0">
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
              </td>
            </tr>

            <tr>
              <td colSpan={tableColCount} className="p-0 border-0">
                <section
                  className={`${
                    portalMode ? 'my-4 print:my-3' : 'mt-3 mb-4 print:mt-0 print:mb-3'
                  } p-3.5 bg-white border border-black rounded-md grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs text-black page-break-avoid`}
                >
                  <div className="flex gap-2">
                    <span className="text-black w-28 shrink-0">Patient Name</span>
                    <span className="font-bold text-black text-sm">: {invoice.patient_name}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-black w-28 shrink-0">Invoice / ID</span>
                    <span className="font-mono font-bold tabular-nums text-black">
                      : {invoice.invoice_no} · {invoice.patient_uid}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-black w-28 shrink-0">Age / Gender</span>
                    <span className="font-semibold text-black tabular-nums">
                      : {formatAge(invoice.age_years, invoice.age_months, invoice.age_days)} / {invoice.gender}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-black w-28 shrink-0">Sample Collected</span>
                    <span className="font-mono tabular-nums text-black">: {formatDateTime(primaryCollectedAt)}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-black w-28 shrink-0">Referred By</span>
                    <span className="font-semibold text-black">
                      :{' '}
                      {invoice.doctor_name
                        ? `${invoice.doctor_name}${invoice.doctor_degree ? ` (${invoice.doctor_degree})` : ''}`
                        : 'Self'}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-black w-28 shrink-0">Reporting Time</span>
                    <span className="font-mono tabular-nums text-black">: {formatDateTime(primaryReportedAt)}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-black w-28 shrink-0">Contact</span>
                    <span className="font-mono tabular-nums text-black">: {invoice.patient_mobile || '—'}</span>
                  </div>
                </section>
              </td>
            </tr>
          </tbody>

          {/* Isolated Single Test Table */}
          {displayTests.map((t) => {
            const cbcMode = isCbcTest(t);
            const orderedCbc = cbcMode ? getOrderedCbcRows(t.results || []) : [];
            let lastSection: string | undefined;

            return (
              <tbody key={t.id} className="text-xs text-black">
                <tr className="print-keep-with-next">
                  <td colSpan={tableColCount} className="pt-1.5 pb-1.5 px-0 border-b border-black">
                    <div className="flex items-center justify-between gap-4">
                      <h2 className="text-sm font-bold uppercase tracking-wider text-black">
                        {t.category_name}
                      </h2>
                      <span className="text-xs font-medium text-black">
                        Specimen: {t.sample_type}
                      </span>
                    </div>
                  </td>
                </tr>

                <tr className="print-keep-with-next">
                  <td colSpan={tableColCount} className="pt-2.5 pb-1.5 px-0 border-0">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-black">{t.test_name}</h3>
                      <span className="text-xs font-medium text-black">Status: {t.status}</span>
                    </div>
                  </td>
                </tr>

                <tr className="border border-black text-left text-black print-keep-with-next print-row-avoid bg-white">
                  <th className="py-1.5 px-3 font-bold border-y border-l border-black">
                    Parameter / Investigation
                  </th>
                  <th className="py-1.5 px-3 font-bold text-right border-y border-black">Result</th>
                  <th className="py-1.5 px-3 font-bold border-y border-black">Unit</th>
                  <th
                    className={`py-1.5 px-3 font-bold border-y border-black ${
                      cbcMode ? 'border-r' : ''
                    }`}
                  >
                    Reference Range
                  </th>
                  {!cbcMode && (
                    <th className="py-1.5 px-3 font-bold text-center border-y border-r border-black">
                      Remark
                    </th>
                  )}
                </tr>

                {cbcMode
                  ? orderedCbc.map(({ row: r, section }) => {
                      const showSection = Boolean(section && section !== lastSection);
                      if (section) lastSection = section;

                      return (
                        <React.Fragment key={r.id}>
                          {showSection && (
                            <tr className="print-keep-with-next print-row-avoid border-x border-b border-black bg-white">
                              <td
                                colSpan={4}
                                className="py-1 px-3 text-[11px] font-bold uppercase tracking-wider text-black border-b border-x border-black"
                              >
                                {section}
                              </td>
                            </tr>
                          )}
                          <tr className="border-b border-x border-black print-row-avoid">
                            <td className="py-1.5 px-3 font-semibold text-black border-b border-l border-black align-top">
                              {r.parameter_name}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums font-bold text-black border-b border-black align-top">
                              {r.result_value || 'Pending'}
                            </td>
                            <td className="py-1.5 px-3 text-black border-b border-black align-top">
                              {r.unit || '—'}
                            </td>
                            <td className="py-1.5 px-3 font-mono tabular-nums text-[11px] leading-snug text-black border-b border-r border-black whitespace-pre-line align-top">
                              {r.normal_text || r.reference_range_text || '—'}
                            </td>
                          </tr>
                        </React.Fragment>
                      );
                    })
                  : (t.results || []).map((r) => {
                      const isAbnormal = r.flag && r.flag !== 'Normal' && r.result_value.trim() !== '';
                      return (
                        <tr key={r.id} className="border-b border-x border-black print-row-avoid">
                          <td className="py-1.5 px-3 font-semibold text-black border-b border-l border-black align-top">
                            {r.parameter_name}
                          </td>
                          <td
                            className={`py-1.5 px-3 text-right font-mono tabular-nums text-black border-b border-black align-top ${
                              isAbnormal ? 'font-bold underline decoration-1 underline-offset-2' : 'font-bold'
                            }`}
                          >
                            {r.result_value || 'Pending'}
                          </td>
                          <td className="py-1.5 px-3 text-black border-b border-black align-top">
                            {r.unit || '—'}
                          </td>
                          <td className="py-1.5 px-3 font-mono tabular-nums text-[11px] leading-snug text-black border-b border-black whitespace-pre-line align-top">
                            {r.reference_range_text || r.normal_text || '—'}
                          </td>
                          <td
                            className={`py-1.5 px-3 text-center text-black border-b border-r border-black align-top ${
                              isAbnormal ? 'font-bold' : 'font-normal'
                            }`}
                          >
                            {r.result_value ? (isAbnormal ? r.flag.toUpperCase() : 'Normal') : '—'}
                          </td>
                        </tr>
                      );
                    })}
              </tbody>
            );
          })}

          {/* Standardized 3-Column Footer & Signatures Block (Pure Black Ink) */}
          <tbody className="page-break-avoid">
            <tr>
              <td colSpan={tableColCount} className="p-0 border-0">
                <div className="page-break-avoid pt-8">
                  <footer className="grid grid-cols-3 gap-6 items-end text-black">
                    {/* 1. Prepared / Tested By */}
                    <div className="text-left">
                      <div className="h-12" />
                      <div className="border-t border-black pt-1.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-black">
                          Prepared / Tested By
                        </div>
                        {resolvedTechName && (
                          <p className="text-xs font-bold text-black mt-0.5 leading-snug">
                            {resolvedTechName}
                          </p>
                        )}
                        {resolvedTechTitle && (
                          <p className="text-[11px] text-black leading-snug">{resolvedTechTitle}</p>
                        )}
                      </div>
                    </div>

                    {/* 2. Checked By */}
                    <div className="text-center">
                      <div className="h-12" />
                      <div className="border-t border-black pt-1.5">
                        <div className="text-[11px] font-bold text-black">Checked by</div>
                      </div>
                    </div>

                    {/* 3. Consultant / Pathologist (Blank line when unassigned) */}
                    <div className="text-right">
                      <div className="h-12" />
                      <div className="border-t border-black pt-1.5 text-left">
                        {resolvedConsultantName ? (
                          <>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-black">
                              Consultant / Pathologist
                            </div>
                            <p className="text-xs font-bold text-black mt-0.5 leading-snug">
                              {resolvedConsultantName}
                            </p>
                            {resolvedConsultantTitle && (
                              <p className="text-[11px] text-black leading-snug">
                                {resolvedConsultantTitle}
                              </p>
                            )}
                          </>
                        ) : (
                          <div className="h-8" aria-label="Blank Consultant / Pathologist Signature Line" />
                        )}
                      </div>
                    </div>
                  </footer>

                  {portalMode ? (
                    <div className="mt-4 pt-3 border-t border-black flex flex-col sm:flex-row items-center justify-between gap-2 text-[10px] text-black">
                      <span>
                        Digitally verified report · {settings.lab_name}, {settings.lab_address}
                      </span>
                      <span className="font-mono tabular-nums">
                        Verification ID: {invoice.invoice_no}-{invoice.patient_uid}
                      </span>
                    </div>
                  ) : (
                    <div
                      style={{ height: `${bottomMarginIn}in` }}
                      className="mt-4 border-t border-dashed border-slate-300 flex items-center justify-center text-[11px] text-slate-400 no-print"
                    >
                      Blank Footer Area ({bottomMarginIn} inch — Reserved for Pre-Printed Offset Pad)
                    </div>
                  )}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};
