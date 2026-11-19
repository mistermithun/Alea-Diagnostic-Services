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
      n.includes('colour') ||
      n.includes('appearance') ||
      n.includes('turbidity') ||
      n.includes('sediment') ||
      n.includes('specific gravity') ||
      n.includes('reaction') ||
      n === 'ph' ||
      /\bph\b/.test(n) ||
      n.includes('(ph)') ||
      n.includes('volume') ||
      n.includes('odor') ||
      n.includes('odour'),
    section: 'Physical Examination',
  },
  {
    match: (n) =>
      !n.includes('red blood') &&
      !n.includes('rbc') &&
      (n.includes('albumin') ||
        n.includes('protein') ||
        n.includes('sugar') ||
        n.includes('glucose') ||
        n.includes('ketone') ||
        n.includes('bilirubin') ||
        n.includes('urobilinogen') ||
        n.includes('nitrite') ||
        n.includes('leukocyte') ||
        n.includes('leucocyte') ||
        n.includes('bile') ||
        n.includes('reducing') ||
        n.includes('blood')),
    section: 'Chemical Examination',
  },
  {
    match: () => true,
    section: 'Microscopic Examination',
  },
];

const URINE_SECTION_ORDER: Record<string, number> = {
  'Physical Examination': 0,
  'Chemical Examination': 1,
  'Microscopic Examination': 2,
};

const CBC_SECTION_ORDER: Record<string, number> = {
  '': 0,
  'ESR (Westergren Method)': 1,
  'Total Count': 2,
  'Differential WBC Count': 3,
  'RBC Indices & Parameters': 4,
  'Additional Parameters': 5,
};

export function getCanonicalParameterKey(paramName: string): string {
  const n = (paramName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!n) return '';

  // Haematology / CBC canonical aliases (handles both legacy short names & full formal names)
  if (
    n === 'hb' ||
    n === 'hemoglobin' ||
    n === 'haemoglobin' ||
    n.includes('hemoglobin (hb)') ||
    n.includes('haemoglobin (hb)') ||
    (n.startsWith('hemoglobin') && !n.includes('occult') && !n.includes('urine')) ||
    (n.startsWith('haemoglobin') && !n.includes('occult') && !n.includes('urine'))
  ) {
    return 'cbc:hemoglobin';
  }
  if (n.startsWith('esr') || n.includes('erythrocyte sedimentation')) {
    return 'cbc:esr';
  }
  if (n === 'total wbc' || n.includes('total wbc count') || n === 'wbc count' || n === 'wbc') {
    return 'cbc:wbc';
  }
  if (n === 'total rbc' || n.includes('total rbc count') || n === 'rbc count' || n === 'rbc') {
    return 'cbc:rbc';
  }
  if (n.includes('platelet count') || n === 'platelets' || n === 'platelet') {
    return 'cbc:platelet';
  }
  if (n.includes('circulating eosinophil')) {
    return 'cbc:circulating_eosinophil';
  }
  if (n.startsWith('neutrophil')) {
    return 'cbc:neutrophils';
  }
  if (n.startsWith('lymphocyte')) {
    return 'cbc:lymphocytes';
  }
  if (n.startsWith('eosinophil')) {
    return 'cbc:eosinophils';
  }
  if (n.startsWith('monocyte')) {
    return 'cbc:monocytes';
  }
  if (n.startsWith('basophil')) {
    return 'cbc:basophils';
  }
  if (n.includes('pcv') || n.includes('hematocrit') || n === 'hct' || n.includes('/ hct')) {
    return 'cbc:pcv';
  }
  if (n === 'mcv' || n.startsWith('mcv ') || n.startsWith('mcv(')) {
    return 'cbc:mcv';
  }
  if (n === 'mch' || n.startsWith('mch ') || n.startsWith('mch(')) {
    return 'cbc:mch';
  }
  if (n === 'mchc' || n.startsWith('mchc ') || n.startsWith('mchc(')) {
    return 'cbc:mchc';
  }

  return n;
}

