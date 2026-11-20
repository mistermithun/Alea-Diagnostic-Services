import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  FileText,
  FlaskConical,
  Save,
  Search,
} from 'lucide-react';
import { apiFetch, evaluateClientFlag, formatAge, formatDateTime } from '../lib/api.ts';
import { broadcastPatientsUpdated } from '../lib/liveSync.ts';
import { OFFLINE_SYNCED_EVENT } from '../lib/offlineEngine.ts';
import { deduplicateTestResults } from '../lib/reportLayout.ts';
import type { FullInvoice, LabQueueItem, LabSettings, TestResultRow } from '../types.ts';
import { SampleTimerControl } from './SampleTimerControl.tsx';

interface LabResultsViewProps {
  settings: LabSettings;
  onOpenReport: (invoiceId: number, focusTestId?: number) => void;
  targetPatient?: { invoiceId: number; testName?: string; nonce: number } | null;
}

interface PatientQueueGroup {
  invoice_id: number;
  invoice_no: string;
  invoice_date: string;
  patient_uid: string;
  patient_name: string;
  age_years: number;
  age_months: number;
  age_days: number;
  gender: LabQueueItem['gender'];
  patient_mobile: string;
  doctor_name?: string;
  tests: LabQueueItem[];
  readyCount: number;
  totalFilled: number;
  totalParams: number;
  totalAbnormal: number;
  latestCollectedAt: string;
}

interface TestDraftState {
  item: LabQueueItem;
  results: TestResultRow[];
  valuesMap: Record<number, string>;
  nextStatus: LabQueueItem['status'];
  verifiedBy: string;
  consultantName: string;
  consultantTitle: string;
  dirty: boolean;
}

const STATUS_TABS = ['Pending', 'Sample Collected', 'Processing', 'Verified', 'Ready', 'All'] as const;

function isTotalWbcParam(name: string): boolean {
  return name.toLowerCase().includes('total wbc');
}

function isDiffEosinophilParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('eosinophil') && !n.includes('circulating');
}

function isCirculatingEosinophilParam(name: string): boolean {
  return name.toLowerCase().includes('circulating eosinophil');
}

function isHemoglobinParam(name: string): boolean {
  const n = name.toLowerCase().trim();
  return (
    n === 'hemoglobin (hb)' ||
    n === 'hemoglobin' ||
    n === 'hb' ||
    (n.includes('hemoglobin') &&
      !n.includes('hba1c') &&
      !n.includes('glycated') &&
      !n.includes('occult'))
  );
}

function isPcvParam(name: string): boolean {
  const n = name.toLowerCase().trim();
  return (
    /\bpcv\b/.test(n) ||
    /\bhct\b/.test(n) ||
    n.includes('packed cell volume') ||
    n.includes('hematocrit')
  );
}

function isTotalRbcParam(name: string): boolean {
  const n = name.toLowerCase().trim();
  return (n.includes('total rbc') || /\brbc\b/.test(n)) && !n.includes('urine');
}

function isMcvParam(name: string): boolean {
  const n = name.toLowerCase().trim();
  return /\bmcv\b/.test(n) || n.includes('mean corpuscular volume');
}

function isMchParam(name: string): boolean {
  const n = name.toLowerCase().trim();
  return (
    (/\bmch\b/.test(n) ||
      (n.includes('mean corpuscular hemoglobin') && !n.includes('concentration'))) &&
    !n.includes('mchc')
  );
}

function isMchcParam(name: string): boolean {
  const n = name.toLowerCase().trim();
  return /\bmchc\b/.test(n) || n.includes('mean corpuscular hemoglobin concentration');
}

function parseNumericInput(rawValue: string | undefined): number {
  const cleaned = (rawValue ?? '').replace(/,/g, '').trim();
  if (!cleaned) return Number.NaN;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : Number.NaN;
}

function roundToTwoDecimals(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function isDifferentialParam(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.startsWith('neutrophil') ||
    n.startsWith('lymphocyte') ||
    n.startsWith('monocyte') ||
    isDiffEosinophilParam(name) ||
    n.startsWith('basophil')
  );
}

