import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, CreditCard, Edit3, FileText, Plus, Printer, Search, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { apiFetch, formatAge, formatBDT, formatDateTime } from '../lib/api.ts';
import { broadcastPatientsUpdated } from '../lib/liveSync.ts';
import { OFFLINE_SYNCED_EVENT } from '../lib/offlineEngine.ts';
import { computeSequentialDiscounts } from '../../shared/discountMath.ts';
import type { DiagnosticTest, Doctor, InvoiceSummary, LabSettings, PatientProfile, TestCategory } from '../types.ts';
import { AdminAdjustBillModal } from './AdminAdjustBillModal.tsx';
import { DeletePatientConfirmModal } from './DeletePatientConfirmModal.tsx';
import { DuePaymentModal } from './DuePaymentModal.tsx';
import { EditInvoiceModal } from './EditInvoiceModal.tsx';
import { SampleTimerControl } from './SampleTimerControl.tsx';

interface PatientBillingViewProps {
  isAdmin: boolean;
  settings: LabSettings;
  onOpenReceipt: (invoiceId: number) => void;
  onOpenReport: (invoiceId: number) => void;
}

export const PatientBillingView: React.FC<PatientBillingViewProps> = ({
  isAdmin,
  settings,
  onOpenReceipt,
  onOpenReport,
}) => {
  const [subTab, setSubTab] = useState<'new' | 'list'>('new');
  const [categories, setCategories] = useState<TestCategory[]>([]);
  const [tests, setTests] = useState<DiagnosticTest[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);

  // Registration Form State
  const [existingPatient, setExistingPatient] = useState<PatientProfile | null>(null);
  const [patientLookupQuery, setPatientLookupQuery] = useState('');
  const [patientMatches, setPatientMatches] = useState<PatientProfile[]>([]);
  const [patientName, setPatientName] = useState('');
  const [ageYears, setAgeYears] = useState('25');
  const [ageMonths, setAgeMonths] = useState('0');
  const [ageDays, setAgeDays] = useState('0');
  const [gender, setGender] = useState<'Male' | 'Female' | 'Other'>('Male');
  const [mobile, setMobile] = useState('');
  const [address, setAddress] = useState('');
  const [doctorSearch, setDoctorSearch] = useState('');
  const [selectedDoctorId, setSelectedDoctorId] = useState<number | null>(null);
  const [showDoctorDropdown, setShowDoctorDropdown] = useState(false);

  // Test Selection & Billing
  const [testSearch, setTestSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [selectedTestIds, setSelectedTestIds] = useState<number[]>([]);
  const [doctorLessPercent, setDoctorLessPercent] = useState<string>('0');
  const [flatDiscountAmount, setFlatDiscountAmount] = useState<string>('0');
  const [paidAmount, setPaidAmount] = useState<string>('');
  const [paidTouched, setPaidTouched] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [notes, setNotes] = useState('');

  // Admin-only custom doctor commission setup (per-patient or per-test)
  const [commissionMode, setCommissionMode] = useState<'doctor_default' | 'custom_invoice' | 'custom_per_test'>('doctor_default');
  const [customCommType, setCustomCommType] = useState<'percent' | 'flat'>('percent');
  const [customCommValue, setCustomCommValue] = useState<string>('0');
  const [perTestCommMap, setPerTestCommMap] = useState<
    Record<number, { type: 'percent' | 'flat'; value: string }>
  >({});

  // List filter & Modals
  const [listSearch, setListSearch] = useState('');
  const [todayOnly, setTodayOnly] = useState(true);
  const [editingInvoiceId, setEditingInvoiceId] = useState<number | null>(null);
  const [duePaymentInvoiceId, setDuePaymentInvoiceId] = useState<number | null>(null);
  const [adjustBillInvoiceId, setAdjustBillInvoiceId] = useState<number | null>(null);
  const [deletingInvoice, setDeletingInvoice] = useState<InvoiceSummary | null>(null);
  const [listBanner, setListBanner] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const loadReferenceData = useCallback(async () => {
    try {
      const [catRes, docRes] = await Promise.all([
        apiFetch<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('/api/catalog'),
        apiFetch<{ doctors: Doctor[] }>('/api/doctors'),
      ]);
      setCategories(catRes.categories);
      setTests(catRes.tests);
      setDoctors(docRes.doctors);
      if (docRes.doctors.length > 0 && selectedDoctorId === null) {
        const selfDoc = docRes.doctors.find((d) => d.name.toLowerCase().includes('self'));
        if (selfDoc) {
          setSelectedDoctorId(selfDoc.id);
          setDoctorSearch(selfDoc.name);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load catalog');
    }
  }, [selectedDoctorId]);

  const loadInvoices = useCallback(async () => {
    try {
      const res = await apiFetch<{ invoices: InvoiceSummary[] }>(
        `/api/invoices?search=${encodeURIComponent(listSearch)}&todayOnly=${todayOnly ? '1' : '0'}`
      );
      setInvoices(res.invoices);
    } catch {
      // ignore
    }
  }, [listSearch, todayOnly]);

  useEffect(() => {
    loadReferenceData();
  }, [loadReferenceData]);

  useEffect(() => {
    if (subTab === 'list') {
      loadInvoices();
    }
  }, [subTab, loadInvoices]);

  useEffect(() => {
    const onOfflineSynced = () => {
      void loadReferenceData();
      if (subTab === 'list') {
        void loadInvoices();
      }
    };
    window.addEventListener(OFFLINE_SYNCED_EVENT, onOfflineSynced);
    return () => {
      window.removeEventListener(OFFLINE_SYNCED_EVENT, onOfflineSynced);
    };
  }, [subTab, loadReferenceData, loadInvoices]);

  const selectedTests = useMemo(
    () => tests.filter((t) => selectedTestIds.includes(t.id)),
    [tests, selectedTestIds]
  );

  const subtotal = useMemo(
    () => selectedTests.reduce((sum, t) => sum + Number(t.price), 0),
    [selectedTests]
  );

  const discountBreakdown = useMemo(
    () =>
      computeSequentialDiscounts({
        subtotal,
        doctorLessPercent: Number(doctorLessPercent || 0),
        flatDiscountAmount: Number(flatDiscountAmount || 0),
      }),
    [subtotal, doctorLessPercent, flatDiscountAmount]
  );

  const doctorLessAmt = discountBreakdown.doctorLessAmount;
  const appliedDoctorLessPct = discountBreakdown.doctorLessPercent;
  const afterDoctorLess = discountBreakdown.afterDoctorLess;
  const flatDiscountAmt = discountBreakdown.flatDiscountAmount;
  const discountAmount = discountBreakdown.discountAmount;
  const netTotal = discountBreakdown.netBeforeAdjustment;

  useEffect(() => {
    if (!paidTouched || selectedTestIds.length === 0) {
      setPaidAmount(String(netTotal));
      if (selectedTestIds.length === 0 && paidTouched) {
        setPaidTouched(false);
      }
      return;
    }
    const parsedPaid = Number(paidAmount || 0);
    if (Number.isFinite(parsedPaid) && parsedPaid > netTotal) {
      setPaidAmount(String(netTotal));
    }
  }, [netTotal, paidTouched, paidAmount, selectedTestIds.length]);

  const effectivePaid = Math.min(netTotal, Math.max(0, Number(paidAmount || 0)));
  const dueAmount = Math.max(0, Math.round((netTotal - effectivePaid) * 100) / 100);
  const rawMaxStaff = settings.max_staff_discount_pct;
  const maxStaffPct =
    rawMaxStaff !== undefined && rawMaxStaff !== '' && Number.isFinite(Number(rawMaxStaff))
      ? Math.min(100, Math.max(0, Number(rawMaxStaff)))
      : 100;
  const currentDiscountPct = discountBreakdown.discountPct;
  const exceedsStaffCap = !isAdmin && currentDiscountPct > maxStaffPct + 0.01;

  const selectedDoctor = useMemo(
    () => doctors.find((d) => d.id === selectedDoctorId) || null,
    [doctors, selectedDoctorId]
  );

  const doctorDefaultPct = Number(selectedDoctor?.commission_pct ?? 0);

  const previewCommission = useMemo(() => {
    if (!selectedDoctorId) return { amount: 0, effectivePct: 0 };
    if (commissionMode === 'custom_per_test') {
      let total = 0;
      for (const t of selectedTests) {
        const entry = perTestCommMap[t.id];
        const tType = entry?.type === 'flat' ? 'flat' : 'percent';
        const tVal = entry ? Math.max(0, Number(entry.value || 0)) : doctorDefaultPct;
        const netShare = subtotal > 0 ? (Number(t.price) / subtotal) * netTotal : 0;
        total += tType === 'flat' ? tVal : Math.round(((netShare * tVal) / 100) * 100) / 100;
      }
      const amt = Math.round(total * 100) / 100;
      const pct = netTotal > 0 ? Math.round(((amt / netTotal) * 100) * 100) / 100 : 0;
      return { amount: amt, effectivePct: pct };
    }
    if (commissionMode === 'custom_invoice') {
      const val = Math.max(0, Number(customCommValue || 0));
      if (customCommType === 'flat') {
        const amt = Math.round(val * 100) / 100;
        const pct = netTotal > 0 ? Math.round(((amt / netTotal) * 100) * 100) / 100 : 0;
        return { amount: amt, effectivePct: pct };
      }
      const amt = Math.round(((netTotal * val) / 100) * 100) / 100;
      return { amount: amt, effectivePct: val };
    }
    const amt = Math.round(((netTotal * doctorDefaultPct) / 100) * 100) / 100;
    return { amount: amt, effectivePct: doctorDefaultPct };
  }, [
    selectedDoctorId,
    commissionMode,
    customCommType,
    customCommValue,
    perTestCommMap,
    selectedTests,
    subtotal,
    netTotal,
    doctorDefaultPct,
  ]);

  const filteredDoctors = useMemo(() => {
    const q = doctorSearch.trim().toLowerCase();
    if (!q) return doctors;
    return doctors.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.degree.toLowerCase().includes(q) ||
        d.hospital.toLowerCase().includes(q)
    );
  }, [doctors, doctorSearch]);

  const filteredTests = useMemo(() => {
    const q = testSearch.trim().toLowerCase();
    return tests.filter((t) => {
      if (activeCategory !== 'All' && t.category_name !== activeCategory) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q);
    });
  }, [tests, activeCategory, testSearch]);

  const toggleTest = (testId: number) => {
    setSelectedTestIds((prev) =>
      prev.includes(testId) ? prev.filter((id) => id !== testId) : [...prev, testId]
    );
  };

  const handlePatientLookup = async (q: string) => {
    setPatientLookupQuery(q);
    if (q.trim().length < 2) {
      setPatientMatches([]);
      return;
    }
    try {
      const res = await apiFetch<{ patients: PatientProfile[] }>(
        `/api/patients/search?q=${encodeURIComponent(q.trim())}`
      );
      setPatientMatches(res.patients);
    } catch {
      setPatientMatches([]);
    }
  };

  const selectExistingPatient = (p: PatientProfile) => {
    setExistingPatient(p);
    setPatientName(p.name);
    setAgeYears(String(p.age_years));
    setAgeMonths(String(p.age_months));
    setAgeDays(String(p.age_days));
    setGender(p.gender);
    setMobile(p.mobile || '');
    setAddress(p.address || '');
    setPatientLookupQuery('');
    setPatientMatches([]);
  };

  const clearExistingPatient = () => {
    setExistingPatient(null);
    setPatientName('');
    setAgeYears('25');
    setAgeMonths('0');
    setAgeDays('0');
    setGender('Male');
    setMobile('');
    setAddress('');
  };

  const resetForm = () => {
    setExistingPatient(null);
    setPatientLookupQuery('');
    setPatientMatches([]);
    setPatientName('');
    setAgeYears('25');
    setAgeMonths('0');
    setAgeDays('0');
    setGender('Male');
    setMobile('');
    setAddress('');
    setSelectedTestIds([]);
    setDoctorLessPercent('0');
    setFlatDiscountAmount('0');
    setPaidAmount('0');
    setPaidTouched(false);
    setPaymentMethod('Cash');
    setNotes('');
    setCommissionMode('doctor_default');
    setCustomCommType('percent');
    setCustomCommValue(String(doctorDefaultPct));
    setPerTestCommMap({});
  };

  const handleSubmit = async (e: React.FormEvent, printAfter = true) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    if (!patientName.trim()) {
      setError('Patient full name is required.');
      return;
    }
    if (selectedTestIds.length === 0) {
      setError('Please select at least one diagnostic test.');
      return;
    }
    if (exceedsStaffCap) {
      setError(`Staff discount limit is ${maxStaffPct}%. Reduce discount or switch to Admin mode.`);
      return;
    }

    const testCommissionsPayload =
      isAdmin && commissionMode === 'custom_per_test'
        ? selectedTests.map((t) => {
            const entry = perTestCommMap[t.id];
            return {
              testId: t.id,
              commissionType: (entry?.type === 'flat' ? 'flat' : 'percent') as 'percent' | 'flat',
              commissionValue: entry ? Math.max(0, Number(entry.value || 0)) : doctorDefaultPct,
            };
          })
        : undefined;

    setSubmitting(true);
    try {
      const created = await apiFetch<{ invoice: InvoiceSummary }>('/api/invoices', {
        method: 'POST',
        body: JSON.stringify({
          existingPatientId: existingPatient?.id || null,
          patient: {
            name: patientName.trim(),
            ageYears: Number(ageYears || 0),
            ageMonths: Number(ageMonths || 0),
            ageDays: Number(ageDays || 0),
            gender,
            mobile: mobile.trim(),
            address: address.trim(),
          },
          doctorId: selectedDoctorId,
          testIds: selectedTestIds,
          doctorLessPercent: appliedDoctorLessPct,
          flatDiscountAmount: flatDiscountAmt,
          discountType: discountBreakdown.legacyDiscountType,
          discountValue: discountBreakdown.legacyDiscountValue,
          paidAmount: effectivePaid,
          paymentMethod,
          notes: notes.trim(),
          ...(isAdmin
            ? {
                commissionMode,
                commissionType: customCommType,
                commissionValue: Number(customCommValue || 0),
                testCommissions: testCommissionsPayload,
              }
            : {}),
        }),
      });
      setSuccessMsg(
        `Created ${created.invoice.invoice_no} · Patient ID: ${created.invoice.patient_uid}${
          created.invoice.patient_portal_password
            ? ` · Portal Password: ${created.invoice.patient_portal_password}`
            : ''
        }`
      );
      resetForm();
      broadcastPatientsUpdated();
      if (printAfter) {
        onOpenReceipt(created.invoice.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invoice.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-200">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-brand-navy tracking-tight leading-tight">
            Patient Registration & Billing
          </h1>
          <p className="text-xs text-slate-600">
            Register patients, select tests, apply authorized discounts, and print receipts.
          </p>
        </div>

        <div className="flex items-center gap-1 p-0.5 bg-slate-200/70 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setSubTab('new')}
            className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'new' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            New Patient & Bill
          </button>
          <button
            type="button"
            onClick={() => setSubTab('list')}
            className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'list' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Invoice Directory
          </button>
        </div>
      </div>

      {subTab === 'new' ? (
        <form onSubmit={(e) => handleSubmit(e, true)} className="grid grid-cols-1 xl:grid-cols-12 gap-3.5 items-start">
          {/* Left Column: Patient Demographics & Test Selector */}
          <div className="xl:col-span-8 space-y-3.5">
            {/* Patient Information */}
            <div className="bg-white border border-slate-200 rounded-xl p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-bold uppercase tracking-wide text-slate-900">
                  01. Patient & Referral Details
                </h2>
                <span className="text-[11px] font-mono text-slate-500">
                  {existingPatient ? `Linking to ${existingPatient.patient_uid}` : 'Auto Patient ID & Portal Password'}
                </span>
              </div>

              {/* Returning Patient Lookup (Compact single bar) */}
              <div className="relative bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5">
                {existingPatient ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div>
                      <span className="font-semibold text-teal-800">Returning Patient:</span>{' '}
                      <span className="font-mono font-bold text-slate-900">{existingPatient.patient_uid}</span> ·{' '}
                      <span className="font-medium text-slate-900">{existingPatient.name}</span>
                    </div>
                    <button
                      type="button"
                      onClick={clearExistingPatient}
                      className="text-[11px] font-medium text-slate-600 hover:text-red-700 underline whitespace-nowrap"
                    >
                      Register New Instead
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2.5">
                    <label className="text-[11px] font-medium text-slate-600 whitespace-nowrap shrink-0">
                      Returning Patient?
                    </label>
                    <input
                      type="text"
                      value={patientLookupQuery}
                      onChange={(e) => handlePatientLookup(e.target.value)}
                      placeholder="Search by Patient ID, Mobile, or Name (optional)..."
                      className="w-full px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    {patientMatches.length > 0 && (
                      <div className="absolute z-20 left-2.5 right-2.5 top-full mt-1 max-h-44 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg divide-y divide-slate-100">
                        {patientMatches.map((pm) => (
                          <button
                            key={pm.id}
                            type="button"
                            onClick={() => selectExistingPatient(pm)}
                            className="w-full text-left px-3 py-1.5 hover:bg-teal-50 flex items-center justify-between gap-2 text-xs"
                          >
                            <span>
                              <span className="font-mono font-bold text-slate-900">{pm.patient_uid}</span> ·{' '}
                              <span className="font-medium text-slate-800">{pm.name}</span>
                            </span>
                            <span className="text-slate-500 font-mono tabular-nums">{pm.mobile || pm.gender}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-6 gap-2.5">
                <div className="sm:col-span-3">
                  <label className="block text-[11px] font-medium text-slate-700 mb-0.5">
                    Patient Full Name <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="text"
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder="e.g. Md. Karim Uddin"
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    required
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-700 mb-0.5">Age (Y / M / D)</label>
                  <div className="grid grid-cols-3 gap-1">
                    <input
                      type="number"
                      min={0}
                      max={130}
                      value={ageYears}
                      onChange={(e) => setAgeYears(e.target.value)}
                      placeholder="Yrs"
                      title="Years"
                      className="w-full px-2 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <input
                      type="number"
                      min={0}
                      max={11}
                      value={ageMonths}
                      onChange={(e) => setAgeMonths(e.target.value)}
                      placeholder="Mo"
                      title="Months"
                      className="w-full px-2 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={ageDays}
                      onChange={(e) => setAgeDays(e.target.value)}
                      placeholder="Day"
                      title="Days"
                      className="w-full px-2 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                  </div>
                </div>

                <div className="sm:col-span-1">
                  <label className="block text-[11px] font-medium text-slate-700 mb-0.5">
                    Gender <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={gender}
                    onChange={(e) => setGender(e.target.value as 'Male' | 'Female' | 'Other')}
                    className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 bg-white"
                  >
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-700 mb-0.5">Mobile Number</label>
                  <input
                    type="text"
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                    placeholder="017XX-XXXXXX"
                    className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-700 mb-0.5">Address / Village</label>
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Halasa, Mirpur, Kushtia"
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>

                {/* Searchable Referral Doctor Dropdown */}
                <div className="sm:col-span-2 relative">
                  <label className="block text-[11px] font-medium text-slate-700 mb-0.5">Referring Doctor</label>
                  <input
                    type="text"
                    value={doctorSearch}
                    onFocus={() => setShowDoctorDropdown(true)}
                    onBlur={() => setTimeout(() => setShowDoctorDropdown(false), 180)}
                    onChange={(e) => {
                      setDoctorSearch(e.target.value);
                      setShowDoctorDropdown(true);
                    }}
                    placeholder="Search doctor name..."
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  {showDoctorDropdown && (
                    <div className="absolute z-20 left-0 right-0 mt-1 max-h-52 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg divide-y divide-slate-100">
                      {filteredDoctors.length === 0 ? (
                        <div className="p-2.5 text-xs text-slate-500">No matching doctors found.</div>
                      ) : (
                        filteredDoctors.map((doc) => (
                          <button
                            key={doc.id}
                            type="button"
                            onMouseDown={() => {
                              setSelectedDoctorId(doc.id);
                              setDoctorSearch(doc.name);
                              setShowDoctorDropdown(false);
                            }}
                            className="w-full text-left px-3 py-1.5 hover:bg-teal-50 flex items-center justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-slate-900 truncate">{doc.name}</div>
                              <div className="text-[11px] text-slate-500 truncate">
                                {doc.degree} {doc.hospital ? `· ${doc.hospital}` : ''}
                              </div>
                            </div>
                            {selectedDoctorId === doc.id && <Check className="w-3.5 h-3.5 text-teal-600 shrink-0" />}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Diagnostic Test Selector */}
            <div className="bg-white border border-slate-200 rounded-xl p-3.5 space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <h2 className="text-xs font-bold uppercase tracking-wide text-slate-900">
                  02. Select Diagnostic Tests
                </h2>
                <div className="relative w-full sm:w-64">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={testSearch}
                    onChange={(e) => setTestSearch(e.target.value)}
                    placeholder="Search CBC, Sugar, Lipid..."
                    className="w-full pl-8 pr-2.5 py-1 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1 pb-1.5 border-b border-slate-200">
                <button
                  type="button"
                  onClick={() => setActiveCategory('All')}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    activeCategory === 'All'
                      ? 'bg-brand-navy text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  All Departments
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setActiveCategory(cat.name)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      activeCategory === cat.name
                        ? 'bg-brand-navy text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {cat.name}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-[340px] overflow-y-auto pr-1">
                {filteredTests.map((t) => {
                  const selected = selectedTestIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleTest(t.id)}
                      className={`text-left px-2.5 py-2 rounded-lg border transition-colors flex items-center justify-between gap-2 ${
                        selected
                          ? 'bg-teal-50 border-teal-600 ring-1 ring-teal-600'
                          : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 truncate">{t.name}</div>
                        <div className="text-[10.5px] text-slate-500 truncate">
                          <span className="font-mono">{t.code}</span> · {t.category_name} · {t.sample_type}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-bold font-mono tabular-nums text-slate-900">
                          {formatBDT(t.price)}
                        </div>
                        <div className="text-[10px] font-medium text-teal-700">
                          {selected ? 'Selected' : '+ Add'}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Column: Billing Summary & Payment */}
          <div className="xl:col-span-4 bg-white border border-slate-200 rounded-xl p-3.5 space-y-2.5 sticky top-16">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h2 className="text-xs font-bold uppercase tracking-wide text-slate-900">
                03. Billing & Payment Summary
              </h2>
              <span className="text-[11px] font-mono tabular-nums text-slate-500">
                {selectedTests.length} {selectedTests.length === 1 ? 'test' : 'tests'}
              </span>
            </div>

            {selectedTests.length === 0 ? (
              <p className="text-[11px] text-slate-500 py-2 text-center">
                Select tests from the catalog to calculate the bill.
              </p>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-slate-700">
                    Added Tests ({selectedTests.length})
                  </span>
                  {selectedTests.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setSelectedTestIds([])}
                      className="text-[11px] font-medium text-red-600 hover:text-red-700 hover:underline cursor-pointer"
                    >
                      Clear All
                    </button>
                  )}
                </div>
                <div className="divide-y divide-slate-200 max-h-36 overflow-y-auto border border-slate-200 rounded-lg">
                  {selectedTests.map((t) => (
                    <div
                      key={t.id}
                      className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px] bg-white hover:bg-slate-50/80"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-800 truncate">{t.name}</div>
                        <div className="text-[10px] text-slate-500 truncate">
                          <span className="font-mono">{t.code}</span> · {t.category_name}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="font-mono tabular-nums font-semibold text-slate-900">
                          {formatBDT(t.price)}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleTest(t.id)}
                          title={`Delete ${t.name}`}
                          aria-label={`Delete ${t.name}`}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10.5px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                          <span>Delete</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-slate-200 space-y-2 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-slate-600">Subtotal ({selectedTests.length} tests)</span>
                <span className="font-mono tabular-nums font-bold text-slate-900">{formatBDT(subtotal)}</span>
              </div>

              {/* Sequential Discounts: 1. Doctor Less (%) -> 2. Discount (৳ Flat) */}
              <div className="space-y-1.5 bg-slate-50/70 border border-slate-200 rounded-lg p-2.5">
                <div className="grid grid-cols-2 gap-2">
                  {/* Field 1: Doctor Less (%) */}
                  <div className="space-y-0.5">
                    <div className="flex items-center justify-between gap-1">
                      <label
                        htmlFor="billing-doctor-less-pct"
                        className="text-[11px] font-semibold text-slate-700"
                      >
                        Doctor Less (%)
                      </label>
                      {doctorLessAmt > 0 && (
                        <span className="text-[10px] font-mono tabular-nums font-semibold text-amber-700">
                          -{formatBDT(doctorLessAmt)}
                        </span>
                      )}
                    </div>
                    <div className="relative">
                      <input
                        id="billing-doctor-less-pct"
                        type="number"
                        min={0}
                        max={100}
                        step="any"
                        value={doctorLessPercent}
                        onChange={(e) => setDoctorLessPercent(e.target.value)}
                        placeholder="0"
                        className="w-full pl-2.5 pr-6 py-1 text-xs font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
                      />
                      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[11px] font-semibold text-slate-500">
                        %
                      </span>
                    </div>
                  </div>

                  {/* Field 2: Discount (৳ Flat) */}
                  <div className="space-y-0.5">
                    <div className="flex items-center justify-between gap-1">
                      <label
                        htmlFor="billing-flat-discount"
                        className="text-[11px] font-semibold text-slate-700"
                      >
                        Discount (৳ Flat)
                      </label>
                      {(isAdmin || maxStaffPct >= 100) && subtotal > 0 && (
                        <button
                          type="button"
                          onClick={() => setFlatDiscountAmount(String(afterDoctorLess))}
                          className="px-1.5 py-0 text-[10px] font-semibold text-teal-700 bg-teal-50 border border-teal-200 rounded hover:bg-teal-100 cursor-pointer"
                        >
                          100% Free
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[11px] font-semibold text-slate-500">
                        ৳
                      </span>
                      <input
                        id="billing-flat-discount"
                        type="number"
                        min={0}
                        max={afterDoctorLess}
                        step="any"
                        value={flatDiscountAmount}
                        onChange={(e) => setFlatDiscountAmount(e.target.value)}
                        placeholder="0"
                        className="w-full pl-5 pr-2 py-1 text-xs font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
                      />
                    </div>
                  </div>
                </div>

                {/* Total Combined Discount Summary */}
                <div className="flex items-center justify-between text-[11px] text-slate-600 pt-1 border-t border-slate-200/80">
                  <span>
                    Total Discount (Cap: {isAdmin ? '100% Admin' : `${maxStaffPct}%`})
                  </span>
                  <span className="font-mono tabular-nums font-semibold text-amber-700">
                    -{formatBDT(discountAmount)} ({currentDiscountPct}%)
                  </span>
                </div>
                {subtotal > 0 && netTotal === 0 && (
                  <p className="text-[11px] font-medium text-teal-700">
                    100% Complimentary / Free Testing applied (Net Payable: ৳0).
                  </p>
                )}
                {exceedsStaffCap && (
                  <p className="text-[11px] font-medium text-red-600">
                    Exceeds Staff discount limit ({maxStaffPct}%). Admin approval required.
                  </p>
                )}
              </div>

              <div className="flex justify-between items-center text-sm font-bold text-slate-900 pt-1 border-t border-slate-200">
                <span>Net Payable</span>
                <span className="font-mono tabular-nums text-teal-700">{formatBDT(netTotal)}</span>
              </div>

              {/* Admin-Only Patient/Test Doctor Commission Setup */}
              {isAdmin && selectedDoctorId && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-2 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate-800">Doctor Commission (Admin)</span>
                    <span className="text-[11px] font-mono font-bold text-teal-700">
                      {formatBDT(previewCommission.amount)} ({previewCommission.effectivePct}%)
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-1 p-0.5 bg-slate-200/70 rounded-md">
                    <button
                      type="button"
                      onClick={() => setCommissionMode('doctor_default')}
                      className={`py-0.5 px-1 text-[10.5px] font-semibold rounded transition-colors ${
                        commissionMode === 'doctor_default'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Default ({doctorDefaultPct}%)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCommissionMode('custom_invoice');
                        if (customCommValue === '0' && doctorDefaultPct > 0) {
                          setCustomCommValue(String(doctorDefaultPct));
                        }
                      }}
                      className={`py-0.5 px-1 text-[10.5px] font-semibold rounded transition-colors ${
                        commissionMode === 'custom_invoice'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Patient Custom
                    </button>
                    <button
                      type="button"
                      onClick={() => setCommissionMode('custom_per_test')}
                      className={`py-0.5 px-1 text-[10.5px] font-semibold rounded transition-colors ${
                        commissionMode === 'custom_per_test'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Per-Test Rate
                    </button>
                  </div>

                  {commissionMode === 'custom_invoice' && (
                    <div className="flex items-center gap-1.5">
                      <select
                        value={customCommType}
                        onChange={(e) => setCustomCommType(e.target.value as 'percent' | 'flat')}
                        className="px-2 py-1 text-xs border border-slate-300 rounded-md bg-white"
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
                        placeholder={customCommType === 'percent' ? 'e.g. 25' : 'e.g. 200'}
                        className="w-full px-2 py-1 text-xs font-mono tabular-nums border border-slate-300 rounded-md bg-white"
                      />
                    </div>
                  )}

                  {commissionMode === 'custom_per_test' && (
                    <div className="space-y-1 max-h-28 overflow-y-auto pr-0.5">
                      {selectedTests.length === 0 ? (
                        <div className="text-[11px] text-slate-500">Select tests first to set per-test rates.</div>
                      ) : (
                        selectedTests.map((t) => {
                          const entry = perTestCommMap[t.id] || {
                            type: 'percent' as const,
                            value: String(doctorDefaultPct),
                          };
                          return (
                            <div
                              key={t.id}
                              className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-2 py-1"
                            >
                              <span className="truncate text-[11px] font-medium text-slate-700" title={t.name}>
                                {t.name}
                              </span>
                              <div className="flex items-center gap-1 shrink-0">
                                <select
                                  value={entry.type}
                                  onChange={(e) =>
                                    setPerTestCommMap((prev) => ({
                                      ...prev,
                                      [t.id]: {
                                        type: e.target.value as 'percent' | 'flat',
                                        value: prev[t.id]?.value ?? String(doctorDefaultPct),
                                      },
                                    }))
                                  }
                                  className="px-1 py-0.5 text-[10.5px] border border-slate-300 rounded bg-white"
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
                                      [t.id]: {
                                        type: prev[t.id]?.type ?? 'percent',
                                        value: e.target.value,
                                      },
                                    }))
                                  }
                                  className="w-14 px-1.5 py-0.5 text-[10.5px] font-mono tabular-nums border border-slate-300 rounded"
                                />
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <label className="block text-[11px] font-medium text-slate-700">Paid Amount (BDT)</label>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setPaidTouched(true);
                        setPaidAmount('0');
                      }}
                      className={`px-1.5 py-0.5 text-[10.5px] font-semibold rounded border transition-colors ${
                        paidTouched && Number(paidAmount || 0) === 0
                          ? 'bg-amber-100 text-amber-900 border-amber-300'
                          : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
                      }`}
                    >
                      ৳0 Credit (Due)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPaidTouched(false);
                        setPaidAmount(String(netTotal));
                      }}
                      className="px-1.5 py-0.5 text-[10.5px] font-semibold text-teal-700 bg-teal-50 border border-teal-200 rounded hover:bg-teal-100"
                    >
                      Full Pay
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <input
                    type="number"
                    min={0}
                    max={netTotal}
                    step="any"
                    value={paidAmount}
                    onChange={(e) => {
                      setPaidTouched(true);
                      setPaidAmount(e.target.value);
                    }}
                    className="col-span-2 px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="px-2 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                    aria-label="Payment method"
                  >
                    <option value="Cash">Cash</option>
                    <option value="bKash">bKash</option>
                    <option value="Nagad">Nagad</option>
                    <option value="Bank">Bank</option>
                  </select>
                </div>
                {netTotal > 0 && effectivePaid === 0 && (
                  <p className="text-[10.5px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    Credit / Unpaid Entry: ৳0 paid, {formatBDT(netTotal)} due.
                  </p>
                )}
              </div>

              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-600 font-medium">Due Balance</span>
                <span className={`font-mono tabular-nums font-bold ${dueAmount > 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                  {formatBDT(dueAmount)}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-[11px] font-medium text-slate-600 shrink-0">Notes:</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Delivery note or reference (optional)"
                  className="w-full px-2.5 py-1 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>

            {error && (
              <div className="p-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
                {error}
              </div>
            )}
            {successMsg && (
              <div className="p-2 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
                {successMsg}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 pt-1">
              <button
                type="submit"
                disabled={submitting || selectedTests.length === 0}
                className="sm:col-span-2 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" />
                {submitting ? 'Generating...' : 'Save & Print Receipt'}
              </button>
              <button
                type="button"
                disabled={submitting || selectedTests.length === 0}
                onClick={(e) => handleSubmit(e, false)}
                className="sm:col-span-1 inline-flex items-center justify-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Save Only
              </button>
            </div>
          </div>
        </form>
      ) : (
        /* Invoice Directory */
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="relative w-full sm:w-80">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={listSearch}
                  onChange={(e) => setListSearch(e.target.value)}
                  placeholder="Search invoice, Patient ID, name, mobile..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
                <button
                  type="button"
                  onClick={() => setTodayOnly(true)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    todayOnly ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Today&apos;s Entries
                </button>
                <button
                  type="button"
                  onClick={() => setTodayOnly(false)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    !todayOnly ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  All Invoices
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSubTab('new')}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark whitespace-nowrap shrink-0 self-start"
            >
              <UserPlus className="w-4 h-4" />
              New Patient
            </button>
          </div>

          {listBanner && (
            <div className="p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
              {listBanner}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-2.5 pr-3 font-medium">Invoice / Date</th>
                  <th className="py-2.5 pr-3 font-medium">Patient</th>
                  <th className="py-2.5 pr-3 font-medium">Referred By</th>
                  <th className="py-2.5 pr-3 font-medium">Tests</th>
                  <th className="py-2.5 pr-3 font-medium text-right">Discount</th>
                  <th className="py-2.5 pr-3 font-medium text-right">Net Bill</th>
                  <th className="py-2.5 pr-3 font-medium text-right">Paid</th>
                  <th className="py-2.5 pr-3 font-medium text-right">Due</th>
                  <th className="py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {invoices.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-sm text-slate-500">
                      No matching invoices found.
                    </td>
                  </tr>
                ) : (
                  invoices.map((inv) => {
                    const canEdit = inv.is_today === 1 || isAdmin;
                    const discPct =
                      inv.discount_pct !== undefined
                        ? inv.discount_pct
                        : inv.subtotal > 0
                        ? Math.round(((inv.discount_amount / inv.subtotal) * 100) * 100) / 100
                        : 0;
                    return (
                      <tr key={inv.id} className="hover:bg-slate-50">
                        <td className="py-3 pr-3 font-mono tabular-nums text-xs">
                          <div className="font-semibold text-slate-900">{inv.invoice_no}</div>
                          <div className="text-slate-500">{formatDateTime(inv.created_at)}</div>
                        </td>
                        <td className="py-3 pr-3">
                          <div className="font-semibold text-slate-900">{inv.patient_name}</div>
                          <div className="text-xs text-slate-500 tabular-nums">
                            {inv.patient_uid} · {formatAge(inv.age_years, inv.age_months, inv.age_days)} · {inv.gender}
                            {inv.patient_mobile ? ` · ${inv.patient_mobile}` : ''}
                          </div>
                        </td>
                        <td className="py-3 pr-3 text-xs text-slate-700">{inv.doctor_name || 'Self'}</td>
                        <td className="py-3 pr-3 text-xs text-slate-700">
                          {inv.test_items && inv.test_items.length > 0 && (
                            <div className="flex flex-wrap gap-1 mb-1 max-w-[260px]">
                              {inv.test_items.map((t) => (
                                <span
                                  key={t.id}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md bg-white border border-slate-200 text-slate-700"
                                >
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full ${
                                      t.status === 'Ready'
                                        ? 'bg-emerald-500'
                                        : t.status === 'Verified'
                                        ? 'bg-teal-500'
                                        : t.status === 'Processing'
                                        ? 'bg-amber-500'
                                        : 'bg-slate-400'
                                    }`}
                                  />
                                  <span className="truncate max-w-[130px]">{t.test_name}</span>
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="font-mono tabular-nums text-[11px] text-slate-500">
                            {inv.ready_tests ?? 0}/{inv.total_tests ?? 0} Ready
                          </div>
                          <div className="mt-1.5">
                            <SampleTimerControl
                              compact
                              alignRight={false}
                              invoiceId={inv.id}
                              invoiceNo={inv.invoice_no}
                              patientUid={inv.patient_uid}
                              patientName={inv.patient_name}
                              tests={inv.test_items}
                            />
                          </div>
                        </td>
                        <td className="py-3 pr-3 text-right font-mono tabular-nums text-xs">
                          {inv.discount_amount > 0 ? (
                            <div>
                              <div className="font-semibold text-amber-700">-{formatBDT(inv.discount_amount)}</div>
                              <div className="text-[11px] text-slate-500">
                                {(inv.doctor_less_amount ?? 0) > 0 && (inv.flat_discount_amount ?? 0) > 0
                                  ? `Dr ${inv.doctor_less_percent ?? 0}% + Flat ${formatBDT(inv.flat_discount_amount ?? 0)}`
                                  : `${discPct}% off`}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 pr-3 text-right font-mono tabular-nums font-medium">
                          <div>{formatBDT(inv.net_total)}</div>
                          {Number(inv.adjustment_amount || 0) !== 0 && (
                            <div className="text-[11px] font-semibold text-amber-700">
                              Adj: {Number(inv.adjustment_amount) > 0 ? `-${formatBDT(inv.adjustment_amount)}` : `+${formatBDT(Math.abs(Number(inv.adjustment_amount)))}`}
                            </div>
                          )}
                        </td>
                        <td className="py-3 pr-3 text-right font-mono tabular-nums text-emerald-700">
                          {formatBDT(inv.paid_amount)}
                        </td>
                        <td className="py-3 pr-3 text-right font-mono tabular-nums font-semibold text-red-700">
                          {inv.due_amount > 0 ? formatBDT(inv.due_amount) : '—'}
                        </td>
                        <td className="py-3 text-right">
                          <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setListBanner('');
                                setDuePaymentInvoiceId(inv.id);
                              }}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md border whitespace-nowrap shrink-0 ${
                                inv.due_amount > 0
                                  ? 'text-emerald-800 bg-emerald-50 border-emerald-300 hover:bg-emerald-100'
                                  : 'text-slate-700 bg-white border-slate-300 hover:bg-slate-100'
                              }`}
                            >
                              <CreditCard className="w-3.5 h-3.5" />
                              {inv.due_amount > 0 ? 'Pay Due' : 'Ledger'}
                            </button>
                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() => {
                                  setListBanner('');
                                  setAdjustBillInvoiceId(inv.id);
                                }}
                                title="Adjust or reduce net bill (Admin only)"
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-300 rounded-md hover:bg-amber-100 whitespace-nowrap shrink-0"
                              >
                                <ShieldCheck className="w-3.5 h-3.5" />
                                Adjust Bill
                              </button>
                            )}
                            {canEdit && (
                              <button
                                type="button"
                                onClick={() => {
                                  setListBanner('');
                                  setEditingInvoiceId(inv.id);
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-300 rounded-md hover:bg-slate-200 whitespace-nowrap shrink-0"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                                Edit / Add Test
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onOpenReceipt(inv.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-slate-100 whitespace-nowrap shrink-0"
                            >
                              <Printer className="w-3.5 h-3.5" />
                              Receipt
                            </button>
                            <button
                              type="button"
                              onClick={() => onOpenReport(inv.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-700 border border-teal-300 bg-teal-50 rounded-md hover:bg-teal-100 whitespace-nowrap shrink-0"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              Report
                            </button>
                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() => {
                                  setListBanner('');
                                  setDeletingInvoice(inv);
                                }}
                                title="Delete patient record (Admin only)"
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition-colors whitespace-nowrap shrink-0"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editingInvoiceId !== null && (
        <EditInvoiceModal
          invoiceId={editingInvoiceId}
          isAdmin={isAdmin}
          settings={settings}
          categories={categories}
          tests={tests}
          doctors={doctors}
          onClose={() => setEditingInvoiceId(null)}
          onSaved={async (updated, printReceipt) => {
            setEditingInvoiceId(null);
            setInvoices((prev) =>
              prev.map((inv) => (inv.id === updated.id ? { ...inv, ...updated } : inv))
            );
            setListBanner(
              `Updated ${updated.invoice_no} (${updated.patient_name}) · Patient ID ${updated.patient_uid} & Portal Login preserved.`
            );
            await loadInvoices();
            if (printReceipt) {
              onOpenReceipt(updated.id);
            }
          }}
        />
      )}

      <DuePaymentModal
        invoiceId={duePaymentInvoiceId}
        isAdmin={isAdmin}
        onClose={() => setDuePaymentInvoiceId(null)}
        onOpenReceipt={onOpenReceipt}
        onOpenAdminAdjust={isAdmin ? (invId) => setAdjustBillInvoiceId(invId) : undefined}
        onPaymentRecorded={async (updated) => {
          setInvoices((prev) =>
            prev.map((inv) => (inv.id === updated.invoice.id ? { ...inv, ...updated.invoice } : inv))
          );
          setListBanner(
            `Updated payment for ${updated.invoice.invoice_no} (${updated.invoice.patient_name}) · Remaining due: ${formatBDT(updated.invoice.due_amount)}`
          );
          await loadInvoices();
        }}
      />

      {isAdmin && (
        <AdminAdjustBillModal
          invoiceId={adjustBillInvoiceId}
          onClose={() => setAdjustBillInvoiceId(null)}
          onAdjusted={async (updated) => {
            setInvoices((prev) =>
              prev.map((inv) => (inv.id === updated.invoice.id ? { ...inv, ...updated.invoice } : inv))
            );
            setListBanner(
              `Admin adjusted bill for ${updated.invoice.invoice_no} (${updated.invoice.patient_name}) · New Net: ${formatBDT(updated.invoice.net_total)} · Due: ${formatBDT(updated.invoice.due_amount)}`
            );
            await loadInvoices();
          }}
        />
      )}

      <DeletePatientConfirmModal
        target={deletingInvoice}
        onClose={() => setDeletingInvoice(null)}
        onDeleted={async (result) => {
          setDeletingInvoice(null);
          setInvoices((prev) => prev.filter((item) => item.id !== result.deletedInvoiceId));
          if (result.patientDeleted && existingPatient?.id === result.deletedPatientId) {
            setExistingPatient(null);
          }
          setListBanner(
            `Deleted ${result.invoiceNo} (${result.patientName})${
              result.patientDeleted ? ' and patient profile' : ''
            } · ${result.deletedTestsCount} test record(s) removed.`
          );
          await loadInvoices();
        }}
      />
    </div>
  );
};
