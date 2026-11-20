import { useEffect, useState } from 'react';
import type {
  DiagnosticTest,
  Doctor,
  DuePayment,
  ExpenseItem,
  FullInvoice,
  InvoiceSummary,
  InvoiceTestItem,
  LabQueueItem,
  LabSettings,
  OtherRevenueItem,
  PatientProfile,
  SystemInfo,
  TestCategory,
  TestCommissionOverride,
  TestParameter,
  TestResultRow,
} from '../types.ts';
import {
  BANGLADESH_TIMEZONE,
  BANGLADESH_UTC_OFFSET,
  DEFAULT_PUBLIC_BASE_URL,
  evaluateClientFlag,
  getAdminToken,
  getBangladeshNowIso,
  getLabToken,
  getTodayISO,
  parseApiResponse,
  resolveApiUrl,
} from './apiBase.ts';
import { broadcastPatientsUpdated } from './liveSync.ts';
import {
  enqueueSyncMutation,
  getAllExpensesLocal,
  getAllInvoicesLocal,
  getAllLabQueueLocal,
  getAllOtherRevenuesLocal,
  getAllPatientsLocal,
  getApiCache,
  getFullInvoiceLocal,
  getLabTestDetailLocal,
  getSnapshot,
  getSyncQueue,
  idbClearAndPutMany,
  idbDelete,
  idbGetAll,
  idbPut,
  idbPutMany,
  type OfflineEntityType,
  type OfflineQueueItem,
  recordIdRemap,
  removeSyncQueueItem,
  resolveRemappedId,
  saveFullInvoiceLocal,
  saveLabTestDetailLocal,
  setApiCache,
  setSnapshot,
  updateSyncQueueItem,
} from './offlineDb.ts';

export const OFFLINE_SYNCED_EVENT = 'alea-offline-synced';
const TEMP_ID_COUNTER_KEY = 'alea_offline_temp_id_seq';
const AUTH_SESSION_LS_KEY = 'alea_offline_auth_session_v1';

export interface SyncStatusSnapshot {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  failedCount: number;
  lastSyncedAt: number | null;
  lastSyncError: string;
  queueItems: OfflineQueueItem[];
}

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

let statusState: SyncStatusSnapshot = {
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  isSyncing: false,
  pendingCount: 0,
  failedCount: 0,
  lastSyncedAt: null,
  lastSyncError: '',
  queueItems: [],
};

const listeners = new Set<(snapshot: SyncStatusSnapshot) => void>();
let syncLoopPromise: Promise<void> | null = null;
let lastWarmAt = 0;
let warmPromise: Promise<void> | null = null;
let initialized = false;

function emitStatus() {
  const snap: SyncStatusSnapshot = {
    ...statusState,
    queueItems: [...statusState.queueItems],
  };
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      // ignore listener errors
    }
  }
}

async function refreshQueueSnapshot() {
  try {
    const queue = await getSyncQueue();
    const pendingCount = queue.filter((q) => q.status !== 'failed').length;
    const failedCount = queue.filter((q) => q.status === 'failed').length;
    statusState = {
      ...statusState,
      pendingCount,
      failedCount,
      queueItems: queue,
    };
    emitStatus();
  } catch {
    // ignore IDB errors during early boot
  }
}

function setOnlineFlag(online: boolean) {
  if (statusState.isOnline === online) return;
  statusState = { ...statusState, isOnline: online };
  emitStatus();
}

export function getSyncStatusSnapshot(): SyncStatusSnapshot {
  return { ...statusState, queueItems: [...statusState.queueItems] };
}

export function subscribeSyncStatus(listener: (snapshot: SyncStatusSnapshot) => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  listener(getSyncStatusSnapshot());
  return () => {
    listeners.delete(listener);
  };
}

export function useSyncStatus(): SyncStatusSnapshot {
  const [snap, setSnap] = useState<SyncStatusSnapshot>(getSyncStatusSnapshot);
  useEffect(() => subscribeSyncStatus(setSnap), []);
  return snap;
}

function createMutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `off-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function allocateTempId(): number {
  let next = -Math.floor(Date.now() % 1_000_000_000) - 1000;
  try {
    const raw = localStorage.getItem(TEMP_ID_COUNTER_KEY);
    if (raw) {
      const prev = Number(raw);
      if (Number.isFinite(prev) && prev <= -1) {
        next = Math.min(next, prev - 1);
      }
    }
    localStorage.setItem(TEMP_ID_COUNTER_KEY, String(next));
  } catch {
    next = -Math.floor(Date.now()) - Math.floor(Math.random() * 1000);
  }
  return next;
}

function roundCurrency(val: number): number {
  return Math.round(Number(val || 0) * 100) / 100;
}

function resolveParamRangeLabel(
  param: TestParameter,
  gender: string,
  ageYears: number,
  ageMonths = 0,
  ageDays = 0
): string {
  let min = param.min_male ?? null;
  let max = param.max_male ?? null;
  const isNewborn = ageYears === 0 && ageMonths === 0 && ageDays <= 28;
  if (isNewborn && (param.min_newborn != null || param.max_newborn != null)) {
    min = param.min_newborn ?? null;
    max = param.max_newborn ?? null;
  } else if (ageYears < 12 && (param.min_child != null || param.max_child != null)) {
    min = param.min_child ?? null;
    max = param.max_child ?? null;
  } else if (gender.toLowerCase() === 'female' && (param.min_female != null || param.max_female != null)) {
    min = param.min_female ?? null;
    max = param.max_female ?? null;
  }

  if (
    param.normal_text &&
    (param.normal_text.includes('Newborn:') ||
      param.normal_text.includes('Child:') ||
      param.normal_text.includes('\n'))
  ) {
    return param.normal_text;
  }
  if (min !== null && max !== null) return `${min} - ${max}`;
  if (max !== null) return `< ${max}`;
  if (min !== null) return `> ${min}`;
  return param.normal_text || '';
}

function computeOfflineCommission(params: {
  tests: Array<{ test_id: number; price: number }>;
  subtotal: number;
  netTotal: number;
  hasDoctor: boolean;
  doctorCommissionPct: number;
  commissionMode?: 'doctor_default' | 'custom_invoice' | 'custom_per_test';
  commissionType?: 'percent' | 'flat';
  commissionValue?: number;
  testCommissions?: TestCommissionOverride[];
}) {
  const perTestMap = new Map<
    number,
    { commission_type: 'percent' | 'flat'; commission_value: number; commission_amount: number }
  >();

  if (!params.hasDoctor) {
    for (const t of params.tests) {
      perTestMap.set(t.test_id, { commission_type: 'percent', commission_value: 0, commission_amount: 0 });
    }
    return {
      invoiceCommissionType: 'percent' as const,
      invoiceCommissionValue: 0,
      invoiceCommissionPct: 0,
      invoiceCommissionAmount: 0,
      perTestMap,
    };
  }

  const mode = params.commissionMode || 'doctor_default';
  const docDefaultPct = Math.max(0, roundCurrency(params.doctorCommissionPct));

  if (mode === 'custom_per_test') {
    const ovMap = new Map<number, TestCommissionOverride>(
      (params.testCommissions || []).map((tc) => [Number(tc.testId), tc])
    );
    let sumAmt = 0;
    for (const t of params.tests) {
      const ov = ovMap.get(t.test_id);
      const tType: 'percent' | 'flat' = ov?.commissionType === 'flat' ? 'flat' : 'percent';
      const tVal = ov ? Math.max(0, roundCurrency(Number(ov.commissionValue || 0))) : docDefaultPct;
      const testNetShare = params.subtotal > 0 ? (Number(t.price) / params.subtotal) * params.netTotal : 0;
      const tAmt = tType === 'flat' ? tVal : roundCurrency((testNetShare * tVal) / 100);
      sumAmt += tAmt;
      perTestMap.set(t.test_id, {
        commission_type: tType,
        commission_value: tVal,
        commission_amount: tAmt,
      });
    }
    const totalAmt = roundCurrency(sumAmt);
    const effectivePct = params.netTotal > 0 ? roundCurrency((totalAmt / params.netTotal) * 100) : 0;
    return {
      invoiceCommissionType: 'per_test' as const,
      invoiceCommissionValue: totalAmt,
      invoiceCommissionPct: effectivePct,
      invoiceCommissionAmount: totalAmt,
      perTestMap,
    };
  }

  if (mode === 'custom_invoice') {
    const cType: 'percent' | 'flat' = params.commissionType === 'flat' ? 'flat' : 'percent';
    const cVal = Math.max(0, roundCurrency(Number(params.commissionValue || 0)));
    const amt = cType === 'flat' ? cVal : roundCurrency((params.netTotal * cVal) / 100);
    const effectivePct =
      cType === 'percent' ? cVal : params.netTotal > 0 ? roundCurrency((amt / params.netTotal) * 100) : 0;
    for (const t of params.tests) {
      const ratio = params.subtotal > 0 ? Number(t.price) / params.subtotal : 0;
      perTestMap.set(t.test_id, {
        commission_type: cType,
        commission_value: cType === 'flat' ? roundCurrency(amt * ratio) : cVal,
        commission_amount: roundCurrency(amt * ratio),
      });
    }
    return {
      invoiceCommissionType: cType,
      invoiceCommissionValue: cVal,
      invoiceCommissionPct: effectivePct,
      invoiceCommissionAmount: amt,
      perTestMap,
    };
  }

  const amt = roundCurrency((params.netTotal * docDefaultPct) / 100);
  for (const t of params.tests) {
    const testNetShare = params.subtotal > 0 ? (Number(t.price) / params.subtotal) * params.netTotal : 0;
    perTestMap.set(t.test_id, {
      commission_type: 'percent',
      commission_value: docDefaultPct,
      commission_amount: roundCurrency((testNetShare * docDefaultPct) / 100),
    });
  }
  return {
    invoiceCommissionType: 'percent' as const,
    invoiceCommissionValue: docDefaultPct,
    invoiceCommissionPct: docDefaultPct,
    invoiceCommissionAmount: amt,
    perTestMap,
  };
}

function extractDateOnly(ts: string | null | undefined): string {
  const s = (ts || '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return match ? match[1] : '';
}

function isNetworkFailureError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (err instanceof TypeError) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('load failed') ||
    msg.includes('service unavailable') ||
    msg.includes('offline')
  );
}

function isServiceOfflineStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || status === 0;
}

async function rawDirectFetch(
  url: string,
  options: RequestInit = {},
  timeoutMs = 12000
): Promise<Response> {
  const token = getLabToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    controller && timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    return await fetch(resolveApiUrl(url), {
      ...options,
      headers,
      signal: options.signal || controller?.signal,
    });
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

export async function probeServerConnectivity(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    setOnlineFlag(false);
    return false;
  }
  try {
    const res = await fetch(resolveApiUrl('/api/health'), { cache: 'no-store' });
    const ok = res.ok;
    setOnlineFlag(ok);
    if (ok && statusState.pendingCount > 0) {
      void processOfflineQueue();
    }
    return ok;
  } catch {
    setOnlineFlag(false);
    return false;
  }
}

function ensureInitialized() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  void refreshQueueSnapshot();

  window.addEventListener('online', () => {
    void probeServerConnectivity().then((ok) => {
      if (ok) {
        void processOfflineQueue();
      }
    });
  });

  window.addEventListener('offline', () => {
    setOnlineFlag(false);
  });

  // Periodic background probe while offline or while pending mutations wait to sync
  window.setInterval(() => {
    if (!statusState.isOnline || statusState.pendingCount > 0) {
      void probeServerConnectivity();
    }
  }, 12000);
}

// -----------------------------------------------------------------------------
// Online GET Response Mirroring into IndexedDB
// -----------------------------------------------------------------------------
async function upsertPatientsFromInvoices(invoices: InvoiceSummary[]) {
  const patients: PatientProfile[] = [];
  for (const inv of invoices) {
    if (!inv.patient_id || !inv.patient_name) continue;
    patients.push({
      id: inv.patient_id,
      patient_uid: inv.patient_uid,
      name: inv.patient_name,
      age_years: inv.age_years || 0,
      age_months: inv.age_months || 0,
      age_days: inv.age_days || 0,
      gender: inv.gender || 'Male',
      mobile: inv.patient_mobile || '',
      address: inv.patient_address || '',
      created_at: inv.created_at,
    });
  }
  if (patients.length > 0) {
    await idbPutMany('patients', patients);
  }
}

async function mirrorOnlineGetResponse(url: string, data: unknown): Promise<void> {
  try {
    const parsedUrl = new URL(url, window.location.origin);
    const pathname = parsedUrl.pathname;

    if (pathname === '/api/auth/verify') {
      const authObj = data as { authenticated?: boolean; isAdmin?: boolean; role?: string | null; name?: string };
      if (authObj?.authenticated) {
        await setSnapshot('auth_session', { ...authObj, tokenSnapshot: getLabToken() || '' });
        try {
          localStorage.setItem(AUTH_SESSION_LS_KEY, JSON.stringify({ ...authObj, token: getLabToken() || '' }));
        } catch {
          // ignore
        }
      }
      return;
    }

    if (pathname === '/api/system/info') {
      await setSnapshot('system_info', data as SystemInfo);
      return;
    }

    if (pathname === '/api/catalog') {
      const incInactive = parsedUrl.searchParams.get('includeInactive') === '1';
      if (incInactive) {
        await setSnapshot('catalog_all', data);
      } else {
        await setSnapshot('catalog_active', data);
      }
      return;
    }

    if (pathname === '/api/doctors') {
      const hasRange = parsedUrl.searchParams.has('from') || parsedUrl.searchParams.has('to');
      const docs = (data as { doctors?: Doctor[] })?.doctors;
      if (Array.isArray(docs) && !hasRange) {
        await setSnapshot('doctors', docs);
      } else if (Array.isArray(docs)) {
        await setApiCache(`GET:${url}`, data);
      }
      return;
    }

    if (pathname === '/api/invoices') {
      const list = (data as { invoices?: InvoiceSummary[] })?.invoices;
      if (Array.isArray(list)) {
        const isUnfiltered =
          !parsedUrl.searchParams.get('search') &&
          parsedUrl.searchParams.get('dueOnly') !== '1' &&
          parsedUrl.searchParams.get('todayOnly') !== '1' &&
          !parsedUrl.searchParams.get('date');

        if (isUnfiltered && statusState.pendingCount === 0) {
          await idbClearAndPutMany<InvoiceSummary>('invoices', list, (existing) => existing.id < 0);
        } else {
          await idbPutMany('invoices', list);
        }
        await upsertPatientsFromInvoices(list);
      }
      return;
    }

    const invMatch = /^\/api\/invoices\/(-?\d+)$/.exec(pathname);
    if (invMatch) {
      const full = data as FullInvoice;
      if (full?.invoice?.id) {
        await saveFullInvoiceLocal(full);
        await idbPut('invoices', {
          ...full.invoice,
          total_tests: full.tests?.length || 0,
          ready_tests: (full.tests || []).filter((t) => t.status === 'Ready').length,
          test_items: (full.tests || []).map((t) => ({
            id: t.id,
            test_id: t.test_id,
            test_name: t.test_name,
            category_name: t.category_name,
            status: t.status,
            collected_at: t.collected_at,
            price: t.price,
            commission_type: t.commission_type,
            commission_value: t.commission_value,
            commission_amount: t.commission_amount,
          })),
        } satisfies InvoiceSummary);
        await upsertPatientsFromInvoices([full.invoice]);
      }
      return;
    }

    if (pathname === '/api/patients/search') {
      const patients = (data as { patients?: PatientProfile[] })?.patients;
      if (Array.isArray(patients) && patients.length > 0) {
        await idbPutMany('patients', patients);
      }
      return;
    }

    if (pathname === '/api/lab-queue') {
      const queue = (data as { queue?: LabQueueItem[] })?.queue;
      if (Array.isArray(queue)) {
        const isUnfiltered =
          !parsedUrl.searchParams.get('search') &&
          (!parsedUrl.searchParams.get('status') || parsedUrl.searchParams.get('status') === 'All');
        if (isUnfiltered && statusState.pendingCount === 0) {
          await idbClearAndPutMany<LabQueueItem>('labQueue', queue, (existing) => existing.id < 0);
        } else {
          await idbPutMany('labQueue', queue);
        }
      }
      return;
    }

    const labTestMatch = /^\/api\/lab-tests\/(-?\d+)$/.exec(pathname);
    if (labTestMatch) {
      const detail = data as { item?: LabQueueItem; results?: TestResultRow[] };
      if (detail?.item?.id && Array.isArray(detail.results)) {
        await saveLabTestDetailLocal(detail.item, detail.results);
      }
      return;
    }

    if (pathname === '/api/admin/expenses') {
      const expRes = data as { expenses?: ExpenseItem[] };
      if (Array.isArray(expRes?.expenses)) {
        await idbPutMany('expenses', expRes.expenses);
      }
      await setApiCache(`GET:${url}`, data);
      return;
    }

    if (pathname === '/api/admin/balance-ledger') {
      const ledger = data as { expenses?: ExpenseItem[]; otherRevenues?: OtherRevenueItem[] };
      if (Array.isArray(ledger?.expenses)) await idbPutMany('expenses', ledger.expenses);
      if (Array.isArray(ledger?.otherRevenues)) await idbPutMany('otherRevenues', ledger.otherRevenues);
      await setApiCache(`GET:${url}`, data);
      return;
    }

    await setApiCache(`GET:${url}`, data);
  } catch {
    // non-fatal caching error
  }
}

// -----------------------------------------------------------------------------
// Offline GET Serving from IndexedDB Mirrors
// -----------------------------------------------------------------------------
async function buildFullInvoiceFallbackFromLocal(invoiceId: number): Promise<FullInvoice | null> {
  const invoices = await getAllInvoicesLocal();
  const inv = invoices.find((i) => i.id === invoiceId);
  if (!inv) return null;

  const queue = await getAllLabQueueLocal();
  const matchingQueue = queue.filter((q) => q.invoice_id === invoiceId);
  const tests: InvoiceTestItem[] = [];

  for (const qItem of matchingQueue) {
    const detail = await getLabTestDetailLocal(qItem.id);
    tests.push({
      ...qItem,
      results: detail?.results || [],
    });
  }

  return {
    invoice: inv,
    tests,
    duePayments: [],
    adjustments: [],
  };
}

async function serveOfflineGet<T>(url: string): Promise<T> {
  const parsedUrl = new URL(url, window.location.origin);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/auth/verify') {
    const token = getLabToken();
    if (!token) {
      return { authenticated: false, isAdmin: false, role: null, name: '' } as unknown as T;
    }
    const cached = await getSnapshot<{
      authenticated?: boolean;
      isAdmin?: boolean;
      role?: string | null;
      name?: string;
    }>('auth_session');
    if (cached?.authenticated) {
      return {
        authenticated: true,
        isAdmin: Boolean(cached.isAdmin),
        role: cached.role || (cached.isAdmin ? 'admin' : 'staff'),
        name: cached.name || '',
      } as unknown as T;
    }
    try {
      const raw = localStorage.getItem(AUTH_SESSION_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          token?: string;
          authenticated?: boolean;
          isAdmin?: boolean;
          role?: string;
          name?: string;
        };
        if (parsed.authenticated && (!parsed.token || parsed.token === token)) {
          return {
            authenticated: true,
            isAdmin: Boolean(parsed.isAdmin),
            role: parsed.role || (parsed.isAdmin ? 'admin' : 'staff'),
            name: parsed.name || '',
          } as unknown as T;
        }
      }
    } catch {
      // ignore
    }
    const isAdmin = Boolean(getAdminToken());
    return {
      authenticated: true,
      isAdmin,
      role: isAdmin ? 'admin' : 'staff',
      name: isAdmin ? DEFAULT_SETTINGS.proprietor_name : 'Reception & Lab Staff',
    } as unknown as T;
  }

  if (pathname === '/api/system/info') {
    const info = await getSnapshot<SystemInfo>('system_info');
    if (info) return info as unknown as T;
    return {
      settings: DEFAULT_SETTINGS,
      port: 3000,
      lanUrls: [],
      serverDate: getTodayISO(),
      publicBaseUrl: DEFAULT_PUBLIC_BASE_URL,
      storageMode: 'mongodb',
      storageLabel: 'Offline Cache (IndexedDB)',
    } as unknown as T;
  }

  if (pathname === '/api/catalog') {
    const includeInactive = parsedUrl.searchParams.get('includeInactive') === '1';
    const cat =
      (includeInactive ? await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_all') : undefined) ||
      (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_active')) ||
      (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_all'));

    if (!cat) {
      return { categories: [], tests: [] } as unknown as T;
    }
    if (!includeInactive) {
      return {
        categories: cat.categories || [],
        tests: (cat.tests || []).filter((t) => Number(t.is_active ?? 1) === 1),
      } as unknown as T;
    }
    return cat as unknown as T;
  }

  if (pathname === '/api/doctors') {
    const docs = (await getSnapshot<Doctor[]>('doctors')) || [];
    const from = (parsedUrl.searchParams.get('from') || '').trim();
    const to = (parsedUrl.searchParams.get('to') || '').trim();

    if (from || to) {
      const invoices = await getAllInvoicesLocal();
      const rangeMap = new Map<number, { count: number; total: number }>();
      for (const inv of invoices) {
        if (!inv.doctor_id) continue;
        const dStr = extractDateOnly(inv.created_at);
        if (from && dStr < from) continue;
        if (to && dStr > to) continue;
        const cur = rangeMap.get(inv.doctor_id) || { count: 0, total: 0 };
        cur.count += 1;
        cur.total = roundCurrency(cur.total + Number(inv.commission_amount || 0));
        rangeMap.set(inv.doctor_id, cur);
      }
      return {
        doctors: docs.map((d) => {
          const stat = rangeMap.get(d.id);
          return {
            ...d,
            period_referrals_count: stat?.count || 0,
            period_commission_total: stat?.total || 0,
          };
        }),
      } as unknown as T;
    }

    return { doctors: docs } as unknown as T;
  }

  if (pathname === '/api/invoices') {
    const search = (parsedUrl.searchParams.get('search') || '').trim().toLowerCase();
    const dueOnly = parsedUrl.searchParams.get('dueOnly') === '1';
    const todayOnly = parsedUrl.searchParams.get('todayOnly') === '1';
    const dateFilter = (parsedUrl.searchParams.get('date') || '').trim();
    const todayStr = getTodayISO();

    let list = await getAllInvoicesLocal();
    if (dueOnly) {
      list = list.filter((i) => Number(i.due_amount || 0) > 0);
    }
    if (todayOnly) {
      list = list.filter((i) => extractDateOnly(i.created_at) === todayStr);
    } else if (dateFilter) {
      list = list.filter((i) => extractDateOnly(i.created_at) === dateFilter);
    }
    if (search) {
      list = list.filter(
        (i) =>
          (i.invoice_no || '').toLowerCase().includes(search) ||
          (i.patient_uid || '').toLowerCase().includes(search) ||
          (i.patient_name || '').toLowerCase().includes(search) ||
          (i.patient_mobile || '').toLowerCase().includes(search)
      );
    }
    list.sort((a, b) => {
      if (b.id > 0 && a.id > 0) return b.id - a.id;
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
    return { invoices: list.slice(0, 200) } as unknown as T;
  }

  const invMatch = /^\/api\/invoices\/(-?\d+)$/.exec(pathname);
  if (invMatch) {
    const rawId = Number(invMatch[1]);
    const resolvedId = await resolveRemappedId('invoice', rawId);
    const full =
      (await getFullInvoiceLocal(resolvedId)) ||
      (await buildFullInvoiceFallbackFromLocal(resolvedId));
    if (!full) {
      throw new Error('Offline cache does not have full details for this invoice yet.');
    }
    return full as unknown as T;
  }

  if (pathname === '/api/patients/search') {
    const q = (parsedUrl.searchParams.get('q') || '').trim().toLowerCase();
    if (!q) return { patients: [] } as unknown as T;
    const all = await getAllPatientsLocal();
    const matched = all
      .filter(
        (p) =>
          (p.name || '').toLowerCase().includes(q) ||
          (p.patient_uid || '').toLowerCase().includes(q) ||
          (p.mobile || '').toLowerCase().includes(q)
      )
      .slice(0, 20);
    return { patients: matched } as unknown as T;
  }

  if (pathname === '/api/lab-queue') {
    const search = (parsedUrl.searchParams.get('search') || '').trim().toLowerCase();
    const status = (parsedUrl.searchParams.get('status') || '').trim();
    let queue = await getAllLabQueueLocal();
    if (status && status !== 'All') {
      queue =
        status === 'Pending'
          ? queue.filter((q) => q.status !== 'Ready')
          : queue.filter((q) => q.status === status);
    }
    if (search) {
      queue = queue.filter(
        (q) =>
          (q.test_name || '').toLowerCase().includes(search) ||
          (q.invoice_no || '').toLowerCase().includes(search) ||
          (q.patient_uid || '').toLowerCase().includes(search) ||
          (q.patient_name || '').toLowerCase().includes(search)
      );
    }
    const statusOrder: Record<string, number> = {
      'Sample Collected': 1,
      Processing: 2,
      Verified: 3,
      Ready: 4,
    };
    queue.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 4;
      const sb = statusOrder[b.status] ?? 4;
      if (sa !== sb) return sa - sb;
      return String(b.collected_at || '').localeCompare(String(a.collected_at || ''));
    });
    return { queue: queue.slice(0, 200) } as unknown as T;
  }

  const labTestMatch = /^\/api\/lab-tests\/(-?\d+)$/.exec(pathname);
  if (labTestMatch) {
    const rawId = Number(labTestMatch[1]);
    const resolvedId = await resolveRemappedId('invoiceTest', rawId);
    const cachedDetail = await getLabTestDetailLocal(resolvedId);
    if (cachedDetail) {
      return cachedDetail as unknown as T;
    }

    // Fallback: synthesize from labQueue + catalog parameters
    const queue = await getAllLabQueueLocal();
    const qItem = queue.find((q) => q.id === resolvedId);
    if (qItem) {
      const cat =
        (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_all')) ||
        (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_active'));
      const testDef = cat?.tests.find((t) => t.id === qItem.test_id);
      if (testDef) {
        const results: TestResultRow[] = (testDef.parameters || []).map((p, idx) => ({
          id: allocateTempId(),
          invoice_test_id: qItem.id,
          parameter_id: p.id,
          parameter_name: p.name,
          unit: p.unit || '',
          result_value: p.default_value || '',
          reference_range_text: resolveParamRangeLabel(
            p,
            qItem.gender,
            qItem.age_years,
            qItem.age_months,
            qItem.age_days
          ),
          flag: 'Normal',
          sort_order: p.sort_order ?? idx + 1,
          input_type: p.input_type || 'numeric',
          select_options: p.select_options || '',
          abnormal_values: p.abnormal_values || '',
          normal_text: p.normal_text || '',
          min_male: p.min_male ?? null,
          max_male: p.max_male ?? null,
          min_female: p.min_female ?? null,
          max_female: p.max_female ?? null,
          min_child: p.min_child ?? null,
          max_child: p.max_child ?? null,
          min_newborn: p.min_newborn ?? null,
          max_newborn: p.max_newborn ?? null,
        }));
        return { item: qItem, results } as unknown as T;
      }
    }
    throw new Error('This lab test was not cached before going offline.');
  }

  if (pathname === '/api/admin/expenses') {
    const from = parsedUrl.searchParams.get('from') || `${getTodayISO().slice(0, 7)}-01`;
    const to = parsedUrl.searchParams.get('to') || getTodayISO();
    const all = await getAllExpensesLocal();
    const filtered = all
      .filter((e) => e.expense_date >= from && e.expense_date <= to)
      .sort((a, b) => b.expense_date.localeCompare(a.expense_date));
    const total = roundCurrency(filtered.reduce((s, e) => s + Number(e.amount || 0), 0));
    return { from, to, expenses: filtered, total } as unknown as T;
  }

  if (pathname === '/api/staff/overview') {
    const todayStr = getTodayISO();
    const invoices = await getAllInvoicesLocal();
    const queue = await getAllLabQueueLocal();
    const todayPatients = invoices.filter((i) => extractDateOnly(i.created_at) === todayStr).length;
    return {
      todayPatients,
      sampleCollectedCount: queue.filter((q) => q.status === 'Sample Collected').length,
      processingCount: queue.filter((q) => q.status === 'Processing').length,
      verifiedCount: queue.filter((q) => q.status === 'Verified').length,
      pendingTestsCount: queue.filter((q) => q.status !== 'Ready').length,
      readyReportsCount: queue.filter((q) => q.status === 'Ready').length,
      dueInvoicesCount: invoices.filter((i) => Number(i.due_amount || 0) > 0).length,
      recentQueue: queue.slice(0, 30),
    } as unknown as T;
  }

  if (pathname === '/api/admin/dashboard') {
    const cached = await getApiCache<Record<string, unknown>>(`GET:${url}`);
    if (cached) return cached as unknown as T;

    const from = parsedUrl.searchParams.get('from') || getTodayISO();
    const to = parsedUrl.searchParams.get('to') || from;
    const invoices = await getAllInvoicesLocal();
    const expenses = await getAllExpensesLocal();
    const inRange = invoices.filter((i) => {
      const d = extractDateOnly(i.created_at);
      return d >= from && d <= to;
    });
    const expInRange = expenses.filter((e) => e.expense_date >= from && e.expense_date <= to);
    const totalBilled = roundCurrency(inRange.reduce((s, i) => s + Number(i.subtotal || 0), 0));
    const totalDiscount = roundCurrency(inRange.reduce((s, i) => s + Number(i.discount_amount || 0), 0));
    const netRevenue = roundCurrency(inRange.reduce((s, i) => s + Number(i.net_total || 0), 0));
    const netCollection = roundCurrency(inRange.reduce((s, i) => s + Number(i.paid_amount || 0), 0));
    const pendingDueInRange = roundCurrency(inRange.reduce((s, i) => s + Number(i.due_amount || 0), 0));
    const docComm = roundCurrency(inRange.reduce((s, i) => s + Number(i.commission_amount || 0), 0));
    const totalExpenses = roundCurrency(expInRange.reduce((s, e) => s + Number(e.amount || 0), 0));
    return {
      from,
      to,
      metrics: {
        patientsCount: inRange.length,
        totalBilled,
        totalDiscount,
        totalNetBilled: netRevenue,
        netRevenue,
        netCollection,
        dueRecovered: 0,
        pendingDueInRange,
        doctorCommissionPayable: docComm,
        unpaidCommissionInRange: inRange
          .filter((i) => !i.commission_paid)
          .reduce((s, i) => s + Number(i.commission_amount || 0), 0),
        paidCommissionInRange: inRange
          .filter((i) => i.commission_paid)
          .reduce((s, i) => s + Number(i.commission_amount || 0), 0),
        totalExpenses,
        netProfit: roundCurrency(netCollection - totalExpenses),
        pendingReports: inRange.filter((i) => (i.ready_tests || 0) < (i.total_tests || 0)).length,
        readyReportsInRange: inRange.filter((i) => (i.total_tests || 0) > 0 && (i.ready_tests || 0) >= (i.total_tests || 0)).length,
        allTimeDue: roundCurrency(invoices.reduce((s, i) => s + Number(i.due_amount || 0), 0)),
        allTimeDueCount: invoices.filter((i) => Number(i.due_amount || 0) > 0).length,
      },
      departmentBreakdown: [],
      recentInvoices: inRange,
    } as unknown as T;
  }

  const genericCached = await getApiCache<T>(`GET:${url}`);
  if (genericCached !== undefined) {
    return genericCached;
  }

  throw new Error('Offline mode: requested screen data was not cached yet.');
}

// -----------------------------------------------------------------------------
// Offline Mutations (Apply Locally to IndexedDB + Push to Sync Queue)
// -----------------------------------------------------------------------------
function isSyncableLabMutation(url: string, method: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  const path = url.split('?')[0];
  if (path.startsWith('/api/auth/')) return false;
  if (path.startsWith('/api/patient-auth/')) return false;
  if (path.startsWith('/api/doctor-auth/')) return false;
  if (path === '/api/admin/change-password' || path === '/api/admin/change-staff-password') return false;
  return true;
}

async function applyAndQueueOfflineMutation<T>(
  url: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown> | undefined
): Promise<T> {
  const path = url.split('?')[0];
  const nowTs = getBangladeshNowIso();
  const isAdmin = Boolean(getAdminToken());
  const mutationId = createMutationId();

  // 1. POST /api/invoices — Register Patient & Create Invoice Offline
  if (method === 'POST' && path === '/api/invoices') {
    const payload = (body || {}) as {
      existingPatientId?: number | null;
      patient: {
        name: string;
        ageYears: number;
        ageMonths?: number;
        ageDays?: number;
        gender: 'Male' | 'Female' | 'Other';
        mobile?: string;
        address?: string;
      };
      doctorId?: number | null;
      testIds: number[];
      discountType?: 'percent' | 'flat';
      discountValue?: number;
      paidAmount?: number;
      paymentMethod?: string;
      notes?: string;
      commissionMode?: 'doctor_default' | 'custom_invoice' | 'custom_per_test';
      commissionType?: 'percent' | 'flat';
      commissionValue?: number;
      testCommissions?: TestCommissionOverride[];
    };

    const cat =
      (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_all')) ||
      (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_active')) ||
      { categories: [], tests: [] };
    const docs = (await getSnapshot<Doctor[]>('doctors')) || [];

    const selectedTests = payload.testIds
      .map((id) => cat.tests.find((t) => t.id === id))
      .filter((t): t is DiagnosticTest => Boolean(t));

    if (selectedTests.length === 0) {
      throw new Error('Selected tests are not available in local offline cache.');
    }

    const subtotal = roundCurrency(selectedTests.reduce((s, t) => s + Number(t.price || 0), 0));
    const dType = payload.discountType === 'flat' ? 'flat' : 'percent';
    const dVal = Math.max(0, Number(payload.discountValue || 0));
    const discountAmount = Math.min(
      subtotal,
      roundCurrency(dType === 'flat' ? dVal : (subtotal * dVal) / 100)
    );
    const discountPct = subtotal > 0 ? roundCurrency((discountAmount / subtotal) * 100) : 0;
    const netTotal = Math.max(0, roundCurrency(subtotal - discountAmount));
    const paid = Math.min(netTotal, Math.max(0, roundCurrency(Number(payload.paidAmount || 0))));
    const due = Math.max(0, roundCurrency(netTotal - paid));
    const paymentStatus: 'Paid' | 'Partial' | 'Due' =
      due <= 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Due';

    const doc = payload.doctorId ? docs.find((d) => d.id === payload.doctorId) : undefined;
    const comm = computeOfflineCommission({
      tests: selectedTests.map((t) => ({ test_id: t.id, price: Number(t.price || 0) })),
      subtotal,
      netTotal,
      hasDoctor: Boolean(doc),
      doctorCommissionPct: Number(doc?.commission_pct || 0),
      commissionMode: payload.commissionMode,
      commissionType: payload.commissionType,
      commissionValue: payload.commissionValue,
      testCommissions: payload.testCommissions,
    });

    const tempInvId = allocateTempId();
    const shortSeq = String(Math.abs(tempInvId) % 1000).padStart(3, '0');
    const invoiceNo = `INV-OFF-${shortSeq}`;

    const allPatients = await getAllPatientsLocal();
    let existingPat = payload.existingPatientId
      ? allPatients.find((p) => p.id === payload.existingPatientId)
      : undefined;

    const tempPatId = existingPat ? existingPat.id : allocateTempId();
    const patientUid = existingPat ? existingPat.patient_uid : `ALEA-OFF-${shortSeq}`;

    if (!existingPat) {
      existingPat = {
        id: tempPatId,
        patient_uid: patientUid,
        name: payload.patient.name.trim(),
        age_years: Number(payload.patient.ageYears || 0),
        age_months: Number(payload.patient.ageMonths || 0),
        age_days: Number(payload.patient.ageDays || 0),
        gender: payload.patient.gender,
        mobile: (payload.patient.mobile || '').trim(),
        address: (payload.patient.address || '').trim(),
        created_at: nowTs,
      };
      await idbPut('patients', existingPat);
    }

    const invoiceTests: InvoiceTestItem[] = [];
    const queueItems: LabQueueItem[] = [];
    const invoiceTestIdByTestId: Record<number, number> = {};
    const catMap = new Map(cat.categories.map((c) => [c.id, c.name]));

    for (const t of selectedTests) {
      const tempItId = allocateTempId();
      invoiceTestIdByTestId[t.id] = tempItId;
      const tc = comm.perTestMap.get(t.id);
      const catName = t.category_name || catMap.get(t.category_id) || 'Pathology';

      const results: TestResultRow[] = (t.parameters || []).map((p, idx) => {
        const val = p.default_value || '';
        const rangeText = resolveParamRangeLabel(
          p,
          existingPat!.gender,
          existingPat!.age_years,
          existingPat!.age_months,
          existingPat!.age_days
        );
        const dummyRow: TestResultRow = {
          id: allocateTempId(),
          invoice_test_id: tempItId,
          parameter_id: p.id,
          parameter_name: p.name,
          unit: p.unit || '',
          result_value: val,
          reference_range_text: rangeText,
          flag: 'Normal',
          sort_order: p.sort_order ?? idx + 1,
          input_type: p.input_type || 'numeric',
          select_options: p.select_options || '',
          abnormal_values: p.abnormal_values || '',
          normal_text: p.normal_text || '',
          min_male: p.min_male ?? null,
          max_male: p.max_male ?? null,
          min_female: p.min_female ?? null,
          max_female: p.max_female ?? null,
          min_child: p.min_child ?? null,
          max_child: p.max_child ?? null,
          min_newborn: p.min_newborn ?? null,
          max_newborn: p.max_newborn ?? null,
        };
        dummyRow.flag = evaluateClientFlag(
          val,
          dummyRow,
          existingPat!.gender,
          existingPat!.age_years,
          existingPat!.age_months,
          existingPat!.age_days
        );
        return dummyRow;
      });

      const invTest: InvoiceTestItem = {
        id: tempItId,
        invoice_id: tempInvId,
        test_id: t.id,
        test_name: t.name,
        category_name: catName,
        sample_type: t.sample_type,
        price: Number(t.price || 0),
        commission_type: tc?.commission_type || 'percent',
        commission_value: tc?.commission_value || 0,
        commission_amount: tc?.commission_amount || 0,
        status: 'Sample Collected',
        collected_at: nowTs,
        verified_at: null,
        ready_at: null,
        verified_by: '',
        consultant_name: '',
        consultant_title: '',
        results,
      };
      invoiceTests.push(invTest);

      const qItem: LabQueueItem = {
        ...invTest,
        invoice_no: invoiceNo,
        invoice_date: nowTs,
        patient_uid: existingPat.patient_uid,
        patient_name: existingPat.name,
        age_years: existingPat.age_years,
        age_months: existingPat.age_months,
        age_days: existingPat.age_days,
        gender: existingPat.gender,
        patient_mobile: existingPat.mobile,
        doctor_name: doc?.name,
        total_params: results.length,
        filled_params: results.filter((r) => r.result_value.trim() !== '').length,
        abnormal_count: results.filter((r) => r.result_value.trim() !== '' && r.flag !== 'Normal').length,
      };
      queueItems.push(qItem);
      await saveLabTestDetailLocal(qItem, results);
    }

    const summary: InvoiceSummary = {
      id: tempInvId,
      invoice_no: invoiceNo,
      patient_id: existingPat.id,
      doctor_id: doc ? doc.id : null,
      subtotal,
      discount_type: dType,
      discount_value: dVal,
      discount_amount: discountAmount,
      discount_pct: discountPct,
      net_total: netTotal,
      paid_amount: paid,
      due_amount: due,
      payment_status: paymentStatus,
      adjustment_amount: 0,
      adjustment_reason: '',
      adjusted_by: '',
      adjusted_at: '',
      initial_payment_method: payload.paymentMethod || 'Cash',
      commission_type: comm.invoiceCommissionType,
      commission_value: comm.invoiceCommissionValue,
      commission_pct: comm.invoiceCommissionPct,
      commission_amount: comm.invoiceCommissionAmount,
      commission_paid: 0,
      commission_paid_at: '',
      notes: (payload.notes || '').trim(),
      created_by: isAdmin ? 'Admin' : 'Staff',
      created_at: nowTs,
      patient_uid: existingPat.patient_uid,
      patient_name: existingPat.name,
      age_years: existingPat.age_years,
      age_months: existingPat.age_months,
      age_days: existingPat.age_days,
      gender: existingPat.gender,
      patient_mobile: existingPat.mobile,
      patient_address: existingPat.address,
      doctor_name: doc?.name,
      doctor_degree: doc?.degree,
      doctor_hospital: doc?.hospital,
      doctor_default_commission_pct: doc?.commission_pct,
      total_tests: invoiceTests.length,
      ready_tests: 0,
      test_items: invoiceTests.map((t) => ({
        id: t.id,
        test_id: t.test_id,
        test_name: t.test_name,
        category_name: t.category_name,
        status: t.status,
        collected_at: t.collected_at,
        price: t.price,
        commission_type: t.commission_type,
        commission_value: t.commission_value,
        commission_amount: t.commission_amount,
      })),
      is_today: 1,
    };

    const full: FullInvoice = {
      invoice: summary,
      tests: invoiceTests,
      duePayments: [],
      adjustments: [],
    };

    await idbPut('invoices', summary);
    await saveFullInvoiceLocal(full);
    await idbPutMany('labQueue', queueItems);

    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body: payload,
      entityType: 'invoice_create',
      label: `New Patient: ${summary.patient_name} (${invoiceNo})`,
      tempIds: {
        invoiceId: tempInvId,
        patientId: payload.existingPatientId ? undefined : tempPatId,
        invoiceTestIdByTestId,
      },
      retryCount: 0,
      status: 'pending',
    });

    await refreshQueueSnapshot();
    broadcastPatientsUpdated();
    return full as unknown as T;
  }

  // 2. PUT /api/invoices/:id — Edit Patient / Invoice Offline
  const invPutMatch = /^\/api\/invoices\/(-?\d+)$/.exec(path);
  if (method === 'PUT' && invPutMatch) {
    const invoiceId = await resolveRemappedId('invoice', Number(invPutMatch[1]));
    const full =
      (await getFullInvoiceLocal(invoiceId)) ||
      (await buildFullInvoiceFallbackFromLocal(invoiceId));
    if (!full) {
      throw new Error('Cannot edit invoice offline because its details were not cached.');
    }

    const payload = (body || {}) as {
      patient?: {
        name?: string;
        ageYears?: number;
        ageMonths?: number;
        ageDays?: number;
        gender?: 'Male' | 'Female' | 'Other';
        mobile?: string;
        address?: string;
      };
      doctorId?: number | null;
      addTestIds?: number[];
      removeInvoiceTestIds?: number[];
      discountType?: 'percent' | 'flat';
      discountValue?: number;
      additionalPayment?: number;
      paymentMethod?: string;
      notes?: string;
      adjustmentAmount?: number;
      adjustmentReason?: string;
      refundExcess?: boolean;
      refundMethod?: string;
      commissionMode?: 'doctor_default' | 'custom_invoice' | 'custom_per_test';
      commissionType?: 'percent' | 'flat';
      commissionValue?: number;
      testCommissions?: TestCommissionOverride[];
    };

    const inv = { ...full.invoice };
    if (payload.patient) {
      if (payload.patient.name !== undefined) inv.patient_name = payload.patient.name.trim();
      if (payload.patient.ageYears !== undefined) inv.age_years = Number(payload.patient.ageYears || 0);
      if (payload.patient.ageMonths !== undefined) inv.age_months = Number(payload.patient.ageMonths || 0);
      if (payload.patient.ageDays !== undefined) inv.age_days = Number(payload.patient.ageDays || 0);
      if (payload.patient.gender !== undefined) inv.gender = payload.patient.gender;
      if (payload.patient.mobile !== undefined) inv.patient_mobile = payload.patient.mobile.trim();
      if (payload.patient.address !== undefined) inv.patient_address = payload.patient.address.trim();
    }

    const docs = (await getSnapshot<Doctor[]>('doctors')) || [];
    if (payload.doctorId !== undefined) {
      inv.doctor_id = payload.doctorId;
      const doc = payload.doctorId ? docs.find((d) => d.id === payload.doctorId) : undefined;
      inv.doctor_name = doc?.name;
      inv.doctor_degree = doc?.degree;
      inv.doctor_hospital = doc?.hospital;
    }

    let nextTests = [...full.tests];
    const removedSet = new Set((payload.removeInvoiceTestIds || []).map(Number));
    if (removedSet.size > 0) {
      for (const remId of removedSet) {
        await idbDelete('labQueue', remId);
        await idbDelete('labTestDetails', remId);
      }
      nextTests = nextTests.filter((t) => !removedSet.has(t.id));
    }

    const addedInvoiceTestIdsByTestId: Record<number, number> = {};
    if (Array.isArray(payload.addTestIds) && payload.addTestIds.length > 0) {
      const cat =
        (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_all')) ||
        (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_active')) ||
        { categories: [], tests: [] };
      const catMap = new Map(cat.categories.map((c) => [c.id, c.name]));

      for (const addId of payload.addTestIds) {
        const testDef = cat.tests.find((t) => t.id === addId);
        if (!testDef) continue;
        const tempItId = allocateTempId();
        addedInvoiceTestIdsByTestId[testDef.id] = tempItId;
        const results: TestResultRow[] = (testDef.parameters || []).map((p, idx) => ({
          id: allocateTempId(),
          invoice_test_id: tempItId,
          parameter_id: p.id,
          parameter_name: p.name,
          unit: p.unit || '',
          result_value: p.default_value || '',
          reference_range_text: resolveParamRangeLabel(
            p,
            inv.gender,
            inv.age_years,
            inv.age_months,
            inv.age_days
          ),
          flag: 'Normal',
          sort_order: p.sort_order ?? idx + 1,
          input_type: p.input_type || 'numeric',
          select_options: p.select_options || '',
          abnormal_values: p.abnormal_values || '',
          normal_text: p.normal_text || '',
          min_male: p.min_male ?? null,
          max_male: p.max_male ?? null,
          min_female: p.min_female ?? null,
          max_female: p.max_female ?? null,
          min_child: p.min_child ?? null,
          max_child: p.max_child ?? null,
          min_newborn: p.min_newborn ?? null,
          max_newborn: p.max_newborn ?? null,
        }));
        const newTestItem: InvoiceTestItem = {
          id: tempItId,
          invoice_id: inv.id,
          test_id: testDef.id,
          test_name: testDef.name,
          category_name: testDef.category_name || catMap.get(testDef.category_id) || 'Pathology',
          sample_type: testDef.sample_type,
          price: Number(testDef.price || 0),
          status: 'Sample Collected',
          collected_at: nowTs,
          verified_at: null,
          ready_at: null,
          verified_by: '',
          results,
        };
        nextTests.push(newTestItem);
        const qItem: LabQueueItem = {
          ...newTestItem,
          invoice_no: inv.invoice_no,
          invoice_date: inv.created_at,
          patient_uid: inv.patient_uid,
          patient_name: inv.patient_name,
          age_years: inv.age_years,
          age_months: inv.age_months,
          age_days: inv.age_days,
          gender: inv.gender,
          patient_mobile: inv.patient_mobile,
          doctor_name: inv.doctor_name,
          total_params: results.length,
          filled_params: results.filter((r) => r.result_value.trim() !== '').length,
          abnormal_count: 0,
        };
        await idbPut('labQueue', qItem);
        await saveLabTestDetailLocal(qItem, results);
      }
    }

    const subtotal = roundCurrency(nextTests.reduce((s, t) => s + Number(t.price || 0), 0));
    const dType = payload.discountType || inv.discount_type;
    const dVal =
      payload.discountValue !== undefined ? Math.max(0, Number(payload.discountValue || 0)) : inv.discount_value;
    const discountAmount = Math.min(
      subtotal,
      roundCurrency(dType === 'flat' ? dVal : (subtotal * dVal) / 100)
    );
    const adjAmt =
      payload.adjustmentAmount !== undefined
        ? Number(payload.adjustmentAmount || 0)
        : Number(inv.adjustment_amount || 0);
    const netTotal = Math.max(0, roundCurrency(subtotal - discountAmount - adjAmt));
    const extraPay = Math.max(0, Number(payload.additionalPayment || 0));
    let paidAmount = roundCurrency(Number(inv.paid_amount || 0) + extraPay);
    if (payload.refundExcess && paidAmount > netTotal) {
      paidAmount = netTotal;
    }
    const dueAmount = Math.max(0, roundCurrency(netTotal - paidAmount));

    inv.subtotal = subtotal;
    inv.discount_type = dType;
    inv.discount_value = dVal;
    inv.discount_amount = discountAmount;
    inv.discount_pct = subtotal > 0 ? roundCurrency((discountAmount / subtotal) * 100) : 0;
    inv.adjustment_amount = adjAmt;
    inv.net_total = netTotal;
    inv.paid_amount = paidAmount;
    inv.due_amount = dueAmount;
    inv.payment_status = dueAmount <= 0 ? 'Paid' : paidAmount > 0 ? 'Partial' : 'Due';
    if (payload.notes !== undefined) inv.notes = payload.notes;

    inv.total_tests = nextTests.length;
    inv.ready_tests = nextTests.filter((t) => t.status === 'Ready').length;
    inv.test_items = nextTests.map((t) => ({
      id: t.id,
      test_id: t.test_id,
      test_name: t.test_name,
      category_name: t.category_name,
      status: t.status,
      collected_at: t.collected_at,
      price: t.price,
    }));

    const duePayments = [...(full.duePayments || [])];
    if (extraPay > 0) {
      duePayments.push({
        id: allocateTempId(),
        invoice_id: inv.id,
        amount: extraPay,
        entry_type: 'payment',
        payment_method: payload.paymentMethod || 'Cash',
        note: 'Offline payment update',
        collected_by: isAdmin ? 'Admin' : 'Staff',
        collected_at: nowTs,
      });
    }

    const updatedFull: FullInvoice = {
      ...full,
      invoice: inv,
      tests: nextTests,
      duePayments,
    };

    await idbPut('invoices', inv);
    await saveFullInvoiceLocal(updatedFull);

    // Refresh labQueue metadata for remaining tests
    const existingQueue = await getAllLabQueueLocal();
    const updatedQueueItems = existingQueue
      .filter((q) => q.invoice_id === inv.id)
      .map((q) => ({
        ...q,
        patient_name: inv.patient_name,
        age_years: inv.age_years,
        age_months: inv.age_months,
        age_days: inv.age_days,
        gender: inv.gender,
        patient_mobile: inv.patient_mobile,
        doctor_name: inv.doctor_name,
      }));
    if (updatedQueueItems.length > 0) {
      await idbPutMany('labQueue', updatedQueueItems);
    }

    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body: payload,
      entityType: 'invoice_update',
      label: `Update Invoice: ${inv.invoice_no}`,
      tempIds: { addedInvoiceTestIdsByTestId },
      retryCount: 0,
      status: 'pending',
    });

    await refreshQueueSnapshot();
    broadcastPatientsUpdated();
    return updatedFull as unknown as T;
  }

  // 3. POST /api/invoices/:id/due-payment
  const duePayMatch = /^\/api\/invoices\/(-?\d+)\/due-payment$/.exec(path);
  if (method === 'POST' && duePayMatch) {
    const invoiceId = await resolveRemappedId('invoice', Number(duePayMatch[1]));
    const full =
      (await getFullInvoiceLocal(invoiceId)) ||
      (await buildFullInvoiceFallbackFromLocal(invoiceId));
    if (!full) {
      throw new Error('Invoice details are not cached locally for offline due collection.');
    }

    const payload = (body || {}) as { amount?: number; paymentMethod?: string; note?: string };
    const payAmt = Math.max(0, roundCurrency(Number(payload.amount || 0)));
    const inv = { ...full.invoice };
    const applied = Math.min(Number(inv.due_amount || 0), payAmt);
    inv.paid_amount = roundCurrency(Number(inv.paid_amount || 0) + applied);
    inv.due_amount = Math.max(0, roundCurrency(Number(inv.net_total || 0) - inv.paid_amount));
    inv.payment_status = inv.due_amount <= 0 ? 'Paid' : inv.paid_amount > 0 ? 'Partial' : 'Due';

    const newPayment: DuePayment = {
      id: allocateTempId(),
      invoice_id: inv.id,
      amount: applied,
      entry_type: 'payment',
      payment_method: payload.paymentMethod || 'Cash',
      note: payload.note || '',
      collected_by: isAdmin ? 'Admin' : 'Staff',
      collected_at: nowTs,
    };

    const updatedFull: FullInvoice = {
      ...full,
      invoice: inv,
      duePayments: [...(full.duePayments || []), newPayment],
    };
    await idbPut('invoices', inv);
    await saveFullInvoiceLocal(updatedFull);

    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body: payload,
      entityType: 'invoice_due_payment',
      label: `Due Payment ${inv.invoice_no}: ৳${applied}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return updatedFull as unknown as T;
  }

  // 4. POST /api/admin/invoices/:id/adjust-bill
  const adjMatch = /^\/api\/admin\/invoices\/(-?\d+)\/adjust-bill$/.exec(path);
  if (method === 'POST' && adjMatch) {
    const invoiceId = await resolveRemappedId('invoice', Number(adjMatch[1]));
    const full =
      (await getFullInvoiceLocal(invoiceId)) ||
      (await buildFullInvoiceFallbackFromLocal(invoiceId));
    if (!full) throw new Error('Invoice not cached locally.');

    const payload = (body || {}) as {
      targetNetTotal?: number;
      reductionAmount?: number;
      reason?: string;
      refundExcess?: boolean;
    };
    const inv = { ...full.invoice };
    const prevNet = Number(inv.net_total || 0);
    const nextNet =
      payload.targetNetTotal !== undefined
        ? Math.max(0, roundCurrency(Number(payload.targetNetTotal)))
        : Math.max(0, roundCurrency(prevNet - Number(payload.reductionAmount || 0)));
    const delta = roundCurrency(prevNet - nextNet);
    inv.adjustment_amount = roundCurrency(Number(inv.adjustment_amount || 0) + delta);
    inv.adjustment_reason = payload.reason || inv.adjustment_reason || '';
    inv.adjusted_at = nowTs;
    inv.net_total = nextNet;
    if (payload.refundExcess && inv.paid_amount > nextNet) {
      inv.paid_amount = nextNet;
    }
    inv.due_amount = Math.max(0, roundCurrency(nextNet - Number(inv.paid_amount || 0)));
    inv.payment_status = inv.due_amount <= 0 ? 'Paid' : inv.paid_amount > 0 ? 'Partial' : 'Due';

    const updatedFull: FullInvoice = { ...full, invoice: inv };
    await idbPut('invoices', inv);
    await saveFullInvoiceLocal(updatedFull);

    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body: payload,
      entityType: 'invoice_adjust_bill',
      label: `Adjust Bill: ${inv.invoice_no}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return updatedFull as unknown as T;
  }

  // 5. DELETE /api/invoices/:id/tests/:invoiceTestId
  const remTestMatch = /^\/api\/invoices\/(-?\d+)\/tests\/(-?\d+)$/.exec(path);
  if (method === 'DELETE' && remTestMatch) {
    const invoiceId = await resolveRemappedId('invoice', Number(remTestMatch[1]));
    const invoiceTestId = await resolveRemappedId('invoiceTest', Number(remTestMatch[2]));
    const full =
      (await getFullInvoiceLocal(invoiceId)) ||
      (await buildFullInvoiceFallbackFromLocal(invoiceId));
    if (!full) throw new Error('Invoice not cached locally.');

    const nextTests = full.tests.filter((t) => t.id !== invoiceTestId);
    const inv = { ...full.invoice };
    const subtotal = roundCurrency(nextTests.reduce((s, t) => s + Number(t.price || 0), 0));
    const discountAmount = Math.min(
      subtotal,
      roundCurrency(inv.discount_type === 'flat' ? inv.discount_value : (subtotal * inv.discount_value) / 100)
    );
    const netTotal = Math.max(0, roundCurrency(subtotal - discountAmount - Number(inv.adjustment_amount || 0)));
    inv.subtotal = subtotal;
    inv.discount_amount = discountAmount;
    inv.net_total = netTotal;
    inv.due_amount = Math.max(0, roundCurrency(netTotal - Number(inv.paid_amount || 0)));
    inv.payment_status = inv.due_amount <= 0 ? 'Paid' : inv.paid_amount > 0 ? 'Partial' : 'Due';
    inv.total_tests = nextTests.length;
    inv.ready_tests = nextTests.filter((t) => t.status === 'Ready').length;
    inv.test_items = nextTests.map((t) => ({
      id: t.id,
      test_id: t.test_id,
      test_name: t.test_name,
      category_name: t.category_name,
      status: t.status,
      collected_at: t.collected_at,
      price: t.price,
    }));

    const updatedFull: FullInvoice = { ...full, invoice: inv, tests: nextTests };
    await idbPut('invoices', inv);
    await saveFullInvoiceLocal(updatedFull);
    await idbDelete('labQueue', invoiceTestId);
    await idbDelete('labTestDetails', invoiceTestId);

    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      entityType: 'invoice_remove_test',
      label: `Remove Test from ${inv.invoice_no}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    broadcastPatientsUpdated();
    return updatedFull as unknown as T;
  }

  // 6. DELETE /api/invoices/:id
  const delInvMatch = /^\/api\/invoices\/(-?\d+)$/.exec(path);
  if (method === 'DELETE' && delInvMatch) {
    const invoiceId = await resolveRemappedId('invoice', Number(delInvMatch[1]));
    const allInvs = await getAllInvoicesLocal();
    const inv = allInvs.find((i) => i.id === invoiceId);
    const full = await getFullInvoiceLocal(invoiceId);
    const testIdsToRemove = (full?.tests || []).map((t) => t.id);

    await idbDelete('invoices', invoiceId);
    await idbDelete('fullInvoices', invoiceId);
    for (const tid of testIdsToRemove) {
      await idbDelete('labQueue', tid);
      await idbDelete('labTestDetails', tid);
    }

    // Also remove any orphaned queue items belonging to this invoice
    const qAll = await getAllLabQueueLocal();
    for (const q of qAll) {
      if (q.invoice_id === invoiceId) {
        await idbDelete('labQueue', q.id);
        await idbDelete('labTestDetails', q.id);
      }
    }

    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      entityType: 'invoice_delete',
      label: `Delete Invoice: ${inv?.invoice_no || `#${invoiceId}`}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    broadcastPatientsUpdated();
    return {
      success: true,
      deletedInvoiceId: invoiceId,
      invoiceNo: inv?.invoice_no || '',
      deletedPatientId: inv?.patient_id || 0,
      patientUid: inv?.patient_uid || '',
      patientName: inv?.patient_name || '',
      patientDeleted: false,
      deletedTestsCount: testIdsToRemove.length,
      deletedResultsCount: 0,
    } as unknown as T;
  }

  // 7. PUT /api/lab-tests/:invoiceTestId/results — Offline Lab Result Entry
  const labResultMatch = /^\/api\/lab-tests\/(-?\d+)\/results$/.exec(path);
  if (method === 'PUT' && labResultMatch) {
    const invoiceTestId = await resolveRemappedId('invoiceTest', Number(labResultMatch[1]));
    const payload = (body || {}) as {
      results: Array<{ parameterId: number; value: string }>;
      status: 'Sample Collected' | 'Processing' | 'Verified' | 'Ready';
      verifiedBy?: string;
      consultantName?: string;
      consultantTitle?: string;
    };

    const existingDetail = await getLabTestDetailLocal(invoiceTestId);
    const queue = await getAllLabQueueLocal();
    const qItem = existingDetail?.item || queue.find((q) => q.id === invoiceTestId);

    if (!qItem) {
      throw new Error('Test parameter form was not cached locally for offline editing.');
    }

    const valMap = new Map((payload.results || []).map((r) => [Number(r.parameterId), r.value ?? '']));
    let existingResults = existingDetail?.results || [];
    if (existingResults.length === 0) {
      const synthesized = await serveOfflineGet<{ item: LabQueueItem; results: TestResultRow[] }>(
        `/api/lab-tests/${invoiceTestId}`
      );
      existingResults = synthesized.results;
    }

    const updatedResults: TestResultRow[] = existingResults.map((row) => {
      const nextVal = valMap.has(row.parameter_id) ? valMap.get(row.parameter_id)! : row.result_value;
      const flag = evaluateClientFlag(
        nextVal,
        row,
        qItem.gender,
        qItem.age_years,
        qItem.age_months,
        qItem.age_days
      );
      return {
        ...row,
        result_value: nextVal,
        flag,
      };
    });

    const nextStatus = payload.status || qItem.status;
    const filledParams = updatedResults.filter((r) => String(r.result_value || '').trim() !== '').length;
    const abnormalCount = updatedResults.filter(
      (r) => String(r.result_value || '').trim() !== '' && r.flag !== 'Normal'
    ).length;

    const updatedItem: LabQueueItem = {
      ...qItem,
      status: nextStatus,
      verified_by: payload.verifiedBy ?? qItem.verified_by,
      consultant_name: payload.consultantName ?? qItem.consultant_name,
      consultant_title: payload.consultantTitle ?? qItem.consultant_title,
      verified_at:
        nextStatus === 'Verified' || nextStatus === 'Ready' ? qItem.verified_at || nowTs : qItem.verified_at,
      ready_at: nextStatus === 'Ready' ? qItem.ready_at || nowTs : qItem.ready_at,
      filled_params: filledParams,
      total_params: updatedResults.length,
      abnormal_count: abnormalCount,
    };

    await saveLabTestDetailLocal(updatedItem, updatedResults);
    await idbPut('labQueue', updatedItem);

    // Sync test status back to invoice & fullInvoice so Live Patient Display & Reports reflect it instantly!
    const allInvs = await getAllInvoicesLocal();
    const inv = allInvs.find((i) => i.id === updatedItem.invoice_id);
    if (inv) {
      const nextItems = (inv.test_items || []).map((ti) =>
        ti.id === updatedItem.id ? { ...ti, status: nextStatus } : ti
      );
      const readyTestsCount = nextItems.filter((ti) => ti.status === 'Ready').length;
      const updatedInv: InvoiceSummary = {
        ...inv,
        test_items: nextItems,
        ready_tests: readyTestsCount,
      };
      await idbPut('invoices', updatedInv);
    }

    const fullInv = await getFullInvoiceLocal(updatedItem.invoice_id);
    if (fullInv) {
      const updatedFullTests = fullInv.tests.map((t) =>
        t.id === updatedItem.id
          ? {
              ...t,
              status: nextStatus,
              verified_by: updatedItem.verified_by,
              consultant_name: updatedItem.consultant_name,
              consultant_title: updatedItem.consultant_title,
              verified_at: updatedItem.verified_at,
              ready_at: updatedItem.ready_at,
              results: updatedResults,
            }
          : t
      );
      const updatedSummary: InvoiceSummary = {
        ...fullInv.invoice,
        ready_tests: updatedFullTests.filter((t) => t.status === 'Ready').length,
        test_items: (fullInv.invoice.test_items || []).map((ti) =>
          ti.id === updatedItem.id ? { ...ti, status: nextStatus } : ti
        ),
      };
      await saveFullInvoiceLocal({
        ...fullInv,
        invoice: updatedSummary,
        tests: updatedFullTests,
      });
    }

    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body: payload,
      entityType: 'lab_results',
      label: `Lab Result: ${updatedItem.patient_name} · ${updatedItem.test_name}`,
      retryCount: 0,
      status: 'pending',
    });

    await refreshQueueSnapshot();
    broadcastPatientsUpdated();
    return { item: updatedItem, results: updatedResults } as unknown as T;
  }

  // 8. Catalog Category & Test Mutations
  if (method === 'POST' && path === '/api/admin/categories') {
    const name = String(body?.name || '').trim();
    const tempCatId = allocateTempId();
    const cat =
      (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_all')) ||
      { categories: [], tests: [] };
    const newCat: TestCategory = {
      id: tempCatId,
      name,
      sort_order: cat.categories.length + 1,
    };
    const nextCat = { ...cat, categories: [...cat.categories, newCat] };
    await setSnapshot('catalog_all', nextCat);
    await setSnapshot('catalog_active', {
      categories: nextCat.categories,
      tests: nextCat.tests.filter((t) => Number(t.is_active ?? 1) === 1),
    });

    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'catalog_category_create',
      label: `New Category: ${name}`,
      tempIds: { categoryId: tempCatId },
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return newCat as unknown as T;
  }

  const delCatMatch = /^\/api\/admin\/categories\/(-?\d+)$/.exec(path);
  if (method === 'DELETE' && delCatMatch) {
    const catId = await resolveRemappedId('category', Number(delCatMatch[1]));
    const cat =
      (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_all')) ||
      { categories: [], tests: [] };
    const nextCat = {
      categories: cat.categories.filter((c) => c.id !== catId),
      tests: cat.tests,
    };
    await setSnapshot('catalog_all', nextCat);
    await setSnapshot('catalog_active', {
      categories: nextCat.categories,
      tests: nextCat.tests.filter((t) => Number(t.is_active ?? 1) === 1),
    });
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      entityType: 'catalog_category_delete',
      label: `Delete Category #${catId}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { success: true } as unknown as T;
  }

  if (method === 'POST' && path === '/api/admin/tests') {
    const tempTestId = allocateTempId();
    const cat =
      (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_all')) ||
      { categories: [], tests: [] };
    const catObj = cat.categories.find((c) => c.id === Number(body?.category_id));
    const rawParams = Array.isArray(body?.parameters) ? (body.parameters as Array<Record<string, unknown>>) : [];
    const params: TestParameter[] = rawParams.map((p, idx) => ({
      id: allocateTempId(),
      test_id: tempTestId,
      name: String(p.name || ''),
      unit: String(p.unit || ''),
      input_type: (p.input_type as 'numeric' | 'text' | 'select') || 'numeric',
      normal_text: String(p.normal_text || ''),
      default_value: String(p.default_value || ''),
      select_options: String(p.select_options || ''),
      abnormal_values: String(p.abnormal_values || ''),
      min_male: (p.min_male as number | null) ?? null,
      max_male: (p.max_male as number | null) ?? null,
      min_female: (p.min_female as number | null) ?? null,
      max_female: (p.max_female as number | null) ?? null,
      min_child: (p.min_child as number | null) ?? null,
      max_child: (p.max_child as number | null) ?? null,
      min_newborn: (p.min_newborn as number | null) ?? null,
      max_newborn: (p.max_newborn as number | null) ?? null,
      sort_order: idx + 1,
    }));
    const newTest: DiagnosticTest = {
      id: tempTestId,
      category_id: Number(body?.category_id),
      category_name: catObj?.name || 'Pathology',
      code: String(body?.code || ''),
      name: String(body?.name || ''),
      price: Number(body?.price || 0),
      sample_type: String(body?.sample_type || ''),
      is_active: 1,
      parameters: params,
    };
    const nextCat = { ...cat, tests: [...cat.tests, newTest] };
    await setSnapshot('catalog_all', nextCat);
    await setSnapshot('catalog_active', {
      categories: nextCat.categories,
      tests: nextCat.tests.filter((t) => Number(t.is_active ?? 1) === 1),
    });
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'catalog_test_create',
      label: `New Test: ${newTest.name}`,
      tempIds: { testId: tempTestId },
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { id: tempTestId } as unknown as T;
  }

  const putTestMatch = /^\/api\/admin\/tests\/(-?\d+)$/.exec(path);
  if (method === 'PUT' && putTestMatch) {
    const testId = await resolveRemappedId('test', Number(putTestMatch[1]));
    const cat =
      (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_all')) ||
      { categories: [], tests: [] };
    const catObj = cat.categories.find((c) => c.id === Number(body?.category_id));
    const rawParams = Array.isArray(body?.parameters) ? (body.parameters as Array<Record<string, unknown>>) : [];
    const nextTests = cat.tests.map((t) => {
      if (t.id !== testId) return t;
      const params: TestParameter[] = rawParams.map((p, idx) => ({
        id: Number(p.id || 0) || allocateTempId(),
        test_id: testId,
        name: String(p.name || ''),
        unit: String(p.unit || ''),
        input_type: (p.input_type as 'numeric' | 'text' | 'select') || 'numeric',
        normal_text: String(p.normal_text || ''),
        default_value: String(p.default_value || ''),
        select_options: String(p.select_options || ''),
        abnormal_values: String(p.abnormal_values || ''),
        min_male: (p.min_male as number | null) ?? null,
        max_male: (p.max_male as number | null) ?? null,
        min_female: (p.min_female as number | null) ?? null,
        max_female: (p.max_female as number | null) ?? null,
        min_child: (p.min_child as number | null) ?? null,
        max_child: (p.max_child as number | null) ?? null,
        min_newborn: (p.min_newborn as number | null) ?? null,
        max_newborn: (p.max_newborn as number | null) ?? null,
        sort_order: idx + 1,
      }));
      return {
        ...t,
        category_id: Number(body?.category_id ?? t.category_id),
        category_name: catObj?.name || t.category_name,
        code: String(body?.code ?? t.code),
        name: String(body?.name ?? t.name),
        price: Number(body?.price ?? t.price),
        sample_type: String(body?.sample_type ?? t.sample_type),
        is_active: body?.is_active !== undefined ? Number(body.is_active) : t.is_active,
        parameters: params,
      };
    });
    const nextCat = { categories: cat.categories, tests: nextTests };
    await setSnapshot('catalog_all', nextCat);
    await setSnapshot('catalog_active', {
      categories: nextCat.categories,
      tests: nextCat.tests.filter((t) => Number(t.is_active ?? 1) === 1),
    });
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'catalog_test_update',
      label: `Update Test: ${String(body?.name || `#${testId}`)}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { success: true } as unknown as T;
  }

  const delTestMatch = /^\/api\/admin\/tests\/(-?\d+)$/.exec(path);
  if (method === 'DELETE' && delTestMatch) {
    const testId = await resolveRemappedId('test', Number(delTestMatch[1]));
    const cat =
      (await getSnapshot<{ categories: TestCategory[]; tests: DiagnosticTest[] }>('catalog_all')) ||
      { categories: [], tests: [] };
    const nextCat = {
      categories: cat.categories,
      tests: cat.tests.filter((t) => t.id !== testId),
    };
    await setSnapshot('catalog_all', nextCat);
    await setSnapshot('catalog_active', {
      categories: nextCat.categories,
      tests: nextCat.tests.filter((t) => Number(t.is_active ?? 1) === 1),
    });
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      entityType: 'catalog_test_delete',
      label: `Delete Test #${testId}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { success: true } as unknown as T;
  }

  // 9. Doctors Mutations
  if (method === 'POST' && path === '/api/admin/doctors') {
    const tempDocId = allocateTempId();
    const docs = (await getSnapshot<Doctor[]>('doctors')) || [];
    const newDoc: Doctor = {
      id: tempDocId,
      name: String(body?.name || '').trim(),
      degree: String(body?.degree || ''),
      hospital: String(body?.hospital || ''),
      mobile: String(body?.mobile || ''),
      commission_pct: Number(body?.commission_pct || 0),
      portal_username: String(body?.portal_username || ''),
      portal_enabled: body?.portal_enabled !== undefined ? Number(body.portal_enabled) : 1,
      is_active: 1,
    };
    await setSnapshot('doctors', [...docs, newDoc]);
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'doctor_create',
      label: `New Doctor: ${newDoc.name}`,
      tempIds: { doctorId: tempDocId },
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { id: tempDocId } as unknown as T;
  }

  const docIdMatch = /^\/api\/admin\/doctors\/(-?\d+)$/.exec(path);
  if (method === 'PUT' && docIdMatch) {
    const docId = await resolveRemappedId('doctor', Number(docIdMatch[1]));
    const docs = (await getSnapshot<Doctor[]>('doctors')) || [];
    await setSnapshot(
      'doctors',
      docs.map((d) =>
        d.id === docId
          ? {
              ...d,
              name: String(body?.name ?? d.name),
              degree: String(body?.degree ?? d.degree),
              hospital: String(body?.hospital ?? d.hospital),
              mobile: String(body?.mobile ?? d.mobile),
              commission_pct:
                body?.commission_pct !== undefined ? Number(body.commission_pct) : d.commission_pct,
            }
          : d
      )
    );
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'doctor_update',
      label: `Update Doctor: ${String(body?.name || `#${docId}`)}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { success: true } as unknown as T;
  }

  if (method === 'DELETE' && docIdMatch) {
    const docId = await resolveRemappedId('doctor', Number(docIdMatch[1]));
    const docs = (await getSnapshot<Doctor[]>('doctors')) || [];
    await setSnapshot('doctors', docs.filter((d) => d.id !== docId));
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      entityType: 'doctor_delete',
      label: `Delete Doctor #${docId}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { success: true } as unknown as T;
  }

  // 10. Expenses & Other Revenues
  if (method === 'POST' && path === '/api/admin/expenses') {
    const tempExpId = allocateTempId();
    const newExp: ExpenseItem = {
      id: tempExpId,
      title: String(body?.title || ''),
      category: String(body?.category || 'General'),
      amount: Number(body?.amount || 0),
      expense_date: String(body?.expense_date || getTodayISO()),
      note: String(body?.note || ''),
      created_by: isAdmin ? 'Admin' : 'Staff',
      created_at: nowTs,
    };
    await idbPut('expenses', newExp);
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'expense_create',
      label: `Expense: ${newExp.title} (৳${newExp.amount})`,
      tempIds: { expenseId: tempExpId },
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { id: tempExpId } as unknown as T;
  }

  const delExpMatch = /^\/api\/admin\/expenses\/(-?\d+)$/.exec(path);
  if (method === 'DELETE' && delExpMatch) {
    const expId = await resolveRemappedId('expense', Number(delExpMatch[1]));
    await idbDelete('expenses', expId);
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      entityType: 'expense_delete',
      label: `Delete Expense #${expId}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { success: true } as unknown as T;
  }

  if (method === 'POST' && path === '/api/admin/other-revenues') {
    const tempRevId = allocateTempId();
    const newRev: OtherRevenueItem = {
      id: tempRevId,
      source: String(body?.source || ''),
      category: String(body?.category || 'Other'),
      amount: Number(body?.amount || 0),
      revenue_date: String(body?.revenue_date || getTodayISO()),
      note: String(body?.note || ''),
      created_by: 'Admin',
      created_at: nowTs,
    };
    await idbPut('otherRevenues', newRev);
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'other_revenue_create',
      label: `Other Income: ${newRev.source}`,
      tempIds: { otherRevenueId: tempRevId },
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { id: tempRevId } as unknown as T;
  }

  const delRevMatch = /^\/api\/admin\/other-revenues\/(-?\d+)$/.exec(path);
  if (method === 'DELETE' && delRevMatch) {
    const revId = await resolveRemappedId('otherRevenue', Number(delRevMatch[1]));
    await idbDelete('otherRevenues', revId);
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      entityType: 'other_revenue_delete',
      label: `Delete Other Income #${revId}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { success: true } as unknown as T;
  }

  // 11. Settings Update
  if (method === 'PUT' && path === '/api/admin/settings') {
    const sysInfo =
      (await getSnapshot<SystemInfo>('system_info')) || {
        settings: DEFAULT_SETTINGS,
        port: 3000,
        lanUrls: [],
        serverDate: getTodayISO(),
      };
    const nextSettings = {
      ...sysInfo.settings,
      ...(body as Partial<LabSettings>),
    };
    await setSnapshot('system_info', { ...sysInfo, settings: nextSettings });
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'settings_update',
      label: 'Update Lab Settings',
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { settings: nextSettings } as unknown as T;
  }

  // 12. Commission & Settlement Updates
  const invCommMatch = /^\/api\/admin\/invoices\/(-?\d+)\/commission$/.exec(path);
  if (method === 'PUT' && invCommMatch) {
    const invoiceId = await resolveRemappedId('invoice', Number(invCommMatch[1]));
    const full = await getFullInvoiceLocal(invoiceId);
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'invoice_commission',
      label: `Update Commission: ${full?.invoice.invoice_no || `#${invoiceId}`}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return (full || { invoice: { id: invoiceId }, tests: [], duePayments: [] }) as unknown as T;
  }

  const invDisbMatch = /^\/api\/admin\/invoices\/(-?\d+)\/disburse-commission$/.exec(path);
  if (method === 'POST' && invDisbMatch) {
    const invoiceId = await resolveRemappedId('invoice', Number(invDisbMatch[1]));
    const full = await getFullInvoiceLocal(invoiceId);
    if (full) {
      const updatedInv = { ...full.invoice, commission_paid: 1, commission_paid_at: nowTs };
      await idbPut('invoices', updatedInv);
      await saveFullInvoiceLocal({ ...full, invoice: updatedInv });
    }
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'invoice_disburse_commission',
      label: `Disburse Commission: ${full?.invoice.invoice_no || `#${invoiceId}`}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { success: true, doctorId: full?.invoice.doctor_id || null } as unknown as T;
  }

  const settleDocMatch = /^\/api\/admin\/doctors\/(-?\d+)\/settle-commission$/.exec(path);
  if (method === 'POST' && settleDocMatch) {
    await enqueueSyncMutation({
      clientMutationId: mutationId,
      createdAt: nowTs,
      method,
      url,
      body,
      entityType: 'doctor_settle',
      label: `Settle Doctor Commission #${settleDocMatch[1]}`,
      retryCount: 0,
      status: 'pending',
    });
    await refreshQueueSnapshot();
    return { success: true } as unknown as T;
  }

  throw new Error('This action requires an active server connection.');
}

// -----------------------------------------------------------------------------
// Chronological Queue Replay & ID Remapping
// -----------------------------------------------------------------------------
async function remapUrlAndBodyForSync(item: OfflineQueueItem): Promise<{
  url: string;
  body: unknown;
}> {
  let url = item.url;
  let body = item.body ? (JSON.parse(JSON.stringify(item.body)) as Record<string, unknown>) : undefined;

  // Remap negative path IDs sequentially based on entity route
  const invMatch = /^(\/api\/(?:admin\/)?invoices\/)(-\d+)(.*)$/.exec(url);
  if (invMatch) {
    const resolved = await resolveRemappedId('invoice', Number(invMatch[2]));
    url = `${invMatch[1]}${resolved}${invMatch[3]}`;
    const remTest = /^(.*\/tests\/)(-\d+)$/.exec(url);
    if (remTest) {
      const resolvedIt = await resolveRemappedId('invoiceTest', Number(remTest[2]));
      url = `${remTest[1]}${resolvedIt}`;
    }
  }

  const labMatch = /^(\/api\/lab-tests\/)(-\d+)(\/results)$/.exec(url);
  if (labMatch) {
    const resolvedIt = await resolveRemappedId('invoiceTest', Number(labMatch[2]));
    url = `${labMatch[1]}${resolvedIt}${labMatch[3]}`;
  }

  const catMatch = /^(\/api\/admin\/categories\/)(-\d+)$/.exec(url);
  if (catMatch) {
    url = `${catMatch[1]}${await resolveRemappedId('category', Number(catMatch[2]))}`;
  }

  const testMatch = /^(\/api\/admin\/tests\/)(-\d+)$/.exec(url);
  if (testMatch) {
    url = `${testMatch[1]}${await resolveRemappedId('test', Number(testMatch[2]))}`;
  }

  const docMatch = /^(\/api\/admin\/doctors\/)(-\d+)(.*)$/.exec(url);
  if (docMatch) {
    url = `${docMatch[1]}${await resolveRemappedId('doctor', Number(docMatch[2]))}${docMatch[3]}`;
  }

  const expMatch = /^(\/api\/admin\/expenses\/)(-\d+)$/.exec(url);
  if (expMatch) {
    url = `${expMatch[1]}${await resolveRemappedId('expense', Number(expMatch[2]))}`;
  }

  const revMatch = /^(\/api\/admin\/other-revenues\/)(-\d+)$/.exec(url);
  if (revMatch) {
    url = `${revMatch[1]}${await resolveRemappedId('otherRevenue', Number(revMatch[2]))}`;
  }

  if (body) {
    if (typeof body.existingPatientId === 'number' && body.existingPatientId < 0) {
      body.existingPatientId = await resolveRemappedId('patient', body.existingPatientId);
    }
    if (typeof body.doctorId === 'number' && body.doctorId < 0) {
      body.doctorId = await resolveRemappedId('doctor', body.doctorId);
    }
    if (typeof body.category_id === 'number' && body.category_id < 0) {
      body.category_id = await resolveRemappedId('category', body.category_id);
    }
    if (Array.isArray(body.testIds)) {
      body.testIds = await Promise.all(
        (body.testIds as number[]).map((tid) => resolveRemappedId('test', Number(tid)))
      );
    }
    if (Array.isArray(body.addTestIds)) {
      body.addTestIds = await Promise.all(
        (body.addTestIds as number[]).map((tid) => resolveRemappedId('test', Number(tid)))
      );
    }
    if (Array.isArray(body.removeInvoiceTestIds)) {
      body.removeInvoiceTestIds = await Promise.all(
        (body.removeInvoiceTestIds as number[]).map((itId) => resolveRemappedId('invoiceTest', Number(itId)))
      );
    }
  }

  return { url, body };
}

async function handlePostSyncIdRemapAndCleanup(item: OfflineQueueItem, serverResponse: unknown) {
  if (!item.tempIds) return;

  if (item.entityType === 'invoice_create') {
    const full = serverResponse as FullInvoice;
    if (full?.invoice?.id && item.tempIds.invoiceId) {
      await recordIdRemap('invoice', item.tempIds.invoiceId, full.invoice.id);
      await idbDelete('invoices', item.tempIds.invoiceId);
      await idbDelete('fullInvoices', item.tempIds.invoiceId);
      await saveFullInvoiceLocal(full);
    }
    if (full?.invoice?.patient_id && item.tempIds.patientId) {
      await recordIdRemap('patient', item.tempIds.patientId, full.invoice.patient_id);
      await idbDelete('patients', item.tempIds.patientId);
    }
    if (Array.isArray(full?.tests) && item.tempIds.invoiceTestIdByTestId) {
      for (const [tempTestIdStr, tempInvoiceTestId] of Object.entries(
        item.tempIds.invoiceTestIdByTestId
      )) {
        const resolvedCatalogTestId = await resolveRemappedId('test', Number(tempTestIdStr));
        const realTest = full.tests.find((t) => Number(t.test_id) === resolvedCatalogTestId);
        if (realTest?.id) {
          await recordIdRemap('invoiceTest', Number(tempInvoiceTestId), realTest.id);
          await idbDelete('labQueue', Number(tempInvoiceTestId));
          await idbDelete('labTestDetails', Number(tempInvoiceTestId));
        }
      }
    }
  } else if (item.entityType === 'invoice_update') {
    const full = serverResponse as FullInvoice;
    if (Array.isArray(full?.tests) && item.tempIds.addedInvoiceTestIdsByTestId) {
      for (const [tempTestIdStr, tempInvoiceTestId] of Object.entries(
        item.tempIds.addedInvoiceTestIdsByTestId
      )) {
        const resolvedCatalogTestId = await resolveRemappedId('test', Number(tempTestIdStr));
        const realTest = full.tests.find((t) => Number(t.test_id) === resolvedCatalogTestId);
        if (realTest?.id) {
          await recordIdRemap('invoiceTest', Number(tempInvoiceTestId), realTest.id);
          await idbDelete('labQueue', Number(tempInvoiceTestId));
          await idbDelete('labTestDetails', Number(tempInvoiceTestId));
        }
      }
    }
  } else if (item.entityType === 'catalog_category_create' && item.tempIds.categoryId) {
    const created = serverResponse as { id?: number };
    if (created?.id) await recordIdRemap('category', item.tempIds.categoryId, created.id);
  } else if (item.entityType === 'catalog_test_create' && item.tempIds.testId) {
    const created = serverResponse as { id?: number };
    if (created?.id) await recordIdRemap('test', item.tempIds.testId, created.id);
  } else if (item.entityType === 'doctor_create' && item.tempIds.doctorId) {
    const created = serverResponse as { id?: number };
    if (created?.id) await recordIdRemap('doctor', item.tempIds.doctorId, created.id);
  } else if (item.entityType === 'expense_create' && item.tempIds.expenseId) {
    const created = serverResponse as { id?: number };
    if (created?.id) {
      await recordIdRemap('expense', item.tempIds.expenseId, created.id);
      await idbDelete('expenses', item.tempIds.expenseId);
    }
  } else if (item.entityType === 'other_revenue_create' && item.tempIds.otherRevenueId) {
    const created = serverResponse as { id?: number };
    if (created?.id) {
      await recordIdRemap('otherRevenue', item.tempIds.otherRevenueId, created.id);
      await idbDelete('otherRevenues', item.tempIds.otherRevenueId);
    }
  }
}

export async function processOfflineQueue(includeFailed = false): Promise<void> {
  if (typeof window === 'undefined') return;
  if (syncLoopPromise) return syncLoopPromise;
  if (!getLabToken()) return;

  syncLoopPromise = (async () => {
    try {
      const queue = await getSyncQueue();
      const targetItems = includeFailed ? queue : queue.filter((q) => q.status !== 'failed');
      if (targetItems.length === 0) {
        await refreshQueueSnapshot();
        return;
      }

      statusState = { ...statusState, isSyncing: true, lastSyncError: '' };
      emitStatus();

      let syncedAny = false;
      for (const item of targetItems) {
        if (!item.seq) continue;

        const { url, body } = await remapUrlAndBodyForSync(item);
        try {
          const res = await rawDirectFetch(
            url,
            {
              method: item.method,
              headers: {
                'X-Offline-Mutation-Id': item.clientMutationId,
              },
              body: body !== undefined ? JSON.stringify(body) : undefined,
            },
            15000
          );

          if (isServiceOfflineStatus(res.status)) {
            setOnlineFlag(false);
            break;
          }

          if (res.status === 401 || res.status === 403) {
            statusState = {
              ...statusState,
              lastSyncError: 'Authorization required to finish syncing queued items.',
            };
            break;
          }

          if (!res.ok) {
            const errBody = (await res.json().catch(() => ({}))) as { error?: string };
            await updateSyncQueueItem({
              ...item,
              retryCount: item.retryCount + 1,
              lastError: errBody.error || `Server rejected (${res.status})`,
              status: 'failed',
            });
            await refreshQueueSnapshot();
            continue;
          }

          const data = await res.json().catch(() => ({}));
          await handlePostSyncIdRemapAndCleanup(item, data);
          await removeSyncQueueItem(item.seq);
          syncedAny = true;
          await refreshQueueSnapshot();
        } catch (err) {
          if (isNetworkFailureError(err)) {
            setOnlineFlag(false);
            break;
          }
          await updateSyncQueueItem({
            ...item,
            retryCount: item.retryCount + 1,
            lastError: err instanceof Error ? err.message : 'Sync failed',
            status: 'failed',
          });
          await refreshQueueSnapshot();
        }
      }

      if (syncedAny) {
        statusState = { ...statusState, lastSyncedAt: Date.now() };
        await warmOfflineCache(true);
        broadcastPatientsUpdated();
        window.dispatchEvent(new CustomEvent(OFFLINE_SYNCED_EVENT));
      }
    } finally {
      statusState = { ...statusState, isSyncing: false };
      await refreshQueueSnapshot();
      syncLoopPromise = null;
    }
  })();

  return syncLoopPromise;
}

export async function retryOfflineQueue(): Promise<void> {
  const queue = await getSyncQueue();
  for (const item of queue) {
    if (item.status === 'failed') {
      await updateSyncQueueItem({ ...item, status: 'pending', lastError: undefined });
    }
  }
  await refreshQueueSnapshot();
  await processOfflineQueue(true);
}

export async function clearFailedQueueItems(): Promise<void> {
  const queue = await getSyncQueue();
  for (const item of queue) {
    if (item.status === 'failed' && item.seq) {
      await removeSyncQueueItem(item.seq);
    }
  }
  await refreshQueueSnapshot();
}

export async function warmOfflineCache(force = false): Promise<void> {
  if (typeof window === 'undefined' || !getLabToken()) return;
  if (!statusState.isOnline) return;
  if (!force && Date.now() - lastWarmAt < 180_000) return;
  if (warmPromise) return warmPromise;

  lastWarmAt = Date.now();
  warmPromise = (async () => {
    try {
      const isAdmin = Boolean(getAdminToken());
      const endpoints = [
        '/api/system/info',
        isAdmin ? '/api/catalog?includeInactive=1' : '/api/catalog',
        '/api/doctors',
        '/api/invoices',
        '/api/lab-queue',
        '/api/staff/overview',
      ];

      await Promise.allSettled(
        endpoints.map(async (ep) => {
          const res = await rawDirectFetch(ep, { method: 'GET' }, 10000);
          if (res.ok) {
            const data = await res.json();
            await mirrorOnlineGetResponse(ep, data);
          }
        })
      );

      // Quietly pre-warm full invoices & parameter forms for active pending patients so Lab Entry & Printing work 100% offline
      const queue = await getAllLabQueueLocal();
      const pendingItems = queue.filter((q) => q.status !== 'Ready').slice(0, 25);
      const pendingInvIds = Array.from(new Set(pendingItems.map((q) => q.invoice_id))).slice(0, 20);

      for (let i = 0; i < pendingInvIds.length; i += 4) {
        if (!statusState.isOnline) break;
        const batch = pendingInvIds.slice(i, i + 4);
        await Promise.allSettled(
          batch.map(async (invId) => {
            if (invId < 0) return;
            const res = await rawDirectFetch(`/api/invoices/${invId}`, { method: 'GET' }, 8000);
            if (res.ok) {
              const data = await res.json();
              await mirrorOnlineGetResponse(`/api/invoices/${invId}`, data);
            }
          })
        );
      }

      for (let i = 0; i < pendingItems.length; i += 4) {
        if (!statusState.isOnline) break;
        const batch = pendingItems.slice(i, i + 4);
        await Promise.allSettled(
          batch.map(async (qItem) => {
            if (qItem.id < 0) return;
            const res = await rawDirectFetch(`/api/lab-tests/${qItem.id}`, { method: 'GET' }, 8000);
            if (res.ok) {
              const data = await res.json();
              await mirrorOnlineGetResponse(`/api/lab-tests/${qItem.id}`, data);
            }
          })
        );
      }
    } catch {
      // non-fatal background warm failure
    } finally {
      warmPromise = null;
    }
  })();

  return warmPromise;
}

// -----------------------------------------------------------------------------
// Main Offline-First Fetch Entry Point
// -----------------------------------------------------------------------------
export async function offlineAwareApiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  ensureInitialized();
  const method = (options.method || 'GET').toUpperCase();

  // Handle offline immediate path when browser reports offline
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    setOnlineFlag(false);
    if (method === 'GET') {
      return serveOfflineGet<T>(url);
    }
    if (isSyncableLabMutation(url, method)) {
      const parsedBody =
        typeof options.body === 'string' ? (JSON.parse(options.body) as Record<string, unknown>) : undefined;
      return applyAndQueueOfflineMutation<T>(url, method as 'POST' | 'PUT' | 'DELETE', parsedBody);
    }
    throw new Error('Internet connection required for authentication.');
  }

  // Online attempt
  const reqHeaders = new Headers(options.headers || {});
  if (method !== 'GET' && method !== 'HEAD' && !reqHeaders.has('X-Offline-Mutation-Id')) {
    reqHeaders.set('X-Offline-Mutation-Id', createMutationId());
  }

  try {
    const res = await rawDirectFetch(url, { ...options, headers: reqHeaders });

    if (isServiceOfflineStatus(res.status)) {
      setOnlineFlag(false);
      if (method === 'GET') {
        return serveOfflineGet<T>(url);
      }
      if (isSyncableLabMutation(url, method)) {
        const parsedBody =
          typeof options.body === 'string' ? (JSON.parse(options.body) as Record<string, unknown>) : undefined;
        return applyAndQueueOfflineMutation<T>(url, method as 'POST' | 'PUT' | 'DELETE', parsedBody);
      }
    }

    const data = await parseApiResponse<T>(res);
    setOnlineFlag(true);

    if (method === 'GET') {
      void mirrorOnlineGetResponse(url, data);
      if (statusState.pendingCount > 0 && !statusState.isSyncing) {
        void processOfflineQueue();
      }
    } else if (isSyncableLabMutation(url, method)) {
      // Refresh background sync if queued items remain
      if (statusState.pendingCount > 0 && !statusState.isSyncing) {
        void processOfflineQueue();
      }
    }

    return data;
  } catch (err) {
    if (isNetworkFailureError(err)) {
      setOnlineFlag(false);
      if (method === 'GET') {
        return serveOfflineGet<T>(url);
      }
      if (isSyncableLabMutation(url, method)) {
        const parsedBody =
          typeof options.body === 'string' ? (JSON.parse(options.body) as Record<string, unknown>) : undefined;
        return applyAndQueueOfflineMutation<T>(url, method as 'POST' | 'PUT' | 'DELETE', parsedBody);
      }
    }
    throw err;
  }
}

export function formatOfflineQueueTimestamp(ts: string): string {
  if (!ts) return '';
  let normalized = ts.includes('T') ? ts : ts.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(normalized)) {
    normalized = `${normalized}${BANGLADESH_UTC_OFFSET}`;
  }
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString('en-US', {
    timeZone: BANGLADESH_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

// Keep unused idbGetAll import clean for diagnostics if needed
export async function getOfflineDiagnostics() {
  const [queue, invoices] = await Promise.all([getSyncQueue(), idbGetAll<InvoiceSummary>('invoices')]);
  return { queueCount: queue.length, cachedInvoicesCount: invoices.length };
}
