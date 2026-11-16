import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellRing, Clock, FlaskConical, Volume2, VolumeX, X } from 'lucide-react';

export interface SampleTimerEntry {
  id: string;
  invoiceId: number;
  invoiceNo: string;
  patientUid: string;
  patientName: string;
  testName?: string;
  durationMinutes: number;
  startedAt: number;
  endsAt: number;
  completedAt?: number;
  alerted: boolean;
  dismissed: boolean;
}

export interface StartTimerInput {
  invoiceId: number;
  invoiceNo: string;
  patientUid: string;
  patientName: string;
  testName?: string;
  durationMinutes: number;
}

export const TIMER_PRESETS: Array<{ minutes: number; label: string; hint?: string }> = [
  { minutes: 5, label: '5m' },
  { minutes: 10, label: '10m', hint: 'RBS' },
  { minutes: 15, label: '15m' },
  { minutes: 30, label: '30m', hint: 'Slide' },
  { minutes: 60, label: '60m', hint: 'ESR' },
  { minutes: 120, label: '120m', hint: '2HABF' },
];

const TIMERS_STORAGE_KEY = 'alea_sample_timers_v1';
const SOUND_STORAGE_KEY = 'alea_timer_sound_enabled_v1';

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctor();
  }
  return sharedAudioCtx;
}

export function unlockTimerAudio(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  } catch {
    // ignore audio unlock errors
  }
}

export function playSubtleTimerChime(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    const playTone = (freq: number, startOffset: number, duration: number, peakGain: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.0001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(peakGain, now + startOffset + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };

    // Soft two-note clinical chime (A5 -> E6)
    playTone(880, 0, 0.28, 0.12);
    playTone(1318.5, 0.16, 0.42, 0.14);
  } catch {
    // ignore Web Audio failure
  }
}

export function formatCountdownMs(remainingMs: number): string {
  const totalSecs = Math.max(0, Math.ceil(remainingMs / 1000));
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function suggestDefaultTimerMinutes(tests?: Array<{ test_name: string }>): {
  minutes: number;
  testName?: string;
} {
  if (!tests || tests.length === 0) return { minutes: 15 };
  for (const t of tests) {
    const n = t.test_name.toLowerCase();
    if (n.includes('2habf') || n.includes('2 hours') || n.includes('75g') || n.includes('ogtt')) {
      return { minutes: 120, testName: t.test_name };
    }
    if (n.includes('esr') || n.includes('cbc') || n.includes('complete blood')) {
      return { minutes: 60, testName: t.test_name };
    }
    if (n.includes('rbs') || n.includes('glucose') || n.includes('sugar')) {
      return { minutes: 10, testName: t.test_name };
    }
  }
  return { minutes: 15, testName: tests[0]?.test_name };
}

function loadInitialTimers(): SampleTimerEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TIMERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Prune dismissed/very old completed timers (> 12 hours old)
    const cutoff = Date.now() - 12 * 3600 * 1000;
    return parsed.filter(
      (item): item is SampleTimerEntry =>
        Boolean(item && typeof item.id === 'string' && typeof item.invoiceId === 'number' && !item.dismissed && item.endsAt > cutoff)
    );
  } catch {
    return [];
  }
}

function loadSoundPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(SOUND_STORAGE_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

interface SampleTimerContextValue {
  timers: SampleTimerEntry[];
  now: number;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  startTimer: (input: StartTimerInput) => SampleTimerEntry;
  cancelTimer: (timerId: string) => void;
  dismissTimer: (timerId: string) => void;
  getTimersForInvoice: (invoiceId: number) => SampleTimerEntry[];
  activeRunningCount: number;
  pendingAlertCount: number;
  onOpenLabForPatient: (invoiceId: number, testName?: string) => void;
}

const SampleTimerContext = createContext<SampleTimerContextValue | null>(null);

export const SampleTimerProvider: React.FC<{
  children: React.ReactNode;
  onOpenLabForPatient: (invoiceId: number, testName?: string) => void;
}> = ({ children, onOpenLabForPatient }) => {
  const [timers, setTimers] = useState<SampleTimerEntry[]>(loadInitialTimers);
  const [now, setNow] = useState<number>(() => Date.now());
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(loadSoundPreference);
  const soundEnabledRef = useRef(soundEnabled);
  const onOpenLabRef = useRef(onOpenLabForPatient);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    try {
      window.localStorage.setItem(SOUND_STORAGE_KEY, soundEnabled ? '1' : '0');
    } catch {
      // ignore
    }
  }, [soundEnabled]);

  useEffect(() => {
    onOpenLabRef.current = onOpenLabForPatient;
  }, [onOpenLabForPatient]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TIMERS_STORAGE_KEY, JSON.stringify(timers));
    } catch {
      // ignore
    }
  }, [timers]);

  // 1-second ticker when any timer exists
  useEffect(() => {
    if (timers.length === 0) return;
    setNow(Date.now());
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [timers.length]);

  // Trigger browser notification + optional audio chime cleanly once when timer hits zero
  useEffect(() => {
    const newlyCompleted = timers.filter((t) => !t.alerted && !t.dismissed && now >= t.endsAt);
    if (newlyCompleted.length === 0) return;

    setTimers((prev) =>
      prev.map((t) =>
        !t.alerted && !t.dismissed && now >= t.endsAt
          ? { ...t, alerted: true, completedAt: now }
          : t
      )
    );

    if (soundEnabledRef.current) {
      playSubtleTimerChime();
    }

    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      for (const timer of newlyCompleted) {
        try {
          const bodyText = `Report time is done for ${timer.patientName} (ID: ${timer.patientUid})!${
            timer.testName ? ` [${timer.testName}]` : ''
          }`;
          const notif = new Notification('Alea Diagnostic Services · Timer Complete', {
            body: bodyText,
            tag: `alea-timer-${timer.id}`,
            requireInteraction: true,
          });
          notif.onclick = () => {
            window.focus();
            onOpenLabRef.current(timer.invoiceId, timer.testName);
            notif.close();
          };
        } catch {
          // ignore browser notification errors in restricted contexts
        }
      }
    }
  }, [timers, now]);

  const startTimer = useCallback((input: StartTimerInput): SampleTimerEntry => {
    unlockTimerAudio();
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    const mins = Math.max(0.1, Number(input.durationMinutes || 1));
    const startedAt = Date.now();
    const endsAt = startedAt + Math.round(mins * 60 * 1000);
    const cleanTest = input.testName?.trim() || undefined;
    const keySuffix = cleanTest ? cleanTest.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'general';
    const entry: SampleTimerEntry = {
      id: `${input.invoiceId}-${keySuffix}-${startedAt}`,
      invoiceId: input.invoiceId,
      invoiceNo: input.invoiceNo,
      patientUid: input.patientUid,
      patientName: input.patientName,
      testName: cleanTest,
      durationMinutes: mins,
      startedAt,
      endsAt,
      alerted: false,
      dismissed: false,
    };

    setTimers((prev) => {
      // Replace existing active timer for same invoice + test label if restarted, otherwise append
      const filtered = prev.filter(
        (t) => !(t.invoiceId === input.invoiceId && (t.testName || '') === (cleanTest || '') && !t.dismissed)
      );
      return [entry, ...filtered];
    });
    setNow(startedAt);
    return entry;
  }, []);

  const cancelTimer = useCallback((timerId: string) => {
    setTimers((prev) => prev.filter((t) => t.id !== timerId));
  }, []);

  const dismissTimer = useCallback((timerId: string) => {
    setTimers((prev) => prev.filter((t) => t.id !== timerId));
  }, []);

  const getTimersForInvoice = useCallback(
    (invoiceId: number) => timers.filter((t) => t.invoiceId === invoiceId && !t.dismissed),
    [timers]
  );

  const activeRunningCount = useMemo(
    () => timers.filter((t) => !t.dismissed && now < t.endsAt).length,
    [timers, now]
  );

  const pendingAlertCount = useMemo(
    () => timers.filter((t) => !t.dismissed && now >= t.endsAt).length,
    [timers, now]
  );

  const value = useMemo<SampleTimerContextValue>(
    () => ({
      timers: timers.filter((t) => !t.dismissed),
      now,
      soundEnabled,
      setSoundEnabled: setSoundEnabledState,
      startTimer,
      cancelTimer,
      dismissTimer,
      getTimersForInvoice,
      activeRunningCount,
      pendingAlertCount,
      onOpenLabForPatient,
    }),
    [
      timers,
      now,
      soundEnabled,
      startTimer,
      cancelTimer,
      dismissTimer,
      getTimersForInvoice,
      activeRunningCount,
      pendingAlertCount,
      onOpenLabForPatient,
    ]
  );

  return <SampleTimerContext.Provider value={value}>{children}</SampleTimerContext.Provider>;
};

export function useSampleTimers(): SampleTimerContextValue {
  const ctx = useContext(SampleTimerContext);
  if (!ctx) {
    throw new Error('useSampleTimers must be used inside SampleTimerProvider');
  }
  return ctx;
}

