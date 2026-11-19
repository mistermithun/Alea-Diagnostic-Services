import { jsPDF } from 'jspdf';
import autoTable, { type RowInput } from 'jspdf-autotable';
import { formatAge, formatDateTime } from './api.ts';
import {
  deduplicateTestResults,
  formatNumericResultDisplay,
  getOrderedCbcRows,
  getOrderedUrineRows,
  getPageTypographyProfile,
  planReportPages,
  type ReportTypographyProfile,
  type ResolvedSignatures,
} from './reportLayout.ts';
import type { InvoiceSummary, InvoiceTestItem, LabSettings } from '../types.ts';

export interface ExportReportPdfOptions {
  invoice: InvoiceSummary;
  selectedTests: InvoiceTestItem[];
  settings: LabSettings;
  portalMode: boolean;
  topMarginIn: number;
  bottomMarginIn: number;
  combinedSpecimens: string;
  primaryCollectedAt: string;
  primaryReportedAt: string;
  portalWebsiteUrl: string;
  qrDataUrl?: string;
  signatures: ResolvedSignatures;
}

const BRAND_LOGO_PDF_URL = '/assets/aistudio/IMG_20261119_111655_480ab481.jpg';
let cachedBrandLogoDataUrl: string | null | undefined;

async function loadBrandLogoDataUrl(): Promise<string | null> {
  if (cachedBrandLogoDataUrl !== undefined) {
    return cachedBrandLogoDataUrl;
  }
  if (typeof window === 'undefined' || typeof fetch === 'undefined') {
    cachedBrandLogoDataUrl = null;
    return null;
  }
  try {
    const res = await fetch(BRAND_LOGO_PDF_URL);
    if (!res.ok) {
      cachedBrandLogoDataUrl = null;
      return null;
    }
    const blob = await res.blob();
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () =>
        resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    cachedBrandLogoDataUrl = dataUrl;
    return dataUrl;
  } catch {
    cachedBrandLogoDataUrl = null;
    return null;
  }
}

function getLastAutoTableFinalY(doc: jsPDF): number {
  const withTable = doc as unknown as { lastAutoTable?: { finalY: number } };
  return withTable.lastAutoTable?.finalY ?? 60;
}

/**
 * Generates and downloads a multi-page A4 clinical diagnostic report PDF:
 * - Respects Pre-Printed Offset Pad blank header/footer margins OR Digital Letterhead mode
 * - Matches exact A4 page separation and dynamic typography tiers from getPageTypographyProfile
 * - Repeats Patient Info Header + QR code on EVERY page
 * - Repeats 3-column signature block (Consultant left, Checked by center, Prepared / Tested By right) on EVERY page
 */
