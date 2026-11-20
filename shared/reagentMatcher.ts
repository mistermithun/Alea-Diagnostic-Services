export interface ReagentMatchCandidate {
  id: number;
  name: string;
  remaining_tests: number;
  expiry_date: string;
  linked_test_id?: number | null;
  linked_test_name?: string;
  linked_parameter_id?: number | null;
  linked_parameter_name?: string;
}

export interface OrderedTestMatchInput {
  test_id: number;
  test_name: string;
  test_code?: string;
  mapped_reagents?: unknown;
  parameters?: Array<{ id?: number | null; name: string }>;
}

export interface CatalogTestOptionInput {
  id: number;
  code: string;
  name: string;
  category_name?: string;
  is_active?: number;
  parameters?: Array<{ id?: number; name: string }>;
}

export interface CatalogReagentOption {
  key: string;
  kind: 'test' | 'parameter';
  label: string;
  displayName: string;
  subtitle: string;
  searchText: string;
  linked_test_id: number;
  linked_test_name: string;
  linked_parameter_id: number | null;
  linked_parameter_name: string;
}

export function normalizeReagentLabel(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const CANONICAL_REAGENT_MAP: Record<string, string> = {
  // Urine / Stool / Microscopy guardrails (never collide with serum biochemistry reagents)
  'bilirubin (bile pigment)': 'urine:bilirubin_bile_pigment',
  'bile pigment': 'urine:bilirubin_bile_pigment',
  'sugar (glucose)': 'urine:sugar_glucose',
  'urine sugar': 'urine:sugar_glucose',
  'albumin (protein)': 'urine:albumin_protein',
  'urine albumin': 'urine:albumin_protein',
  'urine protein': 'urine:albumin_protein',
  'blood (occult / hemoglobin)': 'micro:occult_blood',
  'occult / frank blood': 'micro:occult_blood',
  'occult blood': 'micro:occult_blood',
  'reaction (ph)': 'micro:ph',
  'pus cells': 'micro:pus_cells',
  'epithelial cells': 'micro:epithelial_cells',
  rbcs: 'micro:rbcs',
  casts: 'micro:casts',
  crystals: 'micro:crystals',
  color: 'micro:color',
  'color / appearance': 'micro:color_appearance',
  appearance: 'micro:appearance',
  sediment: 'micro:sediment',
  'specific gravity': 'micro:specific_gravity',
  'ketone bodies': 'micro:ketone_bodies',
  urobilinogen: 'micro:urobilinogen',
  nitrite: 'micro:nitrite',
  'leukocyte esterase': 'micro:leukocyte_esterase',
  'bacteria / yeast cells': 'micro:bacteria_yeast',
  'mucus threads': 'micro:mucus_threads',
  'spermatozoa / trichomonas': 'micro:spermatozoa_trichomonas',
  consistency: 'micro:consistency',
  mucus: 'micro:mucus',
  'ova / parasites': 'micro:ova_parasites',
  cyst: 'micro:cyst',
  volume: 'micro:volume',
  'liquefaction time': 'micro:liquefaction_time',
  'total sperm count': 'micro:total_sperm_count',
  'progressive motility': 'micro:progressive_motility',
  'non-progressive motility': 'micro:non_progressive_motility',
  'immotile sperms': 'micro:immotile_sperms',
  'normal morphology': 'micro:normal_morphology',

  // Lipid Profile components & single tests
  'total cholesterol': 'reagent:cholesterol',
  cholesterol: 'reagent:cholesterol',
  's. cholesterol': 'reagent:cholesterol',
  'serum cholesterol': 'reagent:cholesterol',
  chol: 'reagent:cholesterol',

  'triglycerides (tg)': 'reagent:triglycerides',
  'triglyceride (tg)': 'reagent:triglycerides',
  triglycerides: 'reagent:triglycerides',
  triglyceride: 'reagent:triglycerides',
  tg: 'reagent:triglycerides',
  's. tg': 'reagent:triglycerides',
  'serum tg': 'reagent:triglycerides',
  'serum triglyceride': 'reagent:triglycerides',
  'serum triglycerides': 'reagent:triglycerides',

  'hdl cholesterol': 'reagent:hdl',
  'hdl-c': 'reagent:hdl',
  hdl: 'reagent:hdl',

  'ldl cholesterol': 'reagent:ldl',
  'ldl-c': 'reagent:ldl',
  ldl: 'reagent:ldl',

  'vldl cholesterol': 'reagent:vldl',
  'vldl-c': 'reagent:vldl',
  vldl: 'reagent:vldl',

  // Liver Function Test (LFT) components & single tests
  'sgpt (alt)': 'reagent:sgpt',
  sgpt: 'reagent:sgpt',
  alt: 'reagent:sgpt',
  's. sgpt': 'reagent:sgpt',
  'serum sgpt': 'reagent:sgpt',
  'alanine aminotransferase': 'reagent:sgpt',

  'sgot (ast)': 'reagent:sgot',
  sgot: 'reagent:sgot',
  ast: 'reagent:sgot',
  's. sgot': 'reagent:sgot',
  'serum sgot': 'reagent:sgot',
  'aspartate aminotransferase': 'reagent:sgot',

  'serum bilirubin (total)': 'reagent:bilirubin_total',
  'bilirubin (total)': 'reagent:bilirubin_total',
  'total bilirubin': 'reagent:bilirubin_total',
  's. bilirubin': 'reagent:bilirubin_total',
  's. bilirubin (total)': 'reagent:bilirubin_total',
  'serum bilirubin': 'reagent:bilirubin_total',
  bilirubin: 'reagent:bilirubin_total',
  't. bilirubin': 'reagent:bilirubin_total',

  'serum bilirubin (direct)': 'reagent:bilirubin_direct',
  'bilirubin (direct)': 'reagent:bilirubin_direct',
  'direct bilirubin': 'reagent:bilirubin_direct',

  'alkaline phosphatase (alp)': 'reagent:alp',
  'alkaline phosphatase': 'reagent:alp',
  alp: 'reagent:alp',
  's. alp': 'reagent:alp',

  // Kidney Function Test (KFT) components & single tests
  'serum creatinine': 'reagent:creatinine',
  's. creatinine': 'reagent:creatinine',
  creatinine: 'reagent:creatinine',

  'blood urea': 'reagent:urea',
  'serum urea': 'reagent:urea',
  urea: 'reagent:urea',
  bun: 'reagent:urea',

  'serum uric acid': 'reagent:uric_acid',
  's. uric acid': 'reagent:uric_acid',
  'uric acid': 'reagent:uric_acid',

  // Sugar / Glycemic
  'fasting blood sugar (fbs)': 'reagent:fbs',
  'fasting plasma glucose': 'reagent:fbs',
  fbs: 'reagent:fbs',

  'random blood sugar (rbs)': 'reagent:rbs',
  'random plasma glucose': 'reagent:rbs',
  rbs: 'reagent:rbs',

  '2 hours abf (2habf)': 'reagent:2habf',
  '2 hours after breakfast (2habf)': 'reagent:2habf',
  '2habf': 'reagent:2habf',

  '2 hours after 75g glucose (2ha75g glu)': 'reagent:ogtt',
  '2ha75g glu': 'reagent:ogtt',
  ogtt: 'reagent:ogtt',

  glucose: 'reagent:blood_glucose_generic',
  'blood glucose': 'reagent:blood_glucose_generic',
  'plasma glucose': 'reagent:blood_glucose_generic',
  'blood sugar': 'reagent:blood_glucose_generic',

  'hba1c (glycated hemoglobin)': 'reagent:hba1c',
  hba1c: 'reagent:hba1c',

  // Calcium
  calcium: 'reagent:calcium',
  'serum calcium': 'reagent:calcium',
  'serum calcium (total)': 'reagent:calcium',
  's. calcium': 'reagent:calcium',

  // Clinical Pathology & Hematology & Serology tests
  'urine r/e (routine examination)': 'reagent:urine_re',
  'urine r/m/e': 'reagent:urine_re',
  'r/m/e of urine': 'reagent:urine_re',
  'urine r/e': 'reagent:urine_re',
  'urine re': 'reagent:urine_re',
  'urine rme': 'reagent:urine_re',
  'urine routine examination': 'reagent:urine_re',

  'stool r/e (routine examination)': 'reagent:stool_re',
  'stool r/m/e': 'reagent:stool_re',
  'stool r/e': 'reagent:stool_re',
  'stool re': 'reagent:stool_re',
  'stool rme': 'reagent:stool_re',
  'stool routine examination': 'reagent:stool_re',

  'urine for preg/hcg': 'reagent:urine_hcg',
  'urine pregnancy test (β-hcg)': 'reagent:urine_hcg',
  'urine pregnancy test': 'reagent:urine_hcg',
  'pregnancy test': 'reagent:urine_hcg',
  'preg/hcg': 'reagent:urine_hcg',
  'β-hcg': 'reagent:urine_hcg',
  'beta hcg': 'reagent:urine_hcg',
  hcg: 'reagent:urine_hcg',

  'hbsag (screening / ict)': 'reagent:hbsag',
  'hbsag (ict)': 'reagent:hbsag',
  hbsag: 'reagent:hbsag',

  'anti-hcv (ict)': 'reagent:anti_hcv',
  'anti-hcv': 'reagent:anti_hcv',
  hcv: 'reagent:anti_hcv',

  'widal test': 'reagent:widal',
  widal: 'reagent:widal',

  'febrile antigen (triple antigen: widal, weil-felix, ba, bm)': 'reagent:febrile_antigen',
  'febrile antigen': 'reagent:febrile_antigen',
  'triple antigen': 'reagent:febrile_antigen',

  'crp (c-reactive protein)': 'reagent:crp',
  'crp (quantitative)': 'reagent:crp',
  crp: 'reagent:crp',

  'ra factor (rheumatoid factor)': 'reagent:ra_factor',
  'ra factor': 'reagent:ra_factor',
  'rheumatoid factor': 'reagent:ra_factor',

  tsh: 'reagent:tsh',
  'tsh (thyroid stimulating hormone)': 'reagent:tsh',

  ige: 'reagent:ige',
  'serum total ige': 'reagent:ige',
  'total ige': 'reagent:ige',

  'dengue ns1 antigen': 'reagent:dengue_ns1',
  'dengue ns1': 'reagent:dengue_ns1',
  'dengue igm antibody': 'reagent:dengue_igm',
  'dengue igm': 'reagent:dengue_igm',
  'dengue igg antibody': 'reagent:dengue_igg',
  'dengue igg': 'reagent:dengue_igg',
  'dengue panel (ns1, igm, igg)': 'reagent:panel_dengue',
  'dengue panel': 'reagent:panel_dengue',
  'dengue igg & igm': 'reagent:panel_dengue_igg_igm',

  'cbc (complete blood count)': 'reagent:cbc',
  cbc: 'reagent:cbc',
  'complete blood count': 'reagent:cbc',

  'esr (westergren)': 'reagent:esr',
  'esr (1st hour)': 'reagent:esr',
  'esr (erythrocyte sedimentation rate)': 'reagent:esr',
  esr: 'reagent:esr',

  'blood grouping & rh typing': 'reagent:blood_grouping',
  'blood grouping': 'reagent:blood_grouping',
  'abo blood group': 'reagent:blood_grouping',

  'hemoglobin (hb)': 'reagent:hemoglobin',
  'haemoglobin (hb)': 'reagent:hemoglobin',
  hemoglobin: 'reagent:hemoglobin',
  haemoglobin: 'reagent:hemoglobin',
  hb: 'reagent:hemoglobin',

  'blood crossmatching & screening test': 'reagent:crossmatching',
  crossmatching: 'reagent:crossmatching',

  'semen analysis': 'reagent:semen_analysis',
  'skin scraping for fungus': 'reagent:skin_fungus',

  // Panel test names (distinct from component reagents)
  'lipid profile': 'reagent:panel_lipid_profile',
  'liver function test (lft)': 'reagent:panel_lft',
  lft: 'reagent:panel_lft',
  'kidney function test (kft)': 'reagent:panel_kft',
  kft: 'reagent:panel_kft',
};

const IGNORED_PARENTHETICAL_TOKENS = new Set([
  'total',
  'direct',
  'indirect',
  'quantitative',
  'qualitative',
  'ict',
  'screening',
  'screening / ict',
  'routine examination',
  'westergren',
  '1st hour',
  'bile pigment',
  'glucose',
  'protein',
  'occult / hemoglobin',
  'ph',
  'reactive',
]);

const SINGLE_METHOD_MULTI_PARAM_KEYS = new Set([
  'reagent:cbc',
  'reagent:urine_re',
  'reagent:stool_re',
  'reagent:semen_analysis',
  'reagent:widal',
  'reagent:febrile_antigen',
  'reagent:crossmatching',
  'reagent:blood_grouping',
  'reagent:skin_fungus',
]);

const BLOOD_GLUCOSE_SPECIFIC_KEYS = new Set([
  'reagent:fbs',
  'reagent:rbs',
  'reagent:2habf',
  'reagent:ogtt',
]);

export function getCanonicalReagentKey(raw: string): string {
  const norm = normalizeReagentLabel(raw);
  if (!norm) return '';
  if (CANONICAL_REAGENT_MAP[norm]) {
    return CANONICAL_REAGENT_MAP[norm];
  }

  // Strip trailing kit/reagent suffix if user customized display name e.g. "Triglyceride Reagent" or "TG Kit"
  const strippedSuffix = norm
    .replace(/\s+(reagent|kit|strip|strips|card|cards|cassette|cassettes)$/i, '')
    .trim();
  if (strippedSuffix && CANONICAL_REAGENT_MAP[strippedSuffix]) {
    return CANONICAL_REAGENT_MAP[strippedSuffix];
  }

  return `custom:${norm}`;
}

export function getReagentMatchKeys(raw: string): Set<string> {
  const keys = new Set<string>();
  const norm = normalizeReagentLabel(raw);
  if (!norm) return keys;

  const primary = getCanonicalReagentKey(norm);
  if (primary) keys.add(primary);

  // If generic custom key, also consider stripped suffix & parenthetical base/abbr
  const strippedSuffix = norm
    .replace(/\s+(reagent|kit|strip|strips|card|cards|cassette|cassettes)$/i, '')
    .trim();
  if (strippedSuffix && strippedSuffix !== norm) {
    keys.add(getCanonicalReagentKey(strippedSuffix));
  }

  // Extract "Main (Abbr)" forms safely when not a urine/microscopy key
  if (!primary.startsWith('urine:') && !primary.startsWith('micro:')) {
    const parenMatch = /^(.+?)\s*\(([^()]+)\)$/.exec(strippedSuffix || norm);
    if (parenMatch) {
      const outer = parenMatch[1].trim();
      const inner = parenMatch[2].trim();
      if (outer.length >= 2) {
        const outerKey = getCanonicalReagentKey(outer);
        if (outerKey) keys.add(outerKey);
      }
      if (inner.length >= 2 && !IGNORED_PARENTHETICAL_TOKENS.has(inner)) {
        const innerKey = getCanonicalReagentKey(inner);
        if (innerKey) keys.add(innerKey);
      }
    }
  }

  return keys;
}

function keysOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const k of a) {
    if (b.has(k)) return true;
    if (k === 'reagent:blood_glucose_generic') {
      for (const bk of b) {
        if (BLOOD_GLUCOSE_SPECIFIC_KEYS.has(bk)) return true;
      }
    }
    if (BLOOD_GLUCOSE_SPECIFIC_KEYS.has(k) && b.has('reagent:blood_glucose_generic')) {
      return true;
    }
  }
  return false;
}

