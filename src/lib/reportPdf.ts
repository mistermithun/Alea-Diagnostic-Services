import { jsPDF } from 'jspdf';
import autoTable, { type RowInput } from 'jspdf-autotable';
import { formatAge, formatDateTime } from './api.ts';
import {
  deduplicateTestResults,
  formatNumericResultDisplay,
  getOrderedCbcRows,
  getUrineSection,
  planReportPages,
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

function getLastAutoTableFinalY(doc: jsPDF): number {
  const withTable = doc as unknown as { lastAutoTable?: { finalY: number } };
  return withTable.lastAutoTable?.finalY ?? 60;
}

/**
 * Generates and downloads a multi-page A4 clinical diagnostic report PDF:
 * - Respects Pre-Printed Offset Pad blank header/footer margins OR Digital Letterhead mode
 * - Matches exact A4 page separation from planReportPages (CBC, Urine R/E, Departments)
 * - Repeats Patient Info Header + QR code on EVERY page
 * - Repeats swapped 3-column signature block (Consultant left, Checked by center, Technologist right) on EVERY page
 */
export function exportDiagnosticReportPdf(opts: ExportReportPdfOptions): string {
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

  // Compute Patient Header height dynamically so wrapped patient/doctor/specimen lines never clip
  const qrSize = qrDataUrl ? 16 : 0;
  const infoAreaWidth = qrDataUrl ? contentWidth - qrSize - 6 : contentWidth;
  const colLeftW = infoAreaWidth * 0.48;
  const colRightW = infoAreaWidth * 0.5;
  const labelLeftW = 19;
  const labelRightW = 21;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  const nameLines = doc.splitTextToSize(invoice.patient_name || '—', colLeftW - labelLeftW);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.2);
  const ageSexStr = `${formatAge(invoice.age_years, invoice.age_months, invoice.age_days)} / ${invoice.gender}`;
  const idInvStr = `${invoice.patient_uid} / ${invoice.invoice_no}`;
  const specimenLines = doc.splitTextToSize(combinedSpecimens || '—', colLeftW - labelLeftW);

  const refByStr = invoice.doctor_name
    ? `${invoice.doctor_name}${invoice.doctor_degree ? `, ${invoice.doctor_degree}` : ''}`
    : 'Self';
  const refByLines = doc.splitTextToSize(refByStr, colRightW - labelRightW);
  const contactLines = doc.splitTextToSize(invoice.patient_mobile || '—', colRightW - labelRightW);

  const leftRowsH =
    nameLines.length * 4 +
    4.2 + // Age/Sex
    4.2 + // ID / Inv No
    Math.max(1, specimenLines.length) * 3.8;
  const rightRowsH =
    4.2 + // Reg Date
    4.2 + // Report Date
    Math.max(1, refByLines.length) * 3.8 +
    Math.max(1, contactLines.length) * 3.8;
  const patientBoxHeightMm = Math.max(leftRowsH, rightRowsH, qrDataUrl ? 21 : 17) + 3;

  const headerBottomY = topPadMm + letterheadHeightMm + patientBoxHeightMm;
  const contentTopY = headerBottomY + 4;

  // Footer reserved clearance at bottom of EVERY A4 page
  const footerHeightMm = 23;
  const footerReserveBottomMm = bottomPadMm + footerHeightMm + 3;

  const drawDepartmentBadge = (yPos: number, title: string): number => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    const textW = doc.getTextWidth(title);
    const boxW = Math.max(46, textW + 16);
    const boxH = 6.5;
    const boxX = (pageWidth - boxW) / 2;

    // Subtle crisp black offset shadow matching print preview
    doc.setFillColor(0, 0, 0);
    doc.rect(boxX + 0.6, yPos + 0.6, boxW, boxH, 'F');

    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.35);
    doc.rect(boxX, yPos, boxW, boxH, 'FD');

    doc.setTextColor(0, 0, 0);
    doc.text(title, pageWidth / 2, yPos + 4.5, { align: 'center' });
    return yPos + boxH + 3;
  };

  if (!selectedTests || selectedTests.length === 0) {
    throw new Error('Select at least one test before downloading the PDF report.');
  }

  const plannedPages = planReportPages(selectedTests, {
    topMarginIn,
    bottomMarginIn,
    portalMode,
  });

  for (let pageIdx = 0; pageIdx < plannedPages.length; pageIdx++) {
    if (pageIdx > 0) {
      doc.addPage();
    }
    let cursorY = contentTopY;
    const plan = plannedPages[pageIdx];

    for (const block of plan.blocks) {
      const seg = block.segment;
      const showDeptHeading = block.showDepartmentHeading;
      const isSingleStandard = block.isSingleStandardTest;

      // Guard against an orphaned department heading near the bottom signature zone
      if (cursorY + 26 > pageHeight - footerReserveBottomMm) {
        doc.addPage();
        cursorY = contentTopY;
      }

      if (showDeptHeading) {
        cursorY = drawDepartmentBadge(cursorY, block.departmentHeading);
        if (isSingleStandard && seg.kind === 'standard') {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9);
          doc.setTextColor(0, 0, 0);
          doc.text(seg.tests[0].test_name, pageWidth / 2, cursorY + 1, { align: 'center' });
          cursorY += 4;
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
                fontSize: 8.5,
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
                  fontSize: 7.4,
                  cellPadding: { top: 1.5, bottom: 1, left: 2.2, right: 2.2 },
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
              styles: { textColor: [40, 48, 60] },
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
            fontSize: 8.4,
            cellPadding: { top: 1.2, bottom: 1.2, left: 2.2, right: 2.2 },
            textColor: [0, 0, 0],
            lineColor: [224, 228, 234],
            lineWidth: 0.2,
          },
          headStyles: {
            fillColor: [248, 250, 252],
            textColor: [71, 85, 105],
            fontStyle: 'bold',
            fontSize: 7.8,
            lineColor: [216, 222, 230],
            lineWidth: 0.25,
          },
          columnStyles: {
            0: { cellWidth: contentWidth * 0.34 },
            1: { cellWidth: contentWidth * 0.22 },
            2: { cellWidth: contentWidth * 0.44 },
          },
        });
        cursorY = getLastAutoTableFinalY(doc) + 4.5;
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
                fontSize: 8.5,
              },
            },
          ]);
        }

        let lastSection = '';
        for (const r of deduplicateTestResults(seg.test.results || [])) {
          const sec = getUrineSection(r.parameter_name);
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
                  fontSize: 7.4,
                  cellPadding: { top: 1.4, bottom: 0.9, left: 2.2, right: 2.2 },
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
              styles: { textColor: [40, 48, 60] },
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
            fontSize: 8.2,
            cellPadding: { top: 1.05, bottom: 1.05, left: 2.2, right: 2.2 },
            textColor: [0, 0, 0],
            lineColor: [224, 228, 234],
            lineWidth: 0.2,
          },
          headStyles: {
            fillColor: [248, 250, 252],
            textColor: [71, 85, 105],
            fontStyle: 'bold',
            fontSize: 7.8,
            lineColor: [216, 222, 230],
            lineWidth: 0.25,
          },
          columnStyles: {
            0: { cellWidth: contentWidth * 0.34 },
            1: { cellWidth: contentWidth * 0.22 },
            2: { cellWidth: contentWidth * 0.44 },
          },
        });
        cursorY = getLastAutoTableFinalY(doc) + 4.5;
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
                  fontSize: 8.6,
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
                styles: { fontStyle: isAbnormal ? 'bold' : 'bold' },
              },
              {
                content: r.reference_range_text || r.normal_text || '—',
                styles: { textColor: [40, 48, 60] },
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
            fontSize: 8.8,
            cellPadding: { top: 1.8, bottom: 1.8, left: 2.4, right: 2.4 },
            textColor: [0, 0, 0],
            lineColor: [224, 228, 234],
            lineWidth: 0.2,
          },
          headStyles: {
            fillColor: [248, 250, 252],
            textColor: [71, 85, 105],
            fontStyle: 'bold',
            fontSize: 8,
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
        cursorY = getLastAutoTableFinalY(doc) + 5;
      }
    }
  }

  // Stamp repeating top chrome (Letterhead + Patient Header + QR) and bottom Signature Footer on EVERY A4 page
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);

    let y = topPadMm;

    // 1. Digital Letterhead (Portal / QR digital download mode)
    if (portalMode) {
      doc.setFillColor(0, 0, 0);
      doc.roundedRect(marginX, y, 9.5, 9.5, 2, 2, 'F');
      doc.setFillColor(255, 255, 255);
      doc.rect(marginX + 3.9, y + 2, 1.7, 5.5, 'F');
      doc.rect(marginX + 2, y + 3.9, 5.5, 1.7, 'F');

      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12.5);
      doc.text(settings.lab_name, marginX + 12, y + 4);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(settings.lab_address, marginX + 12, y + 7.5);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text(
        'Department of Pathology & Clinical Diagnostics · Digital Verified Report',
        marginX + 12,
        y + 11
      );

      doc.setFontSize(7);
      doc.text('OFFICIAL TEST REPORT', pageWidth - marginX, y + 3.5, { align: 'right' });
      doc.setFontSize(8.5);
      doc.text(invoice.invoice_no, pageWidth - marginX, y + 7.5, { align: 'right' });

      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(0.5);
      doc.line(marginX, y + 14, pageWidth - marginX, y + 14);
      y += letterheadHeightMm;
    }

    // 2. Repeating Two-Column Patient Info Header + QR Code
    const leftX = marginX;
    const rightX = marginX + colLeftW + 3;

    let ly = y + 3.2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(95, 105, 120);
    doc.text('PATIENT', leftX, ly);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(0, 0, 0);
    doc.text(nameLines, leftX + labelLeftW, ly);
    ly += nameLines.length * 4;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(95, 105, 120);
    doc.text('AGE / SEX', leftX, ly);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.setTextColor(0, 0, 0);
    doc.text(ageSexStr, leftX + labelLeftW, ly);
    ly += 4.2;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(95, 105, 120);
    doc.text('ID / INV NO', leftX, ly);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.setTextColor(0, 0, 0);
    doc.text(idInvStr, leftX + labelLeftW, ly);
    ly += 4.2;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(95, 105, 120);
    doc.text('SPECIMEN', leftX, ly);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.2);
    doc.setTextColor(0, 0, 0);
    doc.text(specimenLines, leftX + labelLeftW, ly);

    let ry = y + 3.2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(95, 105, 120);
    doc.text('REG. DATE', rightX, ry);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.2);
    doc.setTextColor(0, 0, 0);
    doc.text(formatDateTime(primaryCollectedAt), rightX + labelRightW, ry);
    ry += 4.2;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(95, 105, 120);
    doc.text('REPORT DATE', rightX, ry);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.2);
    doc.setTextColor(0, 0, 0);
    doc.text(formatDateTime(primaryReportedAt), rightX + labelRightW, ry);
    ry += 4.2;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(95, 105, 120);
    doc.text('REFERRED BY', rightX, ry);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.2);
    doc.setTextColor(0, 0, 0);
    doc.text(refByLines, rightX + labelRightW, ry);
    ry += Math.max(1, refByLines.length) * 3.8;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(95, 105, 120);
    doc.text('CONTACT', rightX, ry);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.2);
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

    // 3. Repeating Swapped Bottom 3-Column Signature Block on EVERY page
    const footerBottomY = pageHeight - bottomPadMm;
    const portalBarY = footerBottomY - 3.5;
    const sigLineY = footerBottomY - 16;
    const colGap = 8;
    const sigColW = (contentWidth - colGap * 2) / 3;

    // LEFT: Consultant / Pathologist (always visible)
    const leftSigX1 = marginX;
    const leftSigX2 = marginX + sigColW;
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.3);
    doc.line(leftSigX1, sigLineY, leftSigX2, sigLineY);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(0, 0, 0);
    doc.text('CONSULTANT / PATHOLOGIST', leftSigX1, sigLineY + 3.5);
    if (signatures.resolvedConsultantName) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.text(signatures.resolvedConsultantName, leftSigX1, sigLineY + 6.8, {
        maxWidth: sigColW,
      });
      if (signatures.resolvedConsultantTitle) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.text(signatures.resolvedConsultantTitle, leftSigX1, sigLineY + 10, {
          maxWidth: sigColW,
        });
      }
    }

    // CENTER: Checked By
    const centerSigX1 = leftSigX2 + colGap;
    const centerSigX2 = centerSigX1 + sigColW;
    doc.line(centerSigX1, sigLineY, centerSigX2, sigLineY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.8);
    doc.text('Checked by', (centerSigX1 + centerSigX2) / 2, sigLineY + 3.8, {
      align: 'center',
    });

    // RIGHT: Technologist Designation & Signature
    const rightSigX1 = centerSigX2 + colGap;
    const rightSigX2 = pageWidth - marginX;
    doc.line(rightSigX1, sigLineY, rightSigX2, sigLineY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.text('PREPARED / TESTED BY', rightSigX2, sigLineY + 3.5, { align: 'right' });
    if (signatures.resolvedTechName) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.text(signatures.resolvedTechName, rightSigX2, sigLineY + 6.8, {
        align: 'right',
        maxWidth: sigColW,
      });
    }
    if (signatures.resolvedTechTitle) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.text(signatures.resolvedTechTitle, rightSigX2, sigLineY + 10, {
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
