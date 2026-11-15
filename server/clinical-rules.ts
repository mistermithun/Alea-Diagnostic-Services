export interface ParamSeed {
  name: string;
  unit: string;
  input_type?: 'numeric' | 'text' | 'select';
  normal_text?: string;
  default_value?: string;
  select_options?: string;
  abnormal_values?: string;
  min_male?: number | null;
  max_male?: number | null;
  min_female?: number | null;
  max_female?: number | null;
  min_child?: number | null;
  max_child?: number | null;
  min_newborn?: number | null;
  max_newborn?: number | null;
  sort_order?: number;
}

export interface TestSeed {
  code: string;
  name: string;
  price: number;
  sample_type: string;
  parameters: ParamSeed[];
}

export function getTodayDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getLocalTimestampStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

export const CBC_DESIRED_PARAMS: Array<ParamSeed & { sort_order: number }> = [
  { name: 'Hemoglobin (Hb)', unit: 'g/dL', min_male: 13.0, max_male: 17.0, min_female: 12.0, max_female: 15.5, min_child: 11.0, max_child: 14.5, min_newborn: 14.0, max_newborn: 22.0, normal_text: 'M: 13.0–17.0 | F: 12.0–15.5\nChild: 11.0–14.5 | Newborn: 14.0–22.0', sort_order: 1 },
  { name: 'ESR (Erythrocyte Sedimentation Rate)', unit: 'mm/1st hr', min_male: 0, max_male: 15, min_female: 0, max_female: 20, min_child: 0, max_child: 10, min_newborn: 0, max_newborn: 2, normal_text: 'M: 0–15 | F: 0–20\nChild: 0–10 | Newborn: 0–2', sort_order: 2 },
  { name: 'Total WBC Count', unit: '/cumm', min_male: 4000, max_male: 11000, min_female: 4000, max_female: 11000, min_child: 5000, max_child: 13500, min_newborn: 9000, max_newborn: 30000, normal_text: 'Adult (M/F): 4,000–11,000\nChild: 5,000–13,500 | Newborn: 9,000–30,000', sort_order: 3 },
  { name: 'Total RBC Count', unit: 'million/cumm', min_male: 4.5, max_male: 5.9, min_female: 4.0, max_female: 5.2, min_child: 4.0, max_child: 5.3, min_newborn: 4.8, max_newborn: 7.1, normal_text: 'M: 4.5–5.9 | F: 4.0–5.2\nChild: 4.0–5.3 | Newborn: 4.8–7.1', sort_order: 4 },
  { name: 'Platelet Count', unit: '/cumm', min_male: 150000, max_male: 450000, min_female: 150000, max_female: 450000, min_child: 150000, max_child: 450000, min_newborn: 150000, max_newborn: 450000, normal_text: '150,000 - 450,000', sort_order: 5 },
  { name: 'Neutrophils', unit: '%', min_male: 40, max_male: 75, min_female: 40, max_female: 75, min_child: 35, max_child: 65, min_newborn: 45, max_newborn: 80, normal_text: 'Adult (M/F): 40–75 | Child: 35–65\nNewborn: 45–80', sort_order: 6 },
  { name: 'Lymphocytes', unit: '%', min_male: 20, max_male: 45, min_female: 20, max_female: 45, min_child: 25, max_child: 55, min_newborn: 20, max_newborn: 40, normal_text: 'Adult (M/F): 20–45 | Child: 25–55\nNewborn: 20–40', sort_order: 7 },
  { name: 'Eosinophils', unit: '%', min_male: 1, max_male: 6, min_female: 1, max_female: 6, min_child: 1, max_child: 6, min_newborn: 1, max_newborn: 6, normal_text: '1 - 6', sort_order: 8 },
  { name: 'Monocytes', unit: '%', min_male: 2, max_male: 10, min_female: 2, max_female: 10, min_child: 2, max_child: 10, min_newborn: 2, max_newborn: 10, normal_text: '2 - 10', sort_order: 9 },
  { name: 'Basophils', unit: '%', min_male: 0, max_male: 1, min_female: 0, max_female: 1, min_child: 0, max_child: 1, min_newborn: 0, max_newborn: 1, normal_text: '0 - 1', sort_order: 10 },
  { name: 'Total Circulating Eosinophil Count', unit: '/cumm', min_male: 40, max_male: 440, min_female: 40, max_female: 440, min_child: 40, max_child: 440, min_newborn: 40, max_newborn: 440, normal_text: '40 - 440', sort_order: 11 },
  { name: 'PCV / HCT', unit: '%', min_male: 40, max_male: 54, min_female: 36, max_female: 48, min_child: 32, max_child: 44, min_newborn: 44, max_newborn: 64, normal_text: 'M: 40–54 | F: 36–48\nChild: 32–44 | Newborn: 44–64', sort_order: 12 },
  { name: 'MCV', unit: 'fL', min_male: 80, max_male: 100, min_female: 80, max_female: 100, min_child: 75, max_child: 95, min_newborn: 95, max_newborn: 120, normal_text: 'Adult (M/F): 80–100 | Child: 75–95\nNewborn: 95–120', sort_order: 13 },
  { name: 'MCH', unit: 'pg', min_male: 27, max_male: 32, min_female: 27, max_female: 32, min_child: 25, max_child: 31, min_newborn: 31, max_newborn: 37, normal_text: 'Adult (M/F): 27–32 | Child: 25–31\nNewborn: 31–37', sort_order: 14 },
  { name: 'MCHC', unit: 'g/dL', min_male: 32, max_male: 36, min_female: 32, max_female: 36, min_child: 32, max_child: 36, min_newborn: 32, max_newborn: 36, normal_text: '32 - 36', sort_order: 15 },
  { name: 'RDW', unit: '%', min_male: 11.5, max_male: 14.5, min_female: 11.5, max_female: 14.5, min_child: 11.5, max_child: 14.5, min_newborn: 14.0, max_newborn: 18.0, normal_text: 'Adult/Child: 11.5–14.5\nNewborn: 14.0–18.0', sort_order: 16 },
];