function applyCbcAutoCalculations(
  rows: TestResultRow[],
  map: Record<number, string>,
  changedParameterId?: number
): Record<number, string> {
  const next = { ...map };

  const wbcRow = rows.find((r) => isTotalWbcParam(r.parameter_name));
  const eosRow = rows.find((r) => isDiffEosinophilParam(r.parameter_name));
  const circEosRow = rows.find((r) => isCirculatingEosinophilParam(r.parameter_name));

  if (wbcRow && eosRow && circEosRow) {
    const wbc = parseNumericInput(next[wbcRow.parameter_id]);
    const eos = parseNumericInput(next[eosRow.parameter_id]);

    if (Number.isFinite(wbc) && Number.isFinite(eos) && wbc >= 0 && eos >= 0) {
      next[circEosRow.parameter_id] = roundToTwoDecimals((wbc * eos) / 100);
    } else {
      next[circEosRow.parameter_id] = '';
    }
  }

  // Real-time RBC Indices: MCV, MCH, MCHC from Hemoglobin (Hb), PCV / HCT, Total RBC Count
  const hbRow = rows.find((r) => isHemoglobinParam(r.parameter_name));
  const pcvRow = rows.find((r) => isPcvParam(r.parameter_name));
  const rbcRow = rows.find((r) => isTotalRbcParam(r.parameter_name));
  const mcvRow = rows.find((r) => isMcvParam(r.parameter_name));
  const mchRow = rows.find((r) => isMchParam(r.parameter_name));
  const mchcRow = rows.find((r) => isMchcParam(r.parameter_name));

  const isSourceChange =
    changedParameterId === undefined ||
    changedParameterId === hbRow?.parameter_id ||
    changedParameterId === pcvRow?.parameter_id ||
    changedParameterId === rbcRow?.parameter_id;

  if (isSourceChange) {
    const hb = hbRow ? parseNumericInput(next[hbRow.parameter_id]) : Number.NaN;
    const pcv = pcvRow ? parseNumericInput(next[pcvRow.parameter_id]) : Number.NaN;
    const rbc = rbcRow ? parseNumericInput(next[rbcRow.parameter_id]) : Number.NaN;

    const hasHb = Number.isFinite(hb) && hb > 0;
    const hasPcv = Number.isFinite(pcv) && pcv > 0;
    const hasRbc = Number.isFinite(rbc) && rbc > 0;

    // 1. MCV (fL) = (PCV * 10) / Total RBC count
    if (mcvRow && pcvRow && rbcRow) {
      const hasExistingMcv = Boolean((next[mcvRow.parameter_id] ?? '').trim());
      if (hasPcv && hasRbc) {
        if (changedParameterId !== undefined || !hasExistingMcv) {
          next[mcvRow.parameter_id] = roundToTwoDecimals((pcv * 10) / rbc);
        }
      } else if (changedParameterId !== undefined || !hasExistingMcv) {
        next[mcvRow.parameter_id] = '';
      }
    }

    // 2. MCH (pg) = (Hemoglobin * 10) / Total RBC Count
    if (mchRow && hbRow && rbcRow) {
      const hasExistingMch = Boolean((next[mchRow.parameter_id] ?? '').trim());
      if (hasHb && hasRbc) {
        if (changedParameterId !== undefined || !hasExistingMch) {
          next[mchRow.parameter_id] = roundToTwoDecimals((hb * 10) / rbc);
        }
      } else if (changedParameterId !== undefined || !hasExistingMch) {
        next[mchRow.parameter_id] = '';
      }
    }

    // 3. MCHC (g/dL) = (Hemoglobin / PCV) * 100
    if (mchcRow && hbRow && pcvRow) {
      const hasExistingMchc = Boolean((next[mchcRow.parameter_id] ?? '').trim());
      if (hasHb && hasPcv) {
        if (changedParameterId !== undefined || !hasExistingMchc) {
          next[mchcRow.parameter_id] = roundToTwoDecimals((hb / pcv) * 100);
        }
      } else if (changedParameterId !== undefined || !hasExistingMchc) {
        next[mchcRow.parameter_id] = '';
      }
    }
  }

  return next;
}

function getStatusDotClass(status: LabQueueItem['status']): string {
  switch (status) {
    case 'Ready':
      return 'bg-emerald-500';
    case 'Verified':
      return 'bg-teal-500';
    case 'Processing':
      return 'bg-amber-500';
    default:
      return 'bg-slate-400';
  }
}

function getStatusTextClass(status: LabQueueItem['status']): string {
  switch (status) {
    case 'Ready':
      return 'text-emerald-700';
    case 'Verified':
      return 'text-teal-700';
    case 'Processing':
      return 'text-amber-700';
    default:
      return 'text-slate-600';
  }
}

