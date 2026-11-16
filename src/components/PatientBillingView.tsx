import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Edit3, FileText, Plus, Printer, Search, Trash2, UserPlus } from 'lucide-react';
import { apiFetch, formatAge, formatBDT, formatDateTime } from '../lib/api.ts';
import type { DiagnosticTest, Doctor, InvoiceSummary, LabSettings, PatientProfile, TestCategory } from '../types.ts';
import { DeletePatientConfirmModal } from './DeletePatientConfirmModal.tsx';
import { EditInvoiceModal } from './EditInvoiceModal.tsx';

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
  const [discountType, setDiscountType] = useState<'flat' | 'percent'>('flat');
  const [discountValue, setDiscountValue] = useState<string>('0');
  const [paidAmount, setPaidAmount] = useState<string>('');
  const [paidTouched, setPaidTouched] = useState(false);
  const [notes, setNotes] = useState('');

  // Admin-only custom doctor commission setup (per-patient or per-test)
  const [commissionMode, setCommissionMode] = useState<'doctor_default' | 'custom_invoice' | 'custom_per_test'>('doctor_default');
  const [customCommType, setCustomCommType] = useState<'percent' | 'flat'>('percent');
  const [customCommValue, setCustomCommValue] = useState<string>('0');
  const [perTestCommMap, setPerTestCommMap] = useState<
    Record<number, { type: 'percent' | 'flat'; value: string }>
  >({});

  // List filter & Edit modal
  const [listSearch, setListSearch] = useState('');
  const [todayOnly, setTodayOnly] = useState(true);
  const [editingInvoiceId, setEditingInvoiceId] = useState<number | null>(null);
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

  const selectedTests = useMemo(
    () => tests.filter((t) => selectedTestIds.includes(t.id)),
    [tests, selectedTestIds]
  );

  const subtotal = useMemo(
    () => selectedTests.reduce((sum, t) => sum + Number(t.price), 0),
    [selectedTests]
  );

  const discountAmount = useMemo(() => {
    const val = Math.max(0, Number(discountValue || 0));
    const amt = discountType === 'percent' ? (subtotal * val) / 100 : val;
    return Math.min(subtotal, Math.round(amt * 100) / 100);
  }, [subtotal, discountType, discountValue]);

  const netTotal = useMemo(
    () => Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100),
    [subtotal, discountAmount]
  );

  useEffect(() => {
    if (!paidTouched) {
      setPaidAmount(String(netTotal));
    }
  }, [netTotal, paidTouched]);

  const effectivePaid = Math.min(netTotal, Math.max(0, Number(paidAmount || 0)));
  const dueAmount = Math.max(0, Math.round((netTotal - effectivePaid) * 100) / 100);
  const maxStaffPct = Number(settings.max_staff_discount_pct || 15);
  const currentDiscountPct = subtotal > 0 ? Math.round(((discountAmount / subtotal) * 100) * 100) / 100 : 0;
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
    setDiscountType('flat');
    setDiscountValue('0');
    setPaidAmount('0');
    setPaidTouched(false);
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
          discountType,
          discountValue: Number(discountValue || 0),
          paidAmount: effectivePaid,
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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Patient Registration & Billing</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Register patients, select tests, apply authorized discounts, and print receipts.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setSubTab('new')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'new' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            New Patient & Bill
          </button>
          <button
            type="button"
            onClick={() => setSubTab('list')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'list' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Invoice Directory
          </button>
        </div>
      </div>

      {subTab === 'new' ? (
        <form onSubmit={(e) => handleSubmit(e, true)} className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Left Column: Patient Demographics & Test Selector */}
          <div className="xl:col-span-8 space-y-6">
            {/* Patient Information */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">01. Patient & Referral Details</h2>
                <span className="text-xs font-mono text-slate-500">
                  {existingPatient ? `Linking to ${existingPatient.patient_uid}` : 'Auto Patient ID & Portal Password'}
                </span>
              </div>

              {/* Returning Patient Lookup */}
              <div className="relative bg-slate-50 border border-slate-200 rounded-lg p-3">
                {existingPatient ? (
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <div>
                      <span className="font-semibold text-teal-800">Returning Patient Selected:</span>{' '}
                      <span className="font-mono font-bold text-slate-900">{existingPatient.patient_uid}</span> ·{' '}
                      <span className="font-medium text-slate-900">{existingPatient.name}</span>
                    </div>
                    <button
                      type="button"
                      onClick={clearExistingPatient}
                      className="text-xs font-medium text-slate-600 hover:text-red-700 underline whitespace-nowrap"
                    >
                      Register as New Patient Instead
                    </button>
                  </div>
                ) : (
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Returning Patient? Search by Patient ID, Mobile, or Name (optional)
                    </label>
                    <input
                      type="text"
                      value={patientLookupQuery}
                      onChange={(e) => handlePatientLookup(e.target.value)}
                      placeholder="e.g. ALEA-2601 or 01715..."
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    {patientMatches.length > 0 && (
                      <div className="absolute z-20 left-3 right-3 mt-1 max-h-48 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg divide-y divide-slate-100">
                        {patientMatches.map((pm) => (
                          <button
                            key={pm.id}
                            type="button"
                            onClick={() => selectExistingPatient(pm)}
                            className="w-full text-left px-3 py-2 hover:bg-teal-50 flex items-center justify-between gap-2 text-xs"
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

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Patient Full Name <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="text"
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder="e.g. Md. Karim Uddin"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Gender <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={gender}
                    onChange={(e) => setGender(e.target.value as 'Male' | 'Female' | 'Other')}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 bg-white"
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
                      placeholder="Yrs"
                      title="Years"
                      className="w-full px-2 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <input
                      type="number"
                      min={0}
                      max={11}
                      value={ageMonths}
                      onChange={(e) => setAgeMonths(e.target.value)}
                      placeholder="Mo"
                      title="Months"
                      className="w-full px-2 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={ageDays}
                      onChange={(e) => setAgeDays(e.target.value)}
                      placeholder="Day"
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
                    placeholder="Halasa, Mirpur, Kushtia"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>

                {/* Searchable Referral Doctor Dropdown */}
                <div className="sm:col-span-2 lg:col-span-3 relative">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Referring Doctor</label>
                  <input
                    type="text"
                    value={doctorSearch}
                    onFocus={() => setShowDoctorDropdown(true)}
                    onBlur={() => setTimeout(() => setShowDoctorDropdown(false), 180)}
                    onChange={(e) => {
                      setDoctorSearch(e.target.value);
                      setShowDoctorDropdown(true);
                    }}
                    placeholder="Search doctor name, degree, or hospital..."
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  {showDoctorDropdown && (
                    <div className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg divide-y divide-slate-100">
                      {filteredDoctors.length === 0 ? (
                        <div className="p-3 text-xs text-slate-500">No matching doctors found.</div>
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
                            className="w-full text-left px-3.5 py-2 hover:bg-teal-50 flex items-center justify-between gap-2"
                          >
                            <div>
                              <div className="text-sm font-medium text-slate-900">{doc.name}</div>
                              <div className="text-xs text-slate-500">
                                {doc.degree} {doc.hospital ? `· ${doc.hospital}` : ''}
                              </div>
                            </div>
                            {selectedDoctorId === doc.id && <Check className="w-4 h-4 text-teal-600 shrink-0" />}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Diagnostic Test Selector */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-slate-900">02. Select Diagnostic Tests</h2>
                <div className="relative w-full sm:w-64">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={testSearch}
                    onChange={(e) => setTestSearch(e.target.value)}
                    placeholder="Search CBC, Sugar, Lipid..."
                    className="w-full pl-9 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 pb-2 border-b border-slate-200">
                <button
                  type="button"
                  onClick={() => setActiveCategory('All')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    activeCategory === 'All'
                      ? 'bg-slate-900 text-white'
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
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      activeCategory === cat.name
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {cat.name}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[420px] overflow-y-auto pr-1">
                {filteredTests.map((t) => {
                  const selected = selectedTestIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleTest(t.id)}
                      className={`text-left p-3 rounded-lg border transition-colors flex items-center justify-between gap-3 ${
                        selected
                          ? 'bg-teal-50 border-teal-600 ring-1 ring-teal-600'
                          : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 truncate">{t.name}</div>
                        <div className="text-xs text-slate-500 truncate">
                          <span className="font-mono">{t.code}</span> · {t.category_name} · {t.sample_type}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-bold font-mono tabular-nums text-slate-900">
                          {formatBDT(t.price)}
                        </div>
                        <div className="text-[11px] font-medium text-teal-700">
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
          <div className="xl:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4 sticky top-20">
            <h2 className="text-sm font-semibold text-slate-900 pb-3 border-b border-slate-200">
              03. Billing & Payment Summary
            </h2>

            {selectedTests.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">
                Select tests from the catalog to calculate the bill.
              </p>
            ) : (
              <div className="divide-y divide-slate-200 max-h-52 overflow-y-auto pr-1">
                {selectedTests.map((t) => (
                  <div key={t.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-800 truncate">{t.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono tabular-nums font-semibold text-slate-900">
                        {formatBDT(t.price)}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleTest(t.id)}
                        className="text-slate-400 hover:text-red-600 p-0.5"
                        aria-label={`Remove ${t.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="pt-3 border-t border-slate-200 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">Subtotal ({selectedTests.length} tests)</span>
                <span className="font-mono tabular-nums font-semibold text-slate-900">{formatBDT(subtotal)}</span>
              </div>

              {/* Less / Discount */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-700">Less / Discount</label>
                  <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
                    <button
                      type="button"
                      onClick={() => setDiscountType('flat')}
                      className={`px-2 py-0.5 text-xs font-medium rounded ${
                        discountType === 'flat' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                      }`}
                    >
                      ৳ Flat
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiscountType('percent')}
                      className={`px-2 py-0.5 text-xs font-medium rounded ${
                        discountType === 'percent' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                      }`}
                    >
                      % Pct
                    </button>
                  </div>
                </div>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>Recorded Discount</span>
                  <span className="font-mono tabular-nums font-semibold text-amber-700">
                    -{formatBDT(discountAmount)} ({currentDiscountPct}%)
                  </span>
                </div>
                {exceedsStaffCap && (
                  <p className="text-xs font-medium text-red-600">
                    Exceeds Staff discount limit ({maxStaffPct}%). Admin approval required.
                  </p>
                )}
              </div>

              <div className="flex justify-between text-base font-bold text-slate-900 pt-2 border-t border-slate-200">
                <span>Net Payable</span>
                <span className="font-mono tabular-nums text-teal-700">{formatBDT(netTotal)}</span>
              </div>

              {/* Admin-Only Patient/Test Doctor Commission Setup */}
              {isAdmin && selectedDoctorId && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800">Doctor Commission (Admin)</span>
                    <span className="font-mono font-bold text-teal-700">
                      {formatBDT(previewCommission.amount)} ({previewCommission.effectivePct}%)
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-1 p-0.5 bg-slate-200/70 rounded-md">
                    <button
                      type="button"
                      onClick={() => setCommissionMode('doctor_default')}
                      className={`py-1 px-1.5 text-[11px] font-semibold rounded transition-colors ${
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
                      className={`py-1 px-1.5 text-[11px] font-semibold rounded transition-colors ${
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
                      className={`py-1 px-1.5 text-[11px] font-semibold rounded transition-colors ${
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
                        placeholder={customCommType === 'percent' ? 'e.g. 25' : 'e.g. 200'}
                        className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-md bg-white"
                      />
                    </div>
                  )}

                  {commissionMode === 'custom_per_test' && (
                    <div className="space-y-1.5 max-h-40 overflow-y-auto pr-0.5">
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
                              className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-2 py-1.5"
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
                                      [t.id]: {
                                        type: prev[t.id]?.type ?? 'percent',
                                        value: e.target.value,
                                      },
                                    }))
                                  }
                                  className="w-16 px-1.5 py-0.5 text-[11px] font-mono tabular-nums border border-slate-300 rounded"
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

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Paid Amount (BDT)</label>
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
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div className="flex justify-between items-center text-sm">
                <span className="text-slate-600">Due Balance</span>
                <span className={`font-mono tabular-nums font-bold ${dueAmount > 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                  {formatBDT(dueAmount)}
                </span>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Notes (Optional)</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Delivery note or reference"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>

            {error && (
              <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
                {error}
              </div>
            )}
            {successMsg && (
              <div className="p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
                {successMsg}
              </div>
            )}

            <div className="space-y-2 pt-2">
              <button
                type="submit"
                disabled={submitting || selectedTests.length === 0}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <Printer className="w-4 h-4" />
                {submitting ? 'Generating Invoice...' : 'Save & Print Receipt'}
              </button>
              <button
                type="button"
                disabled={submitting || selectedTests.length === 0}
                onClick={(e) => handleSubmit(e, false)}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                Save Without Printing
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
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap shrink-0 self-start"
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
                        <td className="py-3 pr-3 text-xs font-mono tabular-nums text-slate-700">
                          {inv.ready_tests ?? 0}/{inv.total_tests ?? 0} Ready
                        </td>
                        <td className="py-3 pr-3 text-right font-mono tabular-nums text-xs">
                          {inv.discount_amount > 0 ? (
                            <div>
                              <div className="font-semibold text-amber-700">-{formatBDT(inv.discount_amount)}</div>
                              <div className="text-[11px] text-slate-500">{discPct}% off</div>
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 pr-3 text-right font-mono tabular-nums font-medium">
                          {formatBDT(inv.net_total)}
                        </td>
                        <td className="py-3 pr-3 text-right font-mono tabular-nums text-emerald-700">
                          {formatBDT(inv.paid_amount)}
                        </td>
                        <td className="py-3 pr-3 text-right font-mono tabular-nums font-semibold text-red-700">
                          {inv.due_amount > 0 ? formatBDT(inv.due_amount) : '—'}
                        </td>
                        <td className="py-3 text-right">
                          <div className="inline-flex items-center gap-2">
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