export const URINE_DESIRED_PARAMS: Array<ParamSeed & { sort_order: number }> = [
  { name: 'Color', unit: '', input_type: 'text', normal_text: 'Pale Yellow', default_value: 'Pale Yellow', sort_order: 1 },
  { name: 'Appearance', unit: '', input_type: 'select', select_options: 'Clear,Slightly Turbid,Turbid', abnormal_values: 'Slightly Turbid,Turbid', normal_text: 'Clear', default_value: 'Clear', sort_order: 2 },
  { name: 'Sediment', unit: '', input_type: 'select', select_options: 'Nil,Trace,Present (+),Present (++)', abnormal_values: 'Present (+),Present (++)', normal_text: 'Nil', default_value: 'Nil', sort_order: 3 },
  { name: 'Specific Gravity', unit: '', input_type: 'numeric', min_male: 1.005, max_male: 1.03, min_female: 1.005, max_female: 1.03, normal_text: '1.005 - 1.030', default_value: '1.015', sort_order: 4 },
  { name: 'Reaction (pH)', unit: '', input_type: 'numeric', min_male: 4.5, max_male: 8.0, min_female: 4.5, max_female: 8.0, normal_text: '4.5 - 8.0', default_value: '6.0', sort_order: 5 },
  { name: 'Albumin (Protein)', unit: '', input_type: 'select', select_options: 'Nil,Trace,+,++,+++', abnormal_values: 'Trace,+,++,+++', normal_text: 'Nil', default_value: 'Nil', sort_order: 6 },
  { name: 'Sugar (Glucose)', unit: '', input_type: 'select', select_options: 'Nil,Trace,+,++,+++', abnormal_values: 'Trace,+,++,+++', normal_text: 'Nil', default_value: 'Nil', sort_order: 7 },
  { name: 'Ketone Bodies', unit: '', input_type: 'select', select_options: 'Absent,Trace,Present (+),Present (++)', abnormal_values: 'Trace,Present (+),Present (++)', normal_text: 'Absent', default_value: 'Absent', sort_order: 8 },
  { name: 'Bilirubin (Bile Pigment)', unit: '', input_type: 'select', select_options: 'Absent,Present', abnormal_values: 'Present', normal_text: 'Absent', default_value: 'Absent', sort_order: 9 },
  { name: 'Urobilinogen', unit: '', input_type: 'select', select_options: 'Normal,Increased', abnormal_values: 'Increased', normal_text: 'Normal', default_value: 'Normal', sort_order: 10 },
  { name: 'Nitrite', unit: '', input_type: 'select', select_options: 'Negative,Positive', abnormal_values: 'Positive', normal_text: 'Negative', default_value: 'Negative', sort_order: 11 },
  { name: 'Leukocyte Esterase', unit: '', input_type: 'select', select_options: 'Negative,Trace,Positive (+),Positive (++)', abnormal_values: 'Trace,Positive (+),Positive (++)', normal_text: 'Negative', default_value: 'Negative', sort_order: 12 },
  { name: 'Blood (Occult / Hemoglobin)', unit: '', input_type: 'select', select_options: 'Absent,Trace,Present (+),Present (++)', abnormal_values: 'Trace,Present (+),Present (++)', normal_text: 'Absent', default_value: 'Absent', sort_order: 13 },
  { name: 'Pus Cells', unit: '/HPF', input_type: 'numeric', min_male: 0, max_male: 5, min_female: 0, max_female: 5, normal_text: '0 - 5', default_value: '', sort_order: 14 },
  { name: 'Epithelial Cells', unit: '/HPF', input_type: 'numeric', min_male: 0, max_male: 5, min_female: 0, max_female: 5, normal_text: '0 - 5', default_value: '', sort_order: 15 },
  { name: 'RBCs', unit: '/HPF', input_type: 'numeric', min_male: 0, max_male: 2, min_female: 0, max_female: 2, normal_text: '0 - 2', default_value: '0', sort_order: 16 },
  { name: 'Casts', unit: '/LPF', input_type: 'select', select_options: 'Nil,Hyaline Casts,Granular Casts,WBC Casts,RBC Casts', abnormal_values: 'Granular Casts,WBC Casts,RBC Casts', normal_text: 'Nil', default_value: 'Nil', sort_order: 17 },
  { name: 'Crystals', unit: '', input_type: 'select', select_options: 'Nil,Calcium Oxalate,Uric Acid,Amorphous Urates,Triple Phosphate', abnormal_values: 'Calcium Oxalate,Uric Acid,Triple Phosphate', normal_text: 'Nil', default_value: 'Nil', sort_order: 18 },
  { name: 'Bacteria / Yeast Cells', unit: '', input_type: 'select', select_options: 'Nil,Few (+),Moderate (++),Plenty (+++)', abnormal_values: 'Few (+),Moderate (++),Plenty (+++)', normal_text: 'Nil', default_value: 'Nil', sort_order: 19 },
  { name: 'Mucus Threads', unit: '', input_type: 'select', select_options: 'Nil,Few,Moderate,Plenty', abnormal_values: 'Plenty', normal_text: 'Nil', default_value: 'Nil', sort_order: 20 },
  { name: 'Spermatozoa / Trichomonas', unit: '', input_type: 'select', select_options: 'Absent,Present', abnormal_values: 'Present', normal_text: 'Absent', default_value: 'Absent', sort_order: 21 },
];

