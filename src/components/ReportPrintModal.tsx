import React, { useEffect, useMemo, useState } from 'react';
import { Download, FolderOpen, Printer, ShieldCheck, X } from 'lucide-react';
import QRCode from 'qrcode';
import {
  buildPatientReportQrUrl,
  formatAge,
  formatDateTime,
  resolvePublicBaseUrl,
} from '../lib/api.ts';
import type { FullInvoice, InvoiceTestItem, LabSettings, TestResultRow } from '../types.ts';

interface ReportPrintModalProps {
  data: FullInvoice | null;
  settings: LabSettings;
  publicBaseUrl?: string;
  focusTestId?: number | null;
  portalMode?: boolean;
  inlinePageMode?: boolean;
  onViewAllArchive?: () => void;
  onClose: () => void;
}

function isCbcTest(test: InvoiceTestItem): boolean {
  const n = test.test_name.toLowerCase();
  return n.includes('cbc') || n.includes('complete blood count');
}

function isUrineReTest(test: InvoiceTestItem): boolean {
  const n = test.test_name.toLowerCase();
  return n.includes('urine r/e') || n.includes('urine routine');
}

function formatDepartmentHeading(categoryName: string): string {
  const lower = categoryName.trim().toLowerCase();
  if (lower === 'hematology' || lower === 'haematology') return 'Haematology Report';
  if (lower.endsWith('report')) return categoryName;
  return `${categoryName} Report`;
}

const CBC_ORDER_KEYS: Array<{
  match: (name: string) => boolean;
  section?: string;
}> = [
  { match: (n) => n.includes('hemoglobin') || n === 'hb' || n.includes('(hb)') },
  {
    match: (n) => n.startsWith('esr') || n.includes('sedimentation'),
    section: 'ESR (Westergren Method)',
  },
  { match: (n) => n.includes('total wbc'), section: 'Total Count' },
  { match: (n) => n.includes('total rbc'), section: 'Total Count' },
  { match: (n) => n.includes('platelet'), section: 'Total Count' },
  { match: (n) => n.startsWith('neutrophil'), section: 'Differential WBC Count' },
  { match: (n) => n.startsWith('lymphocyte'), section: 'Differential WBC Count' },
  {
    match: (n) => n.startsWith('eosinophil') && !n.includes('circulating'),
    section: 'Differential WBC Count',
  },
  { match: (n) => n.startsWith('monocyte'), section: 'Differential WBC Count' },
  { match: (n) => n.startsWith('basophil'), section: 'Differential WBC Count' },
  { match: (n) => n.includes('circulating eosinophil'), section: 'Differential WBC Count' },
  {
    match: (n) => n.includes('pcv') || n.includes('hct') || n.includes('hematocrit'),
    section: 'RBC Indices & Parameters',
  },
  { match: (n) => n === 'mcv' || n.startsWith('mcv '), section: 'RBC Indices & Parameters' },
  { match: (n) => n === 'mch' || n.startsWith('mch '), section: 'RBC Indices & Parameters' },
  { match: (n) => n === 'mchc' || n.startsWith('mchc '), section: 'RBC Indices & Parameters' },
  { match: (n) => n.startsWith('rdw'), section: 'RBC Indices & Parameters' },
];

const URINE_SECTIONS: Array<{
  match: (name: string) => boolean;
  section: string;
}> = [
  {
    match: (n) =>
      n.includes('color') ||
      n.includes('appearance') ||
      n.includes('sediment') ||
      n.includes('specific gravity') ||
      n.includes('reaction') ||
      n.includes('ph'),
    section: 'Physical Examination',
  },
  {
    match: (n) =>
      n.includes('albumin') ||
      n.includes('protein') ||
      n.includes('sugar') ||
      n.includes('glucose') ||
      n.includes('ketone') ||
      n.includes('bilirubin') ||
      n.includes('urobilinogen') ||
      n.includes('nitrite') ||
      n.includes('leukocyte') ||
      n.includes('blood'),
    section: 'Chemical Examination',
  },
  {
    match: () => true,
    section: 'Microscopic Examination',
  },
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

function getUrineSection(paramName: string): string {
  const lower = paramName.trim().toLowerCase();
  for (const rule of URINE_SECTIONS) {
    if (rule.match(lower)) return rule.section;
  }
  return 'Microscopic Examination';
}

function formatNumericResultDisplay(value: string, paramName: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return 'Pending';
  const cleanNum = Number(trimmed.replace(/,/g, ''));
  if (!Number.isFinite(cleanNum) || /[^0-9.,-]/.test(trimmed)) return trimmed;
  const lower = paramName.toLowerCase();
  if (lower.includes('total wbc') || lower.includes('platelet') || cleanNum >= 1000) {
    return cleanNum.toLocaleString('en-US');
  }
  return trimmed;
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
        height={24}
        viewBox={`0 0 ${bars.totalWidth} 24`}
        className="text-black"
        aria-label={`Verification barcode ${code}`}
      >
        {bars.items.map((bar, idx) => (
          <rect key={idx} x={bar.x} y={0} width={bar.w} height={24} fill="#000000" />
        ))}
      </svg>
      <span className="text-[9px] font-mono tracking-widest text-black">{code}</span>
    </div>
  );
};

