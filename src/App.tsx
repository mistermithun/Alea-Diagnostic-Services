import React, { useCallback, useEffect, useState } from 'react';
import {
  Banknote,
  CreditCard,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  Receipt,
  Scale,
  Settings,
  ShieldCheck,
  Stethoscope,
  TestTube2,
  UserCheck,
  UserPlus,
  Wallet,
  X,
} from 'lucide-react';
import { BalanceLedgerView } from './components/BalanceLedgerView.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { DoctorPayoutView } from './components/DoctorPayoutView.tsx';
import { DoctorPortalView } from './components/DoctorPortalView.tsx';
import { DoctorsView } from './components/DoctorsView.tsx';
import { DueLedgerView } from './components/DueLedgerView.tsx';
import { ExpensesView } from './components/ExpensesView.tsx';
import { LabResultsView } from './components/LabResultsView.tsx';
import { LandingPortalView } from './components/LandingPortalView.tsx';
import { PatientBillingView } from './components/PatientBillingView.tsx';
import { PatientPortalView } from './components/PatientPortalView.tsx';
import { QrDirectReportView } from './components/QrDirectReportView.tsx';
import { ReceiptPrintModal } from './components/ReceiptPrintModal.tsx';
import { ReportPrintModal } from './components/ReportPrintModal.tsx';
import { AdminLoginView, StaffLoginView } from './components/RoleLoginViews.tsx';
import { SettingsBackupView } from './components/SettingsBackupView.tsx';
import { TestCatalogView } from './components/TestCatalogView.tsx';
import {
  apiFetch,
  clearLabTokens,
  doctorApiFetch,
  getAdminToken,
  getDoctorToken,
  getLabToken,
  getPatientToken,
  patientApiFetch,
  resolvePublicBaseUrl,
  setDoctorToken,
  setPatientToken,
} from './lib/api.ts';
import {
  SampleTimerNotificationTray,
  SampleTimerProvider,
  TopBarTimerSummary,
} from './lib/sampleTimers.tsx';
import type { FullInvoice, LabSettings, NavTab, SystemInfo } from './types.ts';

type AppRoute =
  | 'landing'
  | 'admin-login'
  | 'staff-login'
  | 'patient-login'
  | 'doctor-login'
  | 'admin-dashboard'
  | 'staff-dashboard'
  | 'patient-dashboard'
  | 'doctor-dashboard'
  | 'qr-report';

type LabAuthStatus = 'checking' | 'unauthenticated' | 'admin' | 'staff';
type PatientAuthStatus = 'checking' | 'unauthenticated' | 'authenticated';
type DoctorAuthStatus = 'checking' | 'unauthenticated' | 'authenticated';

const DEFAULT_SETTINGS: LabSettings = {
  lab_name: 'Alea Diagnostic Services',
  lab_address: 'Bank Mor, Halasa Bazar, Mirpur, Kushtia',
  proprietor_name: 'Md. Mishkatur Rahman',
  lab_phone: '+88 01720 660 824',
  max_staff_discount_pct: '100',
  technologist_name: 'Md. Mishkatur Rahman, B.Sc (MLT)',
  technologist_title: 'Medical Technologist (Lab)',
  pathologist_name: 'Dr. Farhana Yasmin, MBBS, M.Phil',
  pathologist_title: 'Consultant Pathologist',
  pad_header_margin_in: '2',
  pad_footer_margin_in: '1',
};

interface NavItem {
  id: NavTab;
  label: string;
  adminOnly: boolean;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Analytics & Overview', adminOnly: false, icon: LayoutDashboard },
  { id: 'billing', label: 'Patient & Billing', adminOnly: false, icon: Receipt },
  { id: 'lab', label: 'Lab Result Entry', adminOnly: false, icon: FlaskConical },
  { id: 'dues', label: 'Due Collection', adminOnly: false, icon: CreditCard },
  { id: 'catalog', label: 'Test Catalog', adminOnly: true, icon: TestTube2 },
  { id: 'doctors', label: 'Referral Doctors', adminOnly: true, icon: Stethoscope },
  { id: 'payouts', label: 'Commission Payout', adminOnly: true, icon: Banknote },
  { id: 'expenses', label: 'Expense Tracker', adminOnly: true, icon: Wallet },
  { id: 'balance', label: 'Balance', adminOnly: true, icon: Scale },
  { id: 'settings', label: 'Settings & Backup', adminOnly: true, icon: Settings },
];