export const SEED_CATALOG: Array<{ category: string; sort_order: number; tests: TestSeed[] }> = [
  {
    category: 'Hematology',
    sort_order: 1,
    tests: [
      {
        code: 'HEM-01',
        name: 'CBC (Complete Blood Count)',
        price: 500,
        sample_type: 'Whole Blood (EDTA)',
        parameters: CBC_DESIRED_PARAMS,
      },
      {
        code: 'HEM-02',
        name: 'ESR (Westergren)',
        price: 150,
        sample_type: 'Whole Blood (EDTA)',
        parameters: [
          { name: 'ESR (1st Hour)', unit: 'mm/1st hr', min_male: 0, max_male: 15, min_female: 0, max_female: 20, min_child: 0, max_child: 10, normal_text: 'M: 0-15 | F: 0-20' },
        ],
      },
      {
        code: 'HEM-03',
        name: 'Blood Grouping & Rh Typing',
        price: 150,
        sample_type: 'Whole Blood',
        parameters: [
          { name: 'ABO Blood Group', unit: '', input_type: 'select', select_options: 'A,B,AB,O', normal_text: 'Qualitative' },
          { name: 'Rh (D) Factor', unit: '', input_type: 'select', select_options: 'Positive,Negative', normal_text: 'Qualitative' },
        ],
      },
    ],
  },
  {
    category: 'Biochemistry',
    sort_order: 2,
    tests: [
      {
        code: 'BIO-01',
        name: 'Fasting Blood Sugar (FBS)',
        price: 150,
        sample_type: 'Fluoride Plasma / Serum',
        parameters: [
          { name: 'Fasting Plasma Glucose', unit: 'mg/dL', min_male: 70, max_male: 100, min_female: 70, max_female: 100, min_child: 70, max_child: 100, normal_text: '70 - 100' },
        ],
      },
      {
        code: 'BIO-02',
        name: 'Random Blood Sugar (RBS)',
        price: 150,
        sample_type: 'Fluoride Plasma / Serum',
        parameters: [
          { name: 'Random Plasma Glucose', unit: 'mg/dL', min_male: 70, max_male: 140, min_female: 70, max_female: 140, min_child: 70, max_child: 140, normal_text: '70 - 140' },
        ],
      },
      {
        code: 'BIO-03',
        name: 'HbA1c (Glycated Hemoglobin)',
        price: 900,
        sample_type: 'Whole Blood (EDTA)',
        parameters: [
          { name: 'HbA1c', unit: '%', min_male: 4.0, max_male: 5.6, min_female: 4.0, max_female: 5.6, min_child: 4.0, max_child: 5.6, normal_text: '4.0 - 5.6 (Non-Diabetic)' },
        ],
      },
      {
        code: 'BIO-04',
        name: 'Lipid Profile',
        price: 1000,
        sample_type: 'Serum (Fasting)',
        parameters: [
          { name: 'Total Cholesterol', unit: 'mg/dL', min_male: 0, max_male: 200, min_female: 0, max_female: 200, normal_text: '< 200' },
          { name: 'Triglycerides (TG)', unit: 'mg/dL', min_male: 0, max_male: 150, min_female: 0, max_female: 150, normal_text: '< 150' },
          { name: 'HDL Cholesterol', unit: 'mg/dL', min_male: 40, max_male: 100, min_female: 50, max_female: 100, normal_text: 'M: >40 | F: >50' },
          { name: 'LDL Cholesterol', unit: 'mg/dL', min_male: 0, max_male: 100, min_female: 0, max_female: 100, normal_text: '< 100' },
        ],
      },
      {
        code: 'BIO-05',
        name: 'Liver Function Test (LFT)',
        price: 900,
        sample_type: 'Serum',
        parameters: [
          { name: 'SGPT (ALT)', unit: 'U/L', min_male: 0, max_male: 41, min_female: 0, max_female: 33, normal_text: 'M: <41 | F: <33' },
          { name: 'SGOT (AST)', unit: 'U/L', min_male: 0, max_male: 40, min_female: 0, max_female: 32, normal_text: 'M: <40 | F: <32' },
          { name: 'Serum Bilirubin (Total)', unit: 'mg/dL', min_male: 0.2, max_male: 1.2, min_female: 0.2, max_female: 1.2, normal_text: '0.2 - 1.2' },
          { name: 'Alkaline Phosphatase (ALP)', unit: 'U/L', min_male: 44, max_male: 147, min_female: 44, max_female: 147, normal_text: '44 - 147' },
        ],
      },
      {
        code: 'BIO-06',
        name: 'Kidney Function Test (KFT)',
        price: 800,
        sample_type: 'Serum',
        parameters: [
          { name: 'Serum Creatinine', unit: 'mg/dL', min_male: 0.7, max_male: 1.3, min_female: 0.6, max_female: 1.1, min_child: 0.3, max_child: 0.7, normal_text: 'M: 0.7-1.3 | F: 0.6-1.1' },
          { name: 'Blood Urea', unit: 'mg/dL', min_male: 15, max_male: 45, min_female: 15, max_female: 45, normal_text: '15 - 45' },
          { name: 'Serum Uric Acid', unit: 'mg/dL', min_male: 3.5, max_male: 7.2, min_female: 2.6, max_female: 6.0, normal_text: 'M: 3.5-7.2 | F: 2.6-6.0' },
        ],
      },
    ],
  },
  {
    category: 'Serology & Immunology',
    sort_order: 3,
    tests: [
      {
        code: 'SER-01',
        name: 'HBsAg (Screening / ICT)',
        price: 400,
        sample_type: 'Serum',
        parameters: [
          { name: 'HBsAg (ICT)', unit: '', input_type: 'select', select_options: 'Non-Reactive,Reactive', abnormal_values: 'Reactive', normal_text: 'Non-Reactive' },
        ],
      },
      {
        code: 'SER-02',
        name: 'Anti-HCV (ICT)',
        price: 600,
        sample_type: 'Serum',
        parameters: [
          { name: 'Anti-HCV', unit: '', input_type: 'select', select_options: 'Non-Reactive,Reactive', abnormal_values: 'Reactive', normal_text: 'Non-Reactive' },
        ],
      },
      {
        code: 'SER-03',
        name: 'Widal Test',
        price: 400,
        sample_type: 'Serum',
        parameters: [
          { name: 'S. Typhi "O" Antigen', unit: 'Titre', input_type: 'select', select_options: '< 1:80,1:80,1:160,1:320', abnormal_values: '1:160,1:320', normal_text: '< 1:80' },
          { name: 'S. Typhi "H" Antigen', unit: 'Titre', input_type: 'select', select_options: '< 1:80,1:80,1:160,1:320', abnormal_values: '1:160,1:320', normal_text: '< 1:80' },
          { name: 'S. Paratyphi "AH"', unit: 'Titre', input_type: 'select', select_options: '< 1:80,1:80,1:160,1:320', abnormal_values: '1:160,1:320', normal_text: '< 1:80' },
          { name: 'S. Paratyphi "BH"', unit: 'Titre', input_type: 'select', select_options: '< 1:80,1:80,1:160,1:320', abnormal_values: '1:160,1:320', normal_text: '< 1:80' },
        ],
      },
      {
        code: 'SER-04',
        name: 'CRP (C-Reactive Protein)',
        price: 500,
        sample_type: 'Serum',
        parameters: [
          { name: 'CRP (Quantitative)', unit: 'mg/L', min_male: 0, max_male: 6.0, min_female: 0, max_female: 6.0, normal_text: '< 6.0' },
        ],
      },
      {
        code: 'SER-05',
        name: 'RA Factor (Rheumatoid Factor)',
        price: 450,
        sample_type: 'Serum',
        parameters: [
          { name: 'RA Factor', unit: 'IU/mL', min_male: 0, max_male: 14.0, min_female: 0, max_female: 14.0, normal_text: '< 14.0' },
        ],
      },
      {
        code: 'SER-06',
        name: 'Dengue Panel (NS1, IgM, IgG)',
        price: 1200,
        sample_type: 'Serum',
        parameters: [
          { name: 'Dengue NS1 Antigen', unit: '', input_type: 'select', select_options: 'Negative,Positive', abnormal_values: 'Positive', normal_text: 'Negative' },
          { name: 'Dengue IgM Antibody', unit: '', input_type: 'select', select_options: 'Negative,Positive', abnormal_values: 'Positive', normal_text: 'Negative' },
          { name: 'Dengue IgG Antibody', unit: '', input_type: 'select', select_options: 'Negative,Positive', abnormal_values: 'Positive', normal_text: 'Negative' },
        ],
      },
    ],
  },
  {
    category: 'Clinical Pathology',
    sort_order: 4,
    tests: [
      {
        code: 'CLP-01',
        name: 'Urine R/E (Routine Examination)',
        price: 200,
        sample_type: 'Mid-stream Urine',
        parameters: URINE_DESIRED_PARAMS,
      },
      {
        code: 'CLP-02',
        name: 'Stool R/E (Routine Examination)',
        price: 200,
        sample_type: 'Fresh Stool',
        parameters: [
          { name: 'Color', unit: '', input_type: 'text', normal_text: 'Brownish', default_value: 'Brownish' },
          { name: 'Consistency', unit: '', input_type: 'select', select_options: 'Soft / Formed,Loose,Watery,Hard', abnormal_values: 'Watery,Loose', normal_text: 'Soft / Formed', default_value: 'Soft / Formed' },
          { name: 'Mucus', unit: '', input_type: 'select', select_options: 'Absent,Present (+),Present (++)', abnormal_values: 'Present (+),Present (++)', normal_text: 'Absent', default_value: 'Absent' },
          { name: 'Occult / Frank Blood', unit: '', input_type: 'select', select_options: 'Absent,Present', abnormal_values: 'Present', normal_text: 'Absent', default_value: 'Absent' },
          { name: 'Pus Cells', unit: '/HPF', min_male: 0, max_male: 3, min_female: 0, max_female: 3, normal_text: '0 - 3', default_value: '' },
          { name: 'RBCs', unit: '/HPF', min_male: 0, max_male: 1, min_female: 0, max_female: 1, normal_text: '0 - 1', default_value: '0' },
          { name: 'Ova / Parasites', unit: '', input_type: 'select', select_options: 'Not Found,Found', abnormal_values: 'Found', normal_text: 'Not Found', default_value: 'Not Found' },
          { name: 'Cyst', unit: '', input_type: 'select', select_options: 'Not Found,Found', abnormal_values: 'Found', normal_text: 'Not Found', default_value: 'Not Found' },
        ],
      },
    ],
  },
];