export const ReportPrintModal: React.FC<ReportPrintModalProps> = ({
  data,
  settings,
  publicBaseUrl,
  focusTestId,
  portalMode = false,
  inlinePageMode = false,
  onViewAllArchive,
  onClose,
}) => {
  const [activeTestId, setActiveTestId] = useState<number | null>(focusTestId ?? null);
  const [blankConsultantOverride, setBlankConsultantOverride] = useState<boolean>(false);
  const [qrSvgDataUrl, setQrSvgDataUrl] = useState<string>('');
  const portalWebsiteUrl = resolvePublicBaseUrl(publicBaseUrl);

  const topMarginIn = Math.max(0, Number(settings.pad_header_margin_in || 1.5) || 1.5);
  const bottomMarginIn = Math.max(0, Number(settings.pad_footer_margin_in || 0.4) || 0.4);

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

  const resolvedTestForQr =
    (data && focusTestId ? data.tests.find((t) => t.id === focusTestId) : undefined) ||
    data?.tests.find((t) => t.id === activeTestId) ||
    data?.tests[0];

  useEffect(() => {
    const qrToken = data?.invoice?.patient_qr_token;
    const uid = data?.invoice?.patient_uid;
    const invId = data?.invoice?.id;
    const testId = resolvedTestForQr?.id;
    if (!data || !qrToken || !invId) {
      setQrSvgDataUrl('');
      return;
    }

    const reportUrl = buildPatientReportQrUrl(qrToken, uid, invId, testId, publicBaseUrl);
    QRCode.toDataURL(reportUrl, {
      width: 160,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => setQrSvgDataUrl(url))
      .catch(() => setQrSvgDataUrl(''));
  }, [data, resolvedTestForQr?.id, publicBaseUrl]);

  if (!data) return null;

  const { invoice, tests } = data;

  // Strict Single-Test Isolation
  const isolatedTest: InvoiceTestItem | undefined = resolvedTestForQr;

  const activeIsCbc = isolatedTest ? isCbcTest(isolatedTest) : false;
  const activeIsUrine = isolatedTest ? isUrineReTest(isolatedTest) : false;
  const isThreeColumnLayout = activeIsCbc || activeIsUrine;
  const tableColCount = isThreeColumnLayout ? 3 : 4;

  const primaryCollectedAt = isolatedTest?.collected_at || invoice.created_at;
  const primaryReportedAt =
    isolatedTest?.ready_at || isolatedTest?.verified_at || new Date().toISOString();

  // Prepared / Tested By (Technologist with full academic qualification & designation)
  const techRaw = (isolatedTest?.verified_by || '').trim();
  const techDefaultName = (settings.technologist_name || '').trim();
  const resolvedTechName =
    techRaw && techDefaultName && techDefaultName.toLowerCase().startsWith(techRaw.toLowerCase())
      ? techDefaultName
      : techRaw || techDefaultName;
  const resolvedTechTitle = (settings.technologist_title || 'Medical Technologist (Lab)').trim();

  // Consultant / Pathologist with Conditional Rule
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
      resolvedConsultantTitle =
        testConsultantTitle || settingsPathologistTitle || 'Consultant Pathologist';
    } else if (settingsPathologistName) {
      resolvedConsultantName = settingsPathologistName;
      resolvedConsultantTitle = settingsPathologistTitle || 'Consultant Pathologist';
    } else if (hasRealReferralDoc) {
      resolvedConsultantName = referralDocName;
      resolvedConsultantTitle = (invoice.doctor_degree || '').trim();
    }
  }

  const orderedCbc = isolatedTest && activeIsCbc ? getOrderedCbcRows(isolatedTest.results || []) : [];

  // Test-specific & dynamic parameter table typography (Patient Header & Signature Footer stay fixed)
  const tableTypography = (() => {
    if (activeIsCbc) {
      return {
        theadClass: 'text-[11.5px]',
        tbodyClass: 'text-[12px] leading-[1.3]',
        unitClass: 'text-[11px]',
        normalClass: 'text-[11px] leading-[1.24]',
        rowPadClass: 'py-[2.5px]',
        sectionPadClass: 'pt-2 pb-0.5',
      };
    }
    if (activeIsUrine) {
      return {
        theadClass: 'text-[11.5px]',
        tbodyClass: 'text-[12px] leading-[1.28]',
        unitClass: 'text-[11px]',
        normalClass: 'text-[11px] leading-[1.22]',
        rowPadClass: 'py-[2px]',
        sectionPadClass: 'pt-1.5 pb-0.5',
      };
    }

    const paramRows = isolatedTest?.results || [];
    const paramCount = paramRows.length;
    const extraRangeLines = paramRows.reduce((acc, row) => {
      const refText = (row.reference_range_text || row.normal_text || '').trim();
      if (!refText) return acc;
      const explicitLines = refText.split('\n').length - 1;
      const wrapEstimate = refText.length > 42 ? 1 : 0;
      return acc + Math.max(explicitLines, wrapEstimate);
    }, 0);
    const effectiveUnits = paramCount + extraRangeLines * 0.55;

    if (effectiveUnits <= 5) {
      return {
        theadClass: 'text-[12.5px]',
        tbodyClass: 'text-[13.5px] leading-[1.45]',
        unitClass: 'text-[12.5px]',
        normalClass: 'text-[12.5px] leading-[1.38]',
        rowPadClass: effectiveUnits <= 2 ? 'py-3' : 'py-2.5',
        sectionPadClass: 'pt-2 pb-0.5',
      };
    }
    if (effectiveUnits <= 11) {
      return {
        theadClass: 'text-[12px]',
        tbodyClass: 'text-[12.5px] leading-[1.38]',
        unitClass: 'text-[11.5px]',
        normalClass: 'text-[11.5px] leading-[1.32]',
        rowPadClass: 'py-2',
        sectionPadClass: 'pt-2 pb-0.5',
      };
    }
    if (effectiveUnits <= 17) {
      return {
        theadClass: 'text-[11.5px]',
        tbodyClass: 'text-[12px] leading-[1.32]',
        unitClass: 'text-[11px]',
        normalClass: 'text-[11px] leading-[1.26]',
        rowPadClass: 'py-1.5',
        sectionPadClass: 'pt-2 pb-0.5',
      };
    }
    return {
      theadClass: 'text-[11.5px]',
      tbodyClass: 'text-[12px] leading-[1.34]',
      unitClass: 'text-[11px]',
      normalClass: 'text-[11px] leading-[1.28]',
      rowPadClass: 'py-1.5',
      sectionPadClass: 'pt-2 pb-0.5',
    };
  })();

  const handlePrintReport = () => {
    const prevTitle = document.title;
    const safeName = (invoice.patient_name || 'Patient').replace(/[^a-zA-Z0-9_-]+/g, '_');
    document.title = `${invoice.invoice_no}_${safeName}_Report`;
    window.print();
    setTimeout(() => {
      document.title = prevTitle;
    }, 1000);
  };

  return (
    <div
      className={
        inlinePageMode
          ? 'w-full flex flex-col items-center px-3 py-4 sm:p-6 print:block print:p-0 print:bg-white'
          : 'fixed inset-0 z-50 bg-slate-900/75 overflow-y-auto p-4 sm:p-6 flex flex-col items-center print:block print:static print:inset-auto print:h-auto print:min-h-0 print:overflow-visible print:p-0 print:bg-white'
      }
    >
      {/* Print Controls Toolbar (Hidden on Paper) */}
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-xl px-4 py-3 mb-4 space-y-2.5 no-print shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-semibold text-slate-800">
            {portalMode ? (
              <span className="inline-flex items-center gap-1.5 text-teal-800">
                <ShieldCheck className="w-4 h-4 text-teal-600" />
                Verified Digital Pathology Report · Soft Copy &amp; A4 PDF Ready
              </span>
            ) : (
              <span>
                Lab Internal Print Mode · Pre-Printed Pad ({topMarginIn}&quot; top / {bottomMarginIn}&quot; bottom blank)
              </span>
            )}
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
            {inlinePageMode && onViewAllArchive && (
              <button
                type="button"
                onClick={onViewAllArchive}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <FolderOpen className="w-4 h-4 text-teal-700" />
                All Reports Archive
              </button>
            )}
            <button
              type="button"
              onClick={handlePrintReport}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap shrink-0"
            >
              {portalMode ? <Download className="w-4 h-4" /> : <Printer className="w-4 h-4" />}
              {portalMode ? 'Download PDF' : 'Print Isolated Test Report'}
            </button>
            {!inlinePageMode && (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <X className="w-4 h-4" />
                Close
              </button>
            )}
          </div>
        </div>

        {/* Isolated Single-Test Switcher when opened from Invoice with multiple tests */}
        {!focusTestId && tests.length > 1 && (
          <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-slate-500 mr-1">
              {portalMode ? 'Select Test Report:' : 'Select Isolated Report to Print:'}
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

      {/* A4 Report Sheet — Compact Sample-Inspired Layout, Sticky Bottom Signatures, Pure Black Ink */}
      <div
        className={`w-full max-w-[210mm] min-h-[295.5mm] flex flex-col justify-between bg-white border border-slate-300 rounded-xl shadow-lg text-black print-pure-black print-a4-page ${
          portalMode ? 'p-5 sm:p-8 print-digital-report' : 'px-6 sm:px-10 py-0 print-report-pad'
        }`}
      >
        {/* TOP + BODY SECTION */}
        <div className="print-report-body">
          {/* Exact blank top clearance for pre-printed offset pad (preserved in print; dashed guide hidden on paper) */}
          {!portalMode && (
            <div
              style={{ height: `${topMarginIn}in` }}
              className="border-b border-dashed border-slate-300 print:border-none flex items-center justify-center text-xs text-slate-400"
            >
              <span className="no-print">
                Blank Header Area ({topMarginIn} inch — Reserved for Pre-Printed Offset Pad)
              </span>
            </div>
          )}

          {/* Full Official Digital Letterhead (Patient Portal / Direct QR Digital PDF Mode only) */}
          {portalMode && (
            <header className="border-b-2 border-black pb-2.5 mb-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <svg
                  width="40"
                  height="40"
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
                  <h1 className="text-xl font-bold text-black tracking-tight leading-tight">
                    {settings.lab_name}
                  </h1>
                  <p className="text-xs text-black">{settings.lab_address}</p>
                  <p className="text-[11px] font-semibold text-black">
                    Department of Pathology &amp; Clinical Diagnostics · Digital Verified Report
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 sm:justify-end">
                <div className="text-right">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-black">
                    Official Test Report
                  </div>
                  <div className="text-[11px] font-mono font-bold tabular-nums text-black">
                    {invoice.invoice_no}
                  </div>
                  <VerificationBarcode code={`${invoice.invoice_no}`} />
                </div>
              </div>
            </header>
          )}

          {/* Compact Rectangular Bordered Patient Info Header + Patient-Specific QR Code (Fixed Standard Size) */}
          <section className="print-row-avoid mt-1 mb-2 border border-black bg-white text-black flex flex-col sm:flex-row print:flex-row items-stretch">
            {/* Left / Main Area: Patient Details */}
            <div className="flex-1 min-w-0 px-3 py-1.5 text-[11px] leading-[1.35]">
              <div className="grid grid-cols-1 sm:grid-cols-12 print:grid-cols-12 gap-x-2.5 gap-y-0.5">
                <div className="sm:col-span-6 print:col-span-6 flex min-w-0">
                  <span className="w-[78px] shrink-0">ID / Inv No</span>
                  <span className="font-mono font-bold tabular-nums truncate">
                    : {invoice.patient_uid} / {invoice.invoice_no}
                  </span>
                </div>
                <div className="sm:col-span-6 print:col-span-6 flex min-w-0">
                  <span className="w-[62px] shrink-0">Date</span>
                  <span className="font-mono tabular-nums truncate">
                    : {formatDateTime(primaryCollectedAt)}
                  </span>
                </div>

                <div className="sm:col-span-6 print:col-span-6 flex min-w-0">
                  <span className="w-[78px] shrink-0">Patient Name</span>
                  <span className="font-bold truncate">: {invoice.patient_name}</span>
                </div>
                <div className="sm:col-span-6 print:col-span-6 flex min-w-0">
                  <span className="w-[62px] shrink-0">Age / Sex</span>
                  <span className="tabular-nums whitespace-nowrap">
                    : {formatAge(invoice.age_years, invoice.age_months, invoice.age_days)} /{' '}
                    {invoice.gender}
                  </span>
                </div>

                <div className="sm:col-span-6 print:col-span-6 flex min-w-0">
                  <span className="w-[78px] shrink-0">Specimen</span>
                  <span className="truncate">: {isolatedTest?.sample_type || '—'}</span>
                </div>
                <div className="sm:col-span-6 print:col-span-6 flex min-w-0">
                  <span className="w-[62px] shrink-0">Reported</span>
                  <span className="font-mono tabular-nums truncate">
                    : {formatDateTime(primaryReportedAt)}
                  </span>
                </div>

                <div className="sm:col-span-8 print:col-span-8 flex min-w-0">
                  <span className="w-[78px] shrink-0">Referred By</span>
                  <span className="font-medium truncate">
                    :{' '}
                    {invoice.doctor_name
                      ? `${invoice.doctor_name}${invoice.doctor_degree ? `, ${invoice.doctor_degree}` : ''}`
                      : 'Self'}
                  </span>
                </div>
                <div className="sm:col-span-4 print:col-span-4 flex min-w-0">
                  <span className="w-[50px] shrink-0">Contact</span>
                  <span className="font-mono tabular-nums truncate">
                    : {invoice.patient_mobile || '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* Right Area: Unique Patient-Specific Scannable QR Code */}
            {qrSvgDataUrl && (
              <div className="shrink-0 border-t sm:border-t-0 sm:border-l print:border-t-0 print:border-l border-black px-2 py-1 flex flex-row sm:flex-col print:flex-col items-center justify-center gap-1.5 sm:gap-0.5 print:gap-0.5 bg-white">
                <img
                  src={qrSvgDataUrl}
                  alt={`Verification QR code for ${invoice.patient_uid}`}
                  className="w-[60px] h-[60px] block"
                />
                <span className="text-[7.5px] font-bold uppercase tracking-tight text-black leading-none text-center whitespace-nowrap">
                  Scan for Report
                </span>
              </div>
            )}
          </section>

          {/* Centered Boxed Department Report Title (Fixed Standard Size) */}
          {isolatedTest && (
            <div className="print-keep-with-next mb-2 flex flex-col items-center">
              <div className="border border-black px-7 py-0.5 bg-white shadow-[2px_2px_0_#000000]">
                <h2 className="text-sm font-bold tracking-wide text-black">
                  {formatDepartmentHeading(isolatedTest.category_name)}
                </h2>
              </div>
              {!activeIsCbc && (
                <div className="mt-1 text-[11px] font-bold text-black">
                  {isolatedTest.test_name}
                </div>
              )}
            </div>
          )}

          {/* Parameter Table (Test-Specific & Dynamic Typography) */}
          <table className="w-full border-collapse print-layout-table text-black">
            <colgroup>
              <col className={isThreeColumnLayout ? 'w-[34%]' : 'w-[32%]'} />
              <col className={isThreeColumnLayout ? 'w-[22%]' : 'w-[20%]'} />
              <col className={isThreeColumnLayout ? 'w-[44%]' : 'w-[34%]'} />
              {!isThreeColumnLayout && <col className="w-[14%]" />}
            </colgroup>

            <thead className="print-spacer-head">
              <tr
                className={`border border-black text-left ${tableTypography.theadClass} italic font-bold text-black bg-white`}
              >
                <th className="py-1 px-2 border-y border-l border-black">Parameter Name</th>
                <th className="py-1 px-2 border-y border-black">Result</th>
                <th
                  className={`py-1 px-2 border-y border-black ${
                    isThreeColumnLayout ? 'border-r' : ''
                  }`}
                >
                  Normal Value
                </th>
                {!isThreeColumnLayout && (
                  <th className="py-1 px-2 border-y border-r border-black text-center">Remark</th>
                )}
              </tr>
            </thead>

            {isolatedTest && (
              <tbody className={`${tableTypography.tbodyClass} text-black`}>
                {activeIsCbc &&
                  (() => {
                    let lastSection: string | undefined;
                    return orderedCbc.map(({ row: r, section }) => {
                      const showSection = Boolean(section && section !== lastSection);
                      if (section) lastSection = section;
                      const isHb =
                        r.parameter_name.toLowerCase().includes('hemoglobin') ||
                        r.parameter_name.toLowerCase() === 'hb';
                      const isEsr = r.parameter_name.toLowerCase().startsWith('esr');

                      return (
                        <React.Fragment key={r.id}>
                          {showSection && (
                            <tr className="print-keep-with-next">
                              <td
                                colSpan={tableColCount}
                                className={`${tableTypography.sectionPadClass} px-2 font-bold italic underline text-black`}
                              >
                                {section}
                              </td>
                            </tr>
                          )}
                          <tr className="print-row-avoid">
                            <td
                              className={`${tableTypography.rowPadClass} px-2 align-top text-black ${
                                isHb ? 'font-bold pt-1.5' : 'font-normal'
                              }`}
                            >
                              {r.parameter_name}
                            </td>
                            <td
                              className={`${tableTypography.rowPadClass} px-2 align-top text-black whitespace-nowrap`}
                            >
                              <span
                                className={`font-mono tabular-nums ${
                                  isHb || isEsr ? 'font-bold' : 'font-semibold'
                                }`}
                              >
                                {formatNumericResultDisplay(r.result_value, r.parameter_name)}
                              </span>
                              {r.result_value && r.unit && (
                                <span className={`ml-1.5 ${tableTypography.unitClass}`}>{r.unit}</span>
                              )}
                            </td>
                            <td
                              className={`${tableTypography.rowPadClass} px-2 align-top font-mono tabular-nums ${tableTypography.normalClass} text-black whitespace-pre-line`}
                            >
                              {r.normal_text || r.reference_range_text || '—'}
                            </td>
                          </tr>
                        </React.Fragment>
                      );
                    });
                  })()}

                {!activeIsCbc &&
                  activeIsUrine &&
                  (() => {
                    let lastSection = '';
                    return (isolatedTest.results || []).map((r) => {
                      const sec = getUrineSection(r.parameter_name);
                      const showSection = sec !== lastSection;
                      lastSection = sec;
                      const isAbn = r.flag && r.flag !== 'Normal' && r.result_value.trim() !== '';

                      return (
                        <React.Fragment key={r.id}>
                          {showSection && (
                            <tr className="print-keep-with-next">
                              <td
                                colSpan={tableColCount}
                                className={`${tableTypography.sectionPadClass} px-2 font-bold italic underline text-black`}
                              >
                                {sec}
                              </td>
                            </tr>
                          )}
                          <tr className="print-row-avoid">
                            <td
                              className={`${tableTypography.rowPadClass} px-2 align-top font-medium text-black`}
                            >
                              {r.parameter_name}
                            </td>
                            <td
                              className={`${tableTypography.rowPadClass} px-2 align-top text-black whitespace-nowrap`}
                            >
                              <span
                                className={`font-mono tabular-nums ${
                                  isAbn ? 'font-bold' : 'font-semibold'
                                }`}
                              >
                                {r.result_value || 'Pending'}
                              </span>
                              {r.result_value && r.unit && (
                                <span className={`ml-1.5 ${tableTypography.unitClass}`}>{r.unit}</span>
                              )}
                            </td>
                            <td
                              className={`${tableTypography.rowPadClass} px-2 align-top font-mono tabular-nums ${tableTypography.normalClass} text-black whitespace-pre-line`}
                            >
                              {r.normal_text || r.reference_range_text || '—'}
                            </td>
                          </tr>
                        </React.Fragment>
                      );
                    });
                  })()}

                {!activeIsCbc &&
                  !activeIsUrine &&
                  (isolatedTest.results || []).map((r) => {
                    const isAbnormal = r.flag && r.flag !== 'Normal' && r.result_value.trim() !== '';
                    return (
                      <tr key={r.id} className="print-row-avoid border-b border-slate-200">
                        <td
                          className={`${tableTypography.rowPadClass} px-2 align-top font-semibold text-black`}
                        >
                          {r.parameter_name}
                        </td>
                        <td
                          className={`${tableTypography.rowPadClass} px-2 align-top text-black whitespace-nowrap`}
                        >
                          <span
                            className={`font-mono tabular-nums ${
                              isAbnormal
                                ? 'font-bold underline decoration-1 underline-offset-2'
                                : 'font-bold'
                            }`}
                          >
                            {r.result_value || 'Pending'}
                          </span>
                          {r.result_value && r.unit && (
                            <span className={`ml-1.5 ${tableTypography.unitClass}`}>{r.unit}</span>
                          )}
                        </td>
                        <td
                          className={`${tableTypography.rowPadClass} px-2 align-top font-mono tabular-nums ${tableTypography.normalClass} text-black whitespace-pre-line`}
                        >
                          {r.reference_range_text || r.normal_text || '—'}
                        </td>
                        <td
                          className={`${tableTypography.rowPadClass} px-2 align-top text-center text-black ${
                            isAbnormal ? 'font-bold' : 'font-normal'
                          }`}
                        >
                          {r.result_value ? (isAbnormal ? r.flag.toUpperCase() : 'Normal') : '—'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            )}
          </table>
        </div>

        {/* STICKY BOTTOM FOOTER SECTION (Always pinned to bottom of A4 page) */}
        <div className="print-report-footer mt-auto pt-4">
          <footer className="grid grid-cols-3 gap-6 items-end text-black">
            {/* 1. Prepared / Tested By */}
            <div className="text-left">
              <div className="h-7" />
              <div className="border-t border-black pt-1">
                <div className="text-[9.5px] font-semibold uppercase tracking-wide text-black">
                  Prepared / Tested By
                </div>
                {resolvedTechName && (
                  <p className="text-[11px] font-bold text-black leading-tight mt-0.5">
                    {resolvedTechName}
                  </p>
                )}
                {resolvedTechTitle && (
                  <p className="text-[10px] text-black leading-tight">{resolvedTechTitle}</p>
                )}
              </div>
            </div>

            {/* 2. Checked By */}
            <div className="text-center">
              <div className="h-7" />
              <div className="border-t border-black pt-1">
                <div className="text-[10.5px] font-bold text-black">Checked by</div>
              </div>
            </div>

            {/* 3. Consultant / Pathologist (Blank signature line when unassigned) */}
            <div className="text-right">
              <div className="h-7" />
              <div className="border-t border-black pt-1 text-left">
                {resolvedConsultantName ? (
                  <>
                    <div className="text-[9.5px] font-semibold uppercase tracking-wide text-black">
                      Consultant / Pathologist
                    </div>
                    <p className="text-[11px] font-bold text-black leading-tight mt-0.5">
                      {resolvedConsultantName}
                    </p>
                    {resolvedConsultantTitle && (
                      <p className="text-[10px] text-black leading-tight">
                        {resolvedConsultantTitle}
                      </p>
                    )}
                  </>
                ) : (
                  <div className="h-6" aria-label="Blank Consultant / Pathologist Signature Line" />
                )}
              </div>
            </div>
          </footer>

          {portalMode ? (
            <div className="mt-2 pt-1.5 border-t border-black flex flex-col sm:flex-row items-center justify-between gap-2 text-[9px] text-black">
              <span>
                Online Report Portal:{' '}
                <span className="font-mono font-semibold">{portalWebsiteUrl}</span>
              </span>
              <span className="font-mono tabular-nums">
                Verification ID: {invoice.invoice_no}-{invoice.patient_uid}
              </span>
            </div>
          ) : (
            <div className="mt-1.5 pt-1 border-t border-black/30 flex items-center justify-between gap-2 text-[9px] text-black">
              <span>
                Online Report Portal:{' '}
                <span className="font-mono font-semibold">{portalWebsiteUrl}</span>
              </span>
              <span>Scan QR code above for instant PDF report</span>
            </div>
          )}

          {/* Exact blank bottom clearance for pre-printed offset pad */}
          {!portalMode && (
            <div
              style={{ height: `${bottomMarginIn}in` }}
              className="mt-1.5 border-t border-dashed border-slate-300 print:border-none flex items-center justify-center text-[11px] text-slate-400"
            >
              <span className="no-print">
                Blank Footer Area ({bottomMarginIn} inch — Reserved for Pre-Printed Offset Pad)
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
