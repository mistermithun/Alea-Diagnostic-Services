import type { InvoiceSummary, InvoiceTestItem, LabSettings, TestResultRow } from '../types.ts';

export function isCbcTest(test: InvoiceTestItem): boolean {
  const n = test.test_name.toLowerCase();
  return n.includes('cbc') || n.includes('complete blood count');
}

export function isUrineReTest(test: InvoiceTestItem): boolean {
  const n = test.test_name.toLowerCase();
  return n.includes('urine r/e') || n.includes('urine routine') || n.includes('urine r/m/e');
}

export function isSemenAnalysisTest(test: InvoiceTestItem): boolean {
  const n = test.test_name.toLowerCase();
  return n.includes('semen');
}

export function isStoolReTest(test: InvoiceTestItem): boolean {
  const n = test.test_name.toLowerCase();
  return n.includes('stool');
}

export function isLargeIntactPanel(test: InvoiceTestItem): boolean {
  return (
    isCbcTest(test) ||
    isUrineReTest(test) ||
    isSemenAnalysisTest(test) ||
    isStoolReTest(test)
  );
}

export function formatDepartmentHeading(categoryName: string): string {
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

export function getOrderedCbcRows(
  rows: TestResultRow[]
): Array<{ row: TestResultRow; section?: string }> {
  const indexed = rows.map((row, idx) => {
    const meta = getCbcSequenceMeta(row.parameter_name);
    return { row, idx, order: meta.order, section: meta.section };
  });
  indexed.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.idx - b.idx));
  return indexed.map(({ row, section }) => ({ row, section }));
}

export function getUrineSection(paramName: string): string {
  const lower = paramName.trim().toLowerCase();
  for (const rule of URINE_SECTIONS) {
    if (rule.match(lower)) return rule.section;
  }
  return 'Microscopic Examination';
}

