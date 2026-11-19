import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Lock, RefreshCw, Users } from 'lucide-react';
import {
  apiFetch,
  BANGLADESH_TIMEZONE,
  BANGLADESH_UTC_OFFSET,
  clearLabTokens,
  getLabToken,
  getTodayISO,
  resolveApiUrl,
  setAdminToken,
  setStaffToken,
} from '../lib/api.ts';
import {
  LIVE_SYNC_CHANNEL,
  type LiveSyncMessage,
  requestLabTokenFromParent,
  requestTimersFromParent,
} from '../lib/liveSync.ts';
import {
  formatCountdownMs,
  readStoredSampleTimers,
  type SampleTimerEntry,
  TIMERS_STORAGE_KEY,
} from '../lib/sampleTimers.tsx';
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

function formatCollectionTime(ts: string | null | undefined, todayIso: string): string {
  if (!ts) return '—';
  const trimmed = ts.trim();
  if (!trimmed) return '—';

  let normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(normalized)) {
    normalized = `${normalized}${BANGLADESH_UTC_OFFSET}`;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return trimmed;

  const entryDateIso = parsed.toLocaleDateString('en-CA', {
    timeZone: BANGLADESH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const timeStr = parsed.toLocaleTimeString('en-US', {
    timeZone: BANGLADESH_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (entryDateIso === todayIso) {
    return timeStr;
  }

  const dayMonthStr = parsed.toLocaleDateString('en-GB', {
    timeZone: BANGLADESH_TIMEZONE,
    day: '2-digit',
    month: 'short',
  });
  return `${dayMonthStr}, ${timeStr}`;
}

function extractNumericInvoiceNo(invoiceNo: string | null | undefined): string {
  const raw = (invoiceNo || '').trim();
  if (!raw) return '—';
  const digits = raw.replace(/\D+/g, '');
  return digits || raw;
}

function isInvoicePending(inv: InvoiceSummary): boolean {
  const items = inv.test_items || [];
  if (items.length > 0) {
    return items.some((t) => t.status !== 'Ready');
  }
  const total = Number(inv.total_tests || 0);
  const ready = Number(inv.ready_tests || 0);
  return total > 0 && ready < total;
}

export const LivePatientDisplayView: React.FC<LivePatientDisplayViewProps> = ({ settings }) => {
  const [authState, setAuthState] = useState<'checking' | 'authorized' | 'unauthorized'>('checking');
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [timers, setTimers] = useState<SampleTimerEntry[]>(readStoredSampleTimers);
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
    const activeTimers = highlightTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const timer of activeTimers.values()) {
        window.clearTimeout(timer);
      }
      activeTimers.clear();
    };
  }, []);

  // Keep header clock & live countdown timers ticking every second
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  // Set clear browser window title for dual-monitor task switching
  useEffect(() => {
    document.title = `Live Pending Queue — ${settings.lab_name}`;
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
        const res = await apiFetch<{ invoices: InvoiceSummary[] }>('/api/invoices');
        if (!mountedRef.current) return;
        const pendingOnly = (res.invoices || [])
          .filter(isInvoicePending)
          .sort((a, b) => {
            if (b.id !== a.id) return b.id - a.id;
            return String(b.created_at || '').localeCompare(String(a.created_at || ''));
          });
        markFreshRows(pendingOnly);
        setInvoices(pendingOnly);
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

  // Multi-layer auto-refresh for pending patients AND active sample timers
  useEffect(() => {
    if (authState !== 'authorized') return;

    // Request latest active timers from main portal immediately
    requestTimersFromParent();

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

    const handleSyncMessage = (data: Partial<LiveSyncMessage> | null) => {
      if (!data) return;
      if (data.type === 'PATIENTS_UPDATED') {
        void loadPatients(true);
      } else if (data.type === 'TIMERS_UPDATED' && Array.isArray(data.timers)) {
        if (mountedRef.current) {
          setTimers(data.timers.filter((t) => !t.dismissed));
        }
      } else if (data.type === 'LAB_SIGNED_OUT') {
        clearLabTokens();
        if (mountedRef.current) setAuthState('unauthorized');
      }
    };

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(LIVE_SYNC_CHANNEL);
        channel.onmessage = (event) => {
          handleSyncMessage(event.data as Partial<LiveSyncMessage> | null);
        };
      } catch {
        channel = null;
      }
    }

    const onWindowMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      handleSyncMessage(event.data as Partial<LiveSyncMessage> | null);
    };
    window.addEventListener('message', onWindowMessage);

    const onStorageChange = (event: StorageEvent) => {
      if (event.key === TIMERS_STORAGE_KEY && mountedRef.current) {
        setTimers(readStoredSampleTimers());
      }
    };
    window.addEventListener('storage', onStorageChange);

    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        void loadPatients(true);
        if (mountedRef.current) {
          setTimers(readStoredSampleTimers());
        }
        requestTimersFromParent();
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
      window.removeEventListener('storage', onStorageChange);
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
      window.clearInterval(pollInterval);
    };
  }, [authState, loadPatients]);

  const timersByInvoice = useMemo(() => {
    const map = new Map<number, SampleTimerEntry[]>();
    for (const t of timers) {
      if (t.dismissed) continue;
      const list = map.get(t.invoiceId) || [];
      list.push(t);
      map.set(t.invoiceId, list);
    }
    for (const [invId, list] of map.entries()) {
      list.sort((a, b) => a.endsAt - b.endsAt);
      map.set(invId, list);
    }
    return map;
  }, [timers]);

  const nowMs = now.getTime();
  const todayIso = useMemo(() => getTodayISO(), []);
  const headerDateText = useMemo(() => formatDhakaHeaderDate(now), [now]);
  const headerTimeText = useMemo(() => formatDhakaClock(now), [now]);

  if (authState === 'checking') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-xl px-6 py-5 shadow-sm flex items-center gap-3 text-sm font-medium text-brand-navy">
          <RefreshCw className="w-4 h-4 animate-spin text-brand-cyan" />
          <span>Connecting Live Patient Display...</span>
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
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col select-none">
      {/* Ultra-Compact Single-Line Live Status Bar */}
      <header className="sticky top-0 z-20 bg-brand-navy-dark border-b-2 border-b-brand-red text-white px-3 py-1">
        <div className="w-full flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold bg-white/10 text-teal-200 border border-white/15 shrink-0 leading-tight">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                liveStatus === 'live' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-300'
              }`}
            />
            Pending Reports Live
          </span>

          <div className="flex items-center gap-2 text-[11.5px] shrink-0">
            <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-white/10 border border-white/10 leading-tight">
              <Users className="w-3 h-3 text-teal-300" />
              <span className="font-bold tabular-nums">{invoices.length}</span>
              <span className="text-slate-300">Pending</span>
            </div>

            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/10 border border-white/10 leading-tight">
              <Clock className="w-3 h-3 text-teal-300 shrink-0" />
              <div className="flex items-center gap-1.5 tabular-nums">
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

      {/* Flush Full-Width Pending Patient List */}
      <main className="flex-1 p-0 m-0 w-full">
        {error && (
          <div className="px-3 py-1 bg-red-50 border-b border-red-200 text-red-700 text-xs font-medium">
            {error}
          </div>
        )}

        <div className="bg-white w-full overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse table-auto">
              <thead>
                <tr className="bg-brand-navy text-white text-[10.5px] font-bold uppercase tracking-wider leading-tight">
                  <th className="py-1 pl-3 pr-2 w-[1%] whitespace-nowrap">INV NO</th>
                  <th className="py-1 px-2 w-[1%] whitespace-nowrap">PATIENT NAME</th>
                  <th className="py-1 px-2 w-[1%] whitespace-nowrap">REFERRED BY</th>
                  <th className="py-1 px-2">ORDERED TESTS</th>
                  <th className="py-1 pl-2 pr-3 w-[1%] text-right whitespace-nowrap">COLLECTION TIME</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-[13px]">
                {loading && invoices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500 text-xs">
                      Loading pending patient reports...
                    </td>
                  </tr>
                ) : invoices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-slate-500">
                      <div className="font-semibold text-brand-navy text-sm">
                        All reports are finalized — no pending patients
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        Newly registered patients with pending tests will appear here automatically.
                      </div>
                    </td>
                  </tr>
                ) : (
                  invoices.map((inv, idx) => {
                    const isFresh = newRowIds.has(inv.id);
                    const referredBy = inv.doctor_name?.trim() ? inv.doctor_name.trim() : 'Self';
                    const testItems = (inv.test_items || []).filter((t) => Boolean(t.test_name));
                    const activeTimers = timersByInvoice.get(inv.id) || [];

                    return (
                      <tr
                        key={inv.id}
                        className={`transition-colors duration-500 ${
                          isFresh
                            ? 'bg-teal-50/90 border-l-4 border-l-brand-cyan'
                            : idx % 2 === 0
                              ? 'bg-white'
                              : 'bg-slate-50/75'
                        }`}
                      >
                        <td className="py-1.5 pl-3 pr-2 w-[1%] align-middle whitespace-nowrap font-mono font-bold text-brand-navy text-[13px] tabular-nums">
                          {extractNumericInvoiceNo(inv.invoice_no)}
                        </td>

                        <td className="py-1.5 px-2 w-[1%] align-middle whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span
                              className="font-semibold text-slate-900 text-[13.5px] leading-tight max-w-[235px] truncate"
                              title={inv.patient_name}
                            >
                              {inv.patient_name}
                            </span>
                            {activeTimers.map((t) => {
                              const remainingMs = t.endsAt - nowMs;
                              const isDone = remainingMs <= 0;
                              return (
                                <span
                                  key={t.id}
                                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[11px] font-bold leading-none tabular-nums shrink-0 ${
                                    isDone
                                      ? 'bg-red-50 border-brand-red text-brand-red animate-pulse'
                                      : 'bg-teal-50 border-teal-300 text-teal-800'
                                  }`}
                                  title={t.testName ? `Active timer (${t.testName})` : 'Active sample timer'}
                                >
                                  <Clock className="w-3 h-3 shrink-0" />
                                  <span>{isDone ? '00:00' : formatCountdownMs(remainingMs)}</span>
                                </span>
                              );
                            })}
                          </div>
                        </td>

                        <td className="py-1.5 px-2 w-[1%] align-middle whitespace-nowrap">
                          <span
                            className="block text-slate-700 text-[12.5px] leading-tight max-w-[185px] truncate"
                            title={referredBy}
                          >
                            {referredBy}
                          </span>
                        </td>

                        <td className="py-1.5 px-2 align-middle">
                          {testItems.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1">
                              {testItems.map((item, testIdx) => {
                                const isSubReady = item.status === 'Ready';
                                return (
                                  <span
                                    key={`${inv.id}-${item.id || testIdx}`}
                                    className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11.5px] font-medium leading-tight whitespace-nowrap ${
                                      isSubReady
                                        ? 'bg-emerald-50/80 border-emerald-200 text-emerald-700 line-through decoration-emerald-400/70'
                                        : 'bg-slate-100 border-slate-200 text-slate-800'
                                    }`}
                                  >
                                    {item.test_name}
                                  </span>
                                );
                              })}
                            </div>
                          ) : (
                            <span className="text-slate-400 text-xs">—</span>
                          )}
                        </td>

                        <td className="py-1.5 pl-2 pr-3 w-[1%] align-middle text-right whitespace-nowrap font-mono font-semibold text-brand-navy text-[12px] tabular-nums">
                          {formatCollectionTime(inv.created_at, todayIso)}
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