function parseRouteSegment(segment: string): AppRoute {
  const cleanSegment = segment.split('?')[0];
  const s = cleanSegment.toLowerCase().replace(/^\/+|\/+$/g, '');
  if (s === 'admin-login') return 'admin-login';
  if (s === 'staff-login') return 'staff-login';
  if (s === 'patient-login' || s === 'portal' || s === 'patient-portal') return 'patient-login';
  if (s === 'doctor-login' || s === 'doctor-portal') return 'doctor-login';
  if (s === 'admin' || s.startsWith('admin/')) return 'admin-dashboard';
  if (s === 'staff' || s.startsWith('staff/')) return 'staff-dashboard';
  if (s === 'patient-dashboard' || s.startsWith('patient-dashboard/')) return 'patient-dashboard';
  if (s === 'doctor-dashboard' || s === 'doctor' || s.startsWith('doctor-dashboard/')) return 'doctor-dashboard';
  if (s === 'view-report' || s === 'report' || s === 'r') return 'qr-report';
  return 'landing';
}

function getQrParamsFromLocation(): { id?: string; qr: string; inv?: number; test?: number } {
  if (typeof window === 'undefined') return { qr: '' };
  let search = window.location.search;
  if (!search && window.location.hash.includes('?')) {
    search = '?' + window.location.hash.split('?')[1];
  }
  const params = new URLSearchParams(search);
  const id = (params.get('id') || '').trim() || undefined;
  const qr = (params.get('token') || params.get('qr') || '').trim();
  const invRaw = Number(params.get('inv') || 0);
  const testRaw = Number(params.get('test') || 0);
  return {
    id,
    qr,
    inv: Number.isFinite(invRaw) && invRaw > 0 ? invRaw : undefined,
    test: Number.isFinite(testRaw) && testRaw > 0 ? testRaw : undefined,
  };
}

function isHashRoutingMode(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.hostname.endsWith('github.io') || window.location.protocol === 'file:') {
    return true;
  }
  const cleanPath = window.location.pathname.toLowerCase().replace(/\/+$/, '') || '/';
  if (cleanPath === '/' || parseRouteSegment(cleanPath) !== 'landing') {
    return false;
  }
  return true;
}