export function formatNumericResultDisplay(value: string, paramName: string): string {
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

export interface DepartmentGroup {
  categoryName: string;
  departmentHeading: string;
  tests: InvoiceTestItem[];
}

export function buildDepartmentGroups(selectedTests: InvoiceTestItem[]): DepartmentGroup[] {
  const groups: DepartmentGroup[] = [];
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
}

export type DepartmentSegment =
  | { kind: 'cbc'; test: InvoiceTestItem; keepIntact: boolean }
  | { kind: 'urine'; test: InvoiceTestItem; keepIntact: boolean }
  | { kind: 'standard'; tests: InvoiceTestItem[]; keepIntact: boolean };

export function buildDepartmentSegments(deptTests: InvoiceTestItem[]): DepartmentSegment[] {
  const segments: DepartmentSegment[] = [];

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
}

export interface ResolvedSignatures {
  resolvedConsultantName: string;
  resolvedConsultantTitle: string;
  resolvedTechName: string;
  resolvedTechTitle: string;
}

export function resolveReportSignatures(params: {
  selectedTests: InvoiceTestItem[];
  invoice: InvoiceSummary;
  settings: LabSettings;
  blankConsultantOverride: boolean;
}): ResolvedSignatures {
  const { selectedTests, invoice, settings, blankConsultantOverride } = params;

  // Prepared / Tested By (Technologist)
  const techRaw =
    selectedTests.map((t) => (t.verified_by || '').trim()).find(Boolean) || '';
  const techDefaultName = (settings.technologist_name || '').trim();
  const resolvedTechName =
    techRaw && techDefaultName && techDefaultName.toLowerCase().startsWith(techRaw.toLowerCase())
      ? techDefaultName
      : techRaw || techDefaultName || 'Medical Technologist';
  const resolvedTechTitle = (settings.technologist_title || 'Medical Technologist (Lab)').trim();

  // Consultant / Pathologist
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

  return {
    resolvedConsultantName,
    resolvedConsultantTitle,
    resolvedTechName,
    resolvedTechTitle,
  };
}

export interface ReportPageDepartmentBlock {
  categoryName: string;
  departmentHeading: string;
  showDepartmentHeading: boolean;
  isSingleStandardTest: boolean;
  segment: DepartmentSegment;
}

export interface ReportPagePlan {
  pageNumber: number;
  blocks: ReportPageDepartmentBlock[];
}

export interface PlanReportPagesOptions {
  topMarginIn?: number;
  bottomMarginIn?: number;
  portalMode?: boolean;
}

function getExtraRangeLines(row: TestResultRow): number {
  const refText = (row.reference_range_text || row.normal_text || '').trim();
  if (!refText) return 0;
  const explicitLines = refText.split('\n').length - 1;
  const wrapEstimate = refText.length > 42 ? 1 : 0;
  return Math.max(explicitLines, wrapEstimate);
}

function getSingleTestMetrics(test: InvoiceTestItem): {
  paramRows: number;
  extraLines: number;
  sectionHeaders: number;
  isDensePanel: boolean;
} {
  const rows = test.results || [];
  let extraLines = 0;
  for (const r of rows) {
    extraLines += getExtraRangeLines(r);
  }

  if (isCbcTest(test)) {
    const ordered = getOrderedCbcRows(rows);
    let lastSection: string | undefined;
    let sectionHeaders = 0;
    for (const item of ordered) {
      if (item.section && item.section !== lastSection) {
        lastSection = item.section;
        sectionHeaders += 1;
      }
    }
    return {
      paramRows: rows.length,
      extraLines,
      sectionHeaders,
      isDensePanel: true,
    };
  }

  if (isUrineReTest(test)) {
    let lastSection = '';
    let sectionHeaders = 0;
    for (const r of rows) {
      const sec = getUrineSection(r.parameter_name);
      if (sec !== lastSection) {
        lastSection = sec;
        sectionHeaders += 1;
      }
    }
    return {
      paramRows: rows.length,
      extraLines,
      sectionHeaders,
      isDensePanel: true,
    };
  }

  return {
    paramRows: rows.length,
    extraLines,
    sectionHeaders: 0,
    isDensePanel: isSemenAnalysisTest(test) || isStoolReTest(test),
  };
}

/**
 * Estimates total rendered body height (in mm) for a candidate page's blocks,
 * synchronized with ReportPrintModal's dynamic typography tiers and jsPDF margins.
 */
function estimatePageBodyHeightMm(
  blocks: ReportPageDepartmentBlock[],
  categoryTotalCount: Map<string, number>
): number {
  if (blocks.length === 0) return 0;

  const pageTests = blocks.flatMap((b) =>
    b.segment.kind === 'standard' ? b.segment.tests : [b.segment.test]
  );
  const hasDensePanel = pageTests.some((t) => isLargeIntactPanel(t));
  const totalParamRows = pageTests.reduce((acc, t) => acc + (t.results?.length || 0), 0);
  const totalExtraLines = pageTests.reduce(
    (acc, t) => acc + (t.results || []).reduce((rAcc, r) => rAcc + getExtraRangeLines(r), 0),
    0
  );
  const totalSubHeaders = pageTests.length > 1 ? pageTests.length : 0;
  const effectiveUnits = totalParamRows + totalSubHeaders * 0.75 + totalExtraLines * 0.55;

  // Match ReportPrintModal's 3 typography tiers + dense panel tier
  let rowHeightMm = 7.4;
  let extraLineMm = 3.2;
  if (!hasDensePanel) {
    if (effectiveUnits <= 5) {
      rowHeightMm = 11.2;
      extraLineMm = 4.0;
    } else if (effectiveUnits <= 11) {
      rowHeightMm = 9.0;
      extraLineMm = 3.6;
    }
  } else if (pageTests.length === 1) {
    rowHeightMm = isCbcTest(pageTests[0]) ? 6.1 : 5.7;
    extraLineMm = 3.1;
  } else {
    rowHeightMm = 6.5;
    extraLineMm = 3.1;
  }

  let totalMm = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (i > 0) {
      totalMm += 7.5; // mt-5 pt-2 inter-block spacing
    }
    if (block.showDepartmentHeading) {
      totalMm += 11.5; // boxed department header + bottom margin
      if (block.isSingleStandardTest && block.segment.kind === 'standard') {
        totalMm += 5.0; // centered single test subtitle
      }
    }

    totalMm += 7.0; // table <thead> header row

    const seg = block.segment;
    const catCount = categoryTotalCount.get(block.categoryName.toLowerCase()) || 1;

    if (seg.kind === 'cbc' || seg.kind === 'urine') {
      const m = getSingleTestMetrics(seg.test);
      if (catCount > 1) {
        totalMm += 6.2; // test name row inside CBC/Urine table
      }
      totalMm += m.sectionHeaders * 5.2;
      totalMm += Math.max(m.paramRows, 1) * rowHeightMm + m.extraLines * extraLineMm;
    } else {
      for (const t of seg.tests) {
        const m = getSingleTestMetrics(t);
        if (!block.isSingleStandardTest) {
          totalMm += 6.2; // test name subheader row
        }
        totalMm += Math.max(m.paramRows, 1) * rowHeightMm + m.extraLines * extraLineMm;
      }
    }
  }

  return totalMm;
}

/**
 * Continuous-flow intelligent A4 pagination:
 * - No forced page breaks between departments or small/medium tests.
 * - Tests flow naturally one after another on the same A4 page as long as they fit
 *   within the remaining vertical space above the repeating signature footer.
 * - Same-department consecutive standard tests on the same page merge cleanly into one table.
 * - A test section moves to a fresh page ONLY when it exceeds remaining vertical space.
 * - Oversized single panels taller than one full page gracefully allow table splitting.
 */
