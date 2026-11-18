import type { TestResultRow } from '../types.ts';

const TOKEN_KEY = 'alea_admin_token';
const STAFF_TOKEN_KEY = 'alea_staff_token';
const PATIENT_TOKEN_KEY = 'alea_patient_token';
const DOCTOR_TOKEN_KEY = 'alea_doctor_token';

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

export function getDoctorToken(): string | null {
  try {
    return localStorage.getItem(DOCTOR_TOKEN_KEY) || sessionStorage.getItem(DOCTOR_TOKEN_KEY);
  } catch {
    try {
      return sessionStorage.getItem(DOCTOR_TOKEN_KEY);
    } catch {
      return null;
    }
  }
}

export function setDoctorToken(token: string | null, rememberMe = true) {
  try {
    if (token) {
      if (rememberMe) {
        localStorage.setItem(DOCTOR_TOKEN_KEY, token);
        sessionStorage.removeItem(DOCTOR_TOKEN_KEY);
      } else {
        sessionStorage.setItem(DOCTOR_TOKEN_KEY, token);
        localStorage.removeItem(DOCTOR_TOKEN_KEY);
      }
    } else {
      localStorage.removeItem(DOCTOR_TOKEN_KEY);
      sessionStorage.removeItem(DOCTOR_TOKEN_KEY);
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

export async function doctorApiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getDoctorToken();
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

export const BANGLADESH_TIMEZONE = 'Asia/Dhaka';
export const BANGLADESH_UTC_OFFSET = '+06:00';

function getDhakaDateParts(date: Date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BANGLADESH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  const hour = map.hour === '24' ? '00' : map.hour || '00';
  return {
    year: map.year || '1970',
    month: map.month || '01',
    day: map.day || '01',
    hour,
    minute: map.minute || '00',
    second: map.second || '00',
  };
}

export function getBangladeshNowIso(date: Date = new Date()): string {
  const p = getDhakaDateParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${BANGLADESH_UTC_OFFSET}`;
}

export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const trimmed = ts.trim();
  if (!trimmed) return '—';

  // Pure YYYY-MM-DD date string -> format cleanly in Asia/Dhaka without midnight drift
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const dOnly = new Date(`${trimmed}T12:00:00${BANGLADESH_UTC_OFFSET}`);
    if (Number.isNaN(dOnly.getTime())) return trimmed;
    return dOnly.toLocaleDateString('en-GB', {
      timeZone: BANGLADESH_TIMEZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  let normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  // Bare DB timestamps without explicit Z or ±HH:MM offset represent Bangladesh Standard Time (+06:00)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(normalized)) {
    normalized = `${normalized}${BANGLADESH_UTC_OFFSET}`;
  }

  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('en-GB', {
    timeZone: BANGLADESH_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function getTodayISO(): string {
  const p = getDhakaDateParts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}

export function getMonthStartISO(): string {
  const p = getDhakaDateParts(new Date());
  return `${p.year}-${p.month}-01`;
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

export const DEFAULT_PUBLIC_BASE_URL = 'https://aleadiagnostic.com';

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


