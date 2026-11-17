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