function hasValidResultValue(value: unknown): boolean {
  const s = String(value ?? '').trim();
  return s !== '' && s.toLowerCase() !== 'pending';
}

function scoreResultRowRichness(row: Partial<TestResultRow>): number {
  let score = 0;
  if (hasValidResultValue(row.result_value)) score += 1000;
  if ((row.normal_text || '').trim()) score += 50;
  if ((row.reference_range_text || '').trim()) score += 25;
  if ((row.unit || '').trim()) score += 10;
  if (typeof row.id === 'number') score += Math.min(9, row.id / 1_000_000);
  return score;
}

/**
 * Strictly deduplicates test result rows by canonical parameter key & parameter_id.
 * When duplicate rows exist for the same parameter (e.g., one filled and one "Pending"),
 * always keeps the valid/non-empty result row and preserves natural sort order.
 */
export function deduplicateTestResults<T extends Partial<TestResultRow>>(
  rows: T[] | undefined | null
): T[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const deduped: T[] = [];
  const byKey = new Map<string, number>();
  const byParamId = new Map<number, number>();

  for (const row of rows) {
    const canonKey = getCanonicalParameterKey(row.parameter_name || '');
    const pid = typeof row.parameter_id === 'number' && row.parameter_id > 0 ? row.parameter_id : null;

    let existingIdx: number | undefined;
    if (canonKey && byKey.has(canonKey)) {
      existingIdx = byKey.get(canonKey);
    } else if (pid !== null && byParamId.has(pid)) {
      existingIdx = byParamId.get(pid);
    }

    if (existingIdx === undefined) {
      const nextIdx = deduped.length;
      deduped.push(row);
      if (canonKey) byKey.set(canonKey, nextIdx);
      if (pid !== null) byParamId.set(pid, nextIdx);
    } else {
      const existing = deduped[existingIdx];
      if (scoreResultRowRichness(row) > scoreResultRowRichness(existing)) {
        // Keep earliest sort_order if the winning duplicate has a higher/later sort_order
        const merged = {
          ...row,
          sort_order: existing.sort_order ?? row.sort_order,
        };
        deduped[existingIdx] = merged;
        if (pid !== null) byParamId.set(pid, existingIdx);
      }
    }
  }

  return deduped
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => {
      const sa = typeof a.row.sort_order === 'number' && a.row.sort_order > 0 ? a.row.sort_order : a.idx + 10000;
      const sb = typeof b.row.sort_order === 'number' && b.row.sort_order > 0 ? b.row.sort_order : b.idx + 10000;
      return sa !== sb ? sa - sb : a.idx - b.idx;
    })
    .map((item) => item.row);
}

function getCbcSequenceMeta(paramName: string): { order: number; section?: string } {
  const lower = paramName.trim().toLowerCase();
  for (let i = 0; i < CBC_ORDER_KEYS.length; i++) {
    if (CBC_ORDER_KEYS[i].match(lower)) {
      return { order: i, section: CBC_ORDER_KEYS[i].section };
    }
  }
  if (lower === 'wbc' || lower === 'wbc count') {
    return { order: 2, section: 'Total Count' };
  }
  if (lower === 'rbc' || lower === 'rbc count') {
    return { order: 3, section: 'Total Count' };
  }
  return { order: 999, section: 'Additional Parameters' };
}

