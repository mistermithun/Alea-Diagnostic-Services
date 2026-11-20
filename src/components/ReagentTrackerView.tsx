import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Minus,
  Package,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { apiFetch, getTodayISO } from '../lib/api.ts';
import { LIVE_SYNC_CHANNEL, type LiveSyncMessage } from '../lib/liveSync.ts';
import { OFFLINE_SYNCED_EVENT } from '../lib/offlineEngine.ts';
import type { ReagentItem } from '../types.ts';

function computeDaysUntilExpiry(expiryDate: string, todayIso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test((expiryDate || '').trim())) return null;
  const expMs = Date.parse(`${expiryDate.trim()}T00:00:00Z`);
  const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(expMs) || Number.isNaN(todayMs)) return null;
  return Math.round((expMs - todayMs) / (1000 * 60 * 60 * 24));
}

function formatExpiryReadable(expiryDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test((expiryDate || '').trim())) return expiryDate || '—';
  const [y, m, d] = expiryDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const ReagentTrackerView: React.FC = () => {
  const todayIso = getTodayISO();
  const [reagents, setReagents] = useState<ReagentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(false);

  // Add Reagent Form State
  const [name, setName] = useState('');
  const [totalTests, setTotalTests] = useState('100');
  const [remainingTests, setRemainingTests] = useState('100');
  const [remainingTouched, setRemainingTouched] = useState(false);
  const [expiryDate, setExpiryDate] = useState('');
  const [lowStockThreshold, setLowStockThreshold] = useState('10');

  const [saving, setSaving] = useState(false);
  const [adjustingIds, setAdjustingIds] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const loadReagents = useCallback(async () => {
    try {
      const res = await apiFetch<{ reagents: ReagentItem[] }>('/api/reagents');
      setReagents(res.reagents || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reagent inventory.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReagents();
    const onOfflineSynced = () => {
      void loadReagents();
    };
    window.addEventListener(OFFLINE_SYNCED_EVENT, onOfflineSynced);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(LIVE_SYNC_CHANNEL);
        channel.onmessage = (event) => {
          const data = event.data as Partial<LiveSyncMessage> | null;
          if (data?.type === 'PATIENTS_UPDATED') {
            void loadReagents();
          }
        };
      } catch {
        channel = null;
      }
    }

    return () => {
      window.removeEventListener(OFFLINE_SYNCED_EVENT, onOfflineSynced);
      channel?.close();
    };
  }, [loadReagents]);

  const handleTotalTestsChange = (val: string) => {
    setTotalTests(val);
    if (!remainingTouched) {
      setRemainingTests(val);
    }
  };

  const handleRemainingTestsChange = (val: string) => {
    setRemainingTouched(true);
    setRemainingTests(val);
  };

  const handleAddReagent = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    const cleanName = name.trim();
    const totalNum = Math.round(Number(totalTests || 0));
    const remNum = Math.round(Number(remainingTests === '' ? totalNum : remainingTests));
    const thresholdNum = Math.max(0, Math.round(Number(lowStockThreshold === '' ? 10 : lowStockThreshold)));

    if (!cleanName) {
      setError('Reagent Name is required.');
      return;
    }
    if (!Number.isFinite(totalNum) || totalNum <= 0) {
      setError('Total Tests Count must be at least 1.');
      return;
    }
    if (!Number.isFinite(remNum) || remNum < 0) {
      setError('Remaining Tests Count cannot be negative.');
      return;
    }
    if (!expiryDate.trim()) {
      setError('Expiry Date is required.');
      return;
    }

    setSaving(true);
    try {
      await apiFetch<{ reagent: ReagentItem }>('/api/reagents', {
        method: 'POST',
        body: JSON.stringify({
          name: cleanName,
          total_tests: totalNum,
          remaining_tests: remNum,
          expiry_date: expiryDate.trim(),
          low_stock_threshold: thresholdNum,
        }),
      });
      setName('');
      setTotalTests('100');
      setRemainingTests('100');
      setRemainingTouched(false);
      setExpiryDate('');
      setLowStockThreshold('10');
      setSuccessMsg(`Added "${cleanName}" (${remNum}/${totalNum} tests) to Reagent Tracker.`);
      await loadReagents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add reagent.');
    } finally {
      setSaving(false);
    }
  };

  const handleAdjustStock = async (item: ReagentItem, delta: 1 | -1) => {
    if (delta < 0 && item.remaining_tests <= 0) return;
    setError('');
    setSuccessMsg('');

    const optimisticRemaining = Math.max(0, item.remaining_tests + delta);
    setReagents((prev) =>
      prev.map((r) => (r.id === item.id ? { ...r, remaining_tests: optimisticRemaining } : r))
    );
    setAdjustingIds((prev) => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });

    try {
      const res = await apiFetch<{ reagent: ReagentItem }>(`/api/reagents/${item.id}/adjust`, {
        method: 'POST',
        body: JSON.stringify({ delta }),
      });
      if (res?.reagent) {
        setReagents((prev) => prev.map((r) => (r.id === item.id ? res.reagent : r)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update stock count.');
      await loadReagents();
    } finally {
      setAdjustingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handleDeleteReagent = async (item: ReagentItem) => {
    setError('');
    setSuccessMsg('');
    try {
      await apiFetch(`/api/reagents/${item.id}`, { method: 'DELETE' });
      setReagents((prev) => prev.filter((r) => r.id !== item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove reagent.');
    }
  };

  const summary = useMemo(() => {
    let lowStockCount = 0;
    let expiringOrExpiredCount = 0;
    let totalRemainingTests = 0;

    for (const r of reagents) {
      totalRemainingTests += Number(r.remaining_tests || 0);
      if (Number(r.remaining_tests) <= Number(r.low_stock_threshold ?? 10)) {
        lowStockCount += 1;
      }
      const daysLeft = computeDaysUntilExpiry(r.expiry_date, todayIso);
      if (daysLeft !== null && daysLeft <= 30) {
        expiringOrExpiredCount += 1;
      }
    }

    return {
      totalItems: reagents.length,
      lowStockCount,
      expiringOrExpiredCount,
      totalRemainingTests,
    };
  }, [reagents, todayIso]);

  const visibleReagents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reagents.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (alertsOnly) {
        const isLow = Number(r.remaining_tests) <= Number(r.low_stock_threshold ?? 10);
        const daysLeft = computeDaysUntilExpiry(r.expiry_date, todayIso);
        const isExpAlert = daysLeft !== null && daysLeft <= 30;
        return isLow || isExpAlert;
      }
      return true;
    });
  }, [reagents, search, alertsOnly, todayIso]);

  return (
    <div className="space-y-6">
      {/* Header & Summary KPIs */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy tracking-tight flex items-center gap-2">
            <Package className="w-6 h-6 text-brand-cyan shrink-0" />
            <span>Reagent Inventory Tracker</span>
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Track diagnostic reagent kits, remaining test capacity, expiry dates, and low-stock alert thresholds.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2.5 shrink-0">
          <div className="bg-white border border-slate-200 rounded-lg px-3.5 py-2 text-right">
            <div className="text-[11px] font-medium text-slate-500">Tracked Reagents</div>
            <div className="text-lg font-bold font-mono tabular-nums text-brand-navy">
              {summary.totalItems}
            </div>
          </div>
          <div
            className={`border rounded-lg px-3.5 py-2 text-right ${
              summary.lowStockCount > 0
                ? 'bg-red-50 border-red-200'
                : 'bg-white border-slate-200'
            }`}
          >
            <div className="text-[11px] font-medium text-slate-600">Low Stock Alerts</div>
            <div
              className={`text-lg font-bold font-mono tabular-nums ${
                summary.lowStockCount > 0 ? 'text-brand-red' : 'text-emerald-700'
              }`}
            >
              {summary.lowStockCount}
            </div>
          </div>
          <div
            className={`border rounded-lg px-3.5 py-2 text-right ${
              summary.expiringOrExpiredCount > 0
                ? 'bg-amber-50 border-amber-200'
                : 'bg-white border-slate-200'
            }`}
          >
            <div className="text-[11px] font-medium text-slate-600">Expiring &le;30d</div>
            <div
              className={`text-lg font-bold font-mono tabular-nums ${
                summary.expiringOrExpiredCount > 0 ? 'text-amber-700' : 'text-slate-700'
              }`}
            >
              {summary.expiringOrExpiredCount}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
          {error}
        </div>
      )}
      {successMsg && (
        <div className="p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
          {successMsg}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Add Reagent Card */}
        <form
          onSubmit={handleAddReagent}
          className="xl:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-xs"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 className="text-sm font-bold text-brand-navy">Add Reagent Kit / Stock</h2>
            <span className="text-[11px] font-medium text-brand-cyan">Inventory Entry</span>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Reagent Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Creatinine Reagent Kit (100T)"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 focus:border-brand-navy"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Total Tests Count
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={totalTests}
                onChange={(e) => handleTotalTestsChange(e.target.value)}
                placeholder="e.g. 50 or 100"
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 focus:border-brand-navy"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Remaining Tests Count
              </label>
              <input
                type="number"
                min={0}
                step={1}
                value={remainingTests}
                onChange={(e) => handleRemainingTestsChange(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 focus:border-brand-navy"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Expiry Date
              </label>
              <input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 focus:border-brand-navy"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Low Stock Threshold
              </label>
              <input
                type="number"
                min={0}
                step={1}
                value={lowStockThreshold}
                onChange={(e) => setLowStockThreshold(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 focus:border-brand-navy"
                required
              />
            </div>
          </div>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            Items trigger a Low Stock alert automatically whenever Remaining Tests reaches or drops below the threshold (default: 10).
          </p>

          <button
            type="submit"
            disabled={saving}
            className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 text-sm font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark disabled:opacity-50 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>{saving ? 'Saving Reagent...' : 'Add Reagent Item'}</span>
          </button>
        </form>

        {/* Reagent Inventory Table */}
        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-brand-navy">
              Active Reagent Inventory ({visibleReagents.length})
            </h2>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search reagent..."
                  className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg w-48 focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 focus:border-brand-navy"
                />
              </div>

              <button
                type="button"
                onClick={() => setAlertsOnly((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
                  alertsOnly
                    ? 'bg-red-50 text-brand-red border-red-300'
                    : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Alerts Only</span>
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50/70">
                  <th className="py-2.5 pl-3 pr-3 font-semibold">Reagent Name</th>
                  <th className="py-2.5 px-3 font-semibold text-center">Total Tests</th>
                  <th className="py-2.5 px-3 font-semibold text-center">Remaining Tests</th>
                  <th className="py-2.5 px-3 font-semibold text-center">Alert At</th>
                  <th className="py-2.5 px-3 font-semibold">Expiry Date</th>
                  <th className="py-2.5 pl-3 pr-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-sm text-slate-500">
                      Loading reagent inventory...
                    </td>
                  </tr>
                ) : visibleReagents.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-sm text-slate-500">
                      {reagents.length === 0
                        ? 'No reagent kits added yet. Use the form on the left to add your first reagent.'
                        : 'No reagent items match your current filter.'}
                    </td>
                  </tr>
                ) : (
                  visibleReagents.map((item) => {
                    const threshold = Number(item.low_stock_threshold ?? 10);
                    const remaining = Number(item.remaining_tests || 0);
                    const total = Math.max(1, Number(item.total_tests || 1));
                    const isOut = remaining <= 0;
                    const isLowStock = remaining <= threshold;
                    const pct = Math.min(100, Math.max(0, Math.round((remaining / total) * 100)));

                    const daysLeft = computeDaysUntilExpiry(item.expiry_date, todayIso);
                    const isExpired = daysLeft !== null && daysLeft < 0;
                    const isExpiringSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 30;
                    const isBusy = adjustingIds.has(item.id);

                    return (
                      <tr
                        key={item.id}
                        className={`transition-colors ${
                          isExpired || isOut
                            ? 'bg-red-50/50 hover:bg-red-50/80'
                            : isLowStock || isExpiringSoon
                              ? 'bg-amber-50/40 hover:bg-amber-50/70'
                              : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-3 pl-3 pr-3 align-middle">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-slate-900">{item.name}</span>
                            {isOut ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 border border-red-300 text-[10.5px] font-bold text-brand-red">
                                Out of Stock
                              </span>
                            ) : isLowStock ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-[10.5px] font-semibold text-brand-red">
                                <AlertTriangle className="w-3 h-3" />
                                Low Stock
                              </span>
                            ) : null}
                            {isExpired ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 border border-red-300 text-[10.5px] font-bold text-red-800">
                                Expired
                              </span>
                            ) : isExpiringSoon ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 border border-amber-300 text-[10.5px] font-semibold text-amber-800">
                                <CalendarClock className="w-3 h-3" />
                                {daysLeft === 0 ? 'Expires Today' : `${daysLeft}d left`}
                              </span>
                            ) : null}
                          </div>

                          <div className="mt-1.5 w-36 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all ${
                                isOut || isLowStock
                                  ? 'bg-brand-red'
                                  : pct <= 35
                                    ? 'bg-amber-500'
                                    : 'bg-emerald-500'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </td>

                        <td className="py-3 px-3 align-middle text-center font-mono tabular-nums font-semibold text-slate-700">
                          {item.total_tests}
                        </td>

                        <td className="py-3 px-3 align-middle">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              disabled={isOut || isBusy}
                              onClick={() => void handleAdjustStock(item, -1)}
                              title="Decrease remaining tests by 1"
                              className="inline-flex items-center gap-0.5 px-2 py-1 rounded border border-red-200 bg-red-50 text-brand-red hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold font-mono transition-colors cursor-pointer"
                            >
                              <Minus className="w-3 h-3" />
                              <span>1</span>
                            </button>

                            <span
                              className={`min-w-[3.25rem] text-center px-2 py-1 rounded border font-mono tabular-nums text-sm font-bold ${
                                isLowStock
                                  ? 'bg-red-50 border-red-200 text-brand-red'
                                  : 'bg-slate-50 border-slate-200 text-brand-navy'
                              }`}
                            >
                              {remaining}
                            </span>

                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleAdjustStock(item, 1)}
                              title="Increase remaining tests by 1"
                              className="inline-flex items-center gap-0.5 px-2 py-1 rounded border border-teal-300 bg-teal-50 text-teal-800 hover:bg-teal-100 disabled:opacity-40 text-xs font-bold font-mono transition-colors cursor-pointer"
                            >
                              <Plus className="w-3 h-3" />
                              <span>1</span>
                            </button>
                          </div>
                        </td>

                        <td className="py-3 px-3 align-middle text-center font-mono tabular-nums text-xs text-slate-600">
                          &le; {threshold}
                        </td>

                        <td className="py-3 px-3 align-middle whitespace-nowrap">
                          <div
                            className={`font-mono tabular-nums text-xs font-semibold ${
                              isExpired
                                ? 'text-red-700'
                                : isExpiringSoon
                                  ? 'text-amber-700'
                                  : 'text-slate-700'
                            }`}
                          >
                            {formatExpiryReadable(item.expiry_date)}
                          </div>
                        </td>

                        <td className="py-3 pl-3 pr-3 align-middle text-right">
                          <button
                            type="button"
                            onClick={() => void handleDeleteReagent(item)}
                            className="p-1.5 text-slate-400 hover:text-red-600 transition-colors cursor-pointer"
                            title={`Remove ${item.name}`}
                            aria-label={`Remove ${item.name}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
