import {
  getDoctorToken,
  getPatientToken,
  parseApiResponse,
  resolveApiUrl,
} from './apiBase.ts';
import { offlineAwareApiFetch } from './offlineEngine.ts';

export * from './apiBase.ts';

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  return offlineAwareApiFetch<T>(url, options);
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
