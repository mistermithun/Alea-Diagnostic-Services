import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Calendar,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  LogOut,
  Printer,
  RefreshCw,
  Search,
  ShieldCheck,
  Stethoscope,
  User,
} from 'lucide-react';
import QRCode from 'qrcode';
import {
  buildPatientReportQrUrl,
  doctorApiFetch,
  formatAge,
  formatBDT,
  formatDateTime,
  getDoctorToken,
  resolveApiUrl,
  resolvePublicBaseUrl,
  setDoctorToken,
} from '../lib/api.ts';
import { resolveReportSignatures } from '../lib/reportLayout.ts';
import { exportDiagnosticReportPdf } from '../lib/reportPdf.ts';
import type {
  DoctorPortalDashboardResponse,
  DoctorPortalPatientVisit,
  DoctorPortalProfile,
  FullInvoice,
  LabSettings,
} from '../types.ts';
import { ReportPrintModal } from './ReportPrintModal.tsx';

interface DoctorPortalViewProps {
  settings: LabSettings;
  publicBaseUrl?: string;
  mode: 'login' | 'dashboard';
  onAuthenticated: () => void;
  onSignedOut: () => void;
  onBackToHome: () => void;
}

type FilterTab = 'all' | 'ready' | 'pending';

export const DoctorPortalView: React.FC<DoctorPortalViewProps> = ({
  settings,
  publicBaseUrl,
  mode,
  onAuthenticated,
  onSignedOut,
  onBackToHome,
}) => {
  const [dashboard, setDashboard] = useState<DoctorPortalDashboardResponse | null>(null);
  const [checkingSession, setCheckingSession] = useState(mode === 'dashboard');
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string>('');
  const [portalError, setPortalError] = useState('');
  const [portalNotice, setPortalNotice] = useState('');

  // Login form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  // Filter & Report view state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<number | null>(null);
  const [loadedReports, setLoadedReports] = useState<Record<number, FullInvoice>>({});
  const [loadingReportId, setLoadingReportId] = useState<number | null>(null);
  const [downloadingPdfId, setDownloadingPdfId] = useState<number | null>(null);
  const [printReportData, setPrintReportData] = useState<FullInvoice | null>(null);
  const [printFocusTestId, setPrintFocusTestId] = useState<number | null>(null);

  const isFetchingRef = useRef(false);

  const formatSyncTime = () => {
    return new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  const loadDashboard = useCallback(
    async (silent = false) => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      if (!silent) {
        setPortalError('');
      } else {
        setRefreshing(true);
      }
      try {
        const res = await doctorApiFetch<DoctorPortalDashboardResponse>(
          '/api/doctor/portal-dashboard?days=30'
        );
        setDashboard(res);
        setLastSyncedAt(formatSyncTime());
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unable to load doctor dashboard.';
        if (
          msg.toLowerCase().includes('authentication required') ||
          msg.toLowerCase().includes('disabled') ||
          msg.includes('401') ||
          msg.includes('403')
        ) {
          setDoctorToken(null);
          setDashboard(null);
          onSignedOut();
        } else {
          setPortalError(msg);
        }
      } finally {
        isFetchingRef.current = false;
        setCheckingSession(false);
        setRefreshing(false);
      }
    },
    [onSignedOut]
  );

  // Initial load when entering dashboard
  useEffect(() => {
    if (mode === 'dashboard') {
      if (getDoctorToken()) {
        setCheckingSession(true);
        loadDashboard(false);
      } else {
        setCheckingSession(false);
        onSignedOut();
      }
    } else {
      setCheckingSession(false);
    }
  }, [mode, loadDashboard, onSignedOut]);

  // Real-time SSE sync + mobile resume & fallback polling
  useEffect(() => {
    if (mode !== 'dashboard') return;
    const token = getDoctorToken();
    if (!token) return;

    let es: EventSource | null = null;
    try {
      const streamUrl = resolveApiUrl(`/api/doctor/stream?token=${encodeURIComponent(token)}`);
      es = new EventSource(streamUrl);
      es.addEventListener('refresh', () => {
        // Clear cached inline reports so updated lab results show immediately
        setLoadedReports({});
        loadDashboard(true);
      });
    } catch {
      // Fallback polling remains active
    }

    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        loadDashboard(true);
      }
    };

    window.addEventListener('focus', handleResume);
    document.addEventListener('visibilitychange', handleResume);
    const pollTimer = window.setInterval(() => {
      loadDashboard(true);
    }, 25000);

    return () => {
      if (es) es.close();
      window.removeEventListener('focus', handleResume);
      document.removeEventListener('visibilitychange', handleResume);
      window.clearInterval(pollTimer);
    };
  }, [mode, loadDashboard]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const res = await doctorApiFetch<{ token: string; doctor: DoctorPortalProfile }>(
        '/api/doctor-auth/login',
        {
          method: 'POST',
          body: JSON.stringify({
            username: username.trim(),
            password: password.trim(),
            rememberMe,
          }),
        }
      );
      setDoctorToken(res.token, rememberMe);
      setPassword('');
      onAuthenticated();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setDoctorToken(null);
    setDashboard(null);
    setLoadedReports({});
    setExpandedInvoiceId(null);
    setPrintReportData(null);
    onSignedOut();
  };

  const fetchReportDetail = async (invoiceId: number, forceFresh = false): Promise<FullInvoice | null> => {
    if (!forceFresh && loadedReports[invoiceId]) {
      return loadedReports[invoiceId];
    }
    setLoadingReportId(invoiceId);
    setPortalError('');
    try {
      const full = await doctorApiFetch<FullInvoice>(`/api/doctor/reports/${invoiceId}`);
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
    await fetchReportDetail(invoiceId, true);
    setExpandedInvoiceId(invoiceId);
  };

  const handleOpenPrintPreview = async (invoiceId: number, focusTestId: number | null = null) => {
    const full = await fetchReportDetail(invoiceId, true);
    if (full) {
      setPrintFocusTestId(focusTestId);
      setPrintReportData(full);
    }
  };

  const handleDirectDownloadPdf = async (
    visit: DoctorPortalPatientVisit,
    focusTestId: number | null = null
  ) => {
    setDownloadingPdfId(visit.invoice_id);
    setPortalError('');
    setPortalNotice('');
    try {
      const full = await fetchReportDetail(visit.invoice_id, true);
      if (!full) return;

      const selectedTests =
        focusTestId && full.tests.some((t) => t.id === focusTestId)
          ? full.tests.filter((t) => t.id === focusTestId)
          : full.tests;

      if (selectedTests.length === 0) {
        setPortalError('No diagnostic tests found on this invoice.');
        return;
      }

      const combinedSpecimens = Array.from(
        new Set(selectedTests.map((t) => t.sample_type).filter(Boolean))
      ).join(', ');
      const primaryCollectedAt =
        selectedTests
          .map((t) => t.collected_at)
          .filter(Boolean)
          .sort()[0] || full.invoice.created_at;
      const primaryReportedAt =
        selectedTests
          .map((t) => t.ready_at || t.verified_at || '')
          .filter(Boolean)
          .sort()
          .slice(-1)[0] || new Date().toISOString();

      const portalWebsiteUrl = resolvePublicBaseUrl(publicBaseUrl);
      let qrDataUrl: string | undefined;
      if (full.invoice.patient_qr_token && full.invoice.id) {
        try {
          const qrUrl = buildPatientReportQrUrl(
            full.invoice.patient_qr_token,
            full.invoice.patient_uid,
            full.invoice.id,
            selectedTests.length === 1 ? selectedTests[0]?.id : undefined,
            publicBaseUrl
          );
          qrDataUrl = await QRCode.toDataURL(qrUrl, {
            width: 160,
            margin: 1,
            errorCorrectionLevel: 'M',
            color: { dark: '#000000', light: '#ffffff' },
          });
        } catch {
          qrDataUrl = undefined;
        }
      }

      const signatures = resolveReportSignatures({
        selectedTests,
        invoice: full.invoice,
        settings,
        blankConsultantOverride: false,
      });

      const savedName = exportDiagnosticReportPdf({
        invoice: full.invoice,
        selectedTests,
        settings,
        portalMode: true,
        topMarginIn: Number(settings.pad_header_margin_in || 1.5) || 1.5,
        bottomMarginIn: Number(settings.pad_footer_margin_in || 0.4) || 0.4,
        combinedSpecimens,
        primaryCollectedAt,
        primaryReportedAt,
        portalWebsiteUrl,
        qrDataUrl,
        signatures,
      });
      setPortalNotice(`Downloaded ${savedName}`);
    } catch (err) {
      setPortalError(err instanceof Error ? err.message : 'Failed to generate PDF.');
    } finally {
      setDownloadingPdfId(null);
    }
  };

  const patients = dashboard?.patients || [];

  const filteredPatients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return patients.filter((p) => {
      const isReady = p.total_tests > 0 && p.ready_tests === p.total_tests;
      if (filterTab === 'ready' && !isReady) return false;
      if (filterTab === 'pending' && isReady) return false;
      if (!q) return true;
      return (
        p.patient_name.toLowerCase().includes(q) ||
        p.patient_uid.toLowerCase().includes(q) ||
        p.invoice_no.toLowerCase().includes(q) ||
        (p.patient_mobile || '').toLowerCase().includes(q) ||
        p.tests.some((t) => t.test_name.toLowerCase().includes(q))
      );
    });
  }, [patients, searchQuery, filterTab]);

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-sm text-slate-600">Restoring doctor session...</div>
      </div>
    );
  }

  // ============================================================================
  // MOBILE-FIRST DOCTOR PORTAL LOGIN SCREEN
  // ============================================================================
  if (mode === 'login' || !dashboard) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-between p-4 sm:p-6">
        <header className="max-w-md w-full mx-auto pt-1 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={onBackToHome}
            className="inline-flex items-center gap-1.5 min-h-[44px] text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Portal Home
          </button>
          <span className="text-xs font-semibold text-teal-800 whitespace-nowrap">Doctor Portal</span>
        </header>

        <main className="w-full max-w-md mx-auto my-6 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="bg-slate-900 text-white px-6 py-6">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-teal-600 text-white flex items-center justify-center shrink-0">
                <Stethoscope className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-lg font-bold tracking-tight leading-snug truncate">
                  {settings.lab_name}
                </h1>
                <p className="text-xs text-slate-300 mt-0.5 truncate">{settings.lab_address}</p>
              </div>
            </div>
            <div className="mt-5 pt-4 border-t border-slate-800">
              <h2 className="text-base font-semibold text-white">Referring Doctor Sign In</h2>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                Referring physician portal for live patient report, for transparent billing and instant PDF report download.
              </p>
            </div>
          </div>

          <form onSubmit={handleLogin} className="p-6 space-y-4">
            <div>
              <label htmlFor="doctor-username" className="block text-xs font-semibold text-slate-800 mb-1.5">
                Doctor Username
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  id="doctor-username"
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter admin-provided username"
                  className="w-full min-h-[44px] pl-10 pr-4 py-2.5 text-sm font-mono border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-600"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="doctor-password" className="block text-xs font-semibold text-slate-800 mb-1.5">
                Password
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  id="doctor-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full min-h-[44px] pl-10 pr-11 py-2.5 text-sm font-mono border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-600"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 min-w-[38px] min-h-[38px] flex items-center justify-center text-slate-500 hover:text-slate-800"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2.5 py-1 cursor-pointer select-none text-xs text-slate-700">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="w-4 h-4 accent-teal-600 rounded"
              />
              <span>Keep me logged in on this device (30 days)</span>
            </label>

            {loginError && (
              <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-xl">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full min-h-[46px] py-2.5 px-4 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 disabled:opacity-60 transition-colors whitespace-nowrap"
            >
              {loginLoading ? 'Signing in...' : 'Sign In to Doctor Portal'}
            </button>

            <div className="pt-3 border-t border-slate-200 text-[11px] text-slate-500 space-y-1">
              <div className="flex items-center gap-1.5 text-slate-700 font-medium">
                <ShieldCheck className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                <span>Private Referring Doctor Access</span>
              </div>
              <p className="leading-relaxed">
                Credentials are issued by the {settings.lab_name} administrator. Only patients referred under your name are visible here.
              </p>
            </div>
          </form>
        </main>

        <footer className="max-w-md w-full mx-auto text-center text-[11px] text-slate-500 pb-2">
          Lab Desk: <span className="font-mono tabular-nums font-medium text-slate-700">{settings.lab_phone}</span>
        </footer>
      </div>
    );
  }

  const { doctor, summary } = dashboard;

  // ============================================================================
  // MOBILE-FRIENDLY AUTHENTICATED DOCTOR PORTAL DASHBOARD
  // ============================================================================
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col print:block print:min-h-0 print:h-auto print:bg-white">
      {/* Compact Sticky Top Bar (<= 56px, well within mobile sticky height budget) */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur-md border-b border-slate-200 px-4 sm:px-6 h-14 flex items-center no-print">
        <div className="max-w-6xl w-full mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-slate-900 text-teal-400 flex items-center justify-center shrink-0">
              <Stethoscope className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold text-slate-900 truncate">{doctor.name}</div>
              <div className="text-[11px] text-slate-500 truncate">{settings.lab_name}</div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => loadDashboard(true)}
              disabled={refreshing}
              className="inline-flex items-center justify-center gap-1.5 min-h-[40px] px-3 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
              title="Refresh referrals and reports"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{refreshing ? 'Syncing...' : 'Refresh'}</span>
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center justify-center gap-1.5 min-h-[40px] px-3 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      <main
        className={`flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-5 ${
          printReportData ? 'no-print' : ''
        }`}
      >
        {/* Doctor Profile & 1-Month Window Strip */}
        <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="text-xs font-semibold text-teal-700">Referring Physician Portal</div>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 truncate">{doctor.name}</h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600">
              {doctor.degree && <span>{doctor.degree}</span>}
              {doctor.degree && doctor.hospital && <span aria-hidden="true">·</span>}
              {doctor.hospital && <span>{doctor.hospital}</span>}
              {(doctor.degree || doctor.hospital) && doctor.mobile && <span aria-hidden="true">·</span>}
              {doctor.mobile && <span className="font-mono tabular-nums">{doctor.mobile}</span>}
            </div>
          </div>

          <div className="sm:text-right text-xs text-slate-600 space-y-0.5 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100">
            <div className="font-mono tabular-nums font-medium text-slate-800">
              Last 1 Month: {dashboard.from} to {dashboard.to}
            </div>
            <div className="text-[11px] text-slate-500">
              {lastSyncedAt ? `Synced ${lastSyncedAt}` : 'Live sync active'}
              {doctor.last_commission_paid_up_to ? (
                <>
                  {' '}
                  <span aria-hidden="true">·</span> Settled up to{' '}
                  <span className="font-mono tabular-nums font-medium text-slate-700">
                    {doctor.last_commission_paid_up_to}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        </section>

        {/* 4-Metric Financial & Referral Summary */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <div className="text-[11px] font-medium text-slate-500">Referred Patients (30d)</div>
            <div className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
              {summary.totalPatients}
            </div>
            <div className="text-[11px] text-slate-600 mt-1">
              {summary.readyReportsCount} Ready <span aria-hidden="true">·</span> {summary.pendingReportsCount} Pending
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <div className="text-[11px] font-medium text-slate-500">Total Charged (Net)</div>
            <div className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
              {formatBDT(summary.totalNetCharged)}
            </div>
            <div className="text-[11px] font-mono tabular-nums text-slate-500 mt-1">
              Gross: {formatBDT(summary.totalChargedGross)}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <div className="text-[11px] font-medium text-slate-500">Discount Given</div>
            <div className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-amber-700 mt-1">
              {formatBDT(summary.totalDiscount)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">Across last 30 days</div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <div className="text-[11px] font-medium text-slate-500">Doctor Commission</div>
            <div className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-teal-700 mt-1">
              {formatBDT(summary.totalCommission)}
            </div>
            <div className="text-[11px] font-mono tabular-nums text-slate-600 mt-1">
              Payable: {formatBDT(summary.unpaidCommission)} <span aria-hidden="true">·</span> Paid: {formatBDT(summary.paidCommission)}
            </div>
          </div>
        </section>

        {portalError && (
          <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-xl">
            {portalError}
          </div>
        )}
        {portalNotice && (
          <div className="p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl">
            {portalNotice}
          </div>
        )}

        {/* Filter Bar & Search */}
        <section className="space-y-3">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-xl self-start">
              <button
                type="button"
                onClick={() => setFilterTab('all')}
                className={`min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  filterTab === 'all'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All ({patients.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab('ready')}
                className={`min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  filterTab === 'ready'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Reports Ready ({summary.readyReportsCount})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab('pending')}
                className={`min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  filterTab === 'pending'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Pending ({summary.pendingReportsCount})
              </button>
            </div>

            <div className="relative w-full md:w-80">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search patient name, ID, invoice, or test..."
                className="w-full min-h-[44px] pl-10 pr-4 py-2 text-xs sm:text-sm bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          {/* Referred Patients List */}
          {filteredPatients.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-500">
              {patients.length === 0
                ? 'No referred patients recorded in the last 1 month.'
                : 'No referred patients match your current filter.'}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredPatients.map((visit) => {
                const isExpanded = expandedInvoiceId === visit.invoice_id;
                const detail = loadedReports[visit.invoice_id];
                const allReady = visit.total_tests > 0 && visit.ready_tests === visit.total_tests;

                return (
                  <article
                    key={visit.invoice_id}
                    className="bg-white border border-slate-200 rounded-2xl overflow-hidden"
                  >
                    <div className="p-4 sm:p-5 space-y-4">
                      {/* Top Row: Patient Identity & Status */}
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                            <span className="inline-flex items-center gap-1 font-mono tabular-nums font-medium text-slate-700">
                              <Calendar className="w-3.5 h-3.5 text-teal-700" />
                              {formatDateTime(visit.created_at)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums font-semibold text-slate-800">
                              {visit.invoice_no}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">{visit.patient_uid}</span>
                          </div>

                          <h3 className="text-base sm:text-lg font-bold text-slate-900">
                            {visit.patient_name}
                          </h3>

                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600">
                            <span className="tabular-nums">
                              {formatAge(visit.age_years, visit.age_months, visit.age_days)} / {visit.gender}
                            </span>
                            {visit.patient_mobile && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono tabular-nums">{visit.patient_mobile}</span>
                              </>
                            )}
                            <span aria-hidden="true">·</span>
                            <span className={allReady ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-700'}>
                              {visit.ready_tests}/{visit.total_tests} Reports Ready
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
                        </div>

                        {/* Report Actions (Mobile 44px+ Touch Targets) */}
                        <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleToggleInlineView(visit.invoice_id)}
                            disabled={loadingReportId === visit.invoice_id}
                            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 whitespace-nowrap"
                          >
                            {isExpanded ? (
                              <>
                                <ChevronUp className="w-4 h-4" />
                                <span>Hide</span>
                              </>
                            ) : (
                              <>
                                <ChevronDown className="w-4 h-4" />
                                <span>{loadingReportId === visit.invoice_id ? 'Loading...' : 'Results'}</span>
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenPrintPreview(visit.invoice_id)}
                            disabled={loadingReportId === visit.invoice_id}
                            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 py-2 text-xs font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 whitespace-nowrap"
                          >
                            <Printer className="w-4 h-4" />
                            <span>Print</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDirectDownloadPdf(visit)}
                            disabled={downloadingPdfId === visit.invoice_id}
                            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 py-2 text-xs font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 disabled:opacity-60 whitespace-nowrap"
                          >
                            <Download className="w-4 h-4" />
                            <span>{downloadingPdfId === visit.invoice_id ? 'PDF...' : 'PDF'}</span>
                          </button>
                        </div>
                      </div>

                      {/* Ordered Tests Summary Line */}
                      <div className="text-xs sm:text-sm text-slate-700 leading-relaxed">
                        <span className="font-medium text-slate-500">Tests: </span>
                        {visit.tests.map((t, idx) => (
                          <React.Fragment key={t.id}>
                            {idx > 0 && <span className="text-slate-300"> · </span>}
                            <span className="font-medium text-slate-900">{t.test_name}</span>{' '}
                            <span
                              className={`text-[11px] ${
                                t.status === 'Ready'
                                  ? 'text-emerald-700'
                                  : t.status === 'Verified'
                                  ? 'text-teal-700'
                                  : 'text-amber-700'
                              }`}
                            >
                              ({t.status})
                            </span>
                          </React.Fragment>
                        ))}
                      </div>

                      {/* Financial Breakdown: 1. Total Charge, 2. Paid Amount, 3. Discount, 4. Due Amount, 5. My Commission */}
                      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 sm:gap-3 pt-3 border-t border-slate-100 text-xs items-stretch">
                        {/* 1. Total Charge (Gross) */}
                        <div className="flex items-center justify-between sm:flex-col sm:items-start sm:justify-center bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-2">
                          <div>
                            <div className="text-[11px] font-medium text-slate-600">Total Charge</div>
                            <div className="text-[10px] text-slate-400 sm:hidden">Gross bill before discount</div>
                          </div>
                          <div className="text-right sm:text-left">
                            <div className="font-mono tabular-nums font-bold text-slate-900 text-sm sm:mt-0.5">
                              {formatBDT(visit.subtotal)}
                            </div>
                            <div className="hidden sm:block text-[11px] text-slate-500 mt-0.5">
                              Gross bill
                            </div>
                          </div>
                        </div>

                        {/* 2. Paid Amount */}
                        <div className="flex items-center justify-between sm:flex-col sm:items-start sm:justify-center bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-2">
                          <div>
                            <div className="text-[11px] font-medium text-slate-600">Paid Amount</div>
                            <div className="text-[10px] text-slate-400 sm:hidden">
                              {visit.paid_amount > 0 ? 'Patient paid' : 'Not yet paid'}
                            </div>
                          </div>
                          <div className="text-right sm:text-left">
                            <div
                              className={`font-mono tabular-nums font-bold text-sm sm:mt-0.5 ${
                                visit.paid_amount > 0 ? 'text-emerald-700' : 'text-slate-500'
                              }`}
                            >
                              {formatBDT(visit.paid_amount)}
                            </div>
                            <div className="hidden sm:block text-[11px] text-slate-500 mt-0.5">
                              {visit.paid_amount > 0 ? 'Collected' : 'Unpaid'}
                            </div>
                          </div>
                        </div>

                        {/* 3. Discount */}
                        <div className="flex items-center justify-between sm:flex-col sm:items-start sm:justify-center bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-2">
                          <div>
                            <div className="text-[11px] font-medium text-slate-600">Discount</div>
                            <div className="text-[10px] text-slate-400 sm:hidden">
                              {visit.discount_pct > 0 ? `${visit.discount_pct}% off` : 'No discount'}
                            </div>
                          </div>
                          <div className="text-right sm:text-left">
                            <div
                              className={`font-mono tabular-nums font-bold text-sm sm:mt-0.5 ${
                                visit.discount_amount > 0 ? 'text-amber-700' : 'text-slate-500'
                              }`}
                            >
                              {formatBDT(visit.discount_amount)}
                            </div>
                            <div className="hidden sm:block text-[11px] font-mono tabular-nums text-slate-500 mt-0.5">
                              {visit.discount_pct > 0 ? `${visit.discount_pct}% off` : 'No discount'}
                            </div>
                          </div>
                        </div>

                        {/* 4. Due Amount */}
                        <div className="flex items-center justify-between sm:flex-col sm:items-start sm:justify-center bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-2">
                          <div>
                            <div className="text-[11px] font-medium text-slate-600">Due Amount</div>
                            <div className="text-[10px] text-slate-400 sm:hidden">
                              {visit.due_amount > 0 ? 'Remaining balance' : 'No balance due'}
                            </div>
                          </div>
                          <div className="text-right sm:text-left">
                            <div
                              className={`font-mono tabular-nums font-bold text-sm sm:mt-0.5 ${
                                visit.due_amount > 0 ? 'text-rose-700' : 'text-slate-600'
                              }`}
                            >
                              {formatBDT(visit.due_amount)}
                            </div>
                            <div
                              className={`hidden sm:block text-[11px] font-medium mt-0.5 ${
                                visit.due_amount > 0 ? 'text-rose-600' : 'text-slate-500'
                              }`}
                            >
                              {visit.due_amount > 0 ? 'Balance due' : 'Fully settled'}
                            </div>
                          </div>
                        </div>

                        {/* 5. My Commission */}
                        <div className="flex items-center justify-between sm:flex-col sm:items-start sm:justify-center bg-teal-50/80 border border-teal-200 rounded-xl px-3 py-2">
                          <div>
                            <div className="text-[11px] font-semibold text-teal-900">My Commission</div>
                            <div
                              className={`text-[10px] font-medium sm:hidden ${
                                visit.is_commission_paid ? 'text-emerald-700' : 'text-amber-700'
                              }`}
                            >
                              {visit.is_commission_paid ? 'Settled / Paid' : 'Payable'}
                            </div>
                          </div>
                          <div className="text-right sm:text-left">
                            <div className="font-mono tabular-nums font-extrabold text-teal-800 text-sm sm:mt-0.5">
                              {formatBDT(visit.commission_amount)}
                            </div>
                            <div
                              className={`hidden sm:block text-[11px] font-medium mt-0.5 ${
                                visit.is_commission_paid ? 'text-emerald-700' : 'text-amber-700'
                              }`}
                            >
                              {visit.is_commission_paid ? 'Settled / Paid' : 'Payable'}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Inline Clinical Parameter Results Panel */}
                    {isExpanded && detail && (
                      <div className="border-t border-slate-200 bg-slate-50/70 p-4 sm:p-5 space-y-4">
                        {detail.tests.map((t) => {
                          const isCbc =
                            t.test_name.toLowerCase().includes('cbc') ||
                            t.test_name.toLowerCase().includes('complete blood count');
                          return (
                            <div key={t.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                              <div className="px-4 py-2.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <div className="text-sm font-semibold text-slate-900">{t.test_name}</div>
                                  <div className="text-[11px] text-slate-500">
                                    {t.category_name} · {t.sample_type}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
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
                                  <button
                                    type="button"
                                    onClick={() => handleOpenPrintPreview(visit.invoice_id, t.id)}
                                    className="inline-flex items-center gap-1 min-h-[36px] px-2.5 py-1 text-[11px] font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap"
                                  >
                                    <Printer className="w-3 h-3" />
                                    Print
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDirectDownloadPdf(visit, t.id)}
                                    className="inline-flex items-center gap-1 min-h-[36px] px-2.5 py-1 text-[11px] font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap"
                                  >
                                    <Download className="w-3 h-3" />
                                    PDF
                                  </button>
                                </div>
                              </div>

                              <div className="overflow-x-auto">
                                <table className="w-full text-xs border-collapse">
                                  <thead>
                                    <tr className="border-b border-slate-200 text-left text-slate-500 bg-slate-50">
                                      <th className="py-2 px-3 font-medium">Parameter</th>
                                      <th className="py-2 px-3 font-medium text-right">Result</th>
                                      <th className="py-2 px-3 font-medium">Unit</th>
                                      <th className="py-2 px-3 font-medium">Reference Range</th>
                                      {!isCbc && <th className="py-2 px-3 font-medium text-center">Indicator</th>}
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
                                              isAbn && !isCbc
                                                ? 'font-bold text-red-700'
                                                : 'font-semibold text-slate-900'
                                            }`}
                                          >
                                            {r.result_value || 'Pending'}
                                          </td>
                                          <td className="py-2 px-3 text-slate-600">{r.unit || '—'}</td>
                                          <td className="py-2 px-3 font-mono tabular-nums text-slate-600 whitespace-pre-line">
                                            {r.normal_text || r.reference_range_text || '—'}
                                          </td>
                                          {!isCbc && (
                                            <td
                                              className={`py-2 px-3 text-center font-semibold ${
                                                isAbn ? 'text-red-700' : 'text-slate-700'
                                              }`}
                                            >
                                              {r.result_value ? (isAbn ? r.flag.toUpperCase() : 'Normal') : '—'}
                                            </td>
                                          )}
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          );
                        })}

                        <div className="flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => handleOpenPrintPreview(visit.invoice_id, null)}
                            className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 whitespace-nowrap"
                          >
                            <FileText className="w-4 h-4" />
                            Open Combined Report &amp; Print
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDirectDownloadPdf(visit, null)}
                            className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 text-xs font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 whitespace-nowrap"
                          >
                            <Download className="w-4 h-4" />
                            Download Combined PDF
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* Doctor Portal Report Print & PDF Modal (Digital Letterhead Mode) */}
      <ReportPrintModal
        data={printReportData}
        focusTestId={printFocusTestId}
        settings={settings}
        publicBaseUrl={publicBaseUrl}
        portalMode={true}
        onClose={() => {
          setPrintReportData(null);
          setPrintFocusTestId(null);
        }}
      />
    </div>
  );
};
