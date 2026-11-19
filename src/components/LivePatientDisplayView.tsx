import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Lock, RefreshCw, Users } from 'lucide-react';
import {
  apiFetch,
  BANGLADESH_TIMEZONE,
  BANGLADESH_UTC_OFFSET,
  clearLabTokens,
  getLabToken,
  resolveApiUrl,
  setAdminToken,
  setStaffToken,
} from '../lib/api.ts';
import {
  LIVE_SYNC_CHANNEL,
  type LiveSyncMessage,
  requestLabTokenFromParent,
} from '../lib/liveSync.ts';
import type { InvoiceSummary, LabSettings } from '../types.ts';
import { BrandLogo } from './BrandLogo.tsx';

interface LivePatientDisplayViewProps {
  settings: LabSettings;
}

function formatDhakaHeaderDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    timeZone: BANGLADESH_TIMEZONE,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDhakaClock(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    timeZone: BANGLADESH_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function formatCollectionTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const trimmed = ts.trim();
  if (!trimmed) return '—';

  let normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(normalized)) {
    normalized = `${normalized}${BANGLADESH_UTC_OFFSET}`;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return trimmed;

  return parsed.toLocaleTimeString('en-US', {
    timeZone: BANGLADESH_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export const LivePatientDisplayView: React.FC<LivePatientDisplayViewProps> = ({ settings }) => {
  const [authState, setAuthState] = useState<'checking' | 'authorized' | 'unauthorized'>('checking');
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [liveStatus, setLiveStatus] = useState<'live' | 'polling'>('polling');
  const [now, setNow] = useState<Date>(() => new Date());
  const [newRowIds, setNewRowIds] = useState<Set<number>>(() => new Set());

  const knownIdsRef = useRef<Set<number> | null>(null);
  const highlightTimersRef = useRef<Map<number, number>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const timers = highlightTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  // Keep top Bangladesh clock ticking every second
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  // Set clear browser window title for dual-monitor task switching
  useEffect(() => {
    document.title = `Live Patient Display — ${settings.lab_name}`;
  }, [settings.lab_name]);

  const markFreshRows = useCallback((rows: InvoiceSummary[]) => {
    if (knownIdsRef.current === null) {
      knownIdsRef.current = new Set(rows.map((r) => r.id));
      return;
    }

    const arrived: number[] = [];
    for (const r of rows) {
      if (!knownIdsRef.current.has(r.id)) {
        arrived.push(r.id);
      }
    }
    knownIdsRef.current = new Set(rows.map((r) => r.id));

    if (arrived.length === 0) return;

    setNewRowIds((prev) => {
      const next = new Set(prev);
      for (const id of arrived) next.add(id);
      return next;
    });

    for (const id of arrived) {
      const existingTimer = highlightTimersRef.current.get(id);
      if (existingTimer) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        if (!mountedRef.current) return;
        setNewRowIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        highlightTimersRef.current.delete(id);
      }, 8000);
      highlightTimersRef.current.set(id, timer);
    }
  }, []);

  const loadPatients = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await apiFetch<{ invoices: InvoiceSummary[] }>('/api/invoices?todayOnly=1');
        if (!mountedRef.current) return;
        const sorted = [...(res.invoices || [])].sort((a, b) => {
          if (b.id !== a.id) return b.id - a.id;
          return String(b.created_at || '').localeCompare(String(a.created_at || ''));
        });
        markFreshRows(sorted);
        setInvoices(sorted);
        setError('');
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : 'Unable to sync patient entries.';
        if (/unauthorized|authentication|401|token/i.test(msg)) {
          setAuthState('unauthorized');
          return;
        }
        setError(msg);
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [markFreshRows]
  );

  // Verify or obtain lab token from localStorage/sessionStorage or parent portal window
  useEffect(() => {
    let active = true;

    const verifyAndInit = async () => {
      let token = getLabToken();
      if (!token) {
        const received = await requestLabTokenFromParent(500);
        if (!active) return;
        if (received) {
          if (received.role === 'admin') {
            setAdminToken(received.token, false);
          } else {
            setStaffToken(received.token, false);
          }
          token = received.token;
        }
      }

      if (!token) {
        if (active) {
          setAuthState('unauthorized');
          setLoading(false);
        }
        return;
      }

      try {
        const verify = await apiFetch<{ authenticated: boolean }>('/api/auth/verify');
        if (!active) return;
        if (verify.authenticated) {
          setAuthState('authorized');
          await loadPatients(true);
        } else {
          clearLabTokens();
          setAuthState('unauthorized');
          setLoading(false);
        }
      } catch {
        if (active) {
          setAuthState('unauthorized');
          setLoading(false);
        }
      }
    };

    verifyAndInit();
    return () => {
      active = false;
    };
  }, [loadPatients]);

  // Multi-layer auto-refresh: SSE live stream + BroadcastChannel + Window Focus + 5s Fallback Polling
  useEffect(() => {
    if (authState !== 'authorized') return;

    const token = getLabToken();
    let eventSource: EventSource | null = null;
    if (token && typeof EventSource !== 'undefined') {
      try {
        const streamUrl = resolveApiUrl(`/api/lab/live-stream?token=${encodeURIComponent(token)}`);
        eventSource = new EventSource(streamUrl);
        eventSource.addEventListener('connected', () => {
          if (mountedRef.current) setLiveStatus('live');
        });
        eventSource.addEventListener('refresh', () => {
          void loadPatients(true);
        });
        eventSource.onerror = () => {
          if (mountedRef.current) setLiveStatus('polling');
        };
      } catch {
        setLiveStatus('polling');
      }
    }

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(LIVE_SYNC_CHANNEL);
        channel.onmessage = (event) => {
          const data = event.data as Partial<LiveSyncMessage> | null;
          if (data?.type === 'PATIENTS_UPDATED') {
            void loadPatients(true);
          } else if (data?.type === 'LAB_SIGNED_OUT') {
            clearLabTokens();
            if (mountedRef.current) setAuthState('unauthorized');
          }
        };
      } catch {
        channel = null;
      }
    }

    const onWindowMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Partial<LiveSyncMessage> | null;
      if (data?.type === 'PATIENTS_UPDATED') {
        void loadPatients(true);
      }
    };
    window.addEventListener('message', onWindowMessage);

    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        void loadPatients(true);
      }
    };
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);

    const pollInterval = window.setInterval(() => {
      void loadPatients(true);
    }, 5000);

    return () => {
      eventSource?.close();
      channel?.close();
      window.removeEventListener('message', onWindowMessage);
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
      window.clearInterval(pollInterval);
    };
  }, [authState, loadPatients]);

  const headerDateText = useMemo(() => formatDhakaHeaderDate(now), [now]);
  const headerTimeText = useMemo(() => formatDhakaClock(now), [now]);

  if (authState === 'checking') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-xl px-6 py-5 shadow-sm flex items-center gap-3 text-sm font-medium text-brand-navy">
          <RefreshCw className="w-4 h-4 animate-spin text-brand-cyan" />
          <span>Connecting Live Patient Entry Display...</span>
        </div>
      </div>
    );
  }

  if (authState === 'unauthorized') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 border-t-4 border-t-brand-navy rounded-xl shadow-sm p-6 text-center space-y-4">
          <div className="flex justify-center">
            <BrandLogo surface="light" className="h-12 w-auto" />
          </div>
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-red-50 border border-red-200 text-brand-red">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-brand-navy">Portal Session Required</h1>
            <p className="text-sm text-slate-600 mt-1">
              Sign in to the Admin Panel or Staff Portal first, then reopen Live Display from the navigation bar.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (window.opener && !window.opener.closed) {
                window.opener.focus();
                window.close();
              } else {
                window.location.href = '/';
              }
            }}
            className="w-full py-2.5 px-4 bg-brand-navy hover:bg-brand-navy-dark text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Return to LIMS Portal
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Slim, Unobtrusive Live Monitor Header */}
      <header className="sticky top-0 z-20 bg-brand-navy-dark border-b-2 border-b-brand-red text-white px-4 sm:px-6 py-2.5 shadow-sm">
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <BrandLogo surface="dark" className="h-9 w-auto shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-white truncate">
                  {settings.lab_name}
                </h1>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold bg-white/10 text-teal-200 border border-white/15 shrink-0">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      liveStatus === 'live' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-300'
                    }`}
                  />
                  Live Patient Display
                </span>
              </div>
              <p className="text-[11px] text-slate-300 truncate">{settings.lab_address}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4 text-xs shrink-0">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/10 border border-white/10">
              <Users className="w-3.5 h-3.5 text-teal-300" />
              <span className="font-semibold tabular-nums">{invoices.length}</span>
              <span className="text-slate-300">Today</span>
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 border border-white/10">
              <Clock className="w-3.5 h-3.5 text-teal-300 shrink-0" />
              <div className="flex items-center gap-2 tabular-nums">
                <span className="font-semibold text-white">{headerDateText}</span>
                <span className="text-white/30" aria-hidden="true">|</span>
                <span className="font-mono font-semibold text-teal-200">{headerTimeText}</span>
              </div>
              {refreshing && (
                <RefreshCw className="w-3 h-3 text-teal-300 animate-spin ml-0.5" aria-label="Syncing" />
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Live Scrolling Patient List */}
      <main className="flex-1 px-3 sm:px-5 py-3.5 max-w-[1600px] w-full mx-auto">
        {error && (
          <div className="mb-3 px-4 py-2 bg-red-50 border border-red-200 text-red-700 text-xs font-medium rounded-lg">
            {error}
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-brand-navy text-white text-xs font-semibold uppercase tracking-wider">
                  <th className="py-2.5 px-4 w-[145px] whitespace-nowrap">Patient ID</th>
                  <th className="py-2.5 px-4 min-w-[190px]">Patient Name</th>
                  <th className="py-2.5 px-4 min-w-[175px]">Referred By</th>
                  <th className="py-2.5 px-4">Ordered Tests</th>
                  <th className="py-2.5 px-4 w-[135px] text-right whitespace-nowrap">Collection Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {loading && invoices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-slate-500 text-sm">
                      Loading today&apos;s patient entries...
                    </td>
                  </tr>
                ) : invoices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-14 text-center text-slate-500">
                      <div className="font-semibold text-brand-navy text-base">
                        No patient entries recorded yet today
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        New patients registered at reception will appear automatically at the top of this screen.
                      </div>
                    </td>
                  </tr>
                ) : (
                  invoices.map((inv, idx) => {
                    const isFresh = newRowIds.has(inv.id);
                    const referredBy = inv.doctor_name?.trim() ? inv.doctor_name.trim() : 'Self';
                    const tests = (inv.test_items || []).map((t) => t.test_name).filter(Boolean);

                    return (
                      <tr
                        key={inv.id}
                        className={`transition-colors duration-700 ${
                          isFresh
                            ? 'bg-teal-50 border-l-4 border-l-brand-cyan'
                            : idx % 2 === 0
                              ? 'bg-white'
                              : 'bg-slate-50/75'
                        }`}
                      >
                        <td className="py-2.5 px-4 align-middle whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-brand-navy text-[13.5px] tabular-nums">
                              {inv.patient_uid}
                            </span>
                            {isFresh && (
                              <span className="px-1.5 py-0.5 rounded bg-brand-red text-white text-[10px] font-bold uppercase tracking-wide">
                                New
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="py-2.5 px-4 align-middle font-semibold text-slate-900 text-[15px] leading-snug">
                          {inv.patient_name}
                        </td>

                        <td className="py-2.5 px-4 align-middle text-slate-700 text-[13.5px] leading-snug">
                          {referredBy}
                        </td>

                        <td className="py-2.5 px-4 align-middle">
                          {tests.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {tests.map((testName, testIdx) => (
                                <span
                                  key={`${inv.id}-${testIdx}`}
                                  className="inline-block px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-800 text-xs font-medium leading-tight"
                                >
                                  {testName}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-slate-400 text-xs">—</span>
                          )}
                        </td>

                        <td className="py-2.5 px-4 align-middle text-right whitespace-nowrap font-mono font-semibold text-brand-navy text-[13px] tabular-nums">
                          {formatCollectionTime(inv.created_at)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
};