function getReagentIdentityKeys(reagent: ReagentMatchCandidate): Set<string> {
  const keys = getReagentMatchKeys(reagent.name);
  if (reagent.linked_parameter_name && reagent.linked_parameter_name.trim()) {
    for (const k of getReagentMatchKeys(reagent.linked_parameter_name)) {
      keys.add(k);
    }
  } else if (reagent.linked_test_name && reagent.linked_test_name.trim()) {
    for (const k of getReagentMatchKeys(reagent.linked_test_name)) {
      keys.add(k);
    }
  }
  return keys;
}

export function getLogicalReagentGroupKey(reagent: ReagentMatchCandidate): string {
  const paramLabel = String(reagent.linked_parameter_name || '').trim();
  if (paramLabel) {
    return getCanonicalReagentKey(paramLabel);
  }
  return getCanonicalReagentKey(reagent.name);
}

export function doesReagentMatchTest(
  reagent: ReagentMatchCandidate,
  test: OrderedTestMatchInput
): boolean {
  const testId = Number(test.test_id || 0);
  const params = Array.isArray(test.parameters) ? test.parameters : [];

  // 1. Direct ID links stored on reagent
  if (reagent.linked_parameter_id && Number(reagent.linked_parameter_id) > 0) {
    if (params.some((p) => Number(p.id || 0) === Number(reagent.linked_parameter_id))) {
      return true;
    }
  }
  if (reagent.linked_test_id && Number(reagent.linked_test_id) === testId) {
    const linkedParamName = String(reagent.linked_parameter_name || '').trim();
    if (!linkedParamName && !reagent.linked_parameter_id) {
      return true;
    }
    if (linkedParamName) {
      const lpKeys = getReagentMatchKeys(linkedParamName);
      if (params.some((p) => keysOverlap(lpKeys, getReagentMatchKeys(p.name)))) {
        return true;
      }
    }
  }

  const reagentKeys = getReagentIdentityKeys(reagent);
  if (reagentKeys.size === 0) return false;

  // 2. Explicit mapped_reagents configured on the Test Catalog item
  if (Array.isArray(test.mapped_reagents)) {
    for (const mapped of test.mapped_reagents) {
      const mKeys = getReagentMatchKeys(String(mapped || ''));
      if (keysOverlap(mKeys, reagentKeys)) {
        return true;
      }
    }
  }

  // 3. Test Name match (covers single tests like TG, HDL, Creatinine, Urine R/E, SGPT, etc.)
  const testNameKeys = getReagentMatchKeys(test.test_name);
  if (keysOverlap(testNameKeys, reagentKeys)) {
    return true;
  }

  // 4. Component Parameter match (covers panel tests like Lipid Profile, LFT, KFT, Dengue Panel, etc.)
  const testPrimaryKey = getCanonicalReagentKey(test.test_name);
  if (!SINGLE_METHOD_MULTI_PARAM_KEYS.has(testPrimaryKey)) {
    for (const p of params) {
      const pPrimary = getCanonicalReagentKey(p.name);
      if (!pPrimary || pPrimary.startsWith('urine:') || pPrimary.startsWith('micro:')) {
        continue;
      }
      const pKeys = getReagentMatchKeys(p.name);
      if (keysOverlap(pKeys, reagentKeys)) {
        return true;
      }
    }
  }

  return false;
}