export function getOrderedCbcRows(
  rows: TestResultRow[]
): Array<{ row: TestResultRow; section?: string }> {
  const uniqueRows = deduplicateTestResults(rows);
  const indexed = uniqueRows.map((row, idx) => {
    const meta = getCbcSequenceMeta(row.parameter_name);
    const secKey = meta.section || '';
    const sectionRank = CBC_SECTION_ORDER[secKey] ?? 5;
    const sortVal = typeof row.sort_order === 'number' && row.sort_order > 0 ? row.sort_order : meta.order + 1000;
    return { row, idx, sectionRank, sortVal, defaultOrder: meta.order, section: meta.section };
  });
  indexed.sort((a, b) => {
    if (a.sectionRank !== b.sectionRank) return a.sectionRank - b.sectionRank;
    if (a.sortVal !== b.sortVal) return a.sortVal - b.sortVal;
    if (a.defaultOrder !== b.defaultOrder) return a.defaultOrder - b.defaultOrder;
    return a.idx - b.idx;
  });
  return indexed.map(({ row, section }) => ({ row, section }));
}

export function getUrineSection(paramName: string): string {
  const lower = paramName.trim().toLowerCase();
  for (const rule of URINE_SECTIONS) {
    if (rule.match(lower)) return rule.section;
  }
  return 'Microscopic Examination';
}

