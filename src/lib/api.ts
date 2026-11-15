import type { TestResultRow } from '../types.ts';

const TOKEN_KEY = 'alea_admin_token';
const STAFF_TOKEN_KEY = 'alea_staff_token';
const PATIENT_TOKEN_KEY = 'alea_patient_token';

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null) {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.removeItem(STAFF_TOKEN_KEY);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function getStaffToken(): string | null {
  try {
    return sessionStorage.getItem(STAFF_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStaffToken(token: string | null) {
  try {
    if (token) {
      sessionStorage.setItem(STAFF_TOKEN_KEY, token);
      sessionStorage.removeItem(TOKEN_KEY);
    } else {
      sessionStorage.removeItem(STAFF_TOKEN_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function getLabToken(): string | null {
  return getAdminToken() || getStaffToken();
}

export function clearLabTokens() {
  setAdminToken(null);
  setStaffToken(null);
}

export function getPatientToken(): string | null {
  try {
    return sessionStorage.getItem(PATIENT_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setPatientToken(token: string | null) {
  try {
    if (token) {
      sessionStorage.setItem(PATIENT_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(PATIENT_TOKEN_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export function resolveApiUrl(url: string): string {
  if (!API_BASE || /^https?:\/\//i.test(url)) return url;
  return `${API_BASE}${url.startsWith('/') ? url : `/${url}`}`;
}

async function parseApiResponse<T>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok && !contentType.includes('application/json')) {
    if (res.status === 404 || res.status === 405) {
      throw new Error(
        'Backend API server is not connected on this static host. Start the Node.js LIMS server or configure VITE_API_BASE_URL.'
      );
    }
    throw new Error(`Request failed (${res.status})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getLabToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(resolveApiUrl(url), { ...options, headers });
  return parseApiResponse<T>(res);
}

export async function patientApiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getPatientToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(resolveApiUrl(url), { ...options, headers });
  return parseApiResponse<T>(res);
}

export function formatBDT(amount: number | undefined | null): string {
  const val = Number(amount || 0);
  return `৳ ${val.toLocaleString('en-BD', { minimumFractionDigits: val % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function formatAge(years: number, months = 0, days = 0): string {
  const parts: string[] = [];
  if (years > 0) parts.push(`${years}Y`);
  if (months > 0) parts.push(`${months}M`);
  if (days > 0) parts.push(`${days}D`);
  return parts.length > 0 ? parts.join(' ') : '0Y';
}

export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const normalized = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function getTodayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getMonthStartISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

export function evaluateClientFlag(
  value: string,
  row: TestResultRow,
  gender: string,
  ageYears: number,
  ageMonths = 0,
  ageDays = 0
): 'Normal' | 'High' | 'Low' | 'Abnormal' {
  const trimmed = value.trim();
  if (!trimmed) return 'Normal';

  if ((row.input_type || 'numeric') === 'numeric') {
    const num = Number(trimmed.replace(/,/g, ''));
    if (!Number.isNaN(num)) {
      let min = row.min_male ?? null;
      let max = row.max_male ?? null;
      const isNewborn = ageYears === 0 && ageMonths === 0 && ageDays <= 28;
      if (isNewborn && (row.min_newborn != null || row.max_newborn != null)) {
        min = row.min_newborn ?? null;
        max = row.max_newborn ?? null;
      } else if (ageYears < 12 && (row.min_child != null || row.max_child != null)) {
        min = row.min_child ?? null;
        max = row.max_child ?? null;
      } else if (gender.toLowerCase() === 'female' && (row.min_female != null || row.max_female != null)) {
        min = row.min_female ?? null;
        max = row.max_female ?? null;
      }
      if (min !== null && num < min) return 'Low';
      if (max !== null && num > max) return 'High';
      return 'Normal';
    }
  }

  if (row.abnormal_values) {
    const list = row.abnormal_values
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (list.includes(trimmed.toLowerCase())) return 'Abnormal';
  }
  return 'Normal';
}

export const DEFAULT_PUBLIC_BASE_URL = 'https://alea-diagnostic-services.onrender.com';

export function resolvePublicBaseUrl(serverBaseUrl?: string | null): string {
  const configured =
    (serverBaseUrl || '').trim() ||
    (import.meta.env.VITE_BASE_URL || '').trim() ||
    DEFAULT_PUBLIC_BASE_URL;
  return configured.replace(/\/+$/, '');
}

export function buildPatientReportQrUrl(
  patientQrToken?: string | null,
  patientUid?: string | null,
  invoiceId?: number | null,
  testId?: number | null,
  baseUrlOverride?: string | null
): string {
  if (!patientQrToken) return '';
  const baseUrl = resolvePublicBaseUrl(baseUrlOverride);
  const params = new URLSearchParams();
  if (patientUid) params.set('id', patientUid);
  params.set('token', patientQrToken);
  if (invoiceId && invoiceId > 0) params.set('inv', String(invoiceId));
  if (testId && testId > 0) params.set('test', String(testId));

  return `${baseUrl}/view-report?${params.toString()}`;
}


