import React, { useEffect, useMemo, useState } from 'react';
import { Check, Lock, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { apiFetch, formatBDT, formatDateTime } from '../lib/api.ts';
import { broadcastPatientsUpdated } from '../lib/liveSync.ts';
import { computeSequentialDiscounts, resolveInvoiceDiscountBreakdown } from '../../shared/discountMath.ts';
import type {
  DiagnosticTest,
  Doctor,
  FullInvoice,
  InvoiceSummary,
  LabSettings,
  TestCategory,
} from '../types.ts';

interface EditInvoiceModalProps {
  invoiceId: number;
  isAdmin: boolean;
  settings: LabSettings;
  categories: TestCategory[];
  tests: DiagnosticTest[];
  doctors: Doctor[];
  onClose: () => void;
  onSaved: (updated: InvoiceSummary, printReceipt: boolean) => void;
}

export const EditInvoiceModal: React.FC<EditInvoiceModalProps> = ({
  invoiceId,
  isAdmin,
  settings,
  categories,
  tests,
  doctors,
  onClose,
  onSaved,
}) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fullData, setFullData] = useState<FullInvoice | null>(null);

  // Editable patient & referral fields
  const [patientName, setPatientName] = useState('');
  const [ageYears, setAgeYears] = useState('0');
  const [ageMonths, setAgeMonths] = useState('0');
  const [ageDays, setAgeDays] = useState('0');
  const [gender, setGender] = useState<'Male' | 'Female' | 'Other'>('Male');
  const [mobile, setMobile] = useState('');
  const [address, setAddress] = useState('');
  const [doctorId, setDoctorId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');

  // Add & remove tests dynamically before saving
  const [addTestSearch, setAddTestSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  const [addedTestIds, setAddedTestIds] = useState<number[]>([]);
  const [removedInvoiceTestIds, setRemovedInvoiceTestIds] = useState<number[]>([]);

  // Billing adjustments
  const [doctorLessPercent, setDoctorLessPercent] = useState('0');
  const [flatDiscountAmount, setFlatDiscountAmount] = useState('0');
  const [additionalPayment, setAdditionalPayment] = useState('0');
  const [adjustmentAmount, setAdjustmentAmount] = useState('0');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [refundExcess, setRefundExcess] = useState(true);
  const [refundMethod, setRefundMethod] = useState('Cash');

  // Admin-only custom doctor commission setup
  const [commissionMode, setCommissionMode] = useState<'doctor_default' | 'custom_invoice' | 'custom_per_test'>('doctor_default');
  const [customCommType, setCustomCommType] = useState<'percent' | 'flat'>('percent');
  const [customCommValue, setCustomCommValue] = useState('0');
  const [perTestCommMap, setPerTestCommMap] = useState<
    Record<number, { type: 'percent' | 'flat'; value: string }>
  >({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch<FullInvoice>(`/api/invoices/${invoiceId}`)
      .then((res) => {
        if (cancelled) return;
        setFullData(res);
        setPatientName(res.invoice.patient_name);
        setAgeYears(String(res.invoice.age_years ?? 0));
        setAgeMonths(String(res.invoice.age_months ?? 0));
        setAgeDays(String(res.invoice.age_days ?? 0));
        setGender(res.invoice.gender);
        setMobile(res.invoice.patient_mobile || '');
        setAddress(res.invoice.patient_address || '');
        setDoctorId(res.invoice.doctor_id);
        setNotes(res.invoice.notes || '');
        const breakdown = resolveInvoiceDiscountBreakdown(res.invoice);
        setDoctorLessPercent(String(breakdown.doctorLessPercent));
        setFlatDiscountAmount(String(breakdown.flatDiscountAmount));
        setAdditionalPayment('0');
        setAdjustmentAmount(String(res.invoice.adjustment_amount ?? 0));
        setAdjustmentReason(res.invoice.adjustment_reason || '');
        setRefundExcess(true);
        setRefundMethod('Cash');
        setAddedTestIds([]);
        setRemovedInvoiceTestIds([]);

        const docObj = doctors.find((d) => d.id === res.invoice.doctor_id);
        const docPct = Number(docObj?.commission_pct ?? 0);
        const invCommType = res.invoice.commission_type || 'percent';
        const invCommVal =
          res.invoice.commission_value !== undefined
            ? Number(res.invoice.commission_value)
            : Number(res.invoice.commission_pct ?? docPct);

        if (invCommType === 'per_test') {
          setCommissionMode('custom_per_test');
          setCustomCommType('percent');
          setCustomCommValue(String(docPct));
        } else if (invCommType === 'flat' || Math.abs(invCommVal - docPct) > 0.01) {
          setCommissionMode('custom_invoice');
          setCustomCommType(invCommType === 'flat' ? 'flat' : 'percent');
          setCustomCommValue(String(invCommVal));
        } else {
          setCommissionMode('doctor_default');
          setCustomCommType('percent');
          setCustomCommValue(String(docPct));
        }

        const testMap: Record<number, { type: 'percent' | 'flat'; value: string }> = {};
        for (const t of res.tests) {
          testMap[t.test_id] = {
            type: t.commission_type === 'flat' ? 'flat' : 'percent',
            value: String(
              t.commission_value !== undefined ? t.commission_value : res.invoice.commission_pct ?? docPct
            ),
          };
        }
        setPerTestCommMap(testMap);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load invoice details.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [invoiceId, doctors]);

  const activeExistingTests = useMemo(
    () => (fullData?.tests || []).filter((t) => !removedInvoiceTestIds.includes(t.id)),
    [fullData, removedInvoiceTestIds]
  );

  const removedExistingTests = useMemo(
    () => (fullData?.tests || []).filter((t) => removedInvoiceTestIds.includes(t.id)),
    [fullData, removedInvoiceTestIds]
  );

  const existingTestIdSet = useMemo(
    () => new Set(activeExistingTests.map((t) => t.test_id)),
    [activeExistingTests]
  );

  const availableTests = useMemo(() => {
    const q = addTestSearch.trim().toLowerCase();
    return tests.filter((t) => {
      if (existingTestIdSet.has(t.id)) return false;
      if (activeCategory !== 'All' && t.category_name !== activeCategory) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q);
    });
  }, [tests, existingTestIdSet, activeCategory, addTestSearch]);

  const newlySelectedTests = useMemo(
    () => tests.filter((t) => addedTestIds.includes(t.id)),
    [tests, addedTestIds]
  );

  const totalActiveTestsCount = activeExistingTests.length + newlySelectedTests.length;

  const existingSubtotal = useMemo(
    () => activeExistingTests.reduce((sum, t) => sum + Number(t.price), 0),
    [activeExistingTests]
  );
  const addedSubtotal = useMemo(
    () => newlySelectedTests.reduce((sum, t) => sum + Number(t.price), 0),
    [newlySelectedTests]
  );
  const newSubtotal = existingSubtotal + addedSubtotal;

  const discountBreakdown = useMemo(
    () =>
      computeSequentialDiscounts({
        subtotal: newSubtotal,
        doctorLessPercent: Number(doctorLessPercent || 0),
        flatDiscountAmount: Number(flatDiscountAmount || 0),
      }),
    [newSubtotal, doctorLessPercent, flatDiscountAmount]
  );

  const newDoctorLessAmt = discountBreakdown.doctorLessAmount;
  const appliedDoctorLessPct = discountBreakdown.doctorLessPercent;
  const afterDoctorLess = discountBreakdown.afterDoctorLess;
  const newFlatDiscountAmt = discountBreakdown.flatDiscountAmount;
  const newDiscountAmount = discountBreakdown.discountAmount;

  const activeAdjAmt = isAdmin
    ? Number(adjustmentAmount || 0)
    : Number(fullData?.invoice.adjustment_amount || 0);
  const newNetTotal = Math.max(
    0,
    Math.round((discountBreakdown.netBeforeAdjustment - (Number.isFinite(activeAdjAmt) ? activeAdjAmt : 0)) * 100) / 100
  );
  const alreadyPaid = Number(fullData?.invoice.paid_amount || 0);
  const maxExtraPay = Math.max(0, Math.round((newNetTotal - alreadyPaid) * 100) / 100);
  const appliedExtraPay = Math.min(maxExtraPay, Math.max(0, Number(additionalPayment || 0)));
  const overpaidCredit = Math.max(0, Math.round((alreadyPaid - newNetTotal) * 100) / 100);
  const willRefundAmount = isAdmin && refundExcess && overpaidCredit > 0 ? overpaidCredit : 0;
  const newPaidTotal =
    willRefundAmount > 0 ? newNetTotal : Math.round((alreadyPaid + appliedExtraPay) * 100) / 100;
  const newDue = Math.max(0, Math.round((newNetTotal - newPaidTotal) * 100) / 100);

  const rawMaxStaff = settings.max_staff_discount_pct;
  const maxStaffPct =
    rawMaxStaff !== undefined && rawMaxStaff !== '' && Number.isFinite(Number(rawMaxStaff))
      ? Math.min(100, Math.max(0, Number(rawMaxStaff)))
      : 100;
  const originalBreakdown = useMemo(
    () => resolveInvoiceDiscountBreakdown(fullData?.invoice),
    [fullData]
  );
  const discountChanged =
    fullData !== null &&
    (appliedDoctorLessPct !== originalBreakdown.doctorLessPercent ||
      newFlatDiscountAmt !== originalBreakdown.flatDiscountAmount);
  const effectivePct = discountBreakdown.discountPct;
  const exceedsStaffCap = !isAdmin && discountChanged && effectivePct > maxStaffPct + 0.01;

  const combinedTestsForComm = useMemo(() => {
    const existing = activeExistingTests.map((t) => ({
      test_id: t.test_id,
      test_name: t.test_name,
      price: Number(t.price),
    }));
    const added = newlySelectedTests.map((t) => ({
      test_id: t.id,
      test_name: t.name,
      price: Number(t.price),
    }));
    return [...existing, ...added];
  }, [activeExistingTests, newlySelectedTests]);

  const selectedDoctor = useMemo(() => doctors.find((d) => d.id === doctorId) || null, [doctors, doctorId]);
  const doctorDefaultPct = Number(selectedDoctor?.commission_pct ?? 0);

  const previewCommission = useMemo(() => {
    if (!doctorId) return { amount: 0, effectivePct: 0 };
    if (commissionMode === 'custom_per_test') {
      let sum = 0;
      for (const t of combinedTestsForComm) {
        const entry = perTestCommMap[t.test_id];
        const tType = entry?.type === 'flat' ? 'flat' : 'percent';
        const tVal = entry ? Math.max(0, Number(entry.value || 0)) : doctorDefaultPct;
        const share = newSubtotal > 0 ? (t.price / newSubtotal) * newNetTotal : 0;
        sum += tType === 'flat' ? tVal : Math.round(((share * tVal) / 100) * 100) / 100;
      }
      const amt = Math.round(sum * 100) / 100;
      const pct = newNetTotal > 0 ? Math.round(((amt / newNetTotal) * 100) * 100) / 100 : 0;
      return { amount: amt, effectivePct: pct };
    }
    if (commissionMode === 'custom_invoice') {
      const val = Math.max(0, Number(customCommValue || 0));
      if (customCommType === 'flat') {
        const amt = Math.round(val * 100) / 100;
        const pct = newNetTotal > 0 ? Math.round(((amt / newNetTotal) * 100) * 100) / 100 : 0;
        return { amount: amt, effectivePct: pct };
      }
      const amt = Math.round(((newNetTotal * val) / 100) * 100) / 100;
      return { amount: amt, effectivePct: val };
    }
    const amt = Math.round(((newNetTotal * doctorDefaultPct) / 100) * 100) / 100;
    return { amount: amt, effectivePct: doctorDefaultPct };
  }, [
    doctorId,
    commissionMode,
    customCommType,
    customCommValue,
    perTestCommMap,
    combinedTestsForComm,
    newSubtotal,
    newNetTotal,
    doctorDefaultPct,
  ]);

  const toggleAddedTest = (testId: number) => {
    setError('');
    setAddedTestIds((prev) =>
      prev.includes(testId) ? prev.filter((id) => id !== testId) : [...prev, testId]
    );
  };

  const handleRemoveExistingTest = (invoiceTestId: number) => {
    setError('');
    setRemovedInvoiceTestIds((prev) =>
      prev.includes(invoiceTestId) ? prev : [...prev, invoiceTestId]
    );
  };

  const handleUndoRemovedTest = (invoiceTestId: number, catalogTestId: number) => {
    setError('');
    setRemovedInvoiceTestIds((prev) => prev.filter((id) => id !== invoiceTestId));
    setAddedTestIds((prev) => prev.filter((id) => id !== catalogTestId));
  };

  const handleSave = async (printAfter: boolean) => {
    if (!patientName.trim()) {
      setError('Patient full name is required.');
      return;
    }
    if (totalActiveTestsCount === 0) {
      setError('An invoice must contain at least one diagnostic test.');
      return;
    }
    if (exceedsStaffCap) {
      setError(`Staff discount limit is ${maxStaffPct}%. Switch to Admin mode to authorize higher discounts.`);
      return;
    }

    const testCommissionsPayload =
      isAdmin && commissionMode === 'custom_per_test'
        ? combinedTestsForComm.map((t) => {
            const entry = perTestCommMap[t.test_id];
            return {
              testId: t.test_id,
              commissionType: (entry?.type === 'flat' ? 'flat' : 'percent') as 'percent' | 'flat',
              commissionValue: entry ? Math.max(0, Number(entry.value || 0)) : doctorDefaultPct,
            };
          })
        : undefined;

    setSaving(true);
    setError('');
    try {
      const updated = await apiFetch<FullInvoice>(`/api/invoices/${invoiceId}`, {
        method: 'PUT',
        body: JSON.stringify({
          patient: {
            name: patientName.trim(),
            ageYears: Number(ageYears || 0),
            ageMonths: Number(ageMonths || 0),
            ageDays: Number(ageDays || 0),
            gender,
            mobile: mobile.trim(),
            address: address.trim(),
          },
          doctorId,
          addTestIds: addedTestIds,
          removeInvoiceTestIds: removedInvoiceTestIds,
          doctorLessPercent: appliedDoctorLessPct,
          flatDiscountAmount: newFlatDiscountAmt,
          discountType: discountBreakdown.legacyDiscountType,
          discountValue: discountBreakdown.legacyDiscountValue,
          additionalPayment: appliedExtraPay,
          notes: notes.trim(),
          ...(isAdmin
            ? {
                adjustmentAmount: Number.isFinite(Number(adjustmentAmount)) ? Number(adjustmentAmount) : 0,
                adjustmentReason: adjustmentReason.trim(),
                refundExcess,
                refundMethod,
                commissionMode,
                commissionType: customCommType,
                commissionValue: Number(customCommValue || 0),
                testCommissions: testCommissionsPayload,
              }
            : {}),
        }),
      });
      broadcastPatientsUpdated();
      onSaved(updated.invoice, printAfter);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update patient entry.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 overflow-y-auto p-4 flex items-start justify-center">
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-xl shadow-xl my-6 overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 bg-brand-navy text-white flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">
              Edit Patient Entry &amp; Manage Tests
            </h2>
            <p className="text-xs text-slate-300 mt-0.5">
              Update details, remove or add diagnostic tests dynamically before saving. Patient ID &amp; Portal Login remain unchanged.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-300 hover:text-white p-1"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading || !fullData ? (
          <div className="p-10 text-center text-sm text-slate-500">
            {error ? (
              <div className="text-red-700 font-medium">{error}</div>
            ) : (
              'Loading patient & invoice record...'
            )}
          </div>
        ) : (
          <div className="p-6 space-y-6">
            {/* Preserved Identity Strip */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div>
                <div className="text-slate-500">Invoice Number</div>
                <div className="font-mono font-bold text-slate-900 text-sm mt-0.5">
                  {fullData.invoice.invoice_no}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {formatDateTime(fullData.invoice.created_at)}
                </div>
              </div>
              <div>
                <div className="text-slate-500 flex items-center gap-1">
                  <Lock className="w-3 h-3 text-teal-700" />
                  <span>Patient ID (Fixed)</span>
                </div>
                <div className="font-mono font-bold text-teal-800 text-sm mt-0.5">
                  {fullData.invoice.patient_uid}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">Same ID kept on edit</div>
              </div>
              <div>
                <div className="text-slate-500 flex items-center gap-1">
                  <Lock className="w-3 h-3 text-teal-700" />
                  <span>Patient Portal Password</span>
                </div>
                <div className="font-mono font-bold text-slate-900 text-sm mt-0.5">
                  {fullData.invoice.patient_portal_password || '—'}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">Same portal login kept</div>
              </div>
            </div>

            {/* Patient Demographics Editor */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">01. Patient Details</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Patient Full Name <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="text"
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Gender</label>
                  <select
                    value={gender}
                    onChange={(e) => setGender(e.target.value as 'Male' | 'Female' | 'Other')}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Age (Y / M / D)</label>
                  <div className="grid grid-cols-3 gap-1.5">
                    <input
                      type="number"
                      min={0}
                      max={130}
                      value={ageYears}
                      onChange={(e) => setAgeYears(e.target.value)}
                      title="Years"
                      className="w-full px-2 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <input
                      type="number"
                      min={0}
                      max={11}
                      value={ageMonths}
                      onChange={(e) => setAgeMonths(e.target.value)}
                      title="Months"
                      className="w-full px-2 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={ageDays}
                      onChange={(e) => setAgeDays(e.target.value)}
                      title="Days"
                      className="w-full px-2 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Mobile Number</label>
                  <input
                    type="text"
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                    placeholder="017XX-XXXXXX"
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Address / Village</label>
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Referring Doctor</label>
                  <select
                    value={doctorId ?? ''}
                    onChange={(e) => setDoctorId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    <option value="">Self / Walk-in Patient</option>
                    {doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} {d.degree ? `(${d.degree})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional note"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>
            </div>

            {/* Existing & Newly Added Tests on Invoice (with Dynamic Delete) */}
            <div className="space-y-2.5 pt-3 border-t border-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    02. Active Invoice Tests ({totalActiveTestsCount})
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Click Delete to remove a test and recalculate the bill immediately. Save Changes to update the invoice.
                  </p>
                </div>
                <span className="text-xs font-mono tabular-nums font-semibold text-slate-800 bg-slate-100 px-2.5 py-1 rounded-md">
                  Subtotal: {formatBDT(newSubtotal)}
                </span>
              </div>
              <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden">
                {activeExistingTests.map((t) => {
                  const isCompleted = t.status === 'Ready' || t.status === 'Verified';
                  return (
                    <div
                      key={t.id}
                      className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs bg-white hover:bg-slate-50/70 transition-colors"
                    >
                      <div className="min-w-0 flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900">{t.test_name}</span>
                        <span className="text-slate-500">{t.category_name}</span>
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded border ${
                            isCompleted
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-slate-100 text-slate-600 border-slate-200'
                          }`}
                        >
                          {t.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0">
                        <span className="font-mono tabular-nums font-semibold text-slate-900">
                          {formatBDT(t.price)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveExistingTest(t.id)}
                          title={`Delete ${t.test_name} from invoice`}
                          aria-label={`Delete ${t.test_name}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Delete</span>
                        </button>
                      </div>
                    </div>
                  );
                })}

                {newlySelectedTests.map((t) => (
                  <div
                    key={`new-${t.id}`}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs bg-teal-50/60"
                  >
                    <div className="min-w-0 flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-teal-950">{t.name}</span>
                      <span className="text-teal-700">{t.category_name}</span>
                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded bg-teal-100 text-teal-800 border border-teal-200">
                        New Addition
                      </span>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="font-mono tabular-nums font-semibold text-teal-950">
                        {formatBDT(t.price)}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleAddedTest(t.id)}
                        title={`Remove ${t.name} from invoice`}
                        aria-label={`Remove ${t.name}`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-red-700 bg-white border border-red-200 rounded-md hover:bg-red-50 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Remove</span>
                      </button>
                    </div>
                  </div>
                ))}

                {totalActiveTestsCount === 0 && (
                  <div className="px-3.5 py-5 text-center text-xs font-medium text-red-600 bg-red-50/40">
                    No tests left on invoice. Restore a removed test below or add a replacement test before saving.
                  </div>
                )}
              </div>

              {removedExistingTests.length > 0 && (
                <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg space-y-1.5">
                  <div className="text-[11px] font-semibold text-amber-900">
                    Marked for Removal on Save ({removedExistingTests.length})
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {removedExistingTests.map((t) => (
                      <button
                        key={`undo-${t.id}`}
                        type="button"
                        onClick={() => handleUndoRemovedTest(t.id, t.test_id)}
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-amber-900 bg-white border border-amber-300 rounded hover:bg-amber-100 transition-colors"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span className="line-through text-slate-500">{t.test_name}</span>
                        <span className="text-teal-700 font-semibold">Undo</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Add Additional Tests */}
            <div className="space-y-3 pt-3 border-t border-slate-200">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    03. Add More Tests ({addedTestIds.length} new selected)
                  </h3>
                  <p className="text-xs text-slate-500">
                    Select any additional diagnostic test to append to this invoice.
                  </p>
                </div>
                <div className="relative w-full sm:w-64">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={addTestSearch}
                    onChange={(e) => setAddTestSearch(e.target.value)}
                    placeholder="Search test to add..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setActiveCategory('All')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
                    activeCategory === 'All'
                      ? 'bg-brand-navy text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  All
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setActiveCategory(cat.name)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
                      activeCategory === cat.name
                        ? 'bg-brand-navy text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {cat.name}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-52 overflow-y-auto pr-1">
                {availableTests.length === 0 ? (
                  <div className="col-span-full py-6 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg">
                    No remaining catalog tests match your filter.
                  </div>
                ) : (
                  availableTests.map((t) => {
                    const selected = addedTestIds.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => toggleAddedTest(t.id)}
                        className={`text-left px-3 py-2 rounded-lg border transition-colors flex items-center justify-between gap-2 ${
                          selected
                            ? 'bg-teal-50 border-teal-600 ring-1 ring-teal-600'
                            : 'bg-white border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-900 truncate">{t.name}</div>
                          <div className="text-[11px] text-slate-500 truncate">
                            <span className="font-mono">{t.code}</span> · {t.category_name}
                          </div>
                        </div>
                        <div className="text-right shrink-0 flex items-center gap-2">
                          <span className="text-xs font-mono tabular-nums font-bold text-slate-900">
                            {formatBDT(t.price)}
                          </span>
                          {selected ? (
                            <Check className="w-4 h-4 text-teal-700" />
                          ) : (
                            <Plus className="w-3.5 h-3.5 text-teal-700" />
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Updated Billing & Payment Summary */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">04. Updated Billing Summary</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="space-y-2">
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="block font-medium text-slate-700">Doctor Less (%)</label>
                      <span className="font-mono tabular-nums font-semibold text-amber-700">
                        -{formatBDT(newDoctorLessAmt)} ({appliedDoctorLessPct}%)
                      </span>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="any"
                        value={doctorLessPercent}
                        onChange={(e) => setDoctorLessPercent(e.target.value)}
                        className="w-full pl-2.5 pr-7 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-md bg-white"
                      />
                      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] font-semibold text-slate-500">
                        %
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="block font-medium text-slate-700">Discount (৳ Flat)</label>
                      <div className="flex items-center gap-1.5">
                        {(isAdmin || maxStaffPct >= 100) && newSubtotal > 0 && (
                          <button
                            type="button"
                            onClick={() => setFlatDiscountAmount(String(afterDoctorLess))}
                            className="px-1.5 py-0.5 text-[10px] font-semibold text-teal-700 bg-teal-50 border border-teal-200 rounded hover:bg-teal-100 cursor-pointer"
                          >
                            100% Free
                          </button>
                        )}
                        <span className="font-mono tabular-nums font-semibold text-amber-700">
                          -{formatBDT(newFlatDiscountAmt)}
                        </span>
                      </div>
                    </div>
                    <div className="relative">
                      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[11px] font-semibold text-slate-500">
                        ৳
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={afterDoctorLess}
                        step="any"
                        value={flatDiscountAmount}
                        onChange={(e) => setFlatDiscountAmount(e.target.value)}
                        className="w-full pl-6 pr-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-md bg-white"
                      />
                    </div>
                  </div>
                  {exceedsStaffCap && (
                    <p className="text-[11px] text-red-600 mt-1 font-medium">
                      Exceeds Staff cap ({maxStaffPct}%).
                    </p>
                  )}
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Additional Cash Received (BDT)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={maxExtraPay}
                    step="any"
                    value={additionalPayment}
                    onChange={(e) => setAdditionalPayment(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-md bg-white"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Already paid: <span className="font-mono">{formatBDT(alreadyPaid)}</span>
                  </p>
                </div>

                <div className="space-y-1 bg-white border border-slate-200 rounded-md p-2.5">
                  <div className="flex justify-between">
                    <span className="text-slate-600">Subtotal ({totalActiveTestsCount} tests):</span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900">
                      {formatBDT(newSubtotal)}
                    </span>
                  </div>
                  {newDoctorLessAmt > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-600">Doctor Less ({appliedDoctorLessPct}%):</span>
                      <span className="font-mono tabular-nums font-semibold text-amber-700">
                        -{formatBDT(newDoctorLessAmt)}
                      </span>
                    </div>
                  )}
                  {newFlatDiscountAmt > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-600">Discount (Flat):</span>
                      <span className="font-mono tabular-nums font-semibold text-amber-700">
                        -{formatBDT(newFlatDiscountAmt)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-slate-600">Total Discount ({effectivePct}%):</span>
                    <span className="font-mono tabular-nums font-semibold text-amber-700">
                      -{formatBDT(newDiscountAmount)}
                    </span>
                  </div>
                  {activeAdjAmt !== 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-600">Admin Adjustment:</span>
                      <span className="font-mono tabular-nums font-semibold text-amber-700">
                        {activeAdjAmt > 0 ? `-${formatBDT(activeAdjAmt)}` : `+${formatBDT(Math.abs(activeAdjAmt))}`}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-slate-600">New Net Bill:</span>
                    <span className="font-mono tabular-nums font-bold text-teal-700">
                      {formatBDT(newNetTotal)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Total Paid:</span>
                    <span className="font-mono tabular-nums font-semibold text-emerald-700">
                      {formatBDT(newPaidTotal)}
                      {willRefundAmount > 0 ? ` (-${formatBDT(willRefundAmount)})` : ''}
                    </span>
                  </div>
                  <div className="flex justify-between pt-1 border-t border-slate-200">
                    <span className="text-slate-600">Updated Due:</span>
                    <span
                      className={`font-mono tabular-nums font-bold ${
                        newDue > 0 ? 'text-red-600' : 'text-emerald-700'
                      }`}
                    >
                      {formatBDT(newDue)}
                    </span>
                  </div>
                  {overpaidCredit > 0 && !willRefundAmount && (
                    <div className="flex justify-between text-[11px] text-amber-800 font-medium pt-0.5">
                      <span>Overpaid / Refund Credit:</span>
                      <span className="font-mono tabular-nums">{formatBDT(overpaidCredit)}</span>
                    </div>
                  )}
                </div>
              </div>

              {isAdmin && (
                <div className="bg-amber-50/60 border border-amber-200 rounded-md p-3 space-y-2.5 text-xs">
                  <div className="font-semibold text-amber-900">
                    Admin Bill Amount Reduction / Post-Payment Adjustment
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Bill Reduction / Adjustment Amount (BDT)
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={adjustmentAmount}
                        onChange={(e) => setAdjustmentAmount(e.target.value)}
                        placeholder="e.g. 200 to reduce net bill by ৳200"
                        className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-amber-300 rounded-md bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Adjustment Reason (Audit Note)
                      </label>
                      <input
                        type="text"
                        value={adjustmentReason}
                        onChange={(e) => setAdjustmentReason(e.target.value)}
                        placeholder="Reason for bill reduction / correction"
                        className="w-full px-2.5 py-1.5 text-xs border border-amber-300 rounded-md bg-white"
                      />
                    </div>
                  </div>
                  {overpaidCredit > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-amber-200/80">
                      <label className="flex items-center gap-2 font-medium text-amber-950 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={refundExcess}
                          onChange={(e) => setRefundExcess(e.target.checked)}
                          className="rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                        />
                        <span>Refund excess paid cash ({formatBDT(overpaidCredit)}) back to patient</span>
                      </label>
                      {refundExcess && (
                        <select
                          value={refundMethod}
                          onChange={(e) => setRefundMethod(e.target.value)}
                          className="px-2 py-1 text-xs border border-amber-300 rounded bg-white"
                        >
                          <option value="Cash">Refund via Cash</option>
                          <option value="bKash">Refund via bKash</option>
                          <option value="Nagad">Refund via Nagad</option>
                          <option value="Bank">Refund via Bank</option>
                        </select>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Admin-only Patient / Per-Test Commission Override */}
              {isAdmin && doctorId && (
                <div className="bg-white border border-slate-200 rounded-md p-3 space-y-2.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">Doctor Commission Setup (Admin)</span>
                    <span className="font-mono font-bold text-teal-700">
                      {formatBDT(previewCommission.amount)} ({previewCommission.effectivePct}%)
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setCommissionMode('doctor_default')}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md border ${
                        commissionMode === 'doctor_default'
                          ? 'bg-brand-navy text-white border-brand-navy'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      Doctor Default ({doctorDefaultPct}%)
                    </button>
                    <button
                      type="button"
                      onClick={() => setCommissionMode('custom_invoice')}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md border ${
                        commissionMode === 'custom_invoice'
                          ? 'bg-brand-navy text-white border-brand-navy'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      Custom Patient Rate (% or ৳ Flat)
                    </button>
                    <button
                      type="button"
                      onClick={() => setCommissionMode('custom_per_test')}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md border ${
                        commissionMode === 'custom_per_test'
                          ? 'bg-brand-navy text-white border-brand-navy'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      Per-Test Rates
                    </button>
                  </div>

                  {commissionMode === 'custom_invoice' && (
                    <div className="flex items-center gap-2 max-w-xs">
                      <select
                        value={customCommType}
                        onChange={(e) => setCustomCommType(e.target.value as 'percent' | 'flat')}
                        className="px-2 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                      >
                        <option value="percent">% Pct</option>
                        <option value="flat">৳ Flat</option>
                      </select>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={customCommValue}
                        onChange={(e) => setCustomCommValue(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-md"
                      />
                    </div>
                  )}

                  {commissionMode === 'custom_per_test' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                      {combinedTestsForComm.map((t) => {
                        const entry = perTestCommMap[t.test_id] || {
                          type: 'percent' as const,
                          value: String(doctorDefaultPct),
                        };
                        return (
                          <div
                            key={t.test_id}
                            className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5"
                          >
                            <span className="truncate text-[11px] font-medium text-slate-800">{t.test_name}</span>
                            <div className="flex items-center gap-1 shrink-0">
                              <select
                                value={entry.type}
                                onChange={(e) =>
                                  setPerTestCommMap((prev) => ({
                                    ...prev,
                                    [t.test_id]: {
                                      type: e.target.value as 'percent' | 'flat',
                                      value: prev[t.test_id]?.value ?? String(doctorDefaultPct),
                                    },
                                  }))
                                }
                                className="px-1 py-0.5 text-[11px] border border-slate-300 rounded bg-white"
                              >
                                <option value="percent">%</option>
                                <option value="flat">৳</option>
                              </select>
                              <input
                                type="number"
                                min={0}
                                step="any"
                                value={entry.value}
                                onChange={(e) =>
                                  setPerTestCommMap((prev) => ({
                                    ...prev,
                                    [t.test_id]: {
                                      type: prev[t.test_id]?.type ?? 'percent',
                                      value: e.target.value,
                                    },
                                  }))
                                }
                                className="w-16 px-1.5 py-0.5 text-[11px] font-mono tabular-nums border border-slate-300 rounded bg-white"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {error && (
              <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
                {error}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || totalActiveTestsCount === 0}
                onClick={() => handleSave(false)}
                className="px-4 py-2 text-sm font-medium text-slate-900 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
              <button
                type="button"
                disabled={saving || totalActiveTestsCount === 0}
                onClick={() => handleSave(true)}
                className="px-5 py-2 text-sm font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy-light disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {saving ? 'Saving...' : 'Save & Print Updated Receipt'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
