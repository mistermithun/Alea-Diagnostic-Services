import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { apiFetch, formatBDT, getMonthStartISO, getTodayISO } from '../lib/api.ts';
import type { ExpenseItem } from '../types.ts';

const EXPENSE_CATEGORIES = [
  'Reagents & Kits',
  'Consumables',
  'Staff Salary & Allowance',
  'Electricity & Utilities',
  'Rent & Maintenance',
  'Equipment Repair',
  'Owner Withdrawal',
  'General',
];

export const ExpensesView: React.FC = () => {
  const [fromDate, setFromDate] = useState(getMonthStartISO());
  const [toDate, setToDate] = useState(getTodayISO());
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);
  const [total, setTotal] = useState(0);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState(getTodayISO());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadExpenses = useCallback(async () => {
    try {
      const res = await apiFetch<{ expenses: ExpenseItem[]; total: number }>(
        `/api/admin/expenses?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`
      );
      setExpenses(res.expenses);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load expenses.');
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    loadExpenses();
  }, [loadExpenses]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await apiFetch('/api/admin/expenses', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          category,
          amount: Number(amount),
          expense_date: expenseDate,
          note: note.trim(),
        }),
      });
      setTitle('');
      setAmount('');
      setNote('');
      await loadExpenses();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record expense.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiFetch(`/api/admin/expenses/${id}`, { method: 'DELETE' });
      await loadExpenses();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete expense.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy tracking-tight">Laboratory Expense Tracker</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Log daily reagents, consumables, salaries, utility bills, and owner cash withdrawals (synced to Balance ledger).
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-2 text-right">
          <div className="text-xs text-slate-500">Total Expenses in Range</div>
          <div className="text-lg font-bold font-mono tabular-nums text-brand-red">{formatBDT(total)}</div>
        </div>
      </div>

      {error && <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">{error}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <form onSubmit={handleAdd} className="xl:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900">Record New Expense</h2>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Expense Description</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. EDTA Tubes & Slides"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Amount (BDT ৳)</label>
              <input
                type="number"
                min={1}
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Date</label>
              <input
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Note (Optional)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Vendor or voucher reference"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 text-sm font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy-light disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {saving ? 'Saving...' : 'Add Expense'}
          </button>
        </form>

        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Expense Ledger ({expenses.length})</h2>
            <div className="flex items-center gap-2 text-xs">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="px-2.5 py-1.5 font-mono border border-slate-300 rounded-lg"
              />
              <span className="text-slate-400">to</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="px-2.5 py-1.5 font-mono border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Description</th>
                  <th className="py-2 pr-3 font-medium">Category</th>
                  <th className="py-2 pr-3 font-medium text-right">Amount</th>
                  <th className="py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {expenses.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-sm text-slate-500">
                      No expenses recorded in this period.
                    </td>
                  </tr>
                ) : (
                  expenses.map((ex) => (
                    <tr key={ex.id} className="hover:bg-slate-50">
                      <td className="py-3 pr-3 font-mono tabular-nums text-xs text-slate-600">
                        {ex.expense_date}
                      </td>
                      <td className="py-3 pr-3">
                        <div className="font-medium text-slate-900">{ex.title}</div>
                        {ex.note && <div className="text-xs text-slate-500">{ex.note}</div>}
                      </td>
                      <td className="py-3 pr-3 text-xs text-slate-600">{ex.category}</td>
                      <td className="py-3 pr-3 text-right font-mono tabular-nums font-bold text-red-700">
                        {formatBDT(ex.amount)}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleDelete(ex.id)}
                          className="p-1.5 text-slate-400 hover:text-red-600"
                          aria-label={`Delete ${ex.title}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
