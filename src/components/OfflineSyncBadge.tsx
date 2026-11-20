import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  RefreshCw,
  Trash2,
  WifiOff,
} from 'lucide-react';
import {
  clearFailedQueueItems,
  formatOfflineQueueTimestamp,
  probeServerConnectivity,
  processOfflineQueue,
  retryOfflineQueue,
  useSyncStatus,
} from '../lib/offlineEngine.ts';

interface OfflineSyncBadgeProps {
  variant?: 'light' | 'dark';
  compact?: boolean;
}

export const OfflineSyncBadge: React.FC<OfflineSyncBadgeProps> = ({
  variant = 'light',
  compact = false,
}) => {
  const status = useSyncStatus();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const totalQueued = status.pendingCount + status.failedCount;
  const isDark = variant === 'dark';

  const handleManualSyncOrProbe = async () => {
    setChecking(true);
    try {
      const online = await probeServerConnectivity();
      if (online) {
        if (status.failedCount > 0) {
          await retryOfflineQueue();
        } else {
          await processOfflineQueue(true);
        }
      }
    } finally {
      setChecking(false);
    }
  };

  let buttonClass = '';
  let iconEl: React.ReactNode = null;
  let labelNode: React.ReactNode = null;

  if (status.isSyncing) {
    buttonClass = isDark
      ? 'bg-sky-500/20 text-sky-200 border-sky-400/35 hover:bg-sky-500/30'
      : 'bg-sky-50 text-sky-800 border-sky-200 hover:bg-sky-100';
    iconEl = <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />;
    labelNode =
      status.pendingCount > 0 ? (
        <>
          <span className="sm:hidden">Syncing ({status.pendingCount})</span>
          <span className="hidden sm:inline">
            {`Syncing ${status.pendingCount} item${status.pendingCount === 1 ? '' : 's'}...`}
          </span>
        </>
      ) : (
        'Syncing...'
      );
  } else if (!status.isOnline) {
    buttonClass = isDark
      ? 'bg-amber-500/25 text-amber-200 border-amber-400/40 hover:bg-amber-500/35'
      : 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100';
    iconEl = <WifiOff className="w-3.5 h-3.5 shrink-0" />;
    if (compact) {
      labelNode = status.pendingCount > 0 ? `Offline (${status.pendingCount})` : 'Offline Mode';
    } else {
      labelNode = (
        <>
          <span className="sm:hidden">
            {status.pendingCount > 0 ? `Offline (${status.pendingCount})` : 'Offline'}
          </span>
          <span className="hidden sm:inline">
            {status.pendingCount > 0
              ? `Offline Mode (${status.pendingCount} queued)`
              : 'Offline Mode (Saving Locally)'}
          </span>
        </>
      );
    }
  } else if (status.failedCount > 0) {
    buttonClass = isDark
      ? 'bg-red-500/25 text-red-200 border-red-400/40 hover:bg-red-500/35'
      : 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100';
    iconEl = <AlertTriangle className="w-3.5 h-3.5 shrink-0" />;
    labelNode = `${status.failedCount} Sync Retry`;
  } else if (status.pendingCount > 0) {
    buttonClass = isDark
      ? 'bg-teal-500/25 text-teal-200 border-teal-400/40 hover:bg-teal-500/35'
      : 'bg-teal-50 text-teal-800 border-teal-300 hover:bg-teal-100';
    iconEl = <CloudUpload className="w-3.5 h-3.5 shrink-0" />;
    labelNode = (
      <>
        <span className="sm:hidden">{status.pendingCount} Pending</span>
        <span className="hidden sm:inline">{status.pendingCount} Pending Sync</span>
      </>
    );
  } else {
    buttonClass = isDark
      ? 'bg-white/10 text-emerald-200 border-white/15 hover:bg-white/15'
      : 'bg-emerald-50/70 text-emerald-800 border-emerald-200 hover:bg-emerald-50';
    iconEl = (
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${
          isDark ? 'bg-emerald-400' : 'bg-emerald-500'
        }`}
      />
    );
    labelNode = 'Online • Synced';
  }

  return (
    <div ref={containerRef} className="relative no-print shrink-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title="Click to inspect offline cache & MongoDB sync status"
        className={`inline-flex items-center gap-1.5 border font-semibold transition-colors whitespace-nowrap cursor-pointer ${
          compact
            ? 'px-2 py-0.5 rounded text-[11px] leading-tight'
            : 'px-2 sm:px-2.5 py-1.5 rounded-lg text-[11px] sm:text-xs'
        } ${buttonClass}`}
      >
        {iconEl}
        <span>{labelNode}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Offline Sync Queue Status"
          className="absolute right-0 mt-2 w-80 max-w-[90vw] bg-white text-slate-900 rounded-xl border border-slate-200 shadow-xl z-50 overflow-hidden"
        >
          <div className="px-3.5 py-2.5 bg-brand-navy-dark text-white flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold">
              {status.isOnline ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <WifiOff className="w-3.5 h-3.5 text-amber-300 shrink-0" />
              )}
              <span>{status.isOnline ? 'Connected to Server' : 'Working Offline (IndexedDB)'}</span>
            </div>
            <span className="text-[11px] text-slate-300 tabular-nums">
              {totalQueued} queued
            </span>
          </div>

          <div className="p-3.5 space-y-3 text-xs">
            {status.lastSyncedAt && (
              <div className="text-[11px] text-slate-500">
                Last MongoDB sync:{' '}
                <span className="font-medium text-slate-700">
                  {new Date(status.lastSyncedAt).toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: true,
                  })}
                </span>
              </div>
            )}

            {status.lastSyncError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-2.5 py-2 text-[11px] text-red-700">
                {status.lastSyncError}
              </div>
            )}

            {status.queueItems.length === 0 ? (
              <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-slate-600 text-[11px] leading-relaxed">
                All local patient registrations, payments, lab results, and settings are synchronized with MongoDB.
              </div>
            ) : (
              <div className="max-h-48 overflow-y-auto space-y-1.5 pr-0.5">
                {status.queueItems.map((item) => (
                  <div
                    key={item.clientMutationId}
                    className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${
                      item.status === 'failed'
                        ? 'bg-red-50 border-red-200 text-red-800'
                        : 'bg-slate-50 border-slate-200 text-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 font-semibold">
                      <span className="truncate">{item.label}</span>
                      <span className="text-[10px] text-slate-500 shrink-0 tabular-nums">
                        {formatOfflineQueueTimestamp(item.createdAt)}
                      </span>
                    </div>
                    {item.lastError && (
                      <div className="text-[10.5px] text-red-600 mt-0.5 break-words">
                        {item.lastError}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100">
              <button
                type="button"
                disabled={checking || status.isSyncing}
                onClick={handleManualSyncOrProbe}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-navy hover:bg-brand-navy-dark disabled:opacity-50 text-white font-semibold transition-colors cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${checking || status.isSyncing ? 'animate-spin' : ''}`} />
                <span>
                  {status.failedCount > 0
                    ? 'Retry Failed'
                    : status.pendingCount > 0
                      ? 'Sync Now'
                      : 'Check Sync'}
                </span>
              </button>

              {status.failedCount > 0 && (
                <button
                  type="button"
                  onClick={() => void clearFailedQueueItems()}
                  title="Discard failed sync items from queue"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 font-medium transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Discard</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