export function resolveReferenceRange(
  param: {
    normal_text: string;
    min_male: number | null;
    max_male: number | null;
    min_female: number | null;
    max_female: number | null;
    min_child: number | null;
    max_child: number | null;
    min_newborn?: number | null;
    max_newborn?: number | null;
    input_type: string;
  },
  gender: string,
  ageYears: number,
  ageMonths = 0,
  ageDays = 0
): { min: number | null; max: number | null; label: string } {
  if (param.input_type !== 'numeric') {
    return { min: null, max: null, label: param.normal_text || '-' };
  }

  let min: number | null = param.min_male;
  let max: number | null = param.max_male;

  const isNewborn = ageYears === 0 && ageMonths === 0 && ageDays <= 28;
  const minNb = param.min_newborn ?? null;
  const maxNb = param.max_newborn ?? null;

  if (isNewborn && (minNb !== null || maxNb !== null)) {
    min = minNb;
    max = maxNb;
  } else if (ageYears < 12 && (param.min_child !== null || param.max_child !== null)) {
    min = param.min_child;
    max = param.max_child;
  } else if (gender.toLowerCase() === 'female' && (param.min_female !== null || param.max_female !== null)) {
    min = param.min_female;
    max = param.max_female;
  }

  let label = param.normal_text || '';
  if (
    param.normal_text &&
    (param.normal_text.includes('Newborn:') || param.normal_text.includes('Child:') || param.normal_text.includes('\n'))
  ) {
    label = param.normal_text;
  } else if (min !== null && max !== null) {
    label = `${min} - ${max}`;
  } else if (max !== null) {
    label = `< ${max}`;
  } else if (min !== null) {
    label = `> ${min}`;
  }

  return { min, max, label };
}