/** Floating desktop-style popup toast stack inside the app whenever any timer finishes */
export const SampleTimerNotificationTray: React.FC = () => {
  const { timers, now, soundEnabled, setSoundEnabled, dismissTimer, onOpenLabForPatient } = useSampleTimers();
  const completedAlerts = timers.filter((t) => now >= t.endsAt);

  if (completedAlerts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2.5 max-w-sm w-[calc(100vw-2rem)] no-print"
      role="status"
      aria-live="assertive"
    >
      {completedAlerts.map((alert) => (
        <div
          key={alert.id}
          className="bg-white border-2 border-emerald-500 rounded-xl shadow-2xl p-4 space-y-2.5 animate-in fade-in slide-in-from-bottom-2"
        >
          <div className="flex items-start justify-between gap-2.5">
            <div className="flex items-start gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                <BellRing className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">
                  Sample Timer Complete
                </div>
                <p className="text-sm font-bold text-slate-900 leading-snug mt-0.5">
                  Report time is done for {alert.patientName} (ID: {alert.patientUid})!
                </p>
                <div className="text-xs text-slate-600 mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="font-mono font-semibold text-slate-700">{alert.invoiceNo}</span>
                  {alert.testName && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-teal-700">{alert.testName}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span>{alert.durationMinutes} min elapsed</span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => dismissTimer(alert.id)}
              className="text-slate-400 hover:text-slate-700 p-0.5 shrink-0"
              aria-label="Dismiss notification"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setSoundEnabled(!soundEnabled)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-800"
              title={soundEnabled ? 'Mute timer chime' : 'Enable timer chime'}
            >
              {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              <span>{soundEnabled ? 'Sound On' : 'Muted'}</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => dismissTimer(alert.id)}
                className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => {
                  onOpenLabForPatient(alert.invoiceId, alert.testName);
                  dismissTimer(alert.id);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors"
              >
                <FlaskConical className="w-3.5 h-3.5" />
                Enter Result
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

/** Compact Top-Bar Running Timer Status Indicator */
export const TopBarTimerSummary: React.FC = () => {
  const { timers, now, soundEnabled, setSoundEnabled, onOpenLabForPatient, dismissTimer } = useSampleTimers();
  const [open, setOpen] = useState(false);

  if (timers.length === 0) {
    return (
      <button
        type="button"
        onClick={() => setSoundEnabled(!soundEnabled)}
        title={soundEnabled ? 'Timer Sound Alerts On (click to mute)' : 'Timer Sound Alerts Muted (click to enable)'}
        className="hidden md:inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
      >
        {soundEnabled ? <Volume2 className="w-3.5 h-3.5 text-teal-700" /> : <VolumeX className="w-3.5 h-3.5 text-slate-400" />}
      </button>
    );
  }

  const completed = timers.filter((t) => now >= t.endsAt);
  const running = timers.filter((t) => now < t.endsAt);
  const soonest = [...running].sort((a, b) => a.endsAt - b.endsAt)[0];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
          completed.length > 0
            ? 'bg-emerald-50 text-emerald-800 border-emerald-400 animate-pulse'
            : 'bg-teal-50 text-teal-800 border-teal-200 hover:bg-teal-100'
        }`}
      >
        {completed.length > 0 ? <BellRing className="w-3.5 h-3.5" /> : <Clock className="w-3.5 h-3.5" />}
        {completed.length > 0 ? (
          <span>{completed.length} Timer Done!</span>
        ) : (
          <span className="font-mono tabular-nums">
            {running.length} Active · {formatCountdownMs(soonest.endsAt - now)}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 bg-white border border-slate-200 rounded-xl shadow-xl z-50 p-3 space-y-2.5">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                <Bell className="w-3.5 h-3.5 text-teal-700" />
                Active Sample Timers ({timers.length})
              </div>
              <button
                type="button"
                onClick={() => setSoundEnabled(!soundEnabled)}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-600 bg-slate-100 rounded hover:bg-slate-200"
              >
                {soundEnabled ? <Volume2 className="w-3 h-3 text-teal-700" /> : <VolumeX className="w-3 h-3" />}
                <span>{soundEnabled ? 'Sound On' : 'Muted'}</span>
              </button>
            </div>

            <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
              {timers.map((t) => {
                const remaining = t.endsAt - now;
                const isDone = remaining <= 0;
                return (
                  <div key={t.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 truncate">{t.patientName}</div>
                      <div className="text-[11px] text-slate-500 font-mono truncate">
                        {t.patientUid} {t.testName ? `· ${t.testName}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {isDone ? (
                        <button
                          type="button"
                          onClick={() => {
                            onOpenLabForPatient(t.invoiceId, t.testName);
                            dismissTimer(t.id);
                            setOpen(false);
                          }}
                          className="px-2 py-1 text-[11px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded"
                        >
                          Enter
                        </button>
                      ) : (
                        <span className="font-mono tabular-nums font-bold text-teal-800 bg-teal-50 px-2 py-0.5 rounded border border-teal-200">
                          {formatCountdownMs(remaining)}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => dismissTimer(t.id)}
                        className="text-slate-400 hover:text-red-600 p-0.5"
                        aria-label="Remove timer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