export function planReportPages(
  selectedTests: InvoiceTestItem[],
  options?: PlanReportPagesOptions
): ReportPagePlan[] {
  if (!selectedTests || selectedTests.length === 0) return [];

  const topPadMm = options?.portalMode
    ? 27
    : Math.max(8, (options?.topMarginIn ?? 1.5) * 25.4);
  const bottomPadMm = options?.portalMode
    ? 8
    : Math.max(6, (options?.bottomMarginIn ?? 0.4) * 25.4);
  const patientHeaderMm = 29;
  const footerMm = 26;
  const totalPageMm = 289;
  const availableBodyMm = Math.max(
    115,
    totalPageMm - topPadMm - patientHeaderMm - bottomPadMm - footerMm
  );

  const deptGroups = buildDepartmentGroups(selectedTests);
  const categoryTotalCount = new Map<string, number>();
  for (const dept of deptGroups) {
    categoryTotalCount.set(dept.categoryName.toLowerCase(), dept.tests.length);
  }

  const pages: Array<{ blocks: ReportPageDepartmentBlock[] }> = [{ blocks: [] }];

  const buildUnitBlock = (
    categoryName: string,
    departmentHeading: string,
    test: InvoiceTestItem,
    showDepartmentHeading: boolean
  ): ReportPageDepartmentBlock => {
    const catCount = categoryTotalCount.get(categoryName.toLowerCase()) || 1;
    if (isCbcTest(test)) {
      return {
        categoryName,
        departmentHeading,
        showDepartmentHeading,
        isSingleStandardTest: false,
        segment: { kind: 'cbc', test, keepIntact: true },
      };
    }
    if (isUrineReTest(test)) {
      return {
        categoryName,
        departmentHeading,
        showDepartmentHeading,
        isSingleStandardTest: false,
        segment: { kind: 'urine', test, keepIntact: true },
      };
    }
    return {
      categoryName,
      departmentHeading,
      showDepartmentHeading,
      isSingleStandardTest: catCount === 1 && showDepartmentHeading,
      segment: { kind: 'standard', tests: [test], keepIntact: true },
    };
  };

  const tryAppendTestToPage = (
    pageBlocks: ReportPageDepartmentBlock[],
    categoryName: string,
    departmentHeading: string,
    test: InvoiceTestItem
  ): ReportPageDepartmentBlock[] => {
    const cloned = pageBlocks.map((b) => ({
      ...b,
      segment:
        b.segment.kind === 'standard'
          ? { ...b.segment, tests: [...b.segment.tests] }
          : { ...b.segment },
    }));

    const isSpecial = isCbcTest(test) || isUrineReTest(test);
    const lastBlock = cloned[cloned.length - 1];
    const sameDeptAsLast =
      Boolean(lastBlock) &&
      lastBlock.categoryName.toLowerCase() === categoryName.toLowerCase();

    if (!isSpecial && lastBlock && sameDeptAsLast && lastBlock.segment.kind === 'standard') {
      // Merge consecutive standard tests of the same department on the same page
      lastBlock.segment.tests.push(test);
      lastBlock.isSingleStandardTest = false;
      return cloned;
    }

    const showDeptHeading = !sameDeptAsLast;
    cloned.push(buildUnitBlock(categoryName, departmentHeading, test, showDeptHeading));
    return cloned;
  };

  for (const dept of deptGroups) {
    for (const test of dept.tests) {
      const currentPage = pages[pages.length - 1];

      if (currentPage.blocks.length === 0) {
        const candidateBlocks = tryAppendTestToPage(
          currentPage.blocks,
          dept.categoryName,
          dept.departmentHeading,
          test
        );
        const estimatedMm = estimatePageBodyHeightMm(candidateBlocks, categoryTotalCount);
        if (estimatedMm > availableBodyMm) {
          // Single panel taller than 1 full A4 page: allow graceful multi-page row splitting
          candidateBlocks[candidateBlocks.length - 1].segment.keepIntact = false;
        }
        currentPage.blocks = candidateBlocks;
        continue;
      }

      const candidateBlocks = tryAppendTestToPage(
        currentPage.blocks,
        dept.categoryName,
        dept.departmentHeading,
        test
      );
      const estimatedMm = estimatePageBodyHeightMm(candidateBlocks, categoryTotalCount);

      if (estimatedMm <= availableBodyMm) {
        currentPage.blocks = candidateBlocks;
      } else {
        // Exceeds remaining space on current page — move cleanly to a fresh A4 page
        const freshBlocks = tryAppendTestToPage(
          [],
          dept.categoryName,
          dept.departmentHeading,
          test
        );
        const freshMm = estimatePageBodyHeightMm(freshBlocks, categoryTotalCount);
        if (freshMm > availableBodyMm) {
          freshBlocks[freshBlocks.length - 1].segment.keepIntact = false;
        }
        pages.push({ blocks: freshBlocks });
      }
    }
  }

  return pages
    .filter((p) => p.blocks.length > 0)
    .map((p, idx) => ({
      pageNumber: idx + 1,
      blocks: p.blocks,
    }));
}