export function evaluateResultFlag(
  value: string,
  param: {
    input_type: string;
    abnormal_values: string;
    normal_text: string;
    min_male: number | null;
    max_male: number | null;
    min_female: number | null;
    max_female: number | null;
    min_child: number | null;
    max_child: number | null;
    min_newborn?: number | null;
    max_newborn?: number | null;
  },
  gender: string,
  ageYears: number,
  ageMonths = 0,
  ageDays = 0
): { flag: 'Normal' | 'High' | 'Low' | 'Abnormal'; rangeLabel: string } {
  const trimmed = value.trim();
  const resolved = resolveReferenceRange(param, gender, ageYears, ageMonths, ageDays);

  if (!trimmed) {
    return { flag: 'Normal', rangeLabel: resolved.label };
  }

  if (param.input_type === 'numeric') {
    const num = Number(trimmed.replace(/,/g, ''));
    if (!Number.isNaN(num)) {
      if (resolved.min !== null && num < resolved.min) {
        return { flag: 'Low', rangeLabel: resolved.label };
      }
      if (resolved.max !== null && num > resolved.max) {
        return { flag: 'High', rangeLabel: resolved.label };
      }
      return { flag: 'Normal', rangeLabel: resolved.label };
    }
  }

  if (param.abnormal_values) {
    const abnormalList = param.abnormal_values
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (abnormalList.includes(trimmed.toLowerCase())) {
      return { flag: 'Abnormal', rangeLabel: resolved.label };
    }
  }

  return { flag: 'Normal', rangeLabel: resolved.label };
}