export function getOrderedUrineRows(
  rows: TestResultRow[]
): Array<{ row: TestResultRow; section: string }> {
  const uniqueRows = deduplicateTestResults(rows);
  const indexed = uniqueRows.map((row, idx) => {
    const section = getUrineSection(row.parameter_name);
    const sectionRank = URINE_SECTION_ORDER[section] ?? 2;
    const sortVal = typeof row.sort_order === 'number' && row.sort_order > 0 ? row.sort_order : idx + 10000;
    return { row, idx, sectionRank, sortVal, section };
  });
  indexed.sort((a, b) => {
    if (a.sectionRank !== b.sectionRank) return a.sectionRank - b.sectionRank;
    if (a.sortVal !== b.sortVal) return a.sortVal - b.sortVal;
    return a.idx - b.idx;
  });
  return indexed.map(({ row, section }) => ({ row, section }));
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
  const rows = deduplicateTestResults(test.results || []);
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
      paramRows: ordered.length,
      extraLines,
      sectionHeaders,
      isDensePanel: true,
    };
  }

  if (isUrineReTest(test)) {
    const ordered = getOrderedUrineRows(rows);
    let lastSection = '';
    let sectionHeaders = 0;
    for (const item of ordered) {
      if (item.section !== lastSection) {
        lastSection = item.section;
        sectionHeaders += 1;
      }
    }
    return {
      paramRows: ordered.length,
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

export type ReportTypographyTier =
  | 'cbc'
  | 'urine'
  | 'ultra_short'
  | 'short'
  | 'medium'
  | 'dense';

export interface ReportTypographyProfile {
  tier: ReportTypographyTier;
  patientNameClass: string;
  patientGridClass: string;
  patientLabelClass: string;
  patientLeftLabelWidth: string;
  patientRightLabelWidth: string;
  patientRowSpaceClass: string;
  patientSectionPadClass: string;
  deptHeadingClass: string;
  testSubtitleClass: string;
  theadClass: string;
  thPadClass: string;
  subHeaderClass: string;
  tbodyClass: string;
  unitClass: string;
  normalClass: string;
  rowPadClass: string;
  cellPadXClass: string;
  sectionClass: string;
  sectionPadClass: string;
  pdf: {
    patientNamePt: number;
    patientLabelPt: number;
    patientValuePt: number;
    patientLineH: number;
    deptHeadingPt: number;
    testSubtitlePt: number;
    headPt: number;
    headPadV: number;
    subHeaderPt: number;
    sectionPt: number;
    bodyPt: number;
    normalPt: number;
    bodyPadV: number;
    bodyPadH: number;
    blockGapMm: number;
  };
}

export function getPageTypographyProfile(
  blocks: ReportPageDepartmentBlock[]
): ReportTypographyProfile {
  const pageTests = blocks.flatMap((b) =>
    b.segment.kind === 'standard' ? b.segment.tests : [b.segment.test]
  );
  const hasSpecialDenseTest = pageTests.some((t) => isLargeIntactPanel(t));

  if (hasSpecialDenseTest) {
    const onlyCbc = pageTests.length === 1 && isCbcTest(pageTests[0]);
    if (onlyCbc) {
      return {
        tier: 'cbc',
        patientNameClass: 'text-[14.5px] leading-[1.2]',
        patientGridClass: 'text-[12px] leading-[1.32]',
        patientLabelClass: 'text-[10px]',
        patientLeftLabelWidth: 'w-[70px]',
        patientRightLabelWidth: 'w-[78px]',
        patientRowSpaceClass: 'space-y-1',
        patientSectionPadClass: 'pb-2',
        deptHeadingClass: 'text-[14.5px]',
        testSubtitleClass: 'text-[11.5px]',
        theadClass: 'text-[11.5px]',
        thPadClass: 'py-1.5 px-2.5',
        subHeaderClass: 'text-[11.5px] py-1',
        tbodyClass: 'text-[12.5px] leading-[1.26]',
        unitClass: 'text-[11px]',
        normalClass: 'text-[11px] leading-[1.22]',
        rowPadClass: 'py-[2.5px]',
        cellPadXClass: 'px-2.5',
        sectionClass: 'text-[10.5px]',
        sectionPadClass: 'pt-1.5 pb-0.5',
        pdf: {
          patientNamePt: 10.5,
          patientLabelPt: 7.5,
          patientValuePt: 8.8,
          patientLineH: 4.1,
          deptHeadingPt: 10.8,
          testSubtitlePt: 9,
          headPt: 8.4,
          headPadV: 1.4,
          subHeaderPt: 8.6,
          sectionPt: 7.8,
          bodyPt: 9.1,
          normalPt: 8.4,
          bodyPadV: 1.25,
          bodyPadH: 2.2,
          blockGapMm: 4.5,
        },
      };
    }

    return {
      tier: 'urine',
      patientNameClass: 'text-[14.5px] leading-[1.2]',
      patientGridClass: 'text-[12px] leading-[1.32]',
      patientLabelClass: 'text-[10px]',
      patientLeftLabelWidth: 'w-[70px]',
      patientRightLabelWidth: 'w-[78px]',
      patientRowSpaceClass: 'space-y-1',
      patientSectionPadClass: 'pb-2',
      deptHeadingClass: 'text-[14.5px]',
      testSubtitleClass: 'text-[11.5px]',
      theadClass: 'text-[11.5px]',
      thPadClass: 'py-1.5 px-2.5',
      subHeaderClass: 'text-[11.5px] py-1',
      tbodyClass: 'text-[12px] leading-[1.24]',
      unitClass: 'text-[11px]',
      normalClass: 'text-[11px] leading-[1.2]',
      rowPadClass: 'py-[2px]',
      cellPadXClass: 'px-2.5',
      sectionClass: 'text-[10.5px]',
      sectionPadClass: 'pt-1 pb-0.5',
      pdf: {
        patientNamePt: 10.5,
        patientLabelPt: 7.5,
        patientValuePt: 8.8,
        patientLineH: 4.1,
        deptHeadingPt: 10.8,
        testSubtitlePt: 9,
        headPt: 8.4,
        headPadV: 1.35,
        subHeaderPt: 8.6,
        sectionPt: 7.8,
        bodyPt: 8.8,
        normalPt: 8.2,
        bodyPadV: 1.05,
        bodyPadH: 2.2,
        blockGapMm: 4.5,
      },
    };
  }

  const totalParamRows = pageTests.reduce(
    (acc, t) => acc + deduplicateTestResults(t.results || []).length,
    0
  );
  const totalSubHeaders = pageTests.length > 1 ? pageTests.length : 0;
  const extraRangeLines = pageTests.reduce(
    (acc, t) =>
      acc +
      deduplicateTestResults(t.results || []).reduce(
        (rAcc, row) => rAcc + getExtraRangeLines(row),
        0
      ),
    0
  );

  const effectiveUnits = totalParamRows + totalSubHeaders * 0.75 + extraRangeLines * 0.55;

  if (effectiveUnits <= 2.5) {
    return {
      tier: 'ultra_short',
      patientNameClass: 'text-[16px] leading-[1.22]',
      patientGridClass: 'text-[13px] leading-[1.38]',
      patientLabelClass: 'text-[10.5px]',
      patientLeftLabelWidth: 'w-[74px]',
      patientRightLabelWidth: 'w-[82px]',
      patientRowSpaceClass: 'space-y-1.5',
      patientSectionPadClass: 'pb-2.5',
      deptHeadingClass: 'text-[16px]',
      testSubtitleClass: 'text-[13px]',
      theadClass: 'text-[12.5px]',
      thPadClass: 'py-2.5 px-3',
      subHeaderClass: 'text-[13px] py-1.5',
      tbodyClass: 'text-[15px] leading-[1.48]',
      unitClass: 'text-[13.5px]',
      normalClass: 'text-[13.5px] leading-[1.4]',
      rowPadClass: 'py-3.5',
      cellPadXClass: 'px-3',
      sectionClass: 'text-[11.5px]',
      sectionPadClass: 'pt-2 pb-1',
      pdf: {
        patientNamePt: 11.5,
        patientLabelPt: 8.0,
        patientValuePt: 9.5,
        patientLineH: 4.4,
        deptHeadingPt: 11.5,
        testSubtitlePt: 9.8,
        headPt: 9.2,
        headPadV: 2.2,
        subHeaderPt: 9.6,
        sectionPt: 8.4,
        bodyPt: 11.0,
        normalPt: 10.0,
        bodyPadV: 3.2,
        bodyPadH: 2.8,
        blockGapMm: 6.0,
      },
    };
  }

  if (effectiveUnits <= 5.5) {
    return {
      tier: 'short',
      patientNameClass: 'text-[15.5px] leading-[1.22]',
      patientGridClass: 'text-[12.5px] leading-[1.36]',
      patientLabelClass: 'text-[10.5px]',
      patientLeftLabelWidth: 'w-[74px]',
      patientRightLabelWidth: 'w-[82px]',
      patientRowSpaceClass: 'space-y-1.5',
      patientSectionPadClass: 'pb-2.5',
      deptHeadingClass: 'text-[15.5px]',
      testSubtitleClass: 'text-[12.5px]',
      theadClass: 'text-[12px]',
      thPadClass: 'py-2 px-3',
      subHeaderClass: 'text-[12.5px] py-1.5',
      tbodyClass: 'text-[14px] leading-[1.44]',
      unitClass: 'text-[12.5px]',
      normalClass: 'text-[12.5px] leading-[1.38]',
      rowPadClass: 'py-2.5',
      cellPadXClass: 'px-3',
      sectionClass: 'text-[11px]',
      sectionPadClass: 'pt-2 pb-0.5',
      pdf: {
        patientNamePt: 11.2,
        patientLabelPt: 7.8,
        patientValuePt: 9.2,
        patientLineH: 4.3,
        deptHeadingPt: 11.0,
        testSubtitlePt: 9.5,
        headPt: 8.8,
        headPadV: 1.9,
        subHeaderPt: 9.2,
        sectionPt: 8.2,
        bodyPt: 10.2,
        normalPt: 9.4,
        bodyPadV: 2.5,
        bodyPadH: 2.6,
        blockGapMm: 5.5,
      },
    };
  }

  if (effectiveUnits <= 11) {
    return {
      tier: 'medium',
      patientNameClass: 'text-[15px] leading-[1.2]',
      patientGridClass: 'text-[12.5px] leading-[1.34]',
      patientLabelClass: 'text-[10px]',
      patientLeftLabelWidth: 'w-[72px]',
      patientRightLabelWidth: 'w-[80px]',
      patientRowSpaceClass: 'space-y-1',
      patientSectionPadClass: 'pb-2',
      deptHeadingClass: 'text-[15px]',
      testSubtitleClass: 'text-[12px]',
      theadClass: 'text-[11.5px]',
      thPadClass: 'py-1.5 px-2.5',
      subHeaderClass: 'text-[12px] py-1',
      tbodyClass: 'text-[13px] leading-[1.38]',
      unitClass: 'text-[12px]',
      normalClass: 'text-[12px] leading-[1.32]',
      rowPadClass: 'py-2',
      cellPadXClass: 'px-2.5',
      sectionClass: 'text-[10.5px]',
      sectionPadClass: 'pt-1.5 pb-0.5',
      pdf: {
        patientNamePt: 10.8,
        patientLabelPt: 7.6,
        patientValuePt: 9.0,
        patientLineH: 4.2,
        deptHeadingPt: 10.8,
        testSubtitlePt: 9.2,
        headPt: 8.6,
        headPadV: 1.6,
        subHeaderPt: 8.8,
        sectionPt: 8.0,
        bodyPt: 9.6,
        normalPt: 9.0,
        bodyPadV: 2.0,
        bodyPadH: 2.4,
        blockGapMm: 5.0,
      },
    };
  }

  return {
    tier: 'dense',
    patientNameClass: 'text-[14.5px] leading-[1.2]',
    patientGridClass: 'text-[12px] leading-[1.32]',
    patientLabelClass: 'text-[10px]',
    patientLeftLabelWidth: 'w-[70px]',
    patientRightLabelWidth: 'w-[78px]',
    patientRowSpaceClass: 'space-y-1',
    patientSectionPadClass: 'pb-2',
    deptHeadingClass: 'text-[14.5px]',
    testSubtitleClass: 'text-[11.5px]',
    theadClass: 'text-[11.5px]',
    thPadClass: 'py-1.5 px-2.5',
    subHeaderClass: 'text-[11.5px] py-1',
    tbodyClass: 'text-[12px] leading-[1.28]',
    unitClass: 'text-[11px]',
    normalClass: 'text-[11px] leading-[1.24]',
    rowPadClass: 'py-[3px]',
    cellPadXClass: 'px-2.5',
    sectionClass: 'text-[10.5px]',
    sectionPadClass: 'pt-1.5 pb-0.5',
    pdf: {
      patientNamePt: 10.5,
      patientLabelPt: 7.5,
      patientValuePt: 8.8,
      patientLineH: 4.1,
      deptHeadingPt: 10.8,
      testSubtitlePt: 9,
      headPt: 8.4,
      headPadV: 1.4,
      subHeaderPt: 8.6,
      sectionPt: 7.8,
      bodyPt: 9.0,
      normalPt: 8.4,
      bodyPadV: 1.35,
      bodyPadH: 2.3,
      blockGapMm: 4.5,
    },
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

  const profile = getPageTypographyProfile(blocks);

  let rowHeightMm = 7.6;
  let extraLineMm = 3.3;
  let theadMm = 7.0;
  if (profile.tier === 'ultra_short') {
    rowHeightMm = 14.5;
    extraLineMm = 4.6;
    theadMm = 9.0;
  } else if (profile.tier === 'short') {
    rowHeightMm = 12.0;
    extraLineMm = 4.2;
    theadMm = 8.0;
  } else if (profile.tier === 'medium') {
    rowHeightMm = 9.6;
    extraLineMm = 3.8;
    theadMm = 7.5;
  } else if (profile.tier === 'cbc') {
    rowHeightMm = 6.3;
    extraLineMm = 3.2;
    theadMm = 7.0;
  } else if (profile.tier === 'urine') {
    rowHeightMm = 5.9;
    extraLineMm = 3.1;
    theadMm = 7.0;
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
        totalMm += 5.5; // centered single test subtitle
      }
    }

    totalMm += theadMm; // table <thead> header row

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
  const patientHeaderMm = 30;
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


