import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, FlaskConical, Search } from 'lucide-react';
import { apiFetch, evaluateClientFlag, formatAge, formatDateTime } from '../lib/api.ts';
import type { LabQueueItem, LabSettings, TestResultRow } from '../types.ts';

interface LabResultsViewProps {
  settings: LabSettings;
  onOpenReport: (invoiceId: number, focusTestId?: number) => void;
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
  return (
    n.includes('total rbc') ||
    /\brbc\b/.test(n)
  ) && !n.includes('urine');
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

export const LabResultsView: React.FC<LabResultsViewProps> = ({ settings, onOpenReport }) => {
  const [statusFilter, setStatusFilter] = useState<string>('Pending');
  const [search, setSearch] = useState('');
  const [queue, setQueue] = useState<LabQueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedItem, setSelectedItem] = useState<LabQueueItem | null>(null);
  const [results, setResults] = useState<TestResultRow[]>([]);
  const [valuesMap, setValuesMap] = useState<Record<number, string>>({});
  const [nextStatus, setNextStatus] = useState<LabQueueItem['status']>('Processing');
  const [verifiedBy, setVerifiedBy] = useState(settings.technologist_name || 'Medical Technologist');
  const [consultantName, setConsultantName] = useState('');
  const [consultantTitle, setConsultantTitle] = useState('');
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
  }, [loadQueue]);

  const openEditor = async (q: LabQueueItem) => {
    setMessage('');
    setError('');
    try {
      const res = await apiFetch<{ item: LabQueueItem; results: TestResultRow[] }>(
        `/api/lab-tests/${q.id}`
      );
      setSelectedItem(res.item);
      setResults(res.results);
      const initialVals: Record<number, string> = {};
      for (const r of res.results) {
        initialVals[r.parameter_id] = r.result_value || '';
      }
      setValuesMap(applyCbcAutoCalculations(res.results, initialVals));
      setNextStatus(res.item.status === 'Sample Collected' ? 'Processing' : res.item.status);
      setVerifiedBy(res.item.verified_by || settings.technologist_name || 'Medical Technologist');
      if (res.item.consultant_name === '__BLANK__') {
        setConsultantName('__BLANK__');
        setConsultantTitle('');
      } else if (res.item.consultant_name) {
        setConsultantName(res.item.consultant_name);
        setConsultantTitle(res.item.consultant_title || '');
      } else {
        setConsultantName(settings.pathologist_name || '');
        setConsultantTitle(settings.pathologist_title || '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load test parameters.');
    }
  };

  const handleValueChange = (parameterId: number, nextValue: string) => {
    setValuesMap((prev) => {
      const updated = { ...prev, [parameterId]: nextValue };
      return applyCbcAutoCalculations(results, updated, parameterId);
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

  const handleSave = async (statusOverride?: LabQueueItem['status'], openPrintAfter = false) => {
    if (!selectedItem) return;
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
      const res = await apiFetch<{ item: LabQueueItem; results: TestResultRow[] }>(
        `/api/lab-tests/${selectedItem.id}/results`,
        {
          method: 'PUT',
          body: JSON.stringify({
            results: payload,
            status: targetStatus,
            verifiedBy,
            consultantName: consultantName.trim() === '' ? '__BLANK__' : consultantName.trim(),
            consultantTitle: consultantName.trim() === '' || consultantName === '__BLANK__' ? '' : consultantTitle.trim(),
          }),
        }
      );
      const syncedVals: Record<number, string> = {};
      for (const r of res.results) {
        syncedVals[r.parameter_id] = r.result_value || '';
      }
      setValuesMap((prev) => ({ ...prev, ...syncedVals }));
      setNextStatus(res.item.status);
      setSelectedItem((prev) =>
        prev
          ? {
              ...prev,
              status: res.item.status,
              consultant_name: res.item.consultant_name,
              consultant_title: res.item.consultant_title,
            }
          : null
      );
      setMessage(`Saved results (${res.item.status}).`);
      await loadQueue();
      if (openPrintAfter) {
        onOpenReport(selectedItem.invoice_id, selectedItem.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save results.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Lab Result Entry & Reporting</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Enter test measurements with automatic age/gender abnormal flagging and report verification.
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
        {/* Left: Queue Table */}
        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900">Sample Queue ({queue.length})</span>
            {loading && <span className="text-xs text-slate-500">Loading...</span>}
          </div>

          <div className="divide-y divide-slate-200 max-h-[640px] overflow-y-auto">
            {queue.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No tests match the current filter.
              </div>
            ) : (
              queue.map((q) => {
                const active = selectedItem?.id === q.id;
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => openEditor(q)}
                    className={`w-full text-left p-4 transition-colors flex items-start justify-between gap-3 ${
                      active ? 'bg-teal-50/80' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-slate-500">
                        <span className="font-semibold text-slate-800">{q.invoice_no}</span>
                        <span aria-hidden="true">·</span>
                        <span>{q.patient_uid}</span>
                      </div>
                      <div className="text-sm font-semibold text-slate-900 mt-0.5 truncate">
                        {q.patient_name}{' '}
                        <span className="text-xs font-normal text-slate-600">
                          ({formatAge(q.age_years, q.age_months, q.age_days)} · {q.gender})
                        </span>
                      </div>
                      <div className="text-xs font-medium text-teal-800 mt-1">{q.test_name}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {q.category_name} · {q.filled_params}/{q.total_params} entered
                        {q.abnormal_count > 0 && (
                          <span className="ml-2 font-semibold text-red-600">
                            · {q.abnormal_count} Abnormal
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span
                        className={`text-xs font-semibold ${
                          q.status === 'Ready'
                            ? 'text-emerald-700'
                            : q.status === 'Verified'
                            ? 'text-teal-700'
                            : q.status === 'Processing'
                            ? 'text-amber-700'
                            : 'text-slate-700'
                        }`}
                      >
                        {q.status}
                      </span>
                      <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-1">
                        {formatDateTime(q.collected_at).split(',')[0]}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Tabular Result Entry Workspace */}
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl p-5">
          {!selectedItem ? (
            <div className="py-16 text-center space-y-2">
              <FlaskConical className="w-8 h-8 text-slate-400 mx-auto" />
              <h3 className="text-sm font-semibold text-slate-800">Select a Patient Test From the Queue</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Click any test on the left to enter pathology parameters, check abnormal High/Low flags, and print the A4 clinical report.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Patient Header */}
              <div className="pb-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-mono tabular-nums text-slate-500">
                    {selectedItem.invoice_no} · {selectedItem.patient_uid} · {selectedItem.sample_type}
                  </div>
                  <h2 className="text-lg font-bold text-slate-900 mt-0.5">{selectedItem.test_name}</h2>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Patient: <span className="font-semibold text-slate-900">{selectedItem.patient_name}</span> ·{' '}
                    {formatAge(selectedItem.age_years, selectedItem.age_months, selectedItem.age_days)} ·{' '}
                    {selectedItem.gender}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenReport(selectedItem.invoice_id, selectedItem.id)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 whitespace-nowrap shrink-0"
                >
                  <FileText className="w-4 h-4" />
                  Print A4 Report
                </button>
              </div>

              {/* Parameter Data Entry Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="py-2 pr-3 font-medium">Parameter</th>
                      <th className="py-2 pr-3 font-medium w-44">Result Value</th>
                      <th className="py-2 pr-3 font-medium">Unit</th>
                      <th className="py-2 pr-3 font-medium">Reference Range</th>
                      <th className="py-2 font-medium text-right w-24">Flag</th>
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
                      const autoFormulaLabel = isAutoCircEos
                        ? 'Auto-calculated: (Total WBC × Eosinophils) ÷ 100'
                        : isAutoMcv
                        ? 'Auto-calculated: (PCV × 10) ÷ Total RBC'
                        : isAutoMch
                        ? 'Auto-calculated: (Hb × 10) ÷ Total RBC'
                        : isAutoMchc
                        ? 'Auto-calculated: (Hb ÷ PCV) × 100'
                        : '';
                      const options = (r.select_options || '')
                        .split(',')
                        .map((o) => o.trim())
                        .filter(Boolean);

                      return (
                        <tr key={r.id}>
                          <td className="py-2.5 pr-3 font-medium text-slate-900">
                            <div>{r.parameter_name}</div>
                            {autoFormulaLabel && (
                              <div className="text-[11px] font-normal text-teal-700">
                                {autoFormulaLabel}
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 pr-3">
                            {isAutoCircEos ? (
                              <input
                                type="text"
                                readOnly
                                value={val}
                                placeholder="Auto-calculated"
                                title="Automatically calculated as (Total WBC Count × Eosinophils %) / 100"
                                className={`w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border rounded-lg bg-slate-50 cursor-not-allowed focus:outline-none ${
                                  isAbnormal
                                    ? 'border-red-400 text-red-600 font-bold'
                                    : 'border-slate-200 text-slate-900 font-semibold'
                                }`}
                              />
                            ) : r.input_type === 'select' && options.length > 0 ? (
                              <select
                                value={val}
                                onChange={(e) => handleValueChange(r.parameter_id, e.target.value)}
                                className={`w-full px-2.5 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 bg-white ${
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
                                  autoFormulaLabel
                                    ? 'Auto-calculated'
                                    : r.input_type === 'numeric'
                                    ? '0.0'
                                    : 'Enter value'
                                }
                                title={autoFormulaLabel || undefined}
                                className={`w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 ${
                                  isAbnormal
                                    ? 'border-red-400 bg-red-50/40 text-red-600 font-bold'
                                    : autoFormulaLabel
                                    ? 'border-slate-300 bg-teal-50/30 text-slate-900 font-semibold'
                                    : 'border-slate-300 text-slate-900'
                                }`}
                              />
                            )}
                          </td>
                          <td className="py-2.5 pr-3 text-xs text-slate-600">{r.unit || '—'}</td>
                          <td className="py-2.5 pr-3 text-xs font-mono tabular-nums text-slate-600">
                            {r.reference_range_text || r.normal_text || '—'}
                          </td>
                          <td className="py-2.5 text-right text-xs">
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
                  className={`p-3 rounded-lg border text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
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
              <div className="pt-4 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Workflow Status</label>
                  <select
                    value={nextStatus}
                    onChange={(e) => setNextStatus(e.target.value as LabQueueItem['status'])}
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
                  <label className="block text-xs font-medium text-slate-700 mb-1">Prepared / Tested By (Technologist)</label>
                  <input
                    type="text"
                    value={verifiedBy}
                    onChange={(e) => setVerifiedBy(e.target.value)}
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
                          onClick={() => {
                            setConsultantName(settings.pathologist_name);
                            setConsultantTitle(settings.pathologist_title || 'Consultant Pathologist');
                          }}
                          className="px-2 py-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded hover:bg-teal-100"
                        >
                          Use Lab Pathologist
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setConsultantName('__BLANK__');
                          setConsultantTitle('');
                        }}
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
                      onChange={(e) => setConsultantName(e.target.value)}
                      placeholder="Blank (No Consultant Assigned — Manual Signature Line)"
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <input
                      type="text"
                      value={consultantName === '__BLANK__' ? '' : consultantTitle}
                      onChange={(e) => setConsultantTitle(e.target.value)}
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
                  onClick={() => handleSave()}
                  className="px-4 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  Save Draft / Status
                </button>
                <button
                  type="button"
                  disabled={saving || (differentialSummary.hasDifferential && !differentialSummary.isValid100)}
                  onClick={() => handleSave('Ready', false)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Mark Ready
                </button>
                <button
                  type="button"
                  disabled={saving || (differentialSummary.hasDifferential && !differentialSummary.isValid100)}
                  onClick={() => handleSave('Ready', true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
                >
                  <FileText className="w-4 h-4" />
                  Finalize & Print Report
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