export async function exportDiagnosticReportPdf(opts: ExportReportPdfOptions): Promise<string> {
  const {
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
    qrDataUrl,
    signatures,
  } = opts;

  if (!selectedTests || selectedTests.length === 0) {
    throw new Error('Select at least one test before downloading the PDF report.');
  }

  const plannedPages = planReportPages(selectedTests, {
    topMarginIn,
    bottomMarginIn,
    portalMode,
  });

  if (plannedPages.length === 0) {
    throw new Error('Select at least one test before downloading the PDF report.');
  }

  const brandLogoDataUrl = portalMode ? await loadBrandLogoDataUrl() : null;

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  const pageWidth = 210;
  const pageHeight = 297;
  const marginX = 12;
  const contentWidth = pageWidth - marginX * 2; // 186mm

  const topPadMm = portalMode ? 9 : Math.max(8, topMarginIn * 25.4);
  const bottomPadMm = portalMode ? 8 : Math.max(6, bottomMarginIn * 25.4);
  const letterheadHeightMm = portalMode ? 17 : 0;

  // Footer reserved clearance at bottom of EVERY A4 page
  const footerHeightMm = 23.5;
  const footerReserveBottomMm = bottomPadMm + footerHeightMm + 3;

  const qrSize = qrDataUrl ? 16 : 0;
  const infoAreaWidth = qrDataUrl ? contentWidth - qrSize - 6 : contentWidth;
  const colLeftW = infoAreaWidth * 0.48;
  const colRightW = infoAreaWidth * 0.5;
  const labelLeftW = 20.5;
  const labelRightW = 22.5;

  const ageSexStr = `${formatAge(invoice.age_years, invoice.age_months, invoice.age_days)} / ${invoice.gender}`;
  const idInvStr = `${invoice.patient_uid} / ${invoice.invoice_no}`;
  const refByStr = invoice.doctor_name
    ? `${invoice.doctor_name}${invoice.doctor_degree ? `, ${invoice.doctor_degree}` : ''}`
    : 'Self';

  const getHeaderMetrics = (typo: ReportTypographyProfile) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(typo.pdf.patientNamePt);
    const nameLines = doc.splitTextToSize(invoice.patient_name || '—', colLeftW - labelLeftW);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(typo.pdf.patientValuePt);
    const specimenLines = doc.splitTextToSize(combinedSpecimens || '—', colLeftW - labelLeftW);
    const refByLines = doc.splitTextToSize(refByStr, colRightW - labelRightW);
    const contactLines = doc.splitTextToSize(invoice.patient_mobile || '—', colRightW - labelRightW);

    const rowStep = typo.pdf.patientLineH;
    const subRowStep = Math.max(3.8, rowStep - 0.35);
    const leftRowsH =
      nameLines.length * rowStep +
      rowStep + // Age/Sex
      rowStep + // ID / Inv No
      Math.max(1, specimenLines.length) * subRowStep;
    const rightRowsH =
      rowStep + // Reg Date
      rowStep + // Report Date
      Math.max(1, refByLines.length) * subRowStep +
      Math.max(1, contactLines.length) * subRowStep;
    const patientBoxHeightMm = Math.max(leftRowsH, rightRowsH, qrDataUrl ? 21 : 17) + 3.2;

    const headerBottomY = topPadMm + letterheadHeightMm + patientBoxHeightMm;
    const contentTopY = headerBottomY + 4;
    return {
      nameLines,
      specimenLines,
      refByLines,
      contactLines,
      rowStep,
      subRowStep,
      headerBottomY,
      contentTopY,
    };
  };

  const drawDepartmentBadge = (yPos: number, title: string, fontSizePt: number): number => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(fontSizePt);
    const textW = doc.getTextWidth(title);
    const boxW = Math.max(46, textW + 16);
    const boxH = 6.8;
    const boxX = (pageWidth - boxW) / 2;

    doc.setFillColor(0, 0, 0);
    doc.rect(boxX + 0.6, yPos + 0.6, boxW, boxH, 'F');

    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.35);
    doc.rect(boxX, yPos, boxW, boxH, 'FD');

    doc.setTextColor(0, 0, 0);
    doc.text(title, pageWidth / 2, yPos + 4.7, { align: 'center' });
    return yPos + boxH + 3.2;
  };

  const pdfPageProfiles = new Map<number, ReportTypographyProfile>();
  const defaultProfile = getPageTypographyProfile(plannedPages[0].blocks);

  for (let pageIdx = 0; pageIdx < plannedPages.length; pageIdx++) {
    if (pageIdx > 0) {
      doc.addPage();
    }
    const plan = plannedPages[pageIdx];
    const typo = getPageTypographyProfile(plan.blocks);
    const { contentTopY } = getHeaderMetrics(typo);
    const startPageNum = doc.getNumberOfPages();
    pdfPageProfiles.set(startPageNum, typo);

    let cursorY =
      contentTopY + (typo.tier === 'ultra_short' || typo.tier === 'short' ? 1.5 : 0);

    for (const block of plan.blocks) {
      const seg = block.segment;
      const showDeptHeading = block.showDepartmentHeading;
      const isSingleStandard = block.isSingleStandardTest;

      // Guard against an orphaned department heading near the bottom signature zone
      if (cursorY + 26 > pageHeight - footerReserveBottomMm) {
        doc.addPage();
        pdfPageProfiles.set(doc.getNumberOfPages(), typo);
        cursorY = contentTopY;
      }

      if (showDeptHeading) {
        cursorY = drawDepartmentBadge(cursorY, block.departmentHeading, typo.pdf.deptHeadingPt);
        if (isSingleStandard && seg.kind === 'standard') {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(typo.pdf.testSubtitlePt);
          doc.setTextColor(0, 0, 0);
          doc.text(seg.tests[0].test_name, pageWidth / 2, cursorY + 1.2, { align: 'center' });
          cursorY += typo.tier === 'ultra_short' || typo.tier === 'short' ? 5.2 : 4.2;
        }
      }

      const hasMultipleInCategory =
        selectedTests.filter(
          (t) =>
            (t.category_name || 'Pathology').trim().toLowerCase() ===
            block.categoryName.toLowerCase()
        ).length > 1;

      if (seg.kind === 'cbc') {
        const ordered = getOrderedCbcRows(seg.test.results || []);
        const bodyRows: RowInput[] = [];
        if (hasMultipleInCategory) {
          bodyRows.push([
            {
              content: seg.test.test_name,
              colSpan: 3,
              styles: {
                fontStyle: 'bold',
                fillColor: [248, 250, 252],
                textColor: [0, 0, 0],
                fontSize: typo.pdf.subHeaderPt,
              },
            },
          ]);
        }

        let lastSection: string | undefined;
        for (const { row: r, section } of ordered) {
          if (section && section !== lastSection) {
            lastSection = section;
            bodyRows.push([
              {
                content: section.toUpperCase(),
                colSpan: 3,
                styles: {
                  fontStyle: 'bold',
                  fillColor: [250, 251, 252],
                  textColor: [60, 72, 88],
                  fontSize: typo.pdf.sectionPt,
                  cellPadding: { top: 1.5, bottom: 1, left: typo.pdf.bodyPadH, right: typo.pdf.bodyPadH },
                },
              },
            ]);
          }
          const formattedVal = formatNumericResultDisplay(r.result_value, r.parameter_name);
          const resultText =
            r.result_value && r.unit ? `${formattedVal} ${r.unit}` : formattedVal;
          const isBold =
            r.parameter_name.toLowerCase().includes('hemoglobin') ||
            r.parameter_name.toLowerCase() === 'hb' ||
            r.parameter_name.toLowerCase().startsWith('esr');
          bodyRows.push([
            {
              content: r.parameter_name,
              styles: { fontStyle: isBold ? 'bold' : 'normal' },
            },
            {
              content: resultText,
              styles: { fontStyle: 'bold' },
            },
            {
              content: r.normal_text || r.reference_range_text || '—',
              styles: { fontSize: typo.pdf.normalPt, textColor: [40, 48, 60] },
            },
          ]);
        }

        autoTable(doc, {
          startY: cursorY,
          margin: {
            top: contentTopY,
            left: marginX,
            right: marginX,
            bottom: footerReserveBottomMm,
          },
          head: [['PARAMETER NAME', 'RESULT', 'NORMAL VALUE']],
          body: bodyRows,
          showHead: 'everyPage',
          rowPageBreak: 'avoid',
          theme: 'plain',
          styles: {
            font: 'helvetica',
            fontSize: typo.pdf.bodyPt,
            cellPadding: {
              top: typo.pdf.bodyPadV,
              bottom: typo.pdf.bodyPadV,
              left: typo.pdf.bodyPadH,
              right: typo.pdf.bodyPadH,
            },
            textColor: [0, 0, 0],
            lineColor: [224, 228, 234],
            lineWidth: 0.2,
          },
          headStyles: {
            fillColor: [248, 250, 252],
            textColor: [71, 85, 105],
            fontStyle: 'bold',
            fontSize: typo.pdf.headPt,
            cellPadding: {
              top: typo.pdf.headPadV,
              bottom: typo.pdf.headPadV,
              left: typo.pdf.bodyPadH,
              right: typo.pdf.bodyPadH,
            },
            lineColor: [216, 222, 230],
            lineWidth: 0.25,
          },
          columnStyles: {
            0: { cellWidth: contentWidth * 0.34 },
            1: { cellWidth: contentWidth * 0.22 },
            2: { cellWidth: contentWidth * 0.44 },
          },
        });
        cursorY = getLastAutoTableFinalY(doc) + typo.pdf.blockGapMm;
      } else if (seg.kind === 'urine') {
        const bodyRows: RowInput[] = [];
        if (hasMultipleInCategory) {
          bodyRows.push([
            {
              content: seg.test.test_name,
              colSpan: 3,
              styles: {
                fontStyle: 'bold',
                fillColor: [248, 250, 252],
                textColor: [0, 0, 0],
                fontSize: typo.pdf.subHeaderPt,
              },
            },
          ]);
        }

        const orderedUrine = getOrderedUrineRows(seg.test.results || []);
        let lastSection = '';
        for (const { row: r, section: sec } of orderedUrine) {
          if (sec !== lastSection) {
            lastSection = sec;
            bodyRows.push([
              {
                content: sec.toUpperCase(),
                colSpan: 3,
                styles: {
                  fontStyle: 'bold',
                  fillColor: [250, 251, 252],
                  textColor: [60, 72, 88],
                  fontSize: typo.pdf.sectionPt,
                  cellPadding: { top: 1.4, bottom: 0.9, left: typo.pdf.bodyPadH, right: typo.pdf.bodyPadH },
                },
              },
            ]);
          }
          const isAbnormal = Boolean(r.flag && r.flag !== 'Normal' && r.result_value.trim() !== '');
          const resultText =
            r.result_value && r.unit
              ? `${r.result_value} ${r.unit}`
              : r.result_value || 'Pending';
          bodyRows.push([
            { content: r.parameter_name },
            {
              content: resultText,
              styles: { fontStyle: isAbnormal ? 'bold' : 'normal' },
            },
            {
              content: r.normal_text || r.reference_range_text || '—',
              styles: { fontSize: typo.pdf.normalPt, textColor: [40, 48, 60] },
            },
          ]);
        }

        autoTable(doc, {
          startY: cursorY,
          margin: {
            top: contentTopY,
            left: marginX,
            right: marginX,
            bottom: footerReserveBottomMm,
          },
          head: [['PARAMETER NAME', 'RESULT', 'NORMAL VALUE']],
          body: bodyRows,
          showHead: 'everyPage',
          rowPageBreak: 'avoid',
          theme: 'plain',
          styles: {
            font: 'helvetica',
            fontSize: typo.pdf.bodyPt,
            cellPadding: {
              top: typo.pdf.bodyPadV,
              bottom: typo.pdf.bodyPadV,
              left: typo.pdf.bodyPadH,
              right: typo.pdf.bodyPadH,
            },
            textColor: [0, 0, 0],
            lineColor: [224, 228, 234],
            lineWidth: 0.2,
          },
          headStyles: {
            fillColor: [248, 250, 252],
            textColor: [71, 85, 105],
            fontStyle: 'bold',
            fontSize: typo.pdf.headPt,
            cellPadding: {
              top: typo.pdf.headPadV,
              bottom: typo.pdf.headPadV,
              left: typo.pdf.bodyPadH,
              right: typo.pdf.bodyPadH,
            },
            lineColor: [216, 222, 230],
            lineWidth: 0.25,
          },
          columnStyles: {
            0: { cellWidth: contentWidth * 0.34 },
            1: { cellWidth: contentWidth * 0.22 },
            2: { cellWidth: contentWidth * 0.44 },
          },
        });
        cursorY = getLastAutoTableFinalY(doc) + typo.pdf.blockGapMm;
      } else {
        const bodyRows: RowInput[] = [];
        for (const test of seg.tests) {
          if (!isSingleStandard) {
            bodyRows.push([
              {
                content: test.test_name,
                colSpan: 4,
                styles: {
                  fontStyle: 'bold',
                  fillColor: [248, 250, 252],
                  textColor: [0, 0, 0],
                  fontSize: typo.pdf.subHeaderPt,
                },
              },
            ]);
          }
          for (const r of deduplicateTestResults(test.results || [])) {
            const isAbnormal = Boolean(
              r.flag && r.flag !== 'Normal' && r.result_value.trim() !== ''
            );
            const resultText =
              r.result_value && r.unit
                ? `${r.result_value} ${r.unit}`
                : r.result_value || 'Pending';
            const remarkText = r.result_value
              ? isAbnormal
                ? r.flag.toUpperCase()
                : 'Normal'
              : '—';
            bodyRows.push([
              { content: r.parameter_name },
              {
                content: resultText,
                styles: { fontStyle: 'bold' },
              },
              {
                content: r.reference_range_text || r.normal_text || '—',
                styles: { fontSize: typo.pdf.normalPt, textColor: [40, 48, 60] },
              },
              {
                content: remarkText,
                styles: {
                  halign: 'center',
                  fontStyle: isAbnormal ? 'bold' : 'normal',
                  textColor: isAbnormal ? [0, 0, 0] : [55, 65, 81],
                },
              },
            ]);
          }
        }

        autoTable(doc, {
          startY: cursorY,
          margin: {
            top: contentTopY,
            left: marginX,
            right: marginX,
            bottom: footerReserveBottomMm,
          },
          head: [['PARAMETER NAME', 'RESULT', 'NORMAL VALUE', 'REMARK']],
          body: bodyRows,
          showHead: 'everyPage',
          rowPageBreak: 'avoid',
          theme: 'plain',
          styles: {
            font: 'helvetica',
            fontSize: typo.pdf.bodyPt,
            cellPadding: {
              top: typo.pdf.bodyPadV,
              bottom: typo.pdf.bodyPadV,
              left: typo.pdf.bodyPadH,
              right: typo.pdf.bodyPadH,
            },
            textColor: [0, 0, 0],
            lineColor: [224, 228, 234],
            lineWidth: 0.2,
          },
          headStyles: {
            fillColor: [248, 250, 252],
            textColor: [71, 85, 105],
            fontStyle: 'bold',
            fontSize: typo.pdf.headPt,
            cellPadding: {
              top: typo.pdf.headPadV,
              bottom: typo.pdf.headPadV,
              left: typo.pdf.bodyPadH,
              right: typo.pdf.bodyPadH,
            },
            lineColor: [216, 222, 230],
            lineWidth: 0.25,
          },
          columnStyles: {
            0: { cellWidth: contentWidth * 0.32 },
            1: { cellWidth: contentWidth * 0.2 },
            2: { cellWidth: contentWidth * 0.34 },
            3: { cellWidth: contentWidth * 0.14, halign: 'center' },
          },
        });
        cursorY = getLastAutoTableFinalY(doc) + typo.pdf.blockGapMm;
      }

      const endPageNum = doc.getNumberOfPages();
      for (let pn = startPageNum; pn <= endPageNum; pn++) {
        if (!pdfPageProfiles.has(pn)) {
          pdfPageProfiles.set(pn, typo);
        }
      }
    }
  }

  // Stamp repeating top chrome (Letterhead + Patient Header + QR) and bottom Signature Footer on EVERY A4 page
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const pageTypo = pdfPageProfiles.get(p) || defaultProfile;
    const {
      nameLines,
      specimenLines,
      refByLines,
      contactLines,
      rowStep,
      subRowStep,
      headerBottomY,
    } = getHeaderMetrics(pageTypo);

    let y = topPadMm;

    // 1. Digital Letterhead (Portal / QR digital download mode)
    if (portalMode) {
      let textOffsetX = marginX + 12;
      if (brandLogoDataUrl) {
        // Logo natural aspect ratio 938:804 -> 13.5mm x 11.57mm fits cleanly above the 14mm rule
        doc.addImage(brandLogoDataUrl, 'JPEG', marginX, y - 0.3, 13.5, 11.57);
        textOffsetX = marginX + 15.5;
      } else {
        doc.setFillColor(23, 41, 74);
        doc.roundedRect(marginX, y, 9.5, 9.5, 2, 2, 'F');
        doc.setFillColor(255, 255, 255);
        doc.rect(marginX + 3.9, y + 2, 1.7, 5.5, 'F');
        doc.rect(marginX + 2, y + 3.9, 5.5, 1.7, 'F');
      }

      doc.setTextColor(23, 41, 74);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12.5);
      doc.text(settings.lab_name, textOffsetX, y + 4);

      doc.setTextColor(55, 65, 81);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(settings.lab_address, textOffsetX, y + 7.5);

      doc.setTextColor(27, 122, 145);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text(
        'Department of Pathology & Clinical Diagnostics · Digital Verified Report',
        textOffsetX,
        y + 11
      );

      doc.setTextColor(216, 35, 33);
      doc.setFontSize(7);
      doc.text('OFFICIAL TEST REPORT', pageWidth - marginX, y + 3.5, { align: 'right' });
      doc.setTextColor(23, 41, 74);
      doc.setFontSize(8.5);
      doc.text(invoice.invoice_no, pageWidth - marginX, y + 7.5, { align: 'right' });

      doc.setDrawColor(23, 41, 74);
      doc.setLineWidth(0.5);
      doc.line(marginX, y + 14, pageWidth - marginX, y + 14);
      y += letterheadHeightMm;
    }

    // 2. Repeating Two-Column Patient Info Header + QR Code
    const leftX = marginX;
    const rightX = marginX + colLeftW + 3;

    let ly = y + 3.2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientLabelPt);
    doc.setTextColor(95, 105, 120);
    doc.text('PATIENT', leftX, ly);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientNamePt);
    doc.setTextColor(0, 0, 0);
    doc.text(nameLines, leftX + labelLeftW, ly);
    ly += nameLines.length * rowStep;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientLabelPt);
    doc.setTextColor(95, 105, 120);
    doc.text('AGE / SEX', leftX, ly);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientValuePt);
    doc.setTextColor(0, 0, 0);
    doc.text(ageSexStr, leftX + labelLeftW, ly);
    ly += rowStep;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientLabelPt);
    doc.setTextColor(95, 105, 120);
    doc.text('ID / INV NO', leftX, ly);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientValuePt);
    doc.setTextColor(0, 0, 0);
    doc.text(idInvStr, leftX + labelLeftW, ly);
    ly += rowStep;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientLabelPt);
    doc.setTextColor(95, 105, 120);
    doc.text('SPECIMEN', leftX, ly);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(pageTypo.pdf.patientValuePt);
    doc.setTextColor(0, 0, 0);
    doc.text(specimenLines, leftX + labelLeftW, ly);

    let ry = y + 3.2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientLabelPt);
    doc.setTextColor(95, 105, 120);
    doc.text('REG. DATE', rightX, ry);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(pageTypo.pdf.patientValuePt);
    doc.setTextColor(0, 0, 0);
    doc.text(formatDateTime(primaryCollectedAt), rightX + labelRightW, ry);
    ry += rowStep;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientLabelPt);
    doc.setTextColor(95, 105, 120);
    doc.text('REPORT DATE', rightX, ry);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(pageTypo.pdf.patientValuePt);
    doc.setTextColor(0, 0, 0);
    doc.text(formatDateTime(primaryReportedAt), rightX + labelRightW, ry);
    ry += rowStep;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientLabelPt);
    doc.setTextColor(95, 105, 120);
    doc.text('REFERRED BY', rightX, ry);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(pageTypo.pdf.patientValuePt);
    doc.setTextColor(0, 0, 0);
    doc.text(refByLines, rightX + labelRightW, ry);
    ry += Math.max(1, refByLines.length) * subRowStep;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(pageTypo.pdf.patientLabelPt);
    doc.setTextColor(95, 105, 120);
    doc.text('CONTACT', rightX, ry);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(pageTypo.pdf.patientValuePt);
    doc.setTextColor(0, 0, 0);
    doc.text(contactLines, rightX + labelRightW, ry);

    if (qrDataUrl) {
      const qrX = pageWidth - marginX - qrSize;
      const qrY = y + 1;
      doc.setDrawColor(160, 170, 185);
      doc.setLineWidth(0.2);
      doc.rect(qrX - 1, qrY - 0.5, qrSize + 2, qrSize + 1.5);
      doc.addImage(qrDataUrl, 'PNG', qrX, qrY, qrSize, qrSize);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(5.5);
      doc.setTextColor(70, 80, 95);
      doc.text('SCAN FOR REPORT', qrX + qrSize / 2, qrY + qrSize + 3.2, { align: 'center' });
    }

    doc.setDrawColor(100, 110, 125);
    doc.setLineWidth(0.3);
    doc.line(marginX, headerBottomY, pageWidth - marginX, headerBottomY);

    // 3. Repeating 3-Column Signature Block on EVERY page
    const footerBottomY = pageHeight - bottomPadMm;
    const portalBarY = footerBottomY - 3.5;
    const sigLineY = footerBottomY - 16.5;
    const colGap = 8;
    const sigColW = (contentWidth - colGap * 2) / 3;

    // LEFT: Consultant / Pathologist (always visible)
    const leftSigX1 = marginX;
    const leftSigX2 = marginX + sigColW;
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.3);
    doc.line(leftSigX1, sigLineY, leftSigX2, sigLineY);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(0, 0, 0);
    doc.text('CONSULTANT / PATHOLOGIST', leftSigX1, sigLineY + 3.6);
    if (signatures.resolvedConsultantName) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.text(signatures.resolvedConsultantName, leftSigX1, sigLineY + 7.1, {
        maxWidth: sigColW,
      });
      if (signatures.resolvedConsultantTitle) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.text(signatures.resolvedConsultantTitle, leftSigX1, sigLineY + 10.4, {
          maxWidth: sigColW,
        });
      }
    }

    // CENTER: Checked By
    const centerSigX1 = leftSigX2 + colGap;
    const centerSigX2 = centerSigX1 + sigColW;
    doc.line(centerSigX1, sigLineY, centerSigX2, sigLineY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.text('Checked by', (centerSigX1 + centerSigX2) / 2, sigLineY + 3.9, {
      align: 'center',
    });

    // RIGHT: Technologist Designation & Signature
    const rightSigX1 = centerSigX2 + colGap;
    const rightSigX2 = pageWidth - marginX;
    doc.line(rightSigX1, sigLineY, rightSigX2, sigLineY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text('PREPARED / TESTED BY', rightSigX2, sigLineY + 3.6, { align: 'right' });
    if (signatures.resolvedTechName) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.text(signatures.resolvedTechName, rightSigX2, sigLineY + 7.1, {
        align: 'right',
        maxWidth: sigColW,
      });
    }
    if (signatures.resolvedTechTitle) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(signatures.resolvedTechTitle, rightSigX2, sigLineY + 10.4, {
        align: 'right',
        maxWidth: sigColW,
      });
    }

    // Thin bottom portal verification bar
    doc.setDrawColor(160, 160, 160);
    doc.setLineWidth(0.2);
    doc.line(marginX, portalBarY, pageWidth - marginX, portalBarY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(0, 0, 0);
    doc.text(`Online Report Portal: ${portalWebsiteUrl}`, marginX, portalBarY + 3);

    const rightBarText = portalMode
      ? `Verification ID: ${invoice.invoice_no}-${invoice.patient_uid}${
          totalPages > 1 ? ` · Page ${p}/${totalPages}` : ''
        }`
      : `Scan QR code above for instant PDF report${
          totalPages > 1 ? ` · Page ${p}/${totalPages}` : ''
        }`;
    doc.text(rightBarText, pageWidth - marginX, portalBarY + 3, { align: 'right' });
  }

  const safeName = (invoice.patient_name || 'Patient').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const fileName = `${invoice.invoice_no}_${safeName}_Report.pdf`;
  doc.save(fileName);
  return fileName;
}
