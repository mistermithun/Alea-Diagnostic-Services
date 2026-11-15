import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Calendar,
  ChevronDown,
  ChevronUp,
  FileText,
  KeyRound,
  LogOut,
  Printer,
  Search,
  ShieldCheck,
  User,
} from 'lucide-react';
import {
  formatAge,
  formatDateTime,
  getPatientToken,
  patientApiFetch,
  setPatientToken,
} from '../lib/api.ts';
import type {
  FullInvoice,
  LabSettings,
  PatientPortalArchiveVisit,
  PatientProfile,
} from '../types.ts';
import { ReportPrintModal } from './ReportPrintModal.tsx';

interface PatientPortalViewProps {
  settings: LabSettings;
  mode: 'login' | 'dashboard';
  onAuthenticated: () => void;
  onSignedOut: () => void;
  onBackToHome: () => void;
}

export const PatientPortalView: React.FC<PatientPortalViewProps> = ({
  settings,
  mode,
  onAuthenticated,
  onSignedOut,
  onBackToHome,
}) => {
  const [patient, setPatient] = useState<PatientProfile | null>(null);
  const [archive, setArchive] = useState<PatientPortalArchiveVisit[]>([]);
  const [checkingSession, setCheckingSession] = useState(mode === 'dashboard');

  // Login form state
  const [patientUid, setPatientUid] = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  // Archive UI state
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<number | null>(null);
  const [loadedReports, setLoadedReports] = useState<Record<number, FullInvoice>>({});
  const [loadingReportId, setLoadingReportId] = useState<number | null>(null);
  const [printReportData, setPrintReportData] = useState<FullInvoice | null>(null);
  const [portalError, setPortalError] = useState('');

  const loadProfileAndArchive = useCallback(async () => {
    setPortalError('');
    try {
      const res = await patientApiFetch<{
        patient: PatientProfile;
        archive: PatientPortalArchiveVisit[];
      }>('/api/patient/portal-profile');
      setPatient(res.patient);
      setArchive(res.archive);
    } catch {
      setPatientToken(null);
      setPatient(null);
      setArchive([]);
      onSignedOut();
    } finally {
      setCheckingSession(false);
    }
  }, [onSignedOut]);

  useEffect(() => {
    if (mode === 'dashboard') {
      if (getPatientToken()) {
        setCheckingSession(true);
        loadProfileAndArchive();
      } else {
        setCheckingSession(false);
        onSignedOut();
      }
    } else {
      setCheckingSession(false);
    }
  }, [mode, loadProfileAndArchive, onSignedOut]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const res = await patientApiFetch<{ token: string; patient: PatientProfile }>(
        '/api/patient-auth/login',
        {
          method: 'POST',
          body: JSON.stringify({
            patientUid: patientUid.trim(),
            password: password.trim(),
          }),
        }
      );
      setPatientToken(res.token);
      setPassword('');
      setPatient(res.patient);
      onAuthenticated();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setPatientToken(null);
    setPatient(null);
    setArchive([]);
    setLoadedReports({});
    setExpandedInvoiceId(null);
    setPrintReportData(null);
    onSignedOut();
  };

  const fetchReportDetail = async (invoiceId: number): Promise<FullInvoice | null> => {
    if (loadedReports[invoiceId]) {
      return loadedReports[invoiceId];
    }
    setLoadingReportId(invoiceId);
    setPortalError('');
    try {
      const full = await patientApiFetch<FullInvoice>(`/api/patient/reports/${invoiceId}`);
      setLoadedReports((prev) => ({ ...prev, [invoiceId]: full }));
      return full;
    } catch (err) {
      setPortalError(err instanceof Error ? err.message : 'Unable to load report.');
      return null;
    } finally {
      setLoadingReportId(null);
    }
  };

  const handleToggleInlineView = async (invoiceId: number) => {
    if (expandedInvoiceId === invoiceId) {
      setExpandedInvoiceId(null);
      return;
    }
    await fetchReportDetail(invoiceId);
    setExpandedInvoiceId(invoiceId);
  };

  const handleOpenDigitalPdf = async (invoiceId: number) => {
    const full = await fetchReportDetail(invoiceId);
    if (full) {
      setPrintReportData(full);
    }
  };

  const filteredArchive = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return archive;
    return archive.filter(
      (v) =>
        v.invoice_no.toLowerCase().includes(q) ||
        v.created_at.toLowerCase().includes(q) ||
        (v.doctor_name || '').toLowerCase().includes(q) ||
        v.tests.some((t) => t.test_name.toLowerCase().includes(q))
    );
  }, [archive, searchQuery]);

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-sm text-slate-600">Verifying patient session...</div>
      </div>
    );
  }

  // ============================================================================
  // DEDICATED PATIENT-FRIENDLY LOGIN PAGE (Distinct from Admin/Staff screens)
  // ============================================================================
  if (mode === 'login' || !patient) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-between p-4 sm:p-6">
        <header className="max-w-lg w-full mx-auto pt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={onBackToHome}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 py-1.5 whitespace-nowrap"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Portal Home
          </button>
          <span className="text-xs font-semibold text-teal-800">Patient Self-Service Portal</span>
        </header>

        <main className="w-full max-w-lg mx-auto my-8 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="bg-teal-700 text-white px-6 py-6">
            <div className="flex items-center gap-3">
              <svg
                width="40"
                height="40"
                viewBox="0 0 46 46"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="shrink-0"
                aria-hidden="true"
              >
                <rect width="46" height="46" rx="10" fill="#FFFFFF" />
                <path d="M20 11H26V20H35V26H26V35H20V26H11V20H20V11Z" fill="#0F766E" />
              </svg>
              <div>
                <h1 className="text-lg font-bold tracking-tight leading-snug">{settings.lab_name}</h1>
                <p className="text-xs text-teal-100 mt-0.5">{settings.lab_address}</p>
              </div>
            </div>
            <div className="mt-5 pt-4 border-t border-teal-600">
              <h2 className="text-base font-semibold text-white">Online Test Report Access</h2>
              <p className="text-xs text-teal-50 mt-1">
                Check your test results and download official verified PDF pathology reports from home.
              </p>
            </div>
          </div>

          <div className="p-6 space-y-5">
            {/* Step-by-step Cash Memo Instructions */}
            <div className="p-3.5 bg-teal-50/70 border border-teal-200 rounded-lg text-xs text-slate-700 space-y-1.5">
              <div className="font-semibold text-teal-900">How to find your login details:</div>
              <ol className="list-decimal list-inside space-y-1 text-slate-700">
                <li>Check the <span className="font-semibold">Online Report Portal Access</span> box on your lab cash memo or money receipt.</li>
                <li>Enter your <span className="font-mono font-semibold text-slate-900">Patient ID</span> (example: <span className="font-mono">ALEA-2601</span>) and 6-character <span className="font-semibold">Portal Password</span> below.</li>
              </ol>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label htmlFor="patient-uid" className="block text-xs font-semibold text-slate-800 mb-1.5">
                  Patient ID
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="patient-uid"
                    type="text"
                    autoFocus
                    value={patientUid}
                    onChange={(e) => setPatientUid(e.target.value)}
                    placeholder="e.g. ALEA-2601"
                    className="w-full pl-10 pr-4 py-2.5 text-sm font-mono uppercase border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="patient-password" className="block text-xs font-semibold text-slate-800 mb-1.5">
                  Portal Password (From Cash Memo)
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="patient-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter 6-character memo password"
                    className="w-full pl-10 pr-4 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    required
                  />
                </div>
              </div>

              {loginError && (
                <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {loginError}
                </div>
              )}

              <button
                type="submit"
                disabled={loginLoading}
                className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-60 transition-colors"
              >
                {loginLoading ? 'Signing in...' : 'View My Reports'}
              </button>
            </form>

            <div className="pt-3 border-t border-slate-200 text-[11px] text-slate-500 space-y-1">
              <div className="flex items-center gap-1.5 text-slate-700 font-medium">
                <ShieldCheck className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                <span>Private &amp; Isolated Patient Access</span>
              </div>
              <p>
                For your privacy, only reports registered under your personal Patient ID are accessible here.
              </p>
              <p className="font-mono text-slate-600 pt-1">
                Sample Patient: ALEA-2601 · Password: <span className="font-semibold">ALEA61</span>
              </p>
            </div>
          </div>
        </main>

        <footer className="max-w-lg w-full mx-auto text-center text-[11px] text-slate-500 pb-2">
          Need help? Call Lab Helpline: <span className="font-mono tabular-nums font-medium text-slate-700">{settings.lab_phone}</span>
        </footer>
      </div>
    );
  }

  // ============================================================================
  // AUTHENTICATED PATIENT MEDICAL ARCHIVE & DIGITAL REPORT DOWNLOADS
  // ============================================================================
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col print:block print:min-h-0 print:h-auto print:bg-white">
      {/* Patient Portal Top Bar */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 sm:px-6 py-3 no-print">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm sm:text-base font-bold text-slate-900 truncate">
              {settings.lab_name}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              Patient Health Archive · {settings.lab_address}
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <span className="hidden sm:inline text-xs font-mono font-semibold text-teal-800">
              {patient.patient_uid}
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className={`flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-6 ${printReportData ? 'no-print' : ''}`}>
        {/* Medical Profile Card */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
            <div>
              <div className="text-xs font-medium text-teal-700">Verified Patient Profile</div>
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mt-0.5">{patient.name}</h1>
            </div>
            <div className="font-mono tabular-nums text-sm font-bold text-slate-900 bg-slate-100 border border-slate-200 px-3.5 py-2 rounded-lg self-start sm:self-auto">
              ID: {patient.patient_uid}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 text-xs">
            <div>
              <div className="text-slate-500">Age / Gender</div>
              <div className="font-semibold text-slate-900 mt-0.5 tabular-nums">
                {formatAge(patient.age_years, patient.age_months, patient.age_days)} · {patient.gender}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Mobile</div>
              <div className="font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
                {patient.mobile || '—'}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Address</div>
              <div className="font-medium text-slate-900 mt-0.5 truncate">{patient.address || '—'}</div>
            </div>
            <div>
              <div className="text-slate-500">Total Lab Visits</div>
              <div className="font-mono tabular-nums font-bold text-teal-700 mt-0.5">
                {archive.length} {archive.length === 1 ? 'Visit' : 'Visits'}
              </div>
            </div>
          </div>
        </section>

        {portalError && (
          <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {portalError}
          </div>
        )}

        {/* Date-Wise Archive Filter */}
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">Date-Wise Diagnostic Reports</h2>
              <p className="text-xs text-slate-500">
                Chronological history of your laboratory investigations and official PDF downloads.
              </p>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter by date, test, or invoice..."
                className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          {filteredArchive.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-slate-500">
              No diagnostic visits match your search.
            </div>
          ) : (
            <div className="space-y-4">
              {filteredArchive.map((visit) => {
                const isExpanded = expandedInvoiceId === visit.invoice_id;
                const detail = loadedReports[visit.invoice_id];

                return (
                  <div
                    key={visit.invoice_id}
                    className="bg-white border border-slate-200 rounded-xl overflow-hidden"
                  >
                    {/* Visit Summary Header */}
                    <div className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-600">
                          <span className="inline-flex items-center gap-1 font-mono font-semibold tabular-nums text-slate-900">
                            <Calendar className="w-3.5 h-3.5 text-teal-700" />
                            {formatDateTime(visit.created_at)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums font-medium text-slate-700">
                            {visit.invoice_no}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {visit.ready_tests}/{visit.total_tests} Ready
                          </span>
                          {visit.abnormal_count > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-bold text-red-600">
                                {visit.abnormal_count} Abnormal Finding{visit.abnormal_count > 1 ? 's' : ''}
                              </span>
                            </>
                          )}
                        </div>

                        <div className="text-sm font-semibold text-slate-900">
                          {visit.tests.map((t) => t.test_name).join(' · ')}
                        </div>

                        <div className="text-xs text-slate-500">
                          Referred by: {visit.doctor_name || 'Self'}
                          <span className="mx-2" aria-hidden="true">·</span>
                          Billing: <span className={visit.due_amount > 0 ? 'text-amber-700 font-medium' : 'text-emerald-700 font-medium'}>{visit.payment_status}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleToggleInlineView(visit.invoice_id)}
                          disabled={loadingReportId === visit.invoice_id}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                        >
                          {isExpanded ? (
                            <>
                              <ChevronUp className="w-4 h-4" />
                              Hide Parameters
                            </>
                          ) : (
                            <>
                              <ChevronDown className="w-4 h-4" />
                              {loadingReportId === visit.invoice_id ? 'Loading...' : 'View Results'}
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenDigitalPdf(visit.invoice_id)}
                          disabled={loadingReportId === visit.invoice_id}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap"
                        >
                          <Printer className="w-4 h-4" />
                          Digital PDF Report
                        </button>
                      </div>
                    </div>

                    {/* Inline Parameter Results Table */}
                    {isExpanded && detail && (
                      <div className="border-t border-slate-200 bg-slate-50/70 p-4 sm:p-5 space-y-5">
                        {detail.tests.map((t) => (
                          <div key={t.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                            <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between gap-2">
                              <div>
                                <div className="text-sm font-semibold text-slate-900">{t.test_name}</div>
                                <div className="text-[11px] text-slate-500">
                                  {t.category_name} · {t.sample_type}
                                </div>
                              </div>
                              <span
                                className={`text-xs font-semibold ${
                                  t.status === 'Ready'
                                    ? 'text-emerald-700'
                                    : t.status === 'Verified'
                                    ? 'text-teal-700'
                                    : 'text-amber-700'
                                }`}
                              >
                                {t.status}
                              </span>
                            </div>

                            <div className="overflow-x-auto">
                              <table className="w-full text-xs border-collapse">
                                <thead>
                                  <tr className="border-b border-slate-200 text-left text-slate-500 bg-slate-50">
                                    <th className="py-2 px-3 font-medium">Parameter</th>
                                    <th className="py-2 px-3 font-medium text-right">Result</th>
                                    <th className="py-2 px-3 font-medium">Unit</th>
                                    <th className="py-2 px-3 font-medium">Reference Range</th>
                                    <th className="py-2 px-3 font-medium text-center">Indicator</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-200">
                                  {(t.results || []).map((r) => {
                                    const isAbn =
                                      r.flag && r.flag !== 'Normal' && r.result_value.trim() !== '';
                                    return (
                                      <tr key={r.id}>
                                        <td className="py-2 px-3 font-medium text-slate-900">
                                          {r.parameter_name}
                                        </td>
                                        <td
                                          className={`py-2 px-3 text-right font-mono tabular-nums ${
                                            isAbn ? 'font-bold text-red-600' : 'font-semibold text-slate-900'
                                          }`}
                                        >
                                          {r.result_value || 'Pending'}
                                        </td>
                                        <td className="py-2 px-3 text-slate-600">{r.unit || '—'}</td>
                                        <td className="py-2 px-3 font-mono tabular-nums text-slate-600">
                                          {r.reference_range_text || '—'}
                                        </td>
                                        <td
                                          className={`py-2 px-3 text-center font-semibold ${
                                            isAbn ? 'text-red-600 font-bold' : 'text-emerald-700'
                                          }`}
                                        >
                                          {r.result_value ? (isAbn ? r.flag.toUpperCase() : 'Normal') : '—'}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        ))}

                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() => handleOpenDigitalPdf(visit.invoice_id)}
                            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                          >
                            <FileText className="w-4 h-4" />
                            Open Official Digital PDF
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* Patient Portal Digital PDF Report Modal (Automatically forces Full Digital Letterhead + QR + Signatures) */}
      <ReportPrintModal
        data={printReportData}
        settings={settings}
        portalMode={true}
        onClose={() => setPrintReportData(null)}
      />
    </div>
  );
};
