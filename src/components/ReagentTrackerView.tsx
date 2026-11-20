import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ChevronDown,
  Link2,
  Minus,
  Package,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch, getTodayISO } from '../lib/api.ts';
import { LIVE_SYNC_CHANNEL, type LiveSyncMessage } from '../lib/liveSync.ts';
import { OFFLINE_SYNCED_EVENT } from '../lib/offlineEngine.ts';
import {
  computeDaysUntilExpiry,
  countReagentsNeedingAttention,
  dispatchReagentAlertsCount,
  doesReagentNeedAttention,
  PATIENTS_UPDATED_LOCAL_EVENT,
} from '../lib/reagentAlerts.ts';
import {
  buildCatalogReagentOptions,
  type CatalogReagentOption,
} from '../../shared/reagentMatcher.ts';
import type { DiagnosticTest, ReagentItem } from '../types.ts';

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

interface LinkedCatalogSelection {
  linked_test_id: number;
  linked_test_name: string;
  linked_parameter_id: number | null;
  linked_parameter_name: string;
}

export const ReagentTrackerView: React.FC = () => {
  const todayIso = getTodayISO();
  const [reagents, setReagents] = useState<ReagentItem[]>([]);
  const [catalogTests, setCatalogTests] = useState<DiagnosticTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(false);

  // Add Reagent Form State
  const [name, setName] = useState('');
  const [selectedLink, setSelectedLink] = useState<LinkedCatalogSelection | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const selectorContainerRef = useRef<HTMLDivElement>(null);

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
      const [reagentRes, catalogRes] = await Promise.all([
        apiFetch<{ reagents: ReagentItem[] }>('/api/reagents'),
        apiFetch<{ tests: DiagnosticTest[] }>('/api/catalog').catch(() => ({
          tests: [] as DiagnosticTest[],
        })),
      ]);
      setReagents(reagentRes.reagents || []);
      if (Array.isArray(catalogRes?.tests)) {
        setCatalogTests(catalogRes.tests);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reagent inventory.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReagents();
    const onRefresh = () => {
      void loadReagents();
    };
    window.addEventListener(OFFLINE_SYNCED_EVENT, onRefresh);
    window.addEventListener(PATIENTS_UPDATED_LOCAL_EVENT, onRefresh);

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
      window.removeEventListener(OFFLINE_SYNCED_EVENT, onRefresh);
      window.removeEventListener(PATIENTS_UPDATED_LOCAL_EVENT, onRefresh);
      channel?.close();
    };
  }, [loadReagents]);

  useEffect(() => {
    if (!loading) {
      dispatchReagentAlertsCount(countReagentsNeedingAttention(reagents, todayIso));
    }
  }, [reagents, todayIso, loading]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        selectorContainerRef.current &&
        !selectorContainerRef.current.contains(event.target as Node)
      ) {
        setSelectorOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const catalogOptions = useMemo(() => buildCatalogReagentOptions(catalogTests), [catalogTests]);

  const filteredCatalogOptions = useMemo(() => {
    const q = name.trim().toLowerCase();
    if (!q) return catalogOptions;
    const tokens = q.split(/\s+/).filter(Boolean);
    return catalogOptions.filter((opt) => tokens.every((tok) => opt.searchText.includes(tok)));
  }, [catalogOptions, name]);

  const groupedSelectorOptions = useMemo(() => {
    const paramOptions = filteredCatalogOptions.filter((o) => o.kind === 'parameter');
    const testOptions = filteredCatalogOptions.filter((o) => o.kind === 'test');
    return { paramOptions, testOptions };
  }, [filteredCatalogOptions]);

  const handleSelectCatalogOption = (opt: CatalogReagentOption) => {
    setName(opt.displayName);
    setSelectedLink({
      linked_test_id: opt.linked_test_id,
      linked_test_name: opt.linked_test_name,
      linked_parameter_id: opt.linked_parameter_id,
      linked_parameter_name: opt.linked_parameter_name,
    });
    setSelectorOpen(false);
  };

  const handleReagentNameInputChange = (val: string) => {
    setName(val);
    setSelectorOpen(true);
    if (!val.trim()) {
      setSelectedLink(null);
    }
  };

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
    const thresholdNum = Math.max(
      0,
      Math.round(Number(lowStockThreshold === '' ? 10 : lowStockThreshold))
    );

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

    // If user typed an exact catalog match without clicking the dropdown, auto-attach its link metadata
    let resolvedLink = selectedLink;
    if (!resolvedLink) {
      const exactMatch = catalogOptions.find(
        (opt) => opt.displayName.trim().toLowerCase() === cleanName.toLowerCase()
      );
      if (exactMatch) {
        resolvedLink = {
          linked_test_id: exactMatch.linked_test_id,
          linked_test_name: exactMatch.linked_test_name,
          linked_parameter_id: exactMatch.linked_parameter_id,
          linked_parameter_name: exactMatch.linked_parameter_name,
        };
      }
    }

    setSaving(true);
    try {
      await apiFetch<{ reagent: ReagentItem }>('/api/reagents', {
        method: 'POST',
        body: JSON.stringify({
          name: cleanName,
          linked_test_id: resolvedLink?.linked_test_id ?? null,
          linked_test_name: resolvedLink?.linked_test_name ?? '',
          linked_parameter_id: resolvedLink?.linked_parameter_id ?? null,
          linked_parameter_name: resolvedLink?.linked_parameter_name ?? '',
          total_tests: totalNum,
          remaining_tests: remNum,
          expiry_date: expiryDate.trim(),
          low_stock_threshold: thresholdNum,
        }),
      });
      setName('');
      setSelectedLink(null);
      setSelectorOpen(false);
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
      if (
        q &&
        !r.name.toLowerCase().includes(q) &&
        !(r.linked_test_name || '').toLowerCase().includes(q) &&
        !(r.linked_parameter_name || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      if (alertsOnly) {
        return doesReagentNeedAttention(r, todayIso);
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
            Track diagnostic reagent kits linked to Test Catalog tests &amp; sub-parameters, with automatic FEFO deduction on patient test entry.
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
                ? 'bg-red-50 border-red-200'
                : 'bg-white border-slate-200'
            }`}
          >
            <div className="text-[11px] font-medium text-slate-600">Expiring &le;30d</div>
            <div
              className={`text-lg font-bold font-mono tabular-nums ${
                summary.expiringOrExpiredCount > 0 ? 'text-brand-red' : 'text-slate-700'
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
            <span className="text-[11px] font-medium text-brand-cyan">Catalog Linked</span>
          </div>

          <div ref={selectorContainerRef} className="relative">
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Reagent Name (from Test Catalog or Custom)
            </label>
            <div className="relative flex items-center">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
              <input
                type="text"
                value={name}
                onFocus={() => setSelectorOpen(true)}
                onChange={(e) => handleReagentNameInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSelectorOpen(false);
                  }
                }}
                placeholder="Search test or parameter (e.g. TG, Cholesterol, SGPT, Urine R/E)..."
                className="w-full pl-8 pr-8 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 focus:border-brand-navy"
                autoComplete="off"
                required
              />
              <button
                type="button"
                onClick={() => setSelectorOpen((prev) => !prev)}
                aria-label="Toggle reagent catalog list"
                className="absolute right-2 p-1 text-slate-400 hover:text-brand-navy cursor-pointer"
              >
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${selectorOpen ? 'rotate-180' : ''}`}
                />
              </button>
            </div>

            {selectedLink && (
              <div className="mt-1.5 flex items-center justify-between gap-2 px-2.5 py-1 rounded-md bg-teal-50 border border-teal-200 text-[11px] text-teal-900">
                <span className="inline-flex items-center gap-1 min-w-0">
                  <Link2 className="w-3 h-3 text-teal-700 shrink-0" />
                  <span className="truncate font-medium">
                    {selectedLink.linked_parameter_name
                      ? `Linked: ${selectedLink.linked_parameter_name} (${selectedLink.linked_test_name})`
                      : `Linked Test: ${selectedLink.linked_test_name}`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedLink(null)}
                  className="text-teal-700 hover:text-brand-red shrink-0 cursor-pointer"
                  title="Unlink from catalog item (keep custom name)"
                  aria-label="Unlink catalog selection"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {selectorOpen && (
              <div className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-y-auto bg-white border border-slate-300 rounded-lg shadow-lg divide-y divide-slate-100">
                {groupedSelectorOptions.paramOptions.length > 0 && (
                  <div className="py-1">
                    <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 bg-slate-50">
                      Test Sub-Parameters (Panel Components)
                    </div>
                    {groupedSelectorOptions.paramOptions.map((opt) => {
                      const isSelected =
                        selectedLink?.linked_parameter_name === opt.linked_parameter_name &&
                        selectedLink?.linked_test_id === opt.linked_test_id;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => handleSelectCatalogOption(opt)}
                          className={`w-full text-left px-3 py-1.5 hover:bg-sky-50 flex items-center justify-between gap-2 cursor-pointer ${
                            isSelected ? 'bg-sky-50/80' : ''
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-brand-navy truncate">
                              {opt.displayName}
                            </div>
                            <div className="text-[10.5px] text-slate-500 truncate">
                              {opt.subtitle}
                            </div>
                          </div>
                          {isSelected && <Check className="w-3.5 h-3.5 text-teal-700 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {groupedSelectorOptions.testOptions.length > 0 && (
                  <div className="py-1">
                    <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 bg-slate-50">
                      Test Catalog Tests
                    </div>
                    {groupedSelectorOptions.testOptions.map((opt) => {
                      const isSelected =
                        selectedLink?.linked_test_id === opt.linked_test_id &&
                        !selectedLink?.linked_parameter_name;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => handleSelectCatalogOption(opt)}
                          className={`w-full text-left px-3 py-1.5 hover:bg-sky-50 flex items-center justify-between gap-2 cursor-pointer ${
                            isSelected ? 'bg-sky-50/80' : ''
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-slate-900 truncate">
                              {opt.displayName}
                            </div>
                            <div className="text-[10.5px] text-slate-500 truncate">
                              {opt.subtitle}
                            </div>
                          </div>
                          {isSelected && <Check className="w-3.5 h-3.5 text-teal-700 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {name.trim() !== '' && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedLink(null);
                      setSelectorOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-brand-navy bg-slate-50 hover:bg-slate-100 flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-brand-cyan shrink-0" />
                    <span className="truncate">
                      Use custom reagent name: &ldquo;{name.trim()}&rdquo;
                    </span>
                  </button>
                )}

                {filteredCatalogOptions.length === 0 && name.trim() === '' && (
                  <div className="px-3 py-3 text-xs text-slate-500 text-center">
                    No active catalog tests loaded yet. You can type a custom reagent name above.
                  </div>
                )}
              </div>
            )}
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
            Ordering a single test or panel test (e.g., Lipid Profile, LFT) automatically deducts 1 test from each matching reagent batch with the earliest Expiry Date first.
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
                  <th className="py-2.5 px-3 font-semibold text-center whitespace-nowrap">Days Left</th>
                  <th className="py-2.5 pl-3 pr-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-sm text-slate-500">
                      Loading reagent inventory...
                    </td>
                  </tr>
                ) : visibleReagents.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-sm text-slate-500">
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
                    const needsAttention = isLowStock || isExpired || isExpiringSoon;
                    const isBusy = adjustingIds.has(item.id);

                    const hasLinkMeta =
                      Boolean(item.linked_parameter_name?.trim()) ||
                      Boolean(item.linked_test_name?.trim());

                    return (
                      <tr
                        key={item.id}
                        className={`transition-colors ${
                          needsAttention
                            ? 'bg-red-50 hover:bg-red-100/80'
                            : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-3 pl-3 pr-3 align-middle">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={`font-semibold ${
                                needsAttention ? 'text-red-950' : 'text-slate-900'
                              }`}
                            >
                              {item.name}
                            </span>
                            {isOut ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 border border-red-300 text-[10.5px] font-bold text-red-800">
                                Out of Stock
                              </span>
                            ) : isLowStock ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 border border-red-300 text-[10.5px] font-semibold text-red-800">
                                <AlertTriangle className="w-3 h-3" />
                                Low Stock
                              </span>
                            ) : null}
                            {isExpired ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 border border-red-300 text-[10.5px] font-bold text-red-800">
                                Expired
                              </span>
                            ) : isExpiringSoon ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 border border-red-300 text-[10.5px] font-semibold text-red-800">
                                <CalendarClock className="w-3 h-3" />
                                Expiring Soon
                              </span>
                            ) : null}
                          </div>

                          {hasLinkMeta && (
                            <div
                              className={`mt-0.5 inline-flex items-center gap-1 text-[11px] ${
                                needsAttention ? 'text-red-800/80' : 'text-slate-500'
                              }`}
                            >
                              <Link2 className="w-3 h-3 shrink-0" />
                              <span>
                                {item.linked_parameter_name
                                  ? `${item.linked_parameter_name}${
                                      item.linked_test_name ? ` • ${item.linked_test_name}` : ''
                                    }`
                                  : item.linked_test_name}
                              </span>
                            </div>
                          )}

                          <div
                            className={`mt-1.5 w-36 h-1.5 rounded-full overflow-hidden ${
                              needsAttention ? 'bg-red-200/80' : 'bg-slate-200'
                            }`}
                          >
                            <div
                              className={`h-full transition-all ${
                                needsAttention
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
                              className="inline-flex items-center gap-0.5 px-2 py-1 rounded border border-red-200 bg-white text-brand-red hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold font-mono transition-colors cursor-pointer"
                            >
                              <Minus className="w-3 h-3" />
                              <span>1</span>
                            </button>

                            <span
                              className={`min-w-[3.25rem] text-center px-2 py-1 rounded border font-mono tabular-nums text-sm font-bold ${
                                isLowStock
                                  ? 'bg-red-100 border-red-300 text-red-800'
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
                              isExpired || isExpiringSoon ? 'text-red-700' : 'text-slate-700'
                            }`}
                          >
                            {formatExpiryReadable(item.expiry_date)}
                          </div>
                        </td>

                        <td className="py-3 px-3 align-middle text-center whitespace-nowrap">
                          {daysLeft === null ? (
                            <span className="font-mono text-xs text-slate-400">—</span>
                          ) : daysLeft < 0 ? (
                            <span className="font-mono tabular-nums text-xs font-bold text-red-700">
                              Expired ({Math.abs(daysLeft)}d ago)
                            </span>
                          ) : daysLeft === 0 ? (
                            <span className="font-mono tabular-nums text-xs font-bold text-red-700">
                              0d (Today)
                            </span>
                          ) : daysLeft <= 30 ? (
                            <span className="font-mono tabular-nums text-xs font-bold text-red-700">
                              {daysLeft} {daysLeft === 1 ? 'day' : 'days'}
                            </span>
                          ) : (
                            <span className="font-mono tabular-nums text-xs font-semibold text-emerald-700">
                              {daysLeft} days
                            </span>
                          )}
                        </td>

                        <td className="py-3 pl-3 pr-3 align-middle text-right">
                          <button
                            type="button"
                            onClick={() => void handleDeleteReagent(item)}
                            className={`p-1.5 transition-colors cursor-pointer ${
                              needsAttention
                                ? 'text-red-400 hover:text-red-700'
                                : 'text-slate-400 hover:text-red-600'
                            }`}
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
