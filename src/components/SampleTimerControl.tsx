import React, { useMemo, useRef, useState } from 'react';
import { BellRing, Clock, FlaskConical, Play, Plus, X } from 'lucide-react';
import {
  TIMER_PRESETS,
  formatCountdownMs,
  suggestDefaultTimerMinutes,
  useSampleTimers,
} from '../lib/sampleTimers.tsx';

interface SampleTimerControlProps {
  invoiceId: number;
  invoiceNo: string;
  patientUid: string;
  patientName: string;
  tests?: Array<{ id?: number; test_name: string }>;
  defaultTestName?: string;
  compact?: boolean;
  alignRight?: boolean;
}

export const SampleTimerControl: React.FC<SampleTimerControlProps> = ({
  invoiceId,
  invoiceNo,
  patientUid,
  patientName,
  tests,
  defaultTestName,
  compact = false,
  alignRight = true,
}) => {
  const {
    now,
    startTimer,
    cancelTimer,
    dismissTimer,
    getTimersForInvoice,
    onOpenLabForPatient,
  } = useSampleTimers();

  const invoiceTimers = getTimersForInvoice(invoiceId);
  const suggestion = useMemo(() => suggestDefaultTimerMinutes(tests), [tests]);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [selectedTest, setSelectedTest] = useState<string>(
    defaultTestName ?? suggestion.testName ?? ''
  );
  const [minutesInput, setMinutesInput] = useState<string>(String(suggestion.minutes));

  const computePopoverPos = () => {
    if (typeof window === 'undefined' || !triggerRef.current) return { top: 80, left: 24 };
    const rect = triggerRef.current.getBoundingClientRect();
    const popoverWidth = 288; // w-72
    const estimatedHeight = 310;
    const margin = 12;

    let left = alignRight ? rect.right - popoverWidth : rect.left;
    if (left + popoverWidth > window.innerWidth - margin) {
      left = window.innerWidth - popoverWidth - margin;
    }
    if (left < margin) {
      left = margin;
    }

    let top = rect.bottom + 6;
    if (top + estimatedHeight > window.innerHeight - margin) {
      const aboveTop = rect.top - estimatedHeight - 6;
      top = aboveTop >= margin ? aboveTop : Math.max(margin, window.innerHeight - estimatedHeight - margin);
    }
    return { top, left };
  };

  const openSetup = (e: React.MouseEvent) => {
    e.stopPropagation();
    const initialTest = defaultTestName ?? suggestion.testName ?? '';
    setSelectedTest(initialTest);
    const matchedTestSuggest = suggestDefaultTimerMinutes(
      initialTest ? [{ test_name: initialTest }] : tests
    );
    setMinutesInput(String(matchedTestSuggest.minutes));
    setPopoverPos(computePopoverPos());
    setPopoverOpen((prev) => !prev);
  };

  const handleStart = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const mins = Number(minutesInput);
    if (!Number.isFinite(mins) || mins <= 0) return;
    startTimer({
      invoiceId,
      invoiceNo,
      patientUid,
      patientName,
      testName: selectedTest || undefined,
      durationMinutes: mins,
    });
    setPopoverOpen(false);
  };

  const handlePresetStart = (e: React.MouseEvent, mins: number) => {
    e.stopPropagation();
    setMinutesInput(String(mins));
    startTimer({
      invoiceId,
      invoiceNo,
      patientUid,
      patientName,
      testName: selectedTest || undefined,
      durationMinutes: mins,
    });
    setPopoverOpen(false);
  };

  return (
    <div
      className="relative inline-flex flex-wrap items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Active / Finished Live Ticking Timers for this Patient */}
      {invoiceTimers.map((t) => {
        const remainingMs = t.endsAt - now;
        const isDone = remainingMs <= 0;
        const isUrgent = remainingMs > 0 && remainingMs <= 60_000;

        return (
          <div
            key={t.id}
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-semibold transition-colors ${
              isDone
                ? 'bg-emerald-100 text-emerald-900 border-emerald-400 shadow-sm'
                : isUrgent
                ? 'bg-amber-50 text-amber-900 border-amber-300 animate-pulse'
                : 'bg-teal-50 text-teal-900 border-teal-200'
            }`}
            title={
              isDone
                ? `Report time is done for ${t.patientName} (ID: ${t.patientUid})!`
                : `${t.testName || 'Sample Timer'} — ${formatCountdownMs(remainingMs)} remaining`
            }
          >
            {isDone ? (
              <BellRing className="w-3 h-3 text-emerald-700 shrink-0" />
            ) : (
              <Clock className="w-3 h-3 text-teal-700 shrink-0" />
            )}

            {t.testName && (
              <span className="max-w-[85px] truncate font-medium">{t.testName}</span>
            )}

            {isDone ? (
              <>
                <span className="font-bold">Done!</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenLabForPatient(t.invoiceId, t.testName);
                    dismissTimer(t.id);
                  }}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-bold bg-emerald-700 text-white rounded hover:bg-emerald-800 cursor-pointer"
                >
                  <FlaskConical className="w-2.5 h-2.5" />
                  <span>Enter</span>
                </button>
              </>
            ) : (
              <span className="font-mono tabular-nums font-bold">
                {formatCountdownMs(remainingMs)}
              </span>
            )}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                cancelTimer(t.id);
              }}
              title="Stop / Dismiss timer"
              aria-label="Stop timer"
              className="text-slate-500 hover:text-red-600 p-0.5 cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}

      {/* Start / Add Timer Trigger Button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={openSetup}
        title="Set custom sample countdown timer"
        className={`inline-flex items-center gap-1 rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
          invoiceTimers.length > 0
            ? 'px-1.5 py-0.5 text-[11px] font-medium text-slate-600 bg-white border-slate-200 hover:bg-slate-100'
            : compact
            ? 'px-2 py-1 text-[11px] font-semibold text-slate-700 bg-slate-50 border-slate-200 hover:bg-teal-50 hover:text-teal-800 hover:border-teal-300'
            : 'px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-white border-slate-300 hover:bg-teal-50 hover:text-teal-800 hover:border-teal-300'
        }`}
      >
        {invoiceTimers.length > 0 ? (
          <Plus className="w-3 h-3" />
        ) : (
          <>
            <Clock className="w-3.5 h-3.5 text-teal-700" />
            <span>Timer</span>
          </>
        )}
      </button>

      {/* Fixed Popover Custom Minutes Setup */}
      {popoverOpen && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            onClick={(e) => {
              e.stopPropagation();
              setPopoverOpen(false);
            }}
          />
          <form
            onSubmit={handleStart}
            onClick={(e) => e.stopPropagation()}
            style={{ top: `${popoverPos.top}px`, left: `${popoverPos.left}px` }}
            className="fixed z-[70] w-72 bg-white border border-slate-200 rounded-xl shadow-2xl p-3.5 space-y-3 text-left"
          >
            <div className="flex items-start justify-between gap-2 pb-2 border-b border-slate-100">
              <div className="min-w-0">
                <div className="text-xs font-bold text-slate-900 truncate">
                  Sample Timer · {patientName}
                </div>
                <div className="text-[11px] font-mono text-slate-500">
                  {patientUid} · {invoiceNo}
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPopoverOpen(false);
                }}
                className="text-slate-400 hover:text-slate-700 p-0.5"
                aria-label="Close timer setup"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {tests && tests.length > 0 && (
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                  Test / Sample
                </label>
                <select
                  value={selectedTest}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSelectedTest(val);
                    if (val) {
                      const nextSug = suggestDefaultTimerMinutes([{ test_name: val }]);
                      setMinutesInput(String(nextSug.minutes));
                    }
                  }}
                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  <option value="">General Patient Sample</option>
                  {tests.map((t, idx) => (
                    <option key={t.id ?? `${t.test_name}-${idx}`} value={t.test_name}>
                      {t.test_name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <div className="text-[11px] font-semibold text-slate-600 mb-1.5">
                Quick Presets (One-Click Start)
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {TIMER_PRESETS.map((p) => (
                  <button
                    key={p.minutes}
                    type="button"
                    onClick={(e) => handlePresetStart(e, p.minutes)}
                    className={`px-2 py-1.5 text-[11px] font-semibold rounded-lg border transition-colors text-center cursor-pointer ${
                      Number(minutesInput) === p.minutes
                        ? 'bg-teal-50 border-teal-500 text-teal-800'
                        : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-teal-50 hover:border-teal-300'
                    }`}
                  >
                    <div>{p.label}</div>
                    {p.hint && <div className="text-[9px] font-normal text-slate-500">{p.hint}</div>}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                  Custom Minutes
                </label>
                <input
                  type="number"
                  min={1}
                  max={720}
                  step="any"
                  value={minutesInput}
                  onChange={(e) => setMinutesInput(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  required
                />
              </div>
              <button
                type="submit"
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-3 h-3" />
                Start Timer
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
};