export function selectFefoReagentBatchesForTest<T extends ReagentMatchCandidate>(
  allReagents: T[],
  test: OrderedTestMatchInput
): T[] {
  const available = allReagents.filter((r) => Number(r.remaining_tests || 0) > 0);
  if (available.length === 0) return [];

  const matched = available.filter((r) => doesReagentMatchTest(r, test));
  if (matched.length === 0) return [];

  const byGroup = new Map<string, T[]>();
  for (const r of matched) {
    const gKey = getLogicalReagentGroupKey(r) || `id:${r.id}`;
    const list = byGroup.get(gKey) || [];
    list.push(r);
    byGroup.set(gKey, list);
  }

  const chosen: T[] = [];
  for (const group of byGroup.values()) {
    group.sort((a, b) => {
      const expA = String(a.expiry_date || '').trim() || '9999-12-31';
      const expB = String(b.expiry_date || '').trim() || '9999-12-31';
      const cmp = expA.localeCompare(expB);
      return cmp !== 0 ? cmp : a.id - b.id;
    });
    if (group[0]) {
      chosen.push(group[0]);
    }
  }

  return chosen;
}

const SEARCH_SYNONYMS: Record<string, string> = {
  'reagent:urine_re': 'urine r/m/e urine rme urine re routine examination',
  'reagent:stool_re': 'stool r/m/e stool rme stool re routine examination',
  'reagent:triglycerides': 'tg triglyceride triglycerides',
  'reagent:cholesterol': 'cholesterol total cholesterol chol',
  'reagent:hdl': 'hdl hdl cholesterol',
  'reagent:ldl': 'ldl ldl cholesterol',
  'reagent:sgpt': 'sgpt alt alanine aminotransferase',
  'reagent:sgot': 'sgot ast aspartate aminotransferase',
  'reagent:bilirubin_total': 'bilirubin total bilirubin serum bilirubin',
  'reagent:alp': 'alp alkaline phosphatase',
  'reagent:creatinine': 'creatinine serum creatinine',
  'reagent:panel_lipid_profile': 'lipid profile cholesterol tg hdl ldl',
  'reagent:panel_lft': 'lft liver function test sgpt sgot bilirubin alp',
  'reagent:panel_kft': 'kft kidney function test creatinine urea uric acid',
};

