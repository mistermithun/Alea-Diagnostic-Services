import React, { useEffect, useMemo, useState } from 'react';
import { Check, Download, FolderOpen, Layers, Printer, ShieldCheck, X } from 'lucide-react';
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
  return n.includes('urine r/e') || n.includes('urine routine') || n.includes('urine r/m/e');
}

function isSemenAnalysisTest(test: InvoiceTestItem): boolean {
  const n = test.test_name.toLowerCase();
  return n.includes('semen');
}

function isStoolReTest(test: InvoiceTestItem): boolean {
  const n = test.test_name.toLowerCase();
  return n.includes('stool');
}

function isLargeIntactPanel(test: InvoiceTestItem): boolean {
  return (
    isCbcTest(test) ||
    isUrineReTest(test) ||
    isSemenAnalysisTest(test) ||
    isStoolReTest(test)
  );
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
  const [selectedTestIds, setSelectedTestIds] = useState<number[]>([]);
  const [blankConsultantOverride, setBlankConsultantOverride] = useState<boolean>(false);
  const [qrSvgDataUrl, setQrSvgDataUrl] = useState<string>('');
  const portalWebsiteUrl = resolvePublicBaseUrl(publicBaseUrl);

  const topMarginIn = Math.max(0, Number(settings.pad_header_margin_in || 1.5) || 1.5);
  const bottomMarginIn = Math.max(0, Number(settings.pad_footer_margin_in || 0.4) || 0.4);

  useEffect(() => {
    if (!data) {
      setSelectedTestIds([]);
      setBlankConsultantOverride(false);
      return;
    }
    if (focusTestId && data.tests.some((t) => t.id === focusTestId)) {
      setSelectedTestIds([focusTestId]);
    } else {
      setSelectedTestIds(data.tests.map((t) => t.id));
    }
    setBlankConsultantOverride(false);
  }, [data, focusTestId]);

  const selectedTests = useMemo<InvoiceTestItem[]>(() => {
    if (!data) return [];
    const idSet = new Set(selectedTestIds);
    const matched = data.tests.filter((t) => idSet.has(t.id));
    return matched.length > 0 ? matched : data.tests.slice(0, 1);
  }, [data, selectedTestIds]);

  const qrTestId = selectedTests.length === 1 ? selectedTests[0]?.id : undefined;

  useEffect(() => {
    const qrToken = data?.invoice?.patient_qr_token;
    const uid = data?.invoice?.patient_uid;
    const invId = data?.invoice?.id;
    if (!data || !qrToken || !invId) {
      setQrSvgDataUrl('');
      return;
    }

    const reportUrl = buildPatientReportQrUrl(qrToken, uid, invId, qrTestId, publicBaseUrl);
    QRCode.toDataURL(reportUrl, {
      width: 160,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => setQrSvgDataUrl(url))
      .catch(() => setQrSvgDataUrl(''));
  }, [data, qrTestId, publicBaseUrl]);

  // Group selected tests by department preserving test appearance order
  const departmentGroups = useMemo(() => {
    const groups: Array<{
      categoryName: string;
      departmentHeading: string;
      tests: InvoiceTestItem[];
    }> = [];
    const indexMap = new Map<string, number>();
    for (const test of selectedTests) {
      const cat = (test.category_name || 'Pathology').trim();
      const key = cat.toLowerCase();
      const existingIdx = indexMap.get(key);
      if (existingIdx !== undefined) {
        groups[existingIdx].tests.push(test);
      } else {
        indexMap.set(key, groups.length);
        groups.push({
          categoryName: cat,
          departmentHeading: formatDepartmentHeading(cat),
          tests: [test],
        });
      }
    }
    return groups;
  }, [selectedTests]);

  if (!data) return null;

  const { invoice, tests } = data;
  const readyTests = tests.filter((t) => t.status === 'Ready');

  const toggleTestSelection = (testId: number) => {
    setSelectedTestIds((prev) => {
      if (prev.includes(testId)) {
        // Keep at least 1 test selected so the A4 preview never goes blank
        if (prev.length <= 1) return prev;
        return prev.filter((id) => id !== testId);
      }
      return [...prev, testId];
    });
  };

  // Combined Specimen, Collection Date, and Report Date across selected tests
  const combinedSpecimens = Array.from(
    new Set(selectedTests.map((t) => (t.sample_type || '').trim()).filter(Boolean))
  ).join(', ');

  const primaryCollectedAt =
    selectedTests
      .map((t) => t.collected_at)
      .filter(Boolean)
      .sort()[0] || invoice.created_at;

  const primaryReportedAt =
    selectedTests
      .map((t) => t.ready_at || t.verified_at || '')
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || new Date().toISOString();

  // Prepared / Tested By (Technologist with full academic qualification & designation)
  const techRaw =
    selectedTests.map((t) => (t.verified_by || '').trim()).find(Boolean) || '';
  const techDefaultName = (settings.technologist_name || '').trim();
  const resolvedTechName =
    techRaw && techDefaultName && techDefaultName.toLowerCase().startsWith(techRaw.toLowerCase())
      ? techDefaultName
      : techRaw || techDefaultName;
  const resolvedTechTitle = (settings.technologist_title || 'Medical Technologist (Lab)').trim();

  // Consultant / Pathologist with Conditional Rule
  const assignedConsultantTest = selectedTests.find(
    (t) => (t.consultant_name || '').trim() !== '' && t.consultant_name !== '__BLANK__'
  );
  const allExplicitBlank =
    selectedTests.length > 0 &&
    selectedTests.every((t) => (t.consultant_name || '').trim() === '__BLANK__');

  const testConsultantName = (assignedConsultantTest?.consultant_name || '').trim();
  const testConsultantTitle = (assignedConsultantTest?.consultant_title || '').trim();
  const settingsPathologistName = (settings.pathologist_name || '').trim();
  const settingsPathologistTitle = (settings.pathologist_title || '').trim();
  const referralDocName = (invoice.doctor_name || '').trim();
  const hasRealReferralDoc =
    Boolean(referralDocName) && !referralDocName.toLowerCase().includes('self');

  let resolvedConsultantName = '';
  let resolvedConsultantTitle = '';

  if (!blankConsultantOverride && !allExplicitBlank) {
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

  // Dynamic parameter table typography tuned across all combined tests on the report
  const tableTypography = (() => {
    const hasSpecialDenseTest = selectedTests.some((t) => isLargeIntactPanel(t));
    if (hasSpecialDenseTest && selectedTests.length === 1) {
      const onlyCbc = isCbcTest(selectedTests[0]);
      return onlyCbc
        ? {
            theadClass: 'text-[10.5px]',
            tbodyClass: 'text-[12px] leading-[1.32]',
            unitClass: 'text-[11px]',
            normalClass: 'text-[11px] leading-[1.26]',
            rowPadClass: 'py-[3px]',
            sectionPadClass: 'pt-2 pb-0.5',
          }
        : {
            theadClass: 'text-[10.5px]',
            tbodyClass: 'text-[12px] leading-[1.28]',
            unitClass: 'text-[11px]',
            normalClass: 'text-[11px] leading-[1.24]',
            rowPadClass: 'py-[2.5px]',
            sectionPadClass: 'pt-1.5 pb-0.5',
          };
    }

    const totalParamRows = selectedTests.reduce((acc, t) => acc + (t.results?.length || 0), 0);
    const totalSubHeaders = selectedTests.length > 1 ? selectedTests.length : 0;
    const extraRangeLines = selectedTests.reduce((acc, t) => {
      return (
        acc +
        (t.results || []).reduce((rAcc, row) => {
          const refText = (row.reference_range_text || row.normal_text || '').trim();
          if (!refText) return rAcc;
          const explicitLines = refText.split('\n').length - 1;
          const wrapEstimate = refText.length > 42 ? 1 : 0;
          return rAcc + Math.max(explicitLines, wrapEstimate);
        }, 0)
      );
    }, 0);

    const effectiveUnits = totalParamRows + totalSubHeaders * 0.75 + extraRangeLines * 0.55;

    if (effectiveUnits <= 5 && !hasSpecialDenseTest) {
      return {
        theadClass: 'text-[11px]',
        tbodyClass: 'text-[13px] leading-[1.42]',
        unitClass: 'text-[12px]',
        normalClass: 'text-[12px] leading-[1.35]',
        rowPadClass: effectiveUnits <= 2 ? 'py-2.5' : 'py-2',
        sectionPadClass: 'pt-1.5 pb-0.5',
      };
    }
    if (effectiveUnits <= 11 && !hasSpecialDenseTest) {
      return {
        theadClass: 'text-[11px]',
        tbodyClass: 'text-[12.5px] leading-[1.36]',
        unitClass: 'text-[11.5px]',
        normalClass: 'text-[11.5px] leading-[1.3]',
        rowPadClass: 'py-1.5',
        sectionPadClass: 'pt-1.5 pb-0.5',
      };
    }
    return {
      theadClass: 'text-[10.5px]',
      tbodyClass: 'text-[11.5px] leading-[1.3]',
      unitClass: 'text-[10.5px]',
      normalClass: 'text-[10.5px] leading-[1.24]',
      rowPadClass: 'py-[3px]',
      sectionPadClass: 'pt-1.5 pb-0.5',
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

  /**
   * Build discrete print-shell <tbody> segments inside a department:
   * - Large intact panels (CBC, Urine R/E, Semen Analysis, Stool R/E) are NEVER batched with other tests
   *   and get their own atomic `keepIntact: true` block so they NEVER break mid-test across A4 pages.
   * - Consecutive compact standard 4-col tests in the same department batch smoothly onto one page.
   */
  const buildDepartmentSegments = (deptTests: InvoiceTestItem[]) => {
    const segments: Array<
      | { kind: 'cbc'; test: InvoiceTestItem; keepIntact: boolean }
      | { kind: 'urine'; test: InvoiceTestItem; keepIntact: boolean }
      | { kind: 'standard'; tests: InvoiceTestItem[]; keepIntact: boolean }
    > = [];

    for (const test of deptTests) {
      if (isCbcTest(test)) {
        segments.push({ kind: 'cbc', test, keepIntact: true });
      } else if (isUrineReTest(test)) {
        segments.push({ kind: 'urine', test, keepIntact: true });
      } else if (isSemenAnalysisTest(test) || isStoolReTest(test)) {
        segments.push({ kind: 'standard', tests: [test], keepIntact: true });
      } else {
        const last = segments[segments.length - 1];
        if (last && last.kind === 'standard' && !last.keepIntact) {
          last.tests.push(test);
        } else {
          segments.push({ kind: 'standard', tests: [test], keepIntact: false });
        }
      }
    }
    return segments;
  };

  // Reserve exact vertical clearance at bottom of EVERY printed page so overflowing tables break cleanly above fixed footer
  const printFooterReserveHeight = portalMode
    ? 'calc(1.06in + 8mm)'
    : `calc(1.02in + ${bottomMarginIn}in)`;

  return (
    <div
      className={
        inlinePageMode
          ? 'w-full min-h-screen bg-white flex flex-col items-center px-3 py-4 sm:p-6 print:block print:min-h-0 print:p-0 print:bg-white'
          : 'fixed inset-0 z-50 bg-white overflow-y-auto px-3 py-4 sm:p-6 flex flex-col items-center print:block print:static print:inset-auto print:h-auto print:min-h-0 print:overflow-visible print:p-0 print:bg-white'
      }
    >
      {/* Print Controls Toolbar (Hidden on Paper) */}
      <div className="w-full max-w-4xl bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 mb-4 space-y-2.5 no-print">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-semibold text-slate-800">
            {portalMode ? (
              <span className="inline-flex items-center gap-1.5 text-teal-800">
                <ShieldCheck className="w-4 h-4 text-teal-600" />
                Verified Digital Pathology Report · Smart Multi-Test A4 PDF Ready
              </span>
            ) : (
              <span>
                Smart A4 Combined Print · Pre-Printed Pad ({topMarginIn}&quot; top / {bottomMarginIn}&quot; bottom blank)
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
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                }`}
              >
                {blankConsultantOverride ? 'Doctor Sign: Blank Line' : 'Doctor Sign: Assigned / Auto'}
              </button>
            )}
            {inlinePageMode && onViewAllArchive && (
              <button
                type="button"
                onClick={onViewAllArchive}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
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
              {portalMode
                ? 'Download PDF'
                : selectedTests.length > 1
                ? `Print Combined Report (${selectedTests.length} Tests)`
                : 'Print Report'}
            </button>
            {!inlinePageMode && (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
              >
                <X className="w-4 h-4" />
                Close
              </button>
            )}
          </div>
        </div>

        {/* Dynamic Multi-Test Inclusion Selector when Invoice has Multiple Tests */}
        {tests.length > 1 && (
          <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600 mr-1">
              <Layers className="w-3.5 h-3.5 text-teal-700" />
              Tests on Report ({selectedTests.length}/{tests.length}):
            </span>

            <button
              type="button"
              onClick={() => setSelectedTestIds(tests.map((t) => t.id))}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap ${
                selectedTests.length === tests.length
                  ? 'bg-teal-700 text-white border-teal-700'
                  : 'bg-white text-teal-800 border-teal-300 hover:bg-teal-50'
              }`}
            >
              All Combined ({tests.length})
            </button>

            {readyTests.length > 0 && readyTests.length < tests.length && (
              <button
                type="button"
                onClick={() => setSelectedTestIds(readyTests.map((t) => t.id))}
                className="px-2.5 py-1 text-xs font-medium rounded-md border bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100 whitespace-nowrap"
              >
                Ready Only ({readyTests.length})
              </button>
            )}

            <span className="h-4 w-px bg-slate-200 mx-0.5" aria-hidden="true" />

            {tests.map((t) => {
              const checked = selectedTests.some((s) => s.id === t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleTestSelection(t.id)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                    checked
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  {checked && <Check className="w-3 h-3 shrink-0" />}
                  <span>{t.test_name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Clean White A4 Report Sheet — Repeating Patient Header on Every Page, Intact Large Test Blocks, Swapped Footer */}
      <div
        className={`w-full max-w-[210mm] min-h-0 sm:min-h-[295.5mm] flex flex-col justify-between bg-white border border-slate-200 sm:rounded-lg shadow-none text-black print-pure-black print-a4-page ${
          portalMode ? 'p-4 sm:p-8 print-digital-report' : 'px-4 sm:px-10 py-0 print-report-pad'
        }`}
      >
        {/* Outer Table Shell: guarantees <thead> (Pad Header + Patient Header + QR) and <tfoot> (Bottom Clearance Spacer) repeat on EVERY printed A4 page */}
        <table className="print-shell-table w-full border-collapse">
          <thead className="print-shell-head">
            <tr>
              <td className="p-0 align-top">
                {/* Exact blank top clearance for pre-printed offset pad (repeats on every printed page) */}
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

                {/* Modern Borderless Two-Column Patient Info Header + Far-Right Dynamic QR Code (Repeats on EVERY Printed Page) */}
                <section className="mt-1 mb-2.5 pb-2 border-b border-slate-300 print:border-black/35 bg-white text-black flex flex-col sm:flex-row print:flex-row items-start sm:items-center print:items-center justify-between gap-3 sm:gap-4 print:gap-3.5">
                  <div className="flex-1 min-w-0 w-full grid grid-cols-1 sm:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] print:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] gap-x-5 print:gap-x-4 gap-y-1.5 text-[11px] leading-[1.35]">
                    {/* Left Column: Patient Name, Age/Sex, ID/Invoice No, Specimen */}
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="w-[66px] shrink-0 text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">
                          Patient
                        </span>
                        <span className="min-w-0 flex-1 text-[13.5px] font-bold tracking-tight text-black leading-[1.2] whitespace-normal break-words">
                          {invoice.patient_name}
                        </span>
                      </div>

                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="w-[66px] shrink-0 text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">
                          Age / Sex
                        </span>
                        <span className="min-w-0 flex-1 font-semibold tabular-nums text-black whitespace-normal">
                          {formatAge(invoice.age_years, invoice.age_months, invoice.age_days)} /{' '}
                          {invoice.gender}
                        </span>
                      </div>

                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="w-[66px] shrink-0 text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">
                          ID / Inv No
                        </span>
                        <span className="min-w-0 flex-1 font-mono font-bold tabular-nums text-black whitespace-normal break-all">
                          {invoice.patient_uid} / {invoice.invoice_no}
                        </span>
                      </div>

                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="w-[66px] shrink-0 text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">
                          Specimen
                        </span>
                        <span className="min-w-0 flex-1 font-medium text-black whitespace-normal break-words">
                          {combinedSpecimens || '—'}
                        </span>
                      </div>
                    </div>

                    {/* Right Column: Registration/Report Date, Referring Doctor, Contact */}
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="w-[72px] shrink-0 text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">
                          Reg. Date
                        </span>
                        <span className="min-w-0 flex-1 font-mono font-medium tabular-nums text-black whitespace-nowrap">
                          {formatDateTime(primaryCollectedAt)}
                        </span>
                      </div>

                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="w-[72px] shrink-0 text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">
                          Report Date
                        </span>
                        <span className="min-w-0 flex-1 font-mono font-medium tabular-nums text-black whitespace-nowrap">
                          {formatDateTime(primaryReportedAt)}
                        </span>
                      </div>

                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="w-[72px] shrink-0 text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">
                          Referred By
                        </span>
                        <span className="min-w-0 flex-1 font-medium text-black whitespace-normal break-words leading-[1.3]">
                          {invoice.doctor_name
                            ? `${invoice.doctor_name}${invoice.doctor_degree ? `, ${invoice.doctor_degree}` : ''}`
                            : 'Self'}
                        </span>
                      </div>

                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="w-[72px] shrink-0 text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">
                          Contact
                        </span>
                        <span className="min-w-0 flex-1 font-mono font-medium tabular-nums text-black whitespace-normal break-words">
                          {invoice.patient_mobile || '—'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Far Right Area: Cleanly Padded Patient-Specific Scannable QR Code */}
                  {qrSvgDataUrl && (
                    <div className="shrink-0 pt-1 sm:pt-0 sm:pl-2 print:pt-0 print:pl-2 flex flex-row sm:flex-col print:flex-col items-center justify-center gap-2 sm:gap-1 print:gap-1">
                      <div className="p-1.5 rounded-md border border-slate-200 print:border-black/25 bg-white">
                        <img
                          src={qrSvgDataUrl}
                          alt={`Verification QR code for ${invoice.patient_uid}`}
                          className="w-[62px] h-[62px] block"
                        />
                      </div>
                      <span className="text-[7.5px] font-bold uppercase tracking-wider text-slate-600 leading-none text-center whitespace-nowrap">
                        Scan for Report
                      </span>
                    </div>
                  )}
                </section>
              </td>
            </tr>
          </thead>

          {/* DISCRETE DEPARTMENT & TEST TBODY BLOCKS:
              Native table-row/tbody breaks allow <thead> Patient Header to repeat cleanly on EVERY page,
              while keepIntact prevents CBC, Urine R/E, Semen Analysis, and Stool R/E from splitting mid-test. */}
          {departmentGroups.map((dept) => {
            const segments = buildDepartmentSegments(dept.tests);
            const isSingleStandardTestInReport =
              selectedTests.length === 1 &&
              segments.length === 1 &&
              segments[0].kind === 'standard';

            return segments.map((seg, segIdx) => {
              const showDeptHeaderInBlock = segIdx === 0;
              const useAtomicBlock = seg.keepIntact;

              return (
                <tbody
                  key={`${dept.categoryName}-seg-${segIdx}`}
                  className={
                    useAtomicBlock
                      ? 'print-report-body print-keep-intact'
                      : 'print-report-body print-flow-group'
                  }
                >
                  <tr className={useAtomicBlock ? 'print-row-avoid' : undefined}>
                    <td className="p-0 pb-3 align-top">
                      {/* Centered Boxed Department Heading bound directly with its first test block */}
                      {showDeptHeaderInBlock && (
                        <div className="print-keep-with-next mb-2 flex flex-col items-center">
                          <div className="border border-black px-7 py-0.5 bg-white shadow-[2px_2px_0_#000000]">
                            <h2 className="text-sm font-bold tracking-wide text-black">
                              {dept.departmentHeading}
                            </h2>
                          </div>
                          {isSingleStandardTestInReport && (
                            <div className="mt-1 text-[11px] font-bold text-black">
                              {dept.tests[0].test_name}
                            </div>
                          )}
                        </div>
                      )}

                      {seg.kind === 'cbc' &&
                        (() => {
                          const orderedCbc = getOrderedCbcRows(seg.test.results || []);
                          let lastSection: string | undefined;

                          return (
                            <table className="w-full border-collapse font-sans text-black">
                              <colgroup>
                                <col className="w-[34%]" />
                                <col className="w-[22%]" />
                                <col className="w-[44%]" />
                              </colgroup>
                              <thead>
                                <tr
                                  className={`border border-[#e0e0e0] bg-slate-50 print:bg-[#f8fafc] text-left ${tableTypography.theadClass} font-semibold uppercase tracking-wider text-slate-600`}
                                >
                                  <th className="py-1.5 px-2.5 border-y border-l border-[#e0e0e0]">
                                    Parameter Name
                                  </th>
                                  <th className="py-1.5 px-2.5 border-y border-[#e0e0e0]">Result</th>
                                  <th className="py-1.5 px-2.5 border-y border-r border-[#e0e0e0]">
                                    Normal Value
                                  </th>
                                </tr>
                              </thead>
                              <tbody className={`${tableTypography.tbodyClass} font-sans text-black`}>
                                {dept.tests.length > 1 && (
                                  <tr className="print-keep-with-next border-b border-[#d8dee6] bg-slate-50/80 print:bg-[#f8fafc]">
                                    <td
                                      colSpan={3}
                                      className="py-1 px-2.5 text-[11px] font-bold text-black"
                                    >
                                      {seg.test.test_name}
                                    </td>
                                  </tr>
                                )}
                                {orderedCbc.map(({ row: r, section }) => {
                                  const showSection = Boolean(section && section !== lastSection);
                                  if (section) lastSection = section;
                                  const isHb =
                                    r.parameter_name.toLowerCase().includes('hemoglobin') ||
                                    r.parameter_name.toLowerCase() === 'hb';
                                  const isEsr = r.parameter_name.toLowerCase().startsWith('esr');

                                  return (
                                    <React.Fragment key={r.id}>
                                      {showSection && (
                                        <tr className="print-keep-with-next border-b border-[#d8dee6] bg-slate-50/50 print:bg-[#fafbfc]">
                                          <td
                                            colSpan={3}
                                            className={`${tableTypography.sectionPadClass} px-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-600`}
                                          >
                                            {section}
                                          </td>
                                        </tr>
                                      )}
                                      <tr className="print-row-avoid border-b border-[#e8ecf0]">
                                        <td
                                          className={`${tableTypography.rowPadClass} px-2.5 align-top text-black ${
                                            isHb ? 'font-bold pt-1.5' : 'font-medium'
                                          }`}
                                        >
                                          {r.parameter_name}
                                        </td>
                                        <td
                                          className={`${tableTypography.rowPadClass} px-2.5 align-top text-black whitespace-nowrap`}
                                        >
                                          <span
                                            className={`tabular-nums ${
                                              isHb || isEsr ? 'font-bold' : 'font-semibold'
                                            }`}
                                          >
                                            {formatNumericResultDisplay(r.result_value, r.parameter_name)}
                                          </span>
                                          {r.result_value && r.unit && (
                                            <span
                                              className={`ml-1.5 font-normal text-slate-600 ${tableTypography.unitClass}`}
                                            >
                                              {r.unit}
                                            </span>
                                          )}
                                        </td>
                                        <td
                                          className={`${tableTypography.rowPadClass} px-2.5 align-top tabular-nums font-normal ${tableTypography.normalClass} text-slate-700 whitespace-pre-line`}
                                        >
                                          {r.normal_text || r.reference_range_text || '—'}
                                        </td>
                                      </tr>
                                    </React.Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          );
                        })()}

                      {seg.kind === 'urine' &&
                        (() => {
                          let lastSection = '';
                          return (
                            <table className="w-full border-collapse font-sans text-black">
                              <colgroup>
                                <col className="w-[34%]" />
                                <col className="w-[22%]" />
                                <col className="w-[44%]" />
                              </colgroup>
                              <thead>
                                <tr
                                  className={`border border-[#e0e0e0] bg-slate-50 print:bg-[#f8fafc] text-left ${tableTypography.theadClass} font-semibold uppercase tracking-wider text-slate-600`}
                                >
                                  <th className="py-1.5 px-2.5 border-y border-l border-[#e0e0e0]">
                                    Parameter Name
                                  </th>
                                  <th className="py-1.5 px-2.5 border-y border-[#e0e0e0]">Result</th>
                                  <th className="py-1.5 px-2.5 border-y border-r border-[#e0e0e0]">
                                    Normal Value
                                  </th>
                                </tr>
                              </thead>
                              <tbody className={`${tableTypography.tbodyClass} font-sans text-black`}>
                                {dept.tests.length > 1 && (
                                  <tr className="print-keep-with-next border-b border-[#d8dee6] bg-slate-50/80 print:bg-[#f8fafc]">
                                    <td
                                      colSpan={3}
                                      className="py-1 px-2.5 text-[11px] font-bold text-black"
                                    >
                                      {seg.test.test_name}
                                    </td>
                                  </tr>
                                )}
                                {(seg.test.results || []).map((r) => {
                                  const sec = getUrineSection(r.parameter_name);
                                  const showSection = sec !== lastSection;
                                  lastSection = sec;
                                  const isAbn = r.flag && r.flag !== 'Normal' && r.result_value.trim() !== '';

                                  return (
                                    <React.Fragment key={r.id}>
                                      {showSection && (
                                        <tr className="print-keep-with-next border-b border-[#d8dee6] bg-slate-50/50 print:bg-[#fafbfc]">
                                          <td
                                            colSpan={3}
                                            className={`${tableTypography.sectionPadClass} px-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-600`}
                                          >
                                            {sec}
                                          </td>
                                        </tr>
                                      )}
                                      <tr className="print-row-avoid border-b border-[#e8ecf0]">
                                        <td
                                          className={`${tableTypography.rowPadClass} px-2.5 align-top font-medium text-black`}
                                        >
                                          {r.parameter_name}
                                        </td>
                                        <td
                                          className={`${tableTypography.rowPadClass} px-2.5 align-top text-black whitespace-nowrap`}
                                        >
                                          <span
                                            className={`tabular-nums ${isAbn ? 'font-bold' : 'font-semibold'}`}
                                          >
                                            {r.result_value || 'Pending'}
                                          </span>
                                          {r.result_value && r.unit && (
                                            <span
                                              className={`ml-1.5 font-normal text-slate-600 ${tableTypography.unitClass}`}
                                            >
                                              {r.unit}
                                            </span>
                                          )}
                                        </td>
                                        <td
                                          className={`${tableTypography.rowPadClass} px-2.5 align-top tabular-nums font-normal ${tableTypography.normalClass} text-slate-700 whitespace-pre-line`}
                                        >
                                          {r.normal_text || r.reference_range_text || '—'}
                                        </td>
                                      </tr>
                                    </React.Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          );
                        })()}

                      {seg.kind === 'standard' && (
                        <table
                          className={`w-full border-collapse font-sans text-black ${
                            useAtomicBlock ? '' : 'print-layout-table'
                          }`}
                        >
                          <colgroup>
                            <col className="w-[32%]" />
                            <col className="w-[20%]" />
                            <col className="w-[34%]" />
                            <col className="w-[14%]" />
                          </colgroup>
                          <thead className={useAtomicBlock ? undefined : 'print-spacer-head'}>
                            <tr
                              className={`border border-[#e0e0e0] bg-slate-50 print:bg-[#f8fafc] text-left ${tableTypography.theadClass} font-semibold uppercase tracking-wider text-slate-600`}
                            >
                              <th className="py-1.5 px-2.5 border-y border-l border-[#e0e0e0]">
                                Parameter Name
                              </th>
                              <th className="py-1.5 px-2.5 border-y border-[#e0e0e0]">Result</th>
                              <th className="py-1.5 px-2.5 border-y border-[#e0e0e0]">
                                Normal Value
                              </th>
                              <th className="py-1.5 px-2.5 border-y border-r border-[#e0e0e0] text-center">
                                Remark
                              </th>
                            </tr>
                          </thead>

                          {seg.tests.map((test) => {
                            const rows = test.results || [];
                            const showSubHeading = !isSingleStandardTestInReport;
                            return (
                              <tbody
                                key={test.id}
                                className={`${tableTypography.tbodyClass} font-sans text-black ${
                                  useAtomicBlock || rows.length <= 6 ? 'print-row-avoid' : ''
                                }`}
                              >
                                {showSubHeading && (
                                  <tr className="print-keep-with-next border-b border-[#d8dee6] bg-slate-50/70 print:bg-[#f8fafc]">
                                    <td
                                      colSpan={4}
                                      className="py-1 px-2.5 text-[11px] font-bold tracking-tight text-black"
                                    >
                                      {test.test_name}
                                    </td>
                                  </tr>
                                )}
                                {rows.map((r) => {
                                  const isAbnormal =
                                    r.flag && r.flag !== 'Normal' && r.result_value.trim() !== '';
                                  return (
                                    <tr
                                      key={r.id}
                                      className="print-row-avoid border-b border-[#e8ecf0]"
                                    >
                                      <td
                                        className={`${tableTypography.rowPadClass} px-2.5 align-top font-medium text-black`}
                                      >
                                        {r.parameter_name}
                                      </td>
                                      <td
                                        className={`${tableTypography.rowPadClass} px-2.5 align-top text-black whitespace-nowrap`}
                                      >
                                        <span
                                          className={`tabular-nums ${
                                            isAbnormal
                                              ? 'font-bold underline decoration-1 underline-offset-2'
                                              : 'font-semibold'
                                          }`}
                                        >
                                          {r.result_value || 'Pending'}
                                        </span>
                                        {r.result_value && r.unit && (
                                          <span
                                            className={`ml-1.5 font-normal text-slate-600 ${tableTypography.unitClass}`}
                                          >
                                            {r.unit}
                                          </span>
                                        )}
                                      </td>
                                      <td
                                        className={`${tableTypography.rowPadClass} px-2.5 align-top tabular-nums font-normal ${tableTypography.normalClass} text-slate-700 whitespace-pre-line`}
                                      >
                                        {r.reference_range_text || r.normal_text || '—'}
                                      </td>
                                      <td
                                        className={`${tableTypography.rowPadClass} px-2.5 align-top text-center ${
                                          isAbnormal
                                            ? 'font-bold text-black'
                                            : 'font-medium text-slate-700'
                                        }`}
                                      >
                                        {r.result_value
                                          ? isAbnormal
                                            ? r.flag.toUpperCase()
                                            : 'Normal'
                                          : '—'}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            );
                          })}
                        </table>
                      )}
                    </td>
                  </tr>
                </tbody>
              );
            });
          })}

          {/* Invisible Bottom Spacer repeated on EVERY printed page so overflowing tables break BEFORE the fixed signature footer */}
          <tfoot className="print-shell-foot hidden print:table-footer-group">
            <tr aria-hidden="true">
              <td className="p-0">
                <div style={{ height: printFooterReserveHeight }} />
              </td>
            </tr>
          </tfoot>
        </table>

        {/* SWAPPED BOTTOM SIGNATURE FOOTER — Pinned cleanly to the bottom of EVERY printed A4 page */}
        <div className="print-report-footer print-fixed-footer mt-auto pt-3">
          <footer className="grid grid-cols-3 gap-6 items-end text-black">
            {/* 1. LEFT: Doctor / Consultant Pathologist Designation & Signature Area */}
            <div className="text-left">
              <div className="h-6" />
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

            {/* 2. CENTER: Checked By */}
            <div className="text-center">
              <div className="h-6" />
              <div className="border-t border-black pt-1">
                <div className="text-[10.5px] font-bold text-black">Checked by</div>
              </div>
            </div>

            {/* 3. RIGHT: Technologist Designation & Signature Area */}
            <div className="text-right">
              <div className="h-6" />
              <div className="border-t border-black pt-1 text-right">
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
