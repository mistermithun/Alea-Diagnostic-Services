import type { ReagentItem } from '../types.ts';

export const REAGENT_ALERTS_UPDATED_EVENT = 'alea-reagent-alerts-updated';
export const PATIENTS_UPDATED_LOCAL_EVENT = 'alea-patients-updated-local';

export function computeDaysUntilExpiry(expiryDate: string, todayIso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test((expiryDate || '').trim())) return null;
  const expMs = Date.parse(`${expiryDate.trim()}T00:00:00Z`);
  const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(expMs) || Number.isNaN(todayMs)) return null;
  return Math.round((expMs - todayMs) / (1000 * 60 * 60 * 24));
}

export function doesReagentNeedAttention(item: ReagentItem, todayIso: string): boolean {
  const threshold = Number(item.low_stock_threshold ?? 5);
  const remaining = Number(item.remaining_tests || 0);
  if (remaining <= threshold) return true;
  const daysLeft = computeDaysUntilExpiry(item.expiry_date, todayIso);
  return daysLeft !== null && daysLeft <= 30;
}

export function countReagentsNeedingAttention(reagents: ReagentItem[], todayIso: string): number {
  let count = 0;
  for (const r of reagents) {
    if (doesReagentNeedAttention(r, todayIso)) {
      count += 1;
    }
  }
  return count;
}

export function dispatchReagentAlertsCount(count: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<{ count: number }>(REAGENT_ALERTS_UPDATED_EVENT, {
      detail: { count },
    })
  );
}