export function buildCatalogReagentOptions(
  tests: CatalogTestOptionInput[]
): CatalogReagentOption[] {
  const activeTests = tests.filter((t) => Number(t.is_active ?? 1) === 1);
  const options: CatalogReagentOption[] = [];

  // 1. Add Test Catalog tests
  for (const t of activeTests) {
    const canon = getCanonicalReagentKey(t.name);
    const syn = SEARCH_SYNONYMS[canon] || '';
    options.push({
      key: `test:${t.id}`,
      kind: 'test',
      label: t.name,
      displayName: t.name,
      subtitle: `${t.category_name ? `${t.category_name} • ` : ''}${t.code || 'Test'}`,
      searchText: `${t.name} ${t.code || ''} ${t.category_name || ''} ${syn}`.toLowerCase(),
      linked_test_id: t.id,
      linked_test_name: t.name,
      linked_parameter_id: null,
      linked_parameter_name: '',
    });
  }

  // 2. Collect unique Sub-Parameters across active tests (preferring single-test match when available for linked_test_id)
  const testByCanon = new Map<string, CatalogTestOptionInput>();
  for (const t of activeTests) {
    const c = getCanonicalReagentKey(t.name);
    if (c && !testByCanon.has(c)) {
      testByCanon.set(c, t);
    }
  }

  const paramBuckets = new Map<
    string,
    {
      name: string;
      preferredTest: CatalogTestOptionInput;
      preferredParamId: number | null;
      parentNames: string[];
    }
  >();

  const exactTestNames = new Set(activeTests.map((t) => normalizeReagentLabel(t.name)));

  for (const t of activeTests) {
    const tCanon = getCanonicalReagentKey(t.name);
    // Skip adding redundant micro/urine dipstick observations as standalone sub-parameters unless it's a real analyte
    const params = Array.isArray(t.parameters) ? t.parameters : [];
    for (const p of params) {
      const pName = String(p.name || '').trim();
      if (!pName) continue;
      const pCanon = getCanonicalReagentKey(pName);
      if (pCanon.startsWith('urine:') || pCanon.startsWith('micro:')) continue;
      // If parameter has identical name to an existing test in options, no need to duplicate
      if (exactTestNames.has(normalizeReagentLabel(pName))) {
        continue;
      }

      const bucketKey = pCanon || normalizeReagentLabel(pName);
      const existing = paramBuckets.get(bucketKey);
      if (!existing) {
        const standaloneMatch = testByCanon.get(pCanon);
        paramBuckets.set(bucketKey, {
          name: pName,
          preferredTest: standaloneMatch || t,
          preferredParamId: typeof p.id === 'number' && p.id > 0 ? p.id : null,
          parentNames: [t.name],
        });
      } else {
        if (!existing.parentNames.includes(t.name)) {
          existing.parentNames.push(t.name);
        }
        if (tCanon === pCanon) {
          existing.preferredTest = t;
          if (typeof p.id === 'number' && p.id > 0) {
            existing.preferredParamId = p.id;
          }
        }
      }
    }
  }

  for (const [bKey, bucket] of paramBuckets.entries()) {
    const syn = SEARCH_SYNONYMS[bKey] || '';
    options.push({
      key: `param:${bKey}`,
      kind: 'parameter',
      label: bucket.name,
      displayName: bucket.name,
      subtitle: `Sub-parameter (${bucket.parentNames.join(', ')})`,
      searchText: `${bucket.name} ${bucket.parentNames.join(' ')} ${syn}`.toLowerCase(),
      linked_test_id: bucket.preferredTest.id,
      linked_test_name: bucket.preferredTest.name,
      linked_parameter_id: bucket.preferredParamId,
      linked_parameter_name: bucket.name,
    });
  }

  return options;
}
