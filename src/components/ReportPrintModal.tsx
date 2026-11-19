import React, { useEffect, useMemo, useState } from 'react';
import { Check, Download, FolderOpen, Layers, Printer, ShieldCheck, X } from 'lucide-react';
import QRCode from 'qrcode';
import {
  buildPatientReportQrUrl,
  formatAge,
  formatDateTime,
  getBangladeshNowIso,
  resolvePublicBaseUrl,
} from '../lib/api.ts';
import {
  deduplicateTestResults,
  formatNumericResultDisplay,
  getCanonicalParameterKey,
  getOrderedCbcRows,
  getOrderedUrineRows,
  getPageTypographyProfile,
  planReportPages,
  resolveReportSignatures,
  type ReportPagePlan,
} from '../lib/reportLayout.ts';
import { exportDiagnosticReportPdf } from '../lib/reportPdf.ts';
import type { FullInvoice, InvoiceTestItem, LabSettings } from '../types.ts';
import { BrandLogo } from './BrandLogo.tsx';

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
  const [exportingPdf, setExportingPdf] = useState<boolean>(false);
  const [pdfNotice, setPdfNotice] = useState<string>('');
  const portalWebsiteUrl = resolvePublicBaseUrl(publicBaseUrl);

  const topMarginIn = Math.max(0, Number(settings.pad_header_margin_in || 1.5) || 1.5);
  const bottomMarginIn = Math.max(0, Number(settings.pad_footer_margin_in || 0.4) || 0.4);

  useEffect(() => {
    setPdfNotice('');
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
    return data.tests.filter((t) => idSet.has(t.id));
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

  // Continuous-flow A4 page planner: flows small/medium tests naturally onto the same page
  // and moves to a fresh page only when vertical space is exceeded
  const plannedPages = useMemo<ReportPagePlan[]>(
    () =>
      planReportPages(selectedTests, {
        topMarginIn,
        bottomMarginIn,
        portalMode,
      }),
    [selectedTests, topMarginIn, bottomMarginIn, portalMode]
  );

  if (!data) return null;

  const { invoice, tests } = data;
  const readyTests = tests.filter((t) => t.status === 'Ready');

  const toggleTestSelection = (testId: number) => {
    setSelectedTestIds((prev) =>
      prev.includes(testId) ? prev.filter((id) => id !== testId) : [...prev, testId]
    );
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
      .slice(-1)[0] || getBangladeshNowIso();

  // Resolved Consultant & Technologist signatures (consistent across Print, Finalized Report & PDF Export)
  const resolvedSignatures = resolveReportSignatures({
    selectedTests,
    invoice,
    settings,
    blankConsultantOverride,
  });
  const {
    resolvedConsultantName,
    resolvedConsultantTitle,
    resolvedTechName,
    resolvedTechTitle,
  } = resolvedSignatures;

  // Unified page typography profile synchronized with jsPDF & print pagination
  const getPageTypography = (plan: ReportPagePlan) => getPageTypographyProfile(plan.blocks);

  const handlePrintReport = () => {
    if (selectedTests.length === 0) return;
    const prevTitle = document.title;
    const safeName = (invoice.patient_name || 'Patient').replace(/[^a-zA-Z0-9_-]+/g, '_');
    document.title = `${invoice.invoice_no}_${safeName}_Report`;
    window.print();
    setTimeout(() => {
      document.title = prevTitle;
    }, 1000);
  };

  const handleDownloadPdf = async () => {
    if (selectedTests.length === 0) {
      setPdfNotice('Please select at least one test to download the PDF report.');
      return;
    }
    setExportingPdf(true);
    setPdfNotice('');
    try {
      const savedName = await exportDiagnosticReportPdf({
        invoice,
        selectedTests,
        settings,
        portalMode,
        topMarginIn,
        bottomMarginIn,
        combinedSpecimens,
        primaryCollectedAt,
        primaryReportedAt,
        portalWebsiteUrl,
        qrDataUrl: qrSvgDataUrl || undefined,
        signatures: resolvedSignatures,
      });
      setPdfNotice(`Downloaded ${savedName}`);
    } catch (err) {
      setPdfNotice(err instanceof Error ? err.message : 'Failed to generate PDF report.');
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div
      className={
        inlinePageMode
          ? 'print-modal-root w-full min-h-screen bg-white flex flex-col items-center px-3 py-4 sm:p-6'
          : 'print-modal-root fixed inset-0 z-50 bg-white overflow-y-auto px-3 py-4 sm:p-6 flex flex-col items-center'
      }
    >
      {/* Keep @page margin: 0 so desktop browsers never print auto-generated URLs, dates, or titles */}
      <style>{`@media print { @page { size: A4 portrait; margin: 0; } }`}</style>
      {/* Print Controls Toolbar (Hidden on Paper) */}
      <div className="w-full max-w-4xl bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 mb-4 space-y-2.5 no-print">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-semibold text-brand-navy">
            {portalMode ? (
              <span className="inline-flex items-center gap-1.5 text-brand-navy">
                <ShieldCheck className="w-4 h-4 text-brand-cyan" />
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
                    ? 'bg-brand-navy text-white border-brand-navy'
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
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-brand-navy bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
              >
                <FolderOpen className="w-4 h-4 text-brand-cyan" />
                All Reports Archive
              </button>
            )}
            <button
              type="button"
              disabled={exportingPdf || selectedTests.length === 0}
              onClick={handleDownloadPdf}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-brand-cyan rounded-lg hover:bg-brand-cyan-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-4 h-4" />
              {exportingPdf ? 'Generating PDF...' : 'Download PDF'}
            </button>
            <button
              type="button"
              disabled={selectedTests.length === 0}
              onClick={handlePrintReport}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Printer className="w-4 h-4" />
              {tests.length > 1
                ? `Print Combined Report (${selectedTests.length} ${
                    selectedTests.length === 1 ? 'Test' : 'Tests'
                  })`
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

        {pdfNotice && (
          <div className="text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg px-3 py-1.5">
            {pdfNotice}
          </div>
        )}

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
              className={`px-2.5 py-1 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                selectedTests.length === tests.length
                  ? 'bg-brand-navy text-white border-brand-navy'
                  : 'bg-white text-brand-navy border-brand-navy/30 hover:bg-slate-50'
              }`}
            >
              All Combined ({tests.length})
            </button>

            {readyTests.length > 0 && readyTests.length < tests.length && (
              <button
                type="button"
                onClick={() => setSelectedTestIds(readyTests.map((t) => t.id))}
                className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                  selectedTests.length === readyTests.length &&
                  readyTests.every((rt) => selectedTests.some((st) => st.id === rt.id))
                    ? 'bg-emerald-700 text-white border-emerald-700'
                    : 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                }`}
              >
                Ready Only ({readyTests.length})
              </button>
            )}

            {selectedTests.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedTestIds([])}
                className="px-2 py-1 text-xs font-medium rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition-colors whitespace-nowrap cursor-pointer"
              >
                Clear
              </button>
            )}

            <span className="h-4 w-px bg-slate-200 mx-0.5" aria-hidden="true" />

            {tests.map((t) => {
              const checked = selectedTests.some((s) => s.id === t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={checked}
                  onClick={() => toggleTestSelection(t.id)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                    checked
                      ? 'bg-brand-navy text-white border-brand-navy'
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  {checked ? (
                    <Check className="w-3.5 h-3.5 shrink-0 text-teal-300" />
                  ) : (
                    <span
                      className="w-3 h-3 rounded-[3px] border border-slate-300 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span>{t.test_name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Empty selection prompt when operator clears all test pills */}
      {plannedPages.length === 0 && (
        <div className="no-print w-full max-w-4xl border border-dashed border-slate-300 rounded-xl bg-slate-50 px-6 py-12 text-center">
          <p className="text-sm font-semibold text-slate-800">
            No tests currently selected for this report.
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Toggle one or more test buttons above to preview, download PDF, or print.
          </p>
          <button
            type="button"
            onClick={() => setSelectedTestIds(tests.map((t) => t.id))}
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark transition-colors cursor-pointer"
          >
            <Layers className="w-3.5 h-3.5" />
            Select All Combined ({tests.length} Tests)
          </button>
        </div>
      )}

      {/* Multi-Page Clean White A4 Sheets — Continuous Flow, Repeating Header, In-Flow Bottom Signature Footer */}
      <div className="w-full flex flex-col items-center gap-6 print:block print:gap-0">
        {plannedPages.map((plan) => {
          const tableTypography = getPageTypography(plan);

          return (
            <section
              key={plan.pageNumber}
              className={`w-full max-w-[210mm] min-h-0 sm:min-h-[293mm] bg-white border border-slate-200 sm:rounded-lg shadow-none text-black print-pure-black print-page-sheet ${
                portalMode ? 'p-4 sm:p-8 print-digital-report' : 'px-4 sm:px-10 py-0 print-report-pad'
              }`}
            >
              {plannedPages.length > 1 && (
                <div className="no-print pt-2 pb-1 flex items-center justify-between text-[11px] font-medium text-slate-500">
                  <span>
                    A4 Sheet {plan.pageNumber} of {plannedPages.length}
                  </span>
                  <span>
                    {plan.blocks.map((b) => b.departmentHeading).join(' · ')}
                  </span>
                </div>
              )}

              {/* Outer A4 Page Table Shell:
                  - <thead> repeats Top Pad Margin + Digital Letterhead + Patient Header + QR on every page
                  - <tbody> holds top-aligned test results for this planned A4 page
                  - <tfoot> anchors the real 3-Column Signatures + Portal Bar + Bottom Pad Margin at the bottom of EVERY printed page */}
              <table className="print-shell-table w-full sm:min-h-[293mm] border-collapse">
                <thead className="print-shell-head">
                  <tr>
                    <td className="p-0 pb-2.5 align-top">
                      {/* Top blank clearance inside repeating <thead> */}
                      <div
                        style={{ height: portalMode ? '10mm' : `${topMarginIn}in` }}
                        className={
                          portalMode
                            ? 'hidden print:block'
                            : 'border-b border-dashed border-slate-300 print:border-none flex items-center justify-center text-xs text-slate-400 print:block'
                        }
                      >
                        {!portalMode && (
                          <span className="no-print">
                            Blank Header Area ({topMarginIn} inch — Reserved for Pre-Printed Offset Pad)
                          </span>
                        )}
                        <span className="hidden print:inline text-[1px] leading-none">&nbsp;</span>
                      </div>

                      {/* Full Official Digital Letterhead (Patient Portal / Direct QR Digital PDF Mode only) */}
                      {portalMode && (
                        <header className="border-b-2 border-brand-navy print:border-black pb-2 mb-1.5 flex flex-col sm:flex-row print:flex-row sm:items-center print:items-center justify-between gap-2.5">
                          <div className="flex items-center gap-2.5">
                            <BrandLogo surface="print" className="h-10 sm:h-11 print:h-10 w-auto" />
                            <div>
                              <h1 className="text-lg font-bold text-brand-navy print:text-black tracking-tight leading-tight">
                                {settings.lab_name}
                              </h1>
                              <p className="text-[11px] text-slate-700 print:text-black">{settings.lab_address}</p>
                              <p className="text-[10.5px] font-semibold text-brand-cyan-dark print:text-black">
                                Department of Pathology &amp; Clinical Diagnostics · Digital Verified Report
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 sm:justify-end print:justify-end">
                            <div className="text-right">
                              <div className="text-[9.5px] font-bold uppercase tracking-wider text-brand-red print:text-black">
                                Official Test Report
                              </div>
                              <div className="text-[10.5px] font-mono font-bold tabular-nums text-brand-navy print:text-black">
                                {invoice.invoice_no}
                              </div>
                              <VerificationBarcode code={`${invoice.invoice_no}`} />
                            </div>
                          </div>
                        </header>
                      )}

                      {/* Modern Borderless Two-Column Patient Info Header + Far-Right Dynamic QR Code */}
                      <section
                        className={`mt-0.5 ${tableTypography.patientSectionPadClass} border-b border-slate-300 print:border-black/40 bg-white text-black flex flex-col sm:flex-row print:flex-row items-start sm:items-center print:items-center justify-between gap-3 sm:gap-4 print:gap-3.5`}
                      >
                        <div
                          className={`flex-1 min-w-0 w-full grid grid-cols-1 sm:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] print:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] gap-x-5 print:gap-x-4 gap-y-1.5 ${tableTypography.patientGridClass}`}
                        >
                          {/* Left Column: Patient Name, Age/Sex, ID/Invoice No, Specimen */}
                          <div className={`${tableTypography.patientRowSpaceClass} min-w-0`}>
                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span
                                className={`${tableTypography.patientLeftLabelWidth} shrink-0 ${tableTypography.patientLabelClass} font-semibold uppercase tracking-wider text-slate-500`}
                              >
                                Patient
                              </span>
                              <span
                                className={`min-w-0 flex-1 ${tableTypography.patientNameClass} font-bold tracking-tight text-black whitespace-normal break-words`}
                              >
                                {invoice.patient_name}
                              </span>
                            </div>

                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span
                                className={`${tableTypography.patientLeftLabelWidth} shrink-0 ${tableTypography.patientLabelClass} font-semibold uppercase tracking-wider text-slate-500`}
                              >
                                Age / Sex
                              </span>
                              <span className="min-w-0 flex-1 font-semibold tabular-nums text-black whitespace-normal">
                                {formatAge(invoice.age_years, invoice.age_months, invoice.age_days)} /{' '}
                                {invoice.gender}
                              </span>
                            </div>

                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span
                                className={`${tableTypography.patientLeftLabelWidth} shrink-0 ${tableTypography.patientLabelClass} font-semibold uppercase tracking-wider text-slate-500`}
                              >
                                ID / Inv No
                              </span>
                              <span className="min-w-0 flex-1 font-mono font-bold tabular-nums text-black whitespace-normal break-all">
                                {invoice.patient_uid} / {invoice.invoice_no}
                              </span>
                            </div>

                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span
                                className={`${tableTypography.patientLeftLabelWidth} shrink-0 ${tableTypography.patientLabelClass} font-semibold uppercase tracking-wider text-slate-500`}
                              >
                                Specimen
                              </span>
                              <span className="min-w-0 flex-1 font-medium text-black whitespace-normal break-words">
                                {combinedSpecimens || '—'}
                              </span>
                            </div>
                          </div>

                          {/* Right Column: Registration/Report Date, Referring Doctor, Contact */}
                          <div className={`${tableTypography.patientRowSpaceClass} min-w-0`}>
                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span
                                className={`${tableTypography.patientRightLabelWidth} shrink-0 ${tableTypography.patientLabelClass} font-semibold uppercase tracking-wider text-slate-500`}
                              >
                                Reg. Date
                              </span>
                              <span className="min-w-0 flex-1 font-mono font-medium tabular-nums text-black whitespace-nowrap">
                                {formatDateTime(primaryCollectedAt)}
                              </span>
                            </div>

                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span
                                className={`${tableTypography.patientRightLabelWidth} shrink-0 ${tableTypography.patientLabelClass} font-semibold uppercase tracking-wider text-slate-500`}
                              >
                                Report Date
                              </span>
                              <span className="min-w-0 flex-1 font-mono font-medium tabular-nums text-black whitespace-nowrap">
                                {formatDateTime(primaryReportedAt)}
                              </span>
                            </div>

                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span
                                className={`${tableTypography.patientRightLabelWidth} shrink-0 ${tableTypography.patientLabelClass} font-semibold uppercase tracking-wider text-slate-500`}
                              >
                                Referred By
                              </span>
                              <span className="min-w-0 flex-1 font-medium text-black whitespace-normal break-words leading-[1.3]">
                                {invoice.doctor_name
                                  ? `${invoice.doctor_name}${invoice.doctor_degree ? `, ${invoice.doctor_degree}` : ''}`
                                  : 'Self'}
                              </span>
                            </div>

                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span
                                className={`${tableTypography.patientRightLabelWidth} shrink-0 ${tableTypography.patientLabelClass} font-semibold uppercase tracking-wider text-slate-500`}
                              >
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

                {/* Page Test Blocks Body — cleanly separated per planned A4 sheet */}
                <tbody className="print-report-body">
                  <tr>
                    <td className="p-0 pb-3 align-top">
                      {plan.blocks.map((block, blockIdx) => {
                        const seg = block.segment;
                        const useAtomicBlock = seg.keepIntact;
                        const hasMultipleInCategory =
                          selectedTests.filter(
                            (t) =>
                              (t.category_name || 'Pathology').trim().toLowerCase() ===
                              block.categoryName.toLowerCase()
                          ).length > 1;

                        return (
                          <div
                            key={`${plan.pageNumber}-${block.categoryName}-${blockIdx}`}
                            className={`${blockIdx > 0 ? 'mt-5 pt-2' : ''} ${
                              useAtomicBlock ? 'print-keep-intact' : 'print-flow-group'
                            }`}
                          >
                            {/* Centered Boxed Department Heading */}
                            {block.showDepartmentHeading && (
                              <div
                                className={`print-keep-with-next ${
                                  tableTypography.tier === 'ultra_short' ||
                                  tableTypography.tier === 'short'
                                    ? 'mt-1 mb-3'
                                    : 'mb-2'
                                } flex flex-col items-center`}
                              >
                                <div className="border border-black px-7 py-0.5 bg-white shadow-[2px_2px_0_#000000]">
                                  <h2
                                    className={`${tableTypography.deptHeadingClass} font-bold tracking-wide text-black`}
                                  >
                                    {block.departmentHeading}
                                  </h2>
                                </div>
                                {block.isSingleStandardTest && seg.kind === 'standard' && (
                                  <div
                                    className={`mt-1.5 ${tableTypography.testSubtitleClass} font-bold text-black`}
                                  >
                                    {seg.tests[0].test_name}
                                  </div>
                                )}
                              </div>
                            )}

                            {seg.kind === 'cbc' &&
                              (() => {
                                const orderedCbc = getOrderedCbcRows(seg.test.results || []);
                                let lastSection: string | undefined;

                                return (
                                  <table
                                    className={`w-full border-collapse font-sans text-black ${
                                      useAtomicBlock ? '' : 'print-layout-table'
                                    }`}
                                  >
                                    <colgroup>
                                      <col className="w-[34%]" />
                                      <col className="w-[22%]" />
                                      <col className="w-[44%]" />
                                    </colgroup>
                                    <thead className={useAtomicBlock ? undefined : 'print-spacer-head'}>
                                      <tr
                                        className={`border border-[#e0e0e0] bg-slate-50 print:bg-[#f8fafc] text-left ${tableTypography.theadClass} font-semibold uppercase tracking-wider text-slate-600`}
                                      >
                                        <th
                                          className={`${tableTypography.thPadClass} border-y border-l border-[#e0e0e0]`}
                                        >
                                          Parameter Name
                                        </th>
                                        <th
                                          className={`${tableTypography.thPadClass} border-y border-[#e0e0e0]`}
                                        >
                                          Result
                                        </th>
                                        <th
                                          className={`${tableTypography.thPadClass} border-y border-r border-[#e0e0e0]`}
                                        >
                                          Normal Value
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody className={`${tableTypography.tbodyClass} font-sans text-black`}>
                                      {hasMultipleInCategory && (
                                        <tr className="print-keep-with-next border-b border-[#d8dee6] bg-slate-50/80 print:bg-[#f8fafc]">
                                          <td
                                            colSpan={3}
                                            className={`${tableTypography.cellPadXClass} ${tableTypography.subHeaderClass} font-bold text-black`}
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
                                        const rowKey = `${r.id}-${getCanonicalParameterKey(r.parameter_name)}`;

                                        return (
                                          <React.Fragment key={rowKey}>
                                            {showSection && (
                                              <tr className="print-keep-with-next border-b border-[#d8dee6] bg-slate-50/50 print:bg-[#fafbfc]">
                                                <td
                                                  colSpan={3}
                                                  className={`${tableTypography.sectionPadClass} ${tableTypography.cellPadXClass} ${tableTypography.sectionClass} font-bold uppercase tracking-wider text-slate-600`}
                                                >
                                                  {section}
                                                </td>
                                              </tr>
                                            )}
                                            <tr className="print-row-avoid border-b border-[#e8ecf0]">
                                              <td
                                                className={`${tableTypography.rowPadClass} ${tableTypography.cellPadXClass} align-top text-black ${
                                                  isHb ? 'font-bold pt-1.5' : 'font-medium'
                                                }`}
                                              >
                                                {r.parameter_name}
                                              </td>
                                              <td
                                                className={`${tableTypography.rowPadClass} ${tableTypography.cellPadXClass} align-top text-black whitespace-nowrap`}
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
                                                className={`${tableTypography.rowPadClass} ${tableTypography.cellPadXClass} align-top tabular-nums font-normal ${tableTypography.normalClass} text-slate-700 whitespace-pre-line`}
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
                                const orderedUrine = getOrderedUrineRows(seg.test.results || []);
                                let lastSection = '';
                                return (
                                  <table
                                    className={`w-full border-collapse font-sans text-black ${
                                      useAtomicBlock ? '' : 'print-layout-table'
                                    }`}
                                  >
                                    <colgroup>
                                      <col className="w-[34%]" />
                                      <col className="w-[22%]" />
                                      <col className="w-[44%]" />
                                    </colgroup>
                                    <thead className={useAtomicBlock ? undefined : 'print-spacer-head'}>
                                      <tr
                                        className={`border border-[#e0e0e0] bg-slate-50 print:bg-[#f8fafc] text-left ${tableTypography.theadClass} font-semibold uppercase tracking-wider text-slate-600`}
                                      >
                                        <th
                                          className={`${tableTypography.thPadClass} border-y border-l border-[#e0e0e0]`}
                                        >
                                          Parameter Name
                                        </th>
                                        <th
                                          className={`${tableTypography.thPadClass} border-y border-[#e0e0e0]`}
                                        >
                                          Result
                                        </th>
                                        <th
                                          className={`${tableTypography.thPadClass} border-y border-r border-[#e0e0e0]`}
                                        >
                                          Normal Value
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody className={`${tableTypography.tbodyClass} font-sans text-black`}>
                                      {hasMultipleInCategory && (
                                        <tr className="print-keep-with-next border-b border-[#d8dee6] bg-slate-50/80 print:bg-[#f8fafc]">
                                          <td
                                            colSpan={3}
                                            className={`${tableTypography.cellPadXClass} ${tableTypography.subHeaderClass} font-bold text-black`}
                                          >
                                            {seg.test.test_name}
                                          </td>
                                        </tr>
                                      )}
                                      {orderedUrine.map(({ row: r, section: sec }) => {
                                        const showSection = sec !== lastSection;
                                        lastSection = sec;
                                        const isAbn =
                                          r.flag && r.flag !== 'Normal' && r.result_value.trim() !== '';
                                        const rowKey = `${r.id}-${getCanonicalParameterKey(r.parameter_name)}`;

                                        return (
                                          <React.Fragment key={rowKey}>
                                            {showSection && (
                                              <tr className="print-keep-with-next border-b border-[#d8dee6] bg-slate-50/50 print:bg-[#fafbfc]">
                                                <td
                                                  colSpan={3}
                                                  className={`${tableTypography.sectionPadClass} ${tableTypography.cellPadXClass} ${tableTypography.sectionClass} font-bold uppercase tracking-wider text-slate-600`}
                                                >
                                                  {sec}
                                                </td>
                                              </tr>
                                            )}
                                            <tr className="print-row-avoid border-b border-[#e8ecf0]">
                                              <td
                                                className={`${tableTypography.rowPadClass} ${tableTypography.cellPadXClass} align-top font-medium text-black`}
                                              >
                                                {r.parameter_name}
                                              </td>
                                              <td
                                                className={`${tableTypography.rowPadClass} ${tableTypography.cellPadXClass} align-top text-black whitespace-nowrap`}
                                              >
                                                <span
                                                  className={`tabular-nums ${
                                                    isAbn ? 'font-bold' : 'font-semibold'
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
                                                className={`${tableTypography.rowPadClass} ${tableTypography.cellPadXClass} align-top tabular-nums font-normal ${tableTypography.normalClass} text-slate-700 whitespace-pre-line`}
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
                                    <th
                                      className={`${tableTypography.thPadClass} border-y border-l border-[#e0e0e0]`}
                                    >
                                      Parameter Name
                                    </th>
                                    <th
                                      className={`${tableTypography.thPadClass} border-y border-[#e0e0e0]`}
                                    >
                                      Result
                                    </th>
                                    <th
                                      className={`${tableTypography.thPadClass} border-y border-[#e0e0e0]`}
                                    >
                                      Normal Value
                                    </th>
                                    <th
                                      className={`${tableTypography.thPadClass} border-y border-r border-[#e0e0e0] text-center`}
                                    >
                                      Remark
                                    </th>
                                  </tr>
                                </thead>

                                {seg.tests.map((test) => {
                                  const rows = deduplicateTestResults(test.results || []);
                                  const showSubHeading = !block.isSingleStandardTest;
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
                                            className={`${tableTypography.cellPadXClass} ${tableTypography.subHeaderClass} font-bold tracking-tight text-black`}
                                          >
                                            {test.test_name}
                                          </td>
                                        </tr>
                                      )}
                                      {rows.map((r) => {
                                        const isAbnormal =
                                          r.flag && r.flag !== 'Normal' && r.result_value.trim() !== '';
                                        const rowKey = `${r.id}-${getCanonicalParameterKey(r.parameter_name)}`;
                                        return (
                                          <tr
                                            key={rowKey}
                                            className="print-row-avoid border-b border-[#e8ecf0]"
                                          >
                                            <td
                                              className={`${tableTypography.rowPadClass} ${tableTypography.cellPadXClass} align-top font-medium text-black`}
                                            >
                                              {r.parameter_name}
                                            </td>
                                            <td
                                              className={`${tableTypography.rowPadClass} ${tableTypography.cellPadXClass} align-top text-black whitespace-nowrap`}
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
                                              className={`${tableTypography.rowPadClass} ${tableTypography.cellPadXClass} align-top tabular-nums font-normal ${tableTypography.normalClass} text-slate-700 whitespace-pre-line`}
                                            >
                                              {r.reference_range_text || r.normal_text || '—'}
                                            </td>
                                            <td
                                              className={`${tableTypography.rowPadClass} ${tableTypography.cellPadXClass} align-top text-center ${
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
                          </div>
                        );
                      })}
                    </td>
                  </tr>
                </tbody>

                {/* Native <tfoot class="print-shell-foot"> — In-flow repeating bottom Signature Footer
                    100% visible on Ctrl+P direct print & screen preview without position:fixed clipping */}
                <tfoot className="print-shell-foot">
                  <tr>
                    <td className="p-0 align-bottom">
                      <div className="print-report-footer pt-3">
                        <footer className="grid grid-cols-3 gap-6 items-end text-black">
                          {/* 1. LEFT: Doctor / Consultant Pathologist Designation & Signature Area */}
                          <div className="text-left">
                            <div className="h-7" />
                            <div className="border-t border-black pt-1 text-left">
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-black">
                                Consultant / Pathologist
                              </div>
                              {resolvedConsultantName ? (
                                <>
                                  <p className="text-[11.5px] font-bold text-black leading-tight mt-0.5">
                                    {resolvedConsultantName}
                                  </p>
                                  {resolvedConsultantTitle && (
                                    <p className="text-[10.5px] text-black leading-tight">
                                      {resolvedConsultantTitle}
                                    </p>
                                  )}
                                </>
                              ) : (
                                <div
                                  className="h-4"
                                  aria-label="Manual Consultant / Pathologist Signature Space"
                                />
                              )}
                            </div>
                          </div>

                          {/* 2. CENTER: Checked By */}
                          <div className="text-center">
                            <div className="h-7" />
                            <div className="border-t border-black pt-1">
                              <div className="text-[11px] font-bold text-black">Checked by</div>
                            </div>
                          </div>

                          {/* 3. RIGHT: Technologist Designation & Signature Area */}
                          <div className="text-right">
                            <div className="h-7" />
                            <div className="border-t border-black pt-1 text-right">
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-black">
                                Prepared / Tested By
                              </div>
                              {resolvedTechName && (
                                <p className="text-[11.5px] font-bold text-black leading-tight mt-0.5">
                                  {resolvedTechName}
                                </p>
                              )}
                              {resolvedTechTitle && (
                                <p className="text-[10.5px] text-black leading-tight">
                                  {resolvedTechTitle}
                                </p>
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
                              {plannedPages.length > 1
                                ? ` · Page ${plan.pageNumber}/${plannedPages.length}`
                                : ''}
                            </span>
                          </div>
                        ) : (
                          <div className="mt-1.5 pt-1 border-t border-black/30 flex items-center justify-between gap-2 text-[9px] text-black">
                            <span>
                              Online Report Portal:{' '}
                              <span className="font-mono font-semibold">{portalWebsiteUrl}</span>
                            </span>
                            <span>
                              Scan QR code above for instant PDF report
                              {plannedPages.length > 1
                                ? ` · Page ${plan.pageNumber}/${plannedPages.length}`
                                : ''}
                            </span>
                          </div>
                        )}

                        {/* Bottom blank pad clearance directly inside tfoot */}
                        <div
                          style={{ height: portalMode ? '8mm' : `${bottomMarginIn}in` }}
                          className={
                            portalMode
                              ? 'hidden print:block text-[1px] leading-none'
                              : 'mt-1.5 border-t border-dashed border-slate-300 print:border-none flex items-center justify-center text-[11px] text-slate-400 print:block'
                          }
                        >
                          {!portalMode && (
                            <span className="no-print">
                              Blank Footer Area ({bottomMarginIn} inch — Reserved for Pre-Printed Offset Pad)
                            </span>
                          )}
                          <span className="hidden print:inline text-[1px] leading-none">&nbsp;</span>
                        </div>
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </section>
          );
        })}
      </div>
    </div>
  );
};