function resolveRouteFromLocation(): AppRoute {
  if (typeof window === 'undefined') return 'landing';
  if (getQrParamsFromLocation().qr) return 'qr-report';
  const hashClean = window.location.hash.replace(/^#/, '').trim();
  if (hashClean) {
    return parseRouteSegment(hashClean);
  }
  const p = window.location.pathname.toLowerCase().replace(/\/+$/, '') || '/';
  const direct = parseRouteSegment(p);
  if (direct !== 'landing') return direct;
  const suffixMatch = p.match(
    /\/(admin-login|staff-login|patient-login|doctor-login|doctor-portal|portal|patient-portal|admin|staff|patient-dashboard|doctor-dashboard|doctor|view-report|report)$/
  );
  if (suffixMatch) return parseRouteSegment(suffixMatch[1]);
  return 'landing';
}

function pathForRoute(route: AppRoute): string {
  switch (route) {
    case 'admin-login':
      return '/admin-login';
    case 'staff-login':
      return '/staff-login';
    case 'patient-login':
      return '/patient-login';
    case 'doctor-login':
      return '/doctor-login';
    case 'admin-dashboard':
      return '/admin';
    case 'staff-dashboard':
      return '/staff';
    case 'patient-dashboard':
      return '/patient-dashboard';
    case 'doctor-dashboard':
      return '/doctor-dashboard';
    case 'qr-report':
      return '/view-report';
    default:
      return '/';
  }
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>(resolveRouteFromLocation);
  const [labAuthStatus, setLabAuthStatus] = useState<LabAuthStatus>(() =>
    getLabToken() ? 'checking' : 'unauthenticated'
  );
  const [labOperatorName, setLabOperatorName] = useState('');
  const [patientAuthStatus, setPatientAuthStatus] = useState<PatientAuthStatus>(() =>
    getPatientToken() ? 'checking' : 'unauthenticated'
  );
  const [doctorAuthStatus, setDoctorAuthStatus] = useState<DoctorAuthStatus>(() =>
    getDoctorToken() ? 'checking' : 'unauthenticated'
  );

  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [selectedPayoutDoctorId, setSelectedPayoutDoctorId] = useState<number | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [systemInfo, setSystemInfo] = useState<SystemInfo>({
    settings: DEFAULT_SETTINGS,
    port: 3000,
    lanUrls: [],
    serverDate: '',
    publicBaseUrl: resolvePublicBaseUrl(),
  });

  const [receiptModalData, setReceiptModalData] = useState<FullInvoice | null>(null);
  const [reportModalData, setReportModalData] = useState<{ data: FullInvoice; focusTestId?: number } | null>(null);
  const [labTargetPatient, setLabTargetPatient] = useState<{
    invoiceId: number;
    testName?: string;
    nonce: number;
  } | null>(null);

  const handleOpenLabForPatient = useCallback((invoiceId: number, testName?: string) => {
    setLabTargetPatient({ invoiceId, testName, nonce: Date.now() });
    setActiveTab('lab');
  }, []);

  const navigateTo = useCallback((nextRoute: AppRoute, replace = false) => {
    const targetPath = pathForRoute(nextRoute);
    if (typeof window !== 'undefined') {
      if (isHashRoutingMode()) {
        const targetHash = nextRoute === 'landing' ? '#/' : `#${targetPath}`;
        const nextUrl = `${window.location.pathname}${window.location.search}${targetHash}`;
        if (window.location.hash !== targetHash) {
          if (replace) {
            window.history.replaceState({}, '', nextUrl);
          } else {
            window.history.pushState({}, '', nextUrl);
          }
        }
      } else if (window.location.pathname !== targetPath) {
        if (replace) {
          window.history.replaceState({}, '', targetPath);
        } else {
          window.history.pushState({}, '', targetPath);
        }
      }
    }
    setRoute(nextRoute);
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const info = await apiFetch<SystemInfo>('/api/system/info');
      setSystemInfo(info);
    } catch {
      // keep fallback settings
    }

    if (getLabToken()) {
      try {
        const verify = await apiFetch<{
          authenticated: boolean;
          isAdmin: boolean;
          role: 'admin' | 'staff' | null;
          name: string;
        }>('/api/auth/verify');
        if (verify.authenticated && verify.role === 'admin') {
          setLabAuthStatus('admin');
          setLabOperatorName(verify.name || DEFAULT_SETTINGS.proprietor_name);
        } else if (verify.authenticated && verify.role === 'staff') {
          setLabAuthStatus('staff');
          setLabOperatorName(verify.name || 'Reception & Lab Staff');
        } else {
          clearLabTokens();
          setLabAuthStatus('unauthenticated');
          setLabOperatorName('');
        }
      } catch {
        clearLabTokens();
        setLabAuthStatus('unauthenticated');
        setLabOperatorName('');
      }
    } else {
      setLabAuthStatus('unauthenticated');
    }

    if (getPatientToken()) {
      try {
        const pVerify = await patientApiFetch<{ authenticated: boolean }>('/api/patient-auth/verify');
        if (pVerify.authenticated) {
          setPatientAuthStatus('authenticated');
        } else {
          setPatientToken(null);
          setPatientAuthStatus('unauthenticated');
        }
      } catch {
        setPatientToken(null);
        setPatientAuthStatus('unauthenticated');
      }
    } else {
      setPatientAuthStatus('unauthenticated');
    }

    if (getDoctorToken()) {
      try {
        const dVerify = await doctorApiFetch<{ authenticated: boolean }>('/api/doctor-auth/verify');
        if (dVerify.authenticated) {
          setDoctorAuthStatus('authenticated');
        } else {
          setDoctorToken(null);
          setDoctorAuthStatus('unauthenticated');
        }
      } catch {
        setDoctorToken(null);
        setDoctorAuthStatus('unauthenticated');
      }
    } else {
      setDoctorAuthStatus('unauthenticated');
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const onLocationChange = () => {
      setRoute(resolveRouteFromLocation());
    };
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
    return () => {
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('hashchange', onLocationChange);
    };
  }, []);

  // Strict Role-Based Route Guards (Instant force-redirect to Landing / on unauthorized URL access)
  useEffect(() => {
    if (route === 'qr-report') {
      return;
    }

    // Unknown URL normalization (preserve subpath/GitHub Pages prefix)
    if (
      typeof window !== 'undefined' &&
      !isHashRoutingMode() &&
      route === 'landing' &&
      window.location.pathname !== '/'
    ) {
      window.history.replaceState({}, '', '/');
    }

    // Protected Admin Route
    if (route === 'admin-dashboard') {
      if (labAuthStatus === 'unauthenticated' || labAuthStatus === 'staff') {
        navigateTo('landing', true);
      }
      return;
    }

    // Protected Staff Route
    if (route === 'staff-dashboard') {
      if (labAuthStatus === 'unauthenticated' || labAuthStatus === 'admin') {
        navigateTo('landing', true);
      }
      return;
    }

    // Protected Patient Route
    if (route === 'patient-dashboard') {
      if (patientAuthStatus === 'unauthenticated') {
        navigateTo('landing', true);
      }
      return;
    }

    // Protected Doctor Route
    if (route === 'doctor-dashboard') {
      if (doctorAuthStatus === 'unauthenticated') {
        navigateTo('doctor-login', true);
      }
      return;
    }

    // Redirect already-authenticated users away from their own login route to their authorized dashboard
    if (route === 'admin-login' && labAuthStatus === 'admin') {
      setActiveTab('dashboard');
      navigateTo('admin-dashboard', true);
      return;
    }
    if (route === 'staff-login' && labAuthStatus === 'staff') {
      setActiveTab('billing');
      navigateTo('staff-dashboard', true);
      return;
    }
    if (route === 'patient-login' && patientAuthStatus === 'authenticated') {
      navigateTo('patient-dashboard', true);
      return;
    }
    if (route === 'doctor-login' && doctorAuthStatus === 'authenticated') {
      navigateTo('doctor-dashboard', true);
    }
  }, [route, labAuthStatus, patientAuthStatus, doctorAuthStatus, navigateTo]);

  // Ensure initial default tab matches role on mount/refresh
  useEffect(() => {
    if (route === 'staff-dashboard' && labAuthStatus === 'staff') {
      const currentMeta = NAV_ITEMS.find((n) => n.id === activeTab);
      if (currentMeta?.adminOnly) {
        setActiveTab('billing');
      }
    }
  }, [route, labAuthStatus, activeTab]);

  const handleAdminAuthenticated = (adminName: string) => {
    setLabAuthStatus('admin');
    setLabOperatorName(adminName);
    setActiveTab('dashboard');
    navigateTo('admin-dashboard');
  };

  const handleStaffAuthenticated = (staffName: string) => {
    setLabAuthStatus('staff');
    setLabOperatorName(staffName);
    setActiveTab('billing');
    navigateTo('staff-dashboard');
  };

  const handleLabSignOut = () => {
    clearLabTokens();
    setLabAuthStatus('unauthenticated');
    setLabOperatorName('');
    setReceiptModalData(null);
    setReportModalData(null);
    setMobileMenuOpen(false);
    navigateTo('landing');
  };

  const handlePatientAuthenticated = () => {
    setPatientAuthStatus('authenticated');
    navigateTo('patient-dashboard');
  };

  const handlePatientSignedOut = useCallback(() => {
    setPatientToken(null);
    setPatientAuthStatus('unauthenticated');
    navigateTo('landing', true);
  }, [navigateTo]);

  const handleDoctorAuthenticated = () => {
    setDoctorAuthStatus('authenticated');
    navigateTo('doctor-dashboard');
  };

  const handleDoctorSignedOut = useCallback(() => {
    setDoctorToken(null);
    setDoctorAuthStatus('unauthenticated');
    navigateTo('doctor-login', true);
  }, [navigateTo]);

  const handleOpenReceipt = async (invoiceId: number) => {
    try {
      const full = await apiFetch<FullInvoice>(`/api/invoices/${invoiceId}`);
      setReceiptModalData(full);
    } catch {
      // ignore
    }
  };

  const handleOpenReport = async (invoiceId: number, focusTestId?: number) => {
    try {
      const full = await apiFetch<FullInvoice>(`/api/invoices/${invoiceId}`);
      setReportModalData({ data: full, focusTestId });
    } catch {
      // ignore
    }
  };

  const settings = systemInfo.settings;

  // 1. Dedicated Landing Page (/)
  if (route === 'landing') {
    return (
      <LandingPortalView
        settings={settings}
        onSelectAdminLogin={() => {
          if (labAuthStatus === 'admin') {
            setActiveTab('dashboard');
            navigateTo('admin-dashboard');
          } else {
            navigateTo('admin-login');
          }
        }}
        onSelectStaffLogin={() => {
          if (labAuthStatus === 'staff') {
            setActiveTab('billing');
            navigateTo('staff-dashboard');
          } else {
            navigateTo('staff-login');
          }
        }}
        onSelectPatientLogin={() => {
          if (patientAuthStatus === 'authenticated') {
            navigateTo('patient-dashboard');
          } else {
            navigateTo('patient-login');
          }
        }}
        onSelectDoctorLogin={() => {
          if (doctorAuthStatus === 'authenticated') {
            navigateTo('doctor-dashboard');
          } else {
            navigateTo('doctor-login');
          }
        }}
      />
    );
  }

  // 2. Separate Authentication Screens
  if (route === 'admin-login') {
    if (labAuthStatus === 'checking') {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-sm text-slate-600">
          Checking administrator session...
        </div>
      );
    }
    return (
      <AdminLoginView
        settings={settings}
        onAuthenticated={handleAdminAuthenticated}
        onBackToHome={() => navigateTo('landing')}
      />
    );
  }

  if (route === 'staff-login') {
    if (labAuthStatus === 'checking') {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-sm text-slate-600">
          Checking staff session...
        </div>
      );
    }
    return (
      <StaffLoginView
        settings={settings}
        onAuthenticated={handleStaffAuthenticated}
        onBackToHome={() => navigateTo('landing')}
      />
    );
  }

  if (route === 'patient-login') {
    if (patientAuthStatus === 'checking') {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-sm text-slate-600">
          Checking patient session...
        </div>
      );
    }
    return (
      <PatientPortalView
        settings={settings}
        publicBaseUrl={systemInfo.publicBaseUrl}
        mode="login"
        onAuthenticated={handlePatientAuthenticated}
        onSignedOut={handlePatientSignedOut}
        onBackToHome={() => navigateTo('landing')}
      />
    );
  }

  if (route === 'doctor-login') {
    if (doctorAuthStatus === 'checking') {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-sm text-slate-600">
          Checking doctor session...
        </div>
      );
    }
    return (
      <DoctorPortalView
        settings={settings}
        publicBaseUrl={systemInfo.publicBaseUrl}
        mode="login"
        onAuthenticated={handleDoctorAuthenticated}
        onSignedOut={handleDoctorSignedOut}
        onBackToHome={() => navigateTo('landing')}
      />
    );
  }

  // 2.5. Direct Passwordless QR Report Access (/view-report?id=...&token=...)
  if (route === 'qr-report') {
    const qrParams = getQrParamsFromLocation();
    return (
      <QrDirectReportView
        settings={settings}
        publicBaseUrl={systemInfo.publicBaseUrl}
        patientIdParam={qrParams.id}
        qrToken={qrParams.qr}
        invoiceId={qrParams.inv}
        testId={qrParams.test}
        onQrAuthenticated={() => setPatientAuthStatus('authenticated')}
        onOpenFullArchive={() => navigateTo('patient-dashboard')}
        onGoToManualLogin={() => navigateTo('patient-login')}
        onBackToHome={() => navigateTo('landing')}
      />
    );
  }

  // 3. Protected Patient Dashboard (/patient-dashboard)
  if (route === 'patient-dashboard') {
    if (patientAuthStatus === 'checking') {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-sm text-slate-600">
          Verifying patient authorization...
        </div>
      );
    }
    if (patientAuthStatus !== 'authenticated') {
      return (
        <LandingPortalView
          settings={settings}
          onSelectAdminLogin={() => navigateTo('admin-login')}
          onSelectStaffLogin={() => navigateTo('staff-login')}
          onSelectPatientLogin={() => navigateTo('patient-login')}
          onSelectDoctorLogin={() => navigateTo('doctor-login')}
        />
      );
    }
    return (
      <PatientPortalView
        settings={settings}
        publicBaseUrl={systemInfo.publicBaseUrl}
        mode="dashboard"
        onAuthenticated={handlePatientAuthenticated}
        onSignedOut={handlePatientSignedOut}
        onBackToHome={() => navigateTo('landing')}
      />
    );
  }

  // 3.5. Protected Doctor Portal Dashboard (/doctor-dashboard)
  if (route === 'doctor-dashboard') {
    if (doctorAuthStatus === 'checking') {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-sm text-slate-600">
          Verifying doctor authorization...
        </div>
      );
    }
    if (doctorAuthStatus !== 'authenticated') {
      return (
        <LandingPortalView
          settings={settings}
          onSelectAdminLogin={() => navigateTo('admin-login')}
          onSelectStaffLogin={() => navigateTo('staff-login')}
          onSelectPatientLogin={() => navigateTo('patient-login')}
          onSelectDoctorLogin={() => navigateTo('doctor-login')}
        />
      );
    }
    return (
      <DoctorPortalView
        settings={settings}
        publicBaseUrl={systemInfo.publicBaseUrl}
        mode="dashboard"
        onAuthenticated={handleDoctorAuthenticated}
        onSignedOut={handleDoctorSignedOut}
        onBackToHome={() => navigateTo('landing')}
      />
    );
  }

  // 4. Protected Admin (/admin) or Staff (/staff) Dashboards
  const requiresAdmin = route === 'admin-dashboard';
  const isAuthorizedForRoute =
    (requiresAdmin && labAuthStatus === 'admin') ||
    (!requiresAdmin && labAuthStatus === 'staff');

  if (labAuthStatus === 'checking') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-sm text-slate-600">
        Verifying session permissions...
      </div>
    );
  }

  if (!isAuthorizedForRoute) {
    return (
      <LandingPortalView
        settings={settings}
        onSelectAdminLogin={() => navigateTo('admin-login')}
        onSelectStaffLogin={() => navigateTo('staff-login')}
        onSelectPatientLogin={() => navigateTo('patient-login')}
        onSelectDoctorLogin={() => navigateTo('doctor-login')}
      />
    );
  }

  const isAdmin = labAuthStatus === 'admin';
  const visibleNavItems = isAdmin
    ? NAV_ITEMS
    : NAV_ITEMS.filter((item) => !item.adminOnly);

  const staffOrAdminNavLabel = (item: NavItem) => {
    if (!isAdmin && item.id === 'dashboard') return 'Operations Overview';
    return item.label;
  };

  const activeNavMeta = visibleNavItems.find((n) => n.id === activeTab) || visibleNavItems[0];
  const resolvedTab = activeNavMeta.id;

  return (
    <SampleTimerProvider onOpenLabForPatient={handleOpenLabForPatient}>
      <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col lg:flex-row print:block print:min-h-0 print:h-auto print:bg-white">
      {/* Mobile Drawer Backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/50 lg:hidden no-print"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Left Sidebar Navigation (Strictly scoped to Admin or Staff role) */}
      <aside
        className={`fixed lg:sticky top-0 left-0 z-40 h-screen w-64 bg-slate-900 text-slate-100 flex flex-col shrink-0 transition-transform duration-200 lg:translate-x-0 no-print ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-5 py-5 border-b border-slate-800 flex items-start justify-between gap-2">
          <div>
            <div className="text-base font-bold text-white tracking-tight leading-snug">
              {settings.lab_name}
            </div>
            <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">
              {settings.lab_address}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="lg:hidden text-slate-400 hover:text-white p-1"
            aria-label="Close navigation"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          <div className="px-3 pb-1.5 text-[11px] font-medium text-slate-400">
            Reception &amp; Lab
          </div>
          {visibleNavItems
            .filter((i) => !i.adminOnly)
            .map((item) => {
              const Icon = item.icon;
              const active = resolvedTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setActiveTab(item.id);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-teal-600 text-white'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{staffOrAdminNavLabel(item)}</span>
                </button>
              );
            })}

          {isAdmin && (
            <>
              <div className="px-3 pt-5 pb-1.5 text-[11px] font-medium text-slate-400">
                Admin Control
              </div>
              {visibleNavItems
                .filter((i) => i.adminOnly)
                .map((item) => {
                  const Icon = item.icon;
                  const active = resolvedTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setMobileMenuOpen(false);
                        setActiveTab(item.id);
                      }}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-teal-600 text-white'
                          : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
            </>
          )}
        </nav>

        {/* Bottom Role Identity & Sign Out */}
        <div className="p-4 border-t border-slate-800 space-y-3 text-xs">
          <div>
            <div className="text-slate-400">
              {isAdmin ? 'Administrator' : 'Staff Session'}
            </div>
            <div className="font-semibold text-white truncate">
              {labOperatorName || (isAdmin ? settings.proprietor_name : 'Reception & Lab Desk')}
            </div>
            <div className="font-mono text-slate-400 tabular-nums">{settings.lab_phone}</div>
          </div>

          <button
            type="button"
            onClick={handleLabSignOut}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg font-semibold bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className={`flex-1 flex flex-col min-w-0 ${receiptModalData || reportModalData ? 'no-print' : ''}`}>
        {/* Top Bar Contract */}
        <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-700 hover:bg-slate-100 rounded-lg"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm truncate">
              <span className="font-semibold text-slate-900 whitespace-nowrap">{settings.lab_name}</span>
              <span className="text-slate-300" aria-hidden="true">/</span>
              <span className="text-slate-600 truncate">{staffOrAdminNavLabel(activeNavMeta)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <TopBarTimerSummary />
            <div className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg whitespace-nowrap shrink-0">
              {isAdmin ? (
                <>
                  <ShieldCheck className="w-3.5 h-3.5 text-teal-700" />
                  <span>Admin: {labOperatorName || settings.proprietor_name}</span>
                </>
              ) : (
                <>
                  <UserCheck className="w-3.5 h-3.5 text-teal-700" />
                  <span>Staff: {labOperatorName || 'Reception Desk'}</span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setActiveTab('billing')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap shrink-0"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>New Patient</span>
            </button>
            <button
              type="button"
              onClick={handleLabSignOut}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </header>

        {/* Active Module Viewport */}
        <main
          className={`flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto ${
            resolvedTab === 'payouts' || resolvedTab === 'doctors'
              ? 'print:p-0 print:m-0 print:max-w-none'
              : ''
          } ${
            receiptModalData || reportModalData ? 'no-print' : ''
          }`}
        >
          {resolvedTab === 'dashboard' && (
            <DashboardView
              isAdmin={isAdmin}
              settings={settings}
              onNavigate={setActiveTab}
              onOpenReceipt={handleOpenReceipt}
            />
          )}

          {resolvedTab === 'billing' && (
            <PatientBillingView
              isAdmin={isAdmin}
              settings={settings}
              onOpenReceipt={handleOpenReceipt}
              onOpenReport={(invId) => handleOpenReport(invId)}
            />
          )}

          {resolvedTab === 'lab' && (
            <LabResultsView
              settings={settings}
              targetPatient={labTargetPatient}
              onOpenReport={(invId, testId) => handleOpenReport(invId, testId)}
            />
          )}

          {resolvedTab === 'dues' && (
            <DueLedgerView isAdmin={isAdmin} onOpenReceipt={handleOpenReceipt} />
          )}

          {resolvedTab === 'catalog' && isAdmin && <TestCatalogView />}
          {resolvedTab === 'doctors' && isAdmin && (
            <DoctorsView
              settings={settings}
              onOpenPayout={(docId) => {
                setSelectedPayoutDoctorId(docId);
                setActiveTab('payouts');
              }}
            />
          )}
          {resolvedTab === 'payouts' && isAdmin && (
            <DoctorPayoutView settings={settings} initialDoctorId={selectedPayoutDoctorId} />
          )}
          {resolvedTab === 'expenses' && isAdmin && <ExpensesView />}
          {resolvedTab === 'balance' && isAdmin && (
            <BalanceLedgerView settings={settings} onNavigate={setActiveTab} />
          )}
          {resolvedTab === 'settings' && isAdmin && (
            <SettingsBackupView
              systemInfo={systemInfo}
              onSettingsUpdated={(updated) =>
                setSystemInfo((prev) => ({ ...prev, settings: updated }))
              }
            />
          )}
        </main>
      </div>

      {/* Printable Official Cash Memo / Thermal Receipt */}
      <ReceiptPrintModal
        data={receiptModalData}
        settings={settings}
        publicBaseUrl={systemInfo.publicBaseUrl}
        onClose={() => setReceiptModalData(null)}
      />

      {/* Printable A4 Clinical Pathology Report (Lab Internal Pre-Printed Pad Mode) */}
      <ReportPrintModal
        data={reportModalData?.data || null}
        focusTestId={reportModalData?.focusTestId}
        settings={settings}
        publicBaseUrl={systemInfo.publicBaseUrl}
        portalMode={false}
        onClose={() => setReportModalData(null)}
      />

      <SampleTimerNotificationTray />
    </div>
    </SampleTimerProvider>
  );
}