export const LabResultsView: React.FC<LabResultsViewProps> = ({
  settings,
  onOpenReport,
  targetPatient,
}) => {
  const [statusFilter, setStatusFilter] = useState<string>('Pending');
  const [search, setSearch] = useState('');
  const [queue, setQueue] = useState<LabQueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Unified Patient Workspace State (1 tab per patient, sub-tabs per test)
  const [activeInvoiceId, setActiveInvoiceId] = useState<number | null>(null);
  const [patientHeader, setPatientHeader] = useState<{
    invoice_id: number;
    invoice_no: string;
    patient_uid: string;
    patient_name: string;
    age_years: number;
    age_months: number;
    age_days: number;
    gender: LabQueueItem['gender'];
    patient_mobile: string;
    doctor_name?: string;
    doctor_degree?: string;
  } | null>(null);
  const [subTests, setSubTests] = useState<LabQueueItem[]>([]);
  const [activeSubTestId, setActiveSubTestId] = useState<number | null>(null);
  const [loadingSubTest, setLoadingSubTest] = useState(false);

  // Per-test draft state cache so switching sub-tabs never loses unsaved typed inputs
  const [draftsByTestId, setDraftsByTestId] = useState<Record<number, TestDraftState>>({});

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ queue: LabQueueItem[] }>(
        `/api/lab-queue?status=${encodeURIComponent(statusFilter)}&search=${encodeURIComponent(search)}`
      );
      setQueue(res.queue);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load lab queue.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    loadQueue();
    const onOfflineSynced = () => {
      void loadQueue();
    };
    window.addEventListener(OFFLINE_SYNCED_EVENT, onOfflineSynced);
    return () => {
      window.removeEventListener(OFFLINE_SYNCED_EVENT, onOfflineSynced);
    };
  }, [loadQueue]);

  // Group individual queue items into ONE queue entry per patient/invoice
  const patientGroups = useMemo<PatientQueueGroup[]>(() => {
    const map = new Map<number, PatientQueueGroup>();
    for (const q of queue) {
      let grp = map.get(q.invoice_id);
      if (!grp) {
        grp = {
          invoice_id: q.invoice_id,
          invoice_no: q.invoice_no,
          invoice_date: q.invoice_date,
          patient_uid: q.patient_uid,
          patient_name: q.patient_name,
          age_years: q.age_years,
          age_months: q.age_months,
          age_days: q.age_days,
          gender: q.gender,
          patient_mobile: q.patient_mobile,
          doctor_name: q.doctor_name,
          tests: [],
          readyCount: 0,
          totalFilled: 0,
          totalParams: 0,
          totalAbnormal: 0,
          latestCollectedAt: q.collected_at,
        };
        map.set(q.invoice_id, grp);
      }
      grp.tests.push(q);
      if (q.status === 'Ready') grp.readyCount += 1;
      grp.totalFilled += q.filled_params || 0;
      grp.totalParams += q.total_params || 0;
      grp.totalAbnormal += q.abnormal_count || 0;
      if (q.collected_at && (!grp.latestCollectedAt || q.collected_at > grp.latestCollectedAt)) {
        grp.latestCollectedAt = q.collected_at;
      }
    }
    return Array.from(map.values());
  }, [queue]);

  const buildInitialDraft = useCallback(
    (item: LabQueueItem, fetchedResults: TestResultRow[]): TestDraftState => {
      const uniqueResults = deduplicateTestResults(fetchedResults);
      const initialVals: Record<number, string> = {};
      for (const r of uniqueResults) {
        initialVals[r.parameter_id] = r.result_value || '';
      }
      let cName = '';
      let cTitle = '';
      if (item.consultant_name === '__BLANK__') {
        cName = '__BLANK__';
        cTitle = '';
      } else if (item.consultant_name) {
        cName = item.consultant_name;
        cTitle = item.consultant_title || '';
      } else {
        cName = settings.pathologist_name || '';
        cTitle = settings.pathologist_title || '';
      }
      return {
        item,
        results: uniqueResults,
        valuesMap: applyCbcAutoCalculations(uniqueResults, initialVals),
        nextStatus: item.status === 'Sample Collected' ? 'Processing' : item.status,
        verifiedBy: item.verified_by || settings.technologist_name || 'Medical Technologist',
        consultantName: cName,
        consultantTitle: cTitle,
        dirty: false,
      };
    },
    [settings.pathologist_name, settings.pathologist_title, settings.technologist_name]
  );

  const loadSubTestEditor = useCallback(
    async (invoiceTestId: number, forceRefresh = false) => {
      setActiveSubTestId(invoiceTestId);
      setMessage('');
      setError('');

      if (!forceRefresh && draftsByTestId[invoiceTestId]) {
        return;
      }

      setLoadingSubTest(true);
      try {
        const res = await apiFetch<{ item: LabQueueItem; results: TestResultRow[] }>(
          `/api/lab-tests/${invoiceTestId}`
        );
        const draft = buildInitialDraft(res.item, res.results);
        setDraftsByTestId((prev) => ({
          ...prev,
          [invoiceTestId]: draft,
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load test parameters.');
      } finally {
        setLoadingSubTest(false);
      }
    },
    [buildInitialDraft, draftsByTestId]
  );

  const openPatientWorkspace = async (group: PatientQueueGroup) => {
    setMessage('');
    setError('');
    setActiveInvoiceId(group.invoice_id);
    setPatientHeader({
      invoice_id: group.invoice_id,
      invoice_no: group.invoice_no,
      patient_uid: group.patient_uid,
      patient_name: group.patient_name,
      age_years: group.age_years,
      age_months: group.age_months,
      age_days: group.age_days,
      gender: group.gender,
      patient_mobile: group.patient_mobile,
      doctor_name: group.doctor_name,
    });

    try {
      const fullInv = await apiFetch<FullInvoice>(`/api/invoices/${group.invoice_id}`);
      const queueLookup = new Map(group.tests.map((t) => [t.id, t]));
      const mergedSubTests: LabQueueItem[] = fullInv.tests.map((t) => {
        const fromQueue = queueLookup.get(t.id);
        return {
          ...t,
          invoice_no: fullInv.invoice.invoice_no,
          invoice_date: fullInv.invoice.created_at,
          patient_uid: fullInv.invoice.patient_uid,
          patient_name: fullInv.invoice.patient_name,
          age_years: fullInv.invoice.age_years,
          age_months: fullInv.invoice.age_months,
          age_days: fullInv.invoice.age_days,
          gender: fullInv.invoice.gender,
          patient_mobile: fullInv.invoice.patient_mobile,
          doctor_name: fullInv.invoice.doctor_name,
          total_params: fromQueue?.total_params ?? t.results?.length ?? 0,
          filled_params:
            fromQueue?.filled_params ??
            (t.results ? t.results.filter((r) => (r.result_value || '').trim() !== '').length : 0),
          abnormal_count:
            fromQueue?.abnormal_count ??
            (t.results
              ? t.results.filter(
                  (r) => (r.result_value || '').trim() !== '' && r.flag && r.flag !== 'Normal'
                ).length
              : 0),
        };
      });

      setPatientHeader({
        invoice_id: fullInv.invoice.id,
        invoice_no: fullInv.invoice.invoice_no,
        patient_uid: fullInv.invoice.patient_uid,
        patient_name: fullInv.invoice.patient_name,
        age_years: fullInv.invoice.age_years,
        age_months: fullInv.invoice.age_months,
        age_days: fullInv.invoice.age_days,
        gender: fullInv.invoice.gender,
        patient_mobile: fullInv.invoice.patient_mobile,
        doctor_name: fullInv.invoice.doctor_name,
        doctor_degree: fullInv.invoice.doctor_degree,
      });
      setSubTests(mergedSubTests);
      setDraftsByTestId({});

      // Pick first pending/matching test from the clicked queue group
      const defaultTest =
        group.tests[0] ||
        mergedSubTests.find((t) => t.status !== 'Ready') ||
        mergedSubTests[0];
      if (defaultTest) {
        setActiveSubTestId(defaultTest.id);
        setLoadingSubTest(true);
        try {
          const res = await apiFetch<{ item: LabQueueItem; results: TestResultRow[] }>(
            `/api/lab-tests/${defaultTest.id}`
          );
          const draft = buildInitialDraft(res.item, res.results);
          setDraftsByTestId({ [defaultTest.id]: draft });
        } finally {
          setLoadingSubTest(false);
        }
      }
    } catch (err) {
      // Fallback to tests already in the queue group if invoice lookup fails
      setSubTests(group.tests);
      if (group.tests[0]) {
        await loadSubTestEditor(group.tests[0].id, true);
      }
      if (err instanceof Error) {
        setError(err.message);
      }
    }
  };

  useEffect(() => {
    if (!targetPatient) return;
    let cancelled = false;

    const loadTargetedPatient = async () => {
      setMessage('');
      setError('');
      setActiveInvoiceId(targetPatient.invoiceId);
      setLoadingSubTest(true);
      try {
        const fullInv = await apiFetch<FullInvoice>(`/api/invoices/${targetPatient.invoiceId}`);
        if (cancelled) return;

        const mergedSubTests: LabQueueItem[] = fullInv.tests.map((t) => ({
          ...t,
          invoice_no: fullInv.invoice.invoice_no,
          invoice_date: fullInv.invoice.created_at,
          patient_uid: fullInv.invoice.patient_uid,
          patient_name: fullInv.invoice.patient_name,
          age_years: fullInv.invoice.age_years,
          age_months: fullInv.invoice.age_months,
          age_days: fullInv.invoice.age_days,
          gender: fullInv.invoice.gender,
          patient_mobile: fullInv.invoice.patient_mobile,
          doctor_name: fullInv.invoice.doctor_name,
          total_params: t.results?.length ?? 0,
          filled_params: t.results
            ? t.results.filter((r) => (r.result_value || '').trim() !== '').length
            : 0,
          abnormal_count: t.results
            ? t.results.filter(
                (r) => (r.result_value || '').trim() !== '' && r.flag && r.flag !== 'Normal'
              ).length
            : 0,
        }));

        setPatientHeader({
          invoice_id: fullInv.invoice.id,
          invoice_no: fullInv.invoice.invoice_no,
          patient_uid: fullInv.invoice.patient_uid,
          patient_name: fullInv.invoice.patient_name,
          age_years: fullInv.invoice.age_years,
          age_months: fullInv.invoice.age_months,
          age_days: fullInv.invoice.age_days,
          gender: fullInv.invoice.gender,
          patient_mobile: fullInv.invoice.patient_mobile,
          doctor_name: fullInv.invoice.doctor_name,
          doctor_degree: fullInv.invoice.doctor_degree,
        });
        setSubTests(mergedSubTests);
        setDraftsByTestId({});

        const normalizedTarget = targetPatient.testName?.trim().toLowerCase();
        const chosenTest =
          (normalizedTarget
            ? mergedSubTests.find((t) => t.test_name.toLowerCase() === normalizedTarget)
            : undefined) ||
          mergedSubTests.find((t) => t.status !== 'Ready') ||
          mergedSubTests[0];

        if (chosenTest) {
          setActiveSubTestId(chosenTest.id);
          const res = await apiFetch<{ item: LabQueueItem; results: TestResultRow[] }>(
            `/api/lab-tests/${chosenTest.id}`
          );
          if (cancelled) return;
          const draft = buildInitialDraft(res.item, res.results);
          setDraftsByTestId({ [chosenTest.id]: draft });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to open patient workspace.');
        }
      } finally {
        if (!cancelled) setLoadingSubTest(false);
      }
    };

    loadTargetedPatient();
    return () => {
      cancelled = true;
    };
  }, [targetPatient, buildInitialDraft]);

  const activeDraft = activeSubTestId ? draftsByTestId[activeSubTestId] || null : null;
  const selectedItem = activeDraft?.item || null;
  const results = activeDraft?.results || [];
  const valuesMap = activeDraft?.valuesMap || {};
  const nextStatus = activeDraft?.nextStatus || 'Processing';
  const verifiedBy = activeDraft?.verifiedBy || settings.technologist_name || 'Medical Technologist';
  const consultantName = activeDraft?.consultantName || '';
  const consultantTitle = activeDraft?.consultantTitle || '';

  const updateActiveDraft = (updater: (prev: TestDraftState) => TestDraftState) => {
    if (!activeSubTestId) return;
    setDraftsByTestId((prev) => {
      const current = prev[activeSubTestId];
      if (!current) return prev;
      return {
        ...prev,
        [activeSubTestId]: updater(current),
      };
    });
  };

  const handleValueChange = (parameterId: number, nextValue: string) => {
    updateActiveDraft((prev) => {
      const updated = { ...prev.valuesMap, [parameterId]: nextValue };
      return {
        ...prev,
        valuesMap: applyCbcAutoCalculations(prev.results, updated, parameterId),
        dirty: true,
      };
    });
  };

  const differentialSummary = useMemo(() => {
    const diffRows = results.filter((r) => isDifferentialParam(r.parameter_name));
    if (diffRows.length < 4) {
      return { hasDifferential: false, total: 0, isValid100: true, hasInvalid: false };
    }
    let sum = 0;
    let hasInvalid = false;
    for (const r of diffRows) {
      const raw = (valuesMap[r.parameter_id] ?? '').replace(/,/g, '').trim();
      if (raw !== '') {
        const num = Number(raw);
        if (!Number.isFinite(num) || num < 0) {
          hasInvalid = true;
        } else {
          sum += num;
        }
      }
    }
    const total = Math.round(sum * 100) / 100;
    const isValid100 = !hasInvalid && Math.abs(sum - 100) <= 0.01;
    return { hasDifferential: true, total, isValid100, hasInvalid };
  }, [results, valuesMap]);

  const activeTestIndex = useMemo(
    () => subTests.findIndex((t) => t.id === activeSubTestId),
    [subTests, activeSubTestId]
  );
  const nextSubTest =
    activeTestIndex >= 0 && activeTestIndex + 1 < subTests.length
      ? subTests[activeTestIndex + 1]
      : null;

  const handleSave = async (
    statusOverride?: LabQueueItem['status'],
    actionAfter: 'none' | 'next' | 'print' = 'none'
  ) => {
    if (!selectedItem || !activeDraft) return;
    const targetStatus = statusOverride || nextStatus;

    if (
      targetStatus === 'Ready' &&
      differentialSummary.hasDifferential &&
      !differentialSummary.isValid100
    ) {
      setMessage('');
      setError(
        differentialSummary.hasInvalid
          ? 'Differential Count contains an invalid percentage value. Total must equal 100% before marking Ready.'
          : `Cannot mark CBC report Ready: Differential Count total is ${differentialSummary.total}% (must equal 100%).`
      );
      return;
    }

    setSaving(true);
    setError('');
    setMessage('');
    try {
      const payload = results.map((r) => ({
        parameterId: r.parameter_id,
        value: valuesMap[r.parameter_id] ?? '',
      }));
      const resolvedVerifiedBy =
        verifiedBy.trim() || settings.technologist_name || 'Medical Technologist';
      const resolvedConsultantPayload =
        consultantName === '__BLANK__' ? '__BLANK__' : consultantName.trim();
      const resolvedConsultantTitlePayload =
        consultantName === '__BLANK__' || resolvedConsultantPayload === ''
          ? ''
          : consultantTitle.trim();

      const res = await apiFetch<{ item: LabQueueItem; results: TestResultRow[] }>(
        `/api/lab-tests/${selectedItem.id}/results`,
        {
          method: 'PUT',
          body: JSON.stringify({
            results: payload,
            status: targetStatus,
            verifiedBy: resolvedVerifiedBy,
            consultantName: resolvedConsultantPayload,
            consultantTitle: resolvedConsultantTitlePayload,
          }),
        }
      );

      // If Finalize & Print was clicked, persist any other dirty sub-tab drafts so the combined report has all entered tests & signatures
      if (actionAfter === 'print') {
        const otherDirtyDrafts = Object.values(draftsByTestId).filter(
          (d) => d.dirty && d.item.id !== selectedItem.id
        );
        for (const other of otherDirtyDrafts) {
          const otherPayload = other.results.map((r) => ({
            parameterId: r.parameter_id,
            value: other.valuesMap[r.parameter_id] ?? '',
          }));
          const otherVerified =
            other.verifiedBy.trim() || settings.technologist_name || 'Medical Technologist';
          const otherConsultant =
            other.consultantName === '__BLANK__' ? '__BLANK__' : other.consultantName.trim();
          const otherConsultantTitle =
            other.consultantName === '__BLANK__' || otherConsultant === ''
              ? ''
              : other.consultantTitle.trim();
          await apiFetch(`/api/lab-tests/${other.item.id}/results`, {
            method: 'PUT',
            body: JSON.stringify({
              results: otherPayload,
              status: other.nextStatus,
              verifiedBy: otherVerified,
              consultantName: otherConsultant,
              consultantTitle: otherConsultantTitle,
            }),
          });
        }
      }

      const uniqueSynced = deduplicateTestResults(res.results);
      const syncedVals: Record<number, string> = {};
      let filledCount = 0;
      let abnormalCount = 0;
      for (const r of uniqueSynced) {
        const valStr = r.result_value || '';
        syncedVals[r.parameter_id] = valStr;
        if (valStr.trim() !== '') {
          filledCount += 1;
          if (r.flag && r.flag !== 'Normal') abnormalCount += 1;
        }
      }

      setDraftsByTestId((prev) => {
        const nextMap = { ...prev };
        const current = nextMap[selectedItem.id];
        if (current) {
          nextMap[selectedItem.id] = {
            ...current,
            item: {
              ...current.item,
              status: res.item.status,
              verified_by: res.item.verified_by,
              consultant_name: res.item.consultant_name,
              consultant_title: res.item.consultant_title,
              verified_at: res.item.verified_at,
              ready_at: res.item.ready_at,
            },
            results: uniqueSynced,
            valuesMap: syncedVals,
            nextStatus: res.item.status,
            dirty: false,
          };
        }
        if (actionAfter === 'print') {
          for (const key of Object.keys(nextMap)) {
            const k = Number(key);
            if (nextMap[k]?.dirty) {
              nextMap[k] = { ...nextMap[k], dirty: false };
            }
          }
        }
        return nextMap;
      });

      setSubTests((prev) =>
        prev.map((t) =>
          t.id === selectedItem.id
            ? {
                ...t,
                status: res.item.status,
                verified_by: res.item.verified_by,
                consultant_name: res.item.consultant_name,
                consultant_title: res.item.consultant_title,
                filled_params: filledCount,
                total_params: uniqueSynced.length,
                abnormal_count: abnormalCount,
              }
            : t
        )
      );

      setMessage(`Saved ${selectedItem.test_name} (${res.item.status}).`);
      broadcastPatientsUpdated();
      await loadQueue();

      if (actionAfter === 'print') {
        // Open unified combined A4 report for the entire patient invoice
        onOpenReport(selectedItem.invoice_id);
      } else if (actionAfter === 'next' && nextSubTest) {
        await loadSubTestEditor(nextSubTest.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save results.');
    } finally {
      setSaving(false);
    }
  };

  const handleHeaderPrintCombined = async () => {
    if (!patientHeader) return;
    const dirtyDrafts = Object.values(draftsByTestId).filter((d) => d.dirty);
    if (dirtyDrafts.length === 0) {
      onOpenReport(patientHeader.invoice_id);
      return;
    }
    setSaving(true);
    setError('');
    try {
      for (const draft of dirtyDrafts) {
        const payload = draft.results.map((r) => ({
          parameterId: r.parameter_id,
          value: draft.valuesMap[r.parameter_id] ?? '',
        }));
        const resolvedVerified =
          draft.verifiedBy.trim() || settings.technologist_name || 'Medical Technologist';
        const resolvedConsultant =
          draft.consultantName === '__BLANK__' ? '__BLANK__' : draft.consultantName.trim();
        const resolvedTitle =
          draft.consultantName === '__BLANK__' || resolvedConsultant === ''
            ? ''
            : draft.consultantTitle.trim();
        await apiFetch(`/api/lab-tests/${draft.item.id}/results`, {
          method: 'PUT',
          body: JSON.stringify({
            results: payload,
            status: draft.nextStatus,
            verifiedBy: resolvedVerified,
            consultantName: resolvedConsultant,
            consultantTitle: resolvedTitle,
          }),
        });
      }
      setDraftsByTestId((prev) => {
        const updated = { ...prev };
        for (const key of Object.keys(updated)) {
          const k = Number(key);
          if (updated[k]?.dirty) {
            updated[k] = { ...updated[k], dirty: false };
          }
        }
        return updated;
      });
      broadcastPatientsUpdated();
      await loadQueue();
      onOpenReport(patientHeader.invoice_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save pending changes before printing.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy tracking-tight">Lab Result Entry & Reporting</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            One unified workspace per patient with seamless test sub-tabs, auto calculations, and smart combined A4 printing.
          </p>
        </div>
      </div>

      {/* Filters & Search */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                statusFilter === tab ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="relative w-full lg:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search patient, invoice, test..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Unified Patient Queue (1 card per patient/invoice) */}
        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div>
              <span className="text-sm font-semibold text-slate-900">
                Patient Queue ({patientGroups.length})
              </span>
              <span className="ml-2 text-xs text-slate-500">
                · {queue.length} {queue.length === 1 ? 'test' : 'tests'}
              </span>
            </div>
            {loading && <span className="text-xs text-slate-500">Loading...</span>}
          </div>

          <div className="divide-y divide-slate-200 max-h-[660px] overflow-y-auto">
            {patientGroups.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No patients match the current filter.
              </div>
            ) : (
              patientGroups.map((group) => {
                const isSelected = activeInvoiceId === group.invoice_id;
                const allReady = group.readyCount === group.tests.length && group.tests.length > 0;
                return (
                  <div
                    key={group.invoice_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openPatientWorkspace(group)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openPatientWorkspace(group);
                      }
                    }}
                    className={`w-full text-left p-4 transition-colors flex items-start justify-between gap-3 cursor-pointer ${
                      isSelected ? 'bg-teal-50/80' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-slate-500">
                        <span className="font-semibold text-slate-800">{group.invoice_no}</span>
                        <span aria-hidden="true">·</span>
                        <span>{group.patient_uid}</span>
                      </div>
                      <div className="text-sm font-semibold text-slate-900 mt-0.5 truncate">
                        {group.patient_name}{' '}
                        <span className="text-xs font-normal text-slate-600">
                          ({formatAge(group.age_years, group.age_months, group.age_days)} · {group.gender})
                        </span>
                      </div>

                      {/* Compact Test Sub-list Preview */}
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {group.tests.map((t) => (
                          <span
                            key={t.id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md bg-white border border-slate-200 text-slate-700"
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${getStatusDotClass(t.status)}`} />
                            <span className="truncate max-w-[140px]">{t.test_name}</span>
                          </span>
                        ))}
                      </div>

                      <div className="text-[11px] text-slate-500 mt-1.5">
                        {group.tests.length} {group.tests.length === 1 ? 'test' : 'tests'} · {group.totalFilled}/
                        {group.totalParams} params entered
                        {group.totalAbnormal > 0 && (
                          <span className="ml-2 font-semibold text-red-600">
                            · {group.totalAbnormal} Abnormal
                          </span>
                        )}
                      </div>

                      <div className="mt-2">
                        <SampleTimerControl
                          compact
                          alignRight={false}
                          invoiceId={group.invoice_id}
                          invoiceNo={group.invoice_no}
                          patientUid={group.patient_uid}
                          patientName={group.patient_name}
                          tests={group.tests}
                        />
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span
                        className={`text-xs font-semibold ${
                          allReady
                            ? 'text-emerald-700'
                            : group.tests.length === 1
                            ? getStatusTextClass(group.tests[0].status)
                            : 'text-amber-700'
                        }`}
                      >
                        {group.tests.length === 1
                          ? group.tests[0].status
                          : allReady
                          ? 'All Ready'
                          : `${group.readyCount}/${group.tests.length} Ready`}
                      </span>
                      <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-1">
                        {formatDateTime(group.latestCollectedAt).split(',')[0]}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Single Patient Tab Workspace with Test Sub-Tabs */}
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4">
          {!patientHeader ? (
            <div className="py-16 text-center space-y-2">
              <FlaskConical className="w-8 h-8 text-slate-400 mx-auto" />
              <h3 className="text-sm font-semibold text-slate-800">Select a Patient From the Queue</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Click any patient on the left to open their unified report workspace and switch seamlessly between their ordered tests using sub-tabs.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Unified Patient Header */}
              <div className="pb-3 border-b border-slate-200 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-mono tabular-nums text-slate-500">
                    {patientHeader.invoice_no} · {patientHeader.patient_uid}
                    {selectedItem?.sample_type ? ` · Specimen: ${selectedItem.sample_type}` : ''}
                  </div>
                  <h2 className="text-lg font-bold text-slate-900 mt-0.5 truncate">
                    {patientHeader.patient_name}{' '}
                    <span className="text-xs font-medium text-slate-600">
                      ({formatAge(patientHeader.age_years, patientHeader.age_months, patientHeader.age_days)} ·{' '}
                      {patientHeader.gender})
                    </span>
                  </h2>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Ref: <span className="font-medium text-slate-800">{patientHeader.doctor_name || 'Self'}</span>
                    {' · '}
                    <span>
                      {subTests.filter((t) => t.status === 'Ready').length}/{subTests.length} Tests Ready
                    </span>
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <SampleTimerControl
                    invoiceId={patientHeader.invoice_id}
                    invoiceNo={patientHeader.invoice_no}
                    patientUid={patientHeader.patient_uid}
                    patientName={patientHeader.patient_name}
                    tests={subTests}
                    defaultTestName={selectedItem?.test_name}
                  />
                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleHeaderPrintCombined}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <FileText className="w-4 h-4" />
                    Print Combined A4 Report
                  </button>
                </div>
              </div>

              {/* Sub-Tabs Strip for All Tests Ordered for This Patient */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 px-1 mb-1.5">
                  Patient Tests ({subTests.length}) — Switch Sub-Tab to Enter Results
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {subTests.map((t) => {
                    const isActive = activeSubTestId === t.id;
                    const cachedDraft = draftsByTestId[t.id];
                    const effectiveStatus = cachedDraft?.item.status || t.status;
                    const isDirty = Boolean(cachedDraft?.dirty);

                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => loadSubTestEditor(t.id)}
                        className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                          isActive
                            ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        <span className={`w-2 h-2 rounded-full shrink-0 ${getStatusDotClass(effectiveStatus)}`} />
                        <span>{t.test_name}</span>
                        <span
                          className={`text-[10px] font-normal ${
                            isActive ? 'text-slate-300' : 'text-slate-500'
                          }`}
                        >
                          ({effectiveStatus})
                        </span>
                        {isDirty && (
                          <span
                            title="Unsaved changes in this sub-tab"
                            className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {loadingSubTest || !selectedItem ? (
                <div className="py-10 text-center text-sm text-slate-500">
                  Loading test parameters...
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Active Sub-Test Banner */}
                  <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-teal-50/60 border border-teal-200/80 rounded-lg">
                    <div>
                      <span className="text-xs font-semibold text-teal-900">
                        Active Test: {selectedItem.test_name}
                      </span>
                      <span className="ml-2 text-[11px] text-teal-700">
                        ({selectedItem.category_name} · {selectedItem.sample_type})
                      </span>
                    </div>
                    <span className={`text-xs font-semibold ${getStatusTextClass(selectedItem.status)}`}>
                      Status: {selectedItem.status}
                    </span>
                  </div>

                  {/* Compact Parameter Data Entry Table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs sm:text-[13px] border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wider text-slate-500">
                          <th className="py-1.5 pr-2 font-semibold min-w-[140px]">Parameter</th>
                          <th className="py-1.5 pr-2 font-semibold w-32 sm:w-36">Result Value</th>
                          <th className="py-1.5 pr-2 font-semibold w-20 sm:w-24">Unit</th>
                          <th className="py-1.5 pr-2 font-semibold min-w-[160px]">Reference Range</th>
                          <th className="py-1.5 font-semibold text-right w-16 sm:w-20">Flag</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {results.map((r) => {
                          const val = valuesMap[r.parameter_id] ?? '';
                          const liveFlag = evaluateClientFlag(
                            val,
                            r,
                            selectedItem.gender,
                            selectedItem.age_years,
                            selectedItem.age_months,
                            selectedItem.age_days
                          );
                          const isAbnormal = val.trim() !== '' && liveFlag !== 'Normal';
                          const isAutoCircEos = isCirculatingEosinophilParam(r.parameter_name);
                          const isAutoMcv = isMcvParam(r.parameter_name);
                          const isAutoMch = isMchParam(r.parameter_name);
                          const isAutoMchc = isMchcParam(r.parameter_name);
                          const isAutoCalculated =
                            isAutoCircEos || isAutoMcv || isAutoMch || isAutoMchc;
                          const fullRangeText = (r.reference_range_text || r.normal_text || '').trim();
                          const options = (r.select_options || '')
                            .split(',')
                            .map((o) => o.trim())
                            .filter(Boolean);

                          return (
                            <tr key={r.id} className="hover:bg-slate-50/70">
                              <td className="py-1 pr-2 font-medium text-slate-900 align-middle leading-tight">
                                {r.parameter_name}
                              </td>
                              <td className="py-1 pr-2 align-middle">
                                {isAutoCircEos ? (
                                  <input
                                    type="text"
                                    readOnly
                                    value={val}
                                    placeholder="Auto-calculated"
                                    title="Auto-calculated"
                                    className={`w-full h-7 px-2 py-0.5 text-xs sm:text-[13px] font-mono tabular-nums border rounded-md bg-slate-50 cursor-not-allowed focus:outline-none ${
                                      isAbnormal
                                        ? 'border-red-400 text-red-600 font-bold'
                                        : 'border-slate-200 text-slate-900 font-semibold'
                                    }`}
                                  />
                                ) : r.input_type === 'select' && options.length > 0 ? (
                                  <select
                                    value={val}
                                    onChange={(e) => handleValueChange(r.parameter_id, e.target.value)}
                                    className={`w-full h-7 px-2 py-0.5 text-xs sm:text-[13px] border rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600 bg-white ${
                                      isAbnormal ? 'border-red-400 text-red-600 font-bold' : 'border-slate-300 text-slate-900'
                                    }`}
                                  >
                                    <option value="">Select...</option>
                                    {options.map((opt) => (
                                      <option key={opt} value={opt}>
                                        {opt}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    type="text"
                                    inputMode={r.input_type === 'numeric' ? 'decimal' : 'text'}
                                    value={val}
                                    onChange={(e) => handleValueChange(r.parameter_id, e.target.value)}
                                    placeholder={
                                      isAutoCalculated
                                        ? 'Auto-calculated'
                                        : r.input_type === 'numeric'
                                        ? '0.0'
                                        : 'Enter value'
                                    }
                                    title={isAutoCalculated ? 'Auto-calculated' : undefined}
                                    className={`w-full h-7 px-2 py-0.5 text-xs sm:text-[13px] font-mono tabular-nums border rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600 ${
                                      isAbnormal
                                        ? 'border-red-400 bg-red-50/40 text-red-600 font-bold'
                                        : isAutoCalculated
                                        ? 'border-slate-300 bg-teal-50/30 text-slate-900 font-semibold'
                                        : 'border-slate-300 text-slate-900'
                                    }`}
                                  />
                                )}
                              </td>
                              <td className="py-1 pr-2 text-[11px] text-slate-600 whitespace-nowrap align-middle">
                                {r.unit || '—'}
                              </td>
                              <td className="py-1 pr-2 align-middle">
                                <div
                                  title={fullRangeText || undefined}
                                  className="line-clamp-2 text-[11px] leading-snug font-mono tabular-nums text-slate-600 whitespace-pre-line break-words"
                                >
                                  {fullRangeText || '—'}
                                </div>
                              </td>
                              <td className="py-1 text-right text-[11px] whitespace-nowrap align-middle">
                                {val.trim() === '' ? (
                                  <span className="text-slate-400">—</span>
                                ) : isAbnormal ? (
                                  <span className="font-bold text-red-600 uppercase">{liveFlag}</span>
                                ) : (
                                  <span className="font-medium text-emerald-700">Normal</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Differential Count 100% Validation Banner */}
                  {differentialSummary.hasDifferential && (
                    <div
                      className={`p-2.5 rounded-lg border text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                        differentialSummary.isValid100
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                          : 'bg-red-50 border-red-200 text-red-800'
                      }`}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        {differentialSummary.isValid100 ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                        )}
                        <span>
                          {differentialSummary.hasInvalid
                            ? 'Differential Count contains an invalid numeric entry.'
                            : differentialSummary.isValid100
                            ? 'Differential Count equals 100%. Report can be marked Ready.'
                            : 'Differential Count must total exactly 100% before this report can be marked Ready.'}
                        </span>
                      </div>
                      <div className="font-mono tabular-nums font-bold shrink-0">
                        Total: {differentialSummary.total}% / 100%
                      </div>
                    </div>
                  )}

                  {/* Workflow Status & Save Controls */}
                  <div className="pt-3 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Workflow Status</label>
                      <select
                        value={nextStatus}
                        onChange={(e) =>
                          updateActiveDraft((prev) => ({
                            ...prev,
                            nextStatus: e.target.value as LabQueueItem['status'],
                            dirty: true,
                          }))
                        }
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 bg-white"
                      >
                        <option value="Sample Collected">Sample Collected</option>
                        <option value="Processing">Processing</option>
                        <option value="Verified">Verified</option>
                        <option
                          value="Ready"
                          disabled={differentialSummary.hasDifferential && !differentialSummary.isValid100}
                        >
                          Ready
                          {differentialSummary.hasDifferential && !differentialSummary.isValid100
                            ? ' (Requires 100% Differential)'
                            : ''}
                        </option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Prepared / Tested By (Technologist)
                      </label>
                      <input
                        type="text"
                        value={verifiedBy}
                        onChange={(e) =>
                          updateActiveDraft((prev) => ({
                            ...prev,
                            verifiedBy: e.target.value,
                            dirty: true,
                          }))
                        }
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                      />
                    </div>

                    <div className="sm:col-span-2 p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="text-xs font-medium text-slate-700">
                          Consultant / Pathologist Signature (Optional — leave blank for manual signing)
                        </label>
                        <div className="flex items-center gap-1.5">
                          {settings.pathologist_name && (
                            <button
                              type="button"
                              onClick={() =>
                                updateActiveDraft((prev) => ({
                                  ...prev,
                                  consultantName: settings.pathologist_name,
                                  consultantTitle: settings.pathologist_title || 'Consultant Pathologist',
                                  dirty: true,
                                }))
                              }
                              className="px-2 py-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded hover:bg-teal-100"
                            >
                              Use Lab Pathologist
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              updateActiveDraft((prev) => ({
                                ...prev,
                                consultantName: '__BLANK__',
                                consultantTitle: '',
                                dirty: true,
                              }))
                            }
                            className="px-2 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-100"
                          >
                            Leave Blank (Manual Sign)
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <input
                          type="text"
                          value={consultantName === '__BLANK__' ? '' : consultantName}
                          onChange={(e) =>
                            updateActiveDraft((prev) => ({
                              ...prev,
                              consultantName: e.target.value,
                              dirty: true,
                            }))
                          }
                          placeholder="Blank (No Consultant Assigned — Manual Signature Line)"
                          className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                        <input
                          type="text"
                          value={consultantName === '__BLANK__' ? '' : consultantTitle}
                          onChange={(e) =>
                            updateActiveDraft((prev) => ({
                              ...prev,
                              consultantTitle: e.target.value,
                              dirty: true,
                            }))
                          }
                          placeholder="Full Designation (e.g. MBBS, M.Phil / FCPS)"
                          disabled={consultantName === '__BLANK__'}
                          className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:bg-slate-100"
                        />
                      </div>
                    </div>
                  </div>

                  {error && (
                    <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
                      {error}
                    </div>
                  )}
                  {message && (
                    <div className="p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
                      {message}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => handleSave(undefined, 'none')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      <Save className="w-4 h-4" />
                      Save Draft
                    </button>

                    {nextSubTest && (
                      <button
                        type="button"
                        disabled={saving || (differentialSummary.hasDifferential && !differentialSummary.isValid100)}
                        onClick={() => handleSave('Ready', 'next')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-teal-900 bg-teal-50 border border-teal-300 rounded-lg hover:bg-teal-100 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
                      >
                        Save Ready &amp; Next Test
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={saving || (differentialSummary.hasDifferential && !differentialSummary.isValid100)}
                      onClick={() => handleSave('Ready', 'none')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-cyan rounded-lg hover:bg-brand-cyan-dark disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      Mark Ready
                    </button>

                    <button
                      type="button"
                      disabled={saving || (differentialSummary.hasDifferential && !differentialSummary.isValid100)}
                      onClick={() => handleSave('Ready', 'print')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
                    >
                      <FileText className="w-4 h-4" />
                      Finalize &amp; Print Combined Report
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
