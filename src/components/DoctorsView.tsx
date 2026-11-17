import React, { useCallback, useEffect, useState } from 'react';
import { Banknote, Edit2, FileSpreadsheet, Plus, Printer, Trash2, X } from 'lucide-react';
import { apiFetch, formatBDT, formatDateTime, getMonthStartISO, getTodayISO } from '../lib/api.ts';
import type { Doctor, DoctorStatementResponse, LabSettings } from '../types.ts';

interface DoctorsViewProps {
  settings: LabSettings;
  onOpenPayout?: (doctorId: number) => void;
}

export const DoctorsView: React.FC<DoctorsViewProps> = ({ settings, onOpenPayout }) => {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Add/Edit Doctor form
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [degree, setDegree] = useState('');
  const [hospital, setHospital] = useState('');
  const [mobile, setMobile] = useState('');
  const [commissionPct, setCommissionPct] = useState('20');
  const [saving, setSaving] = useState(false);

  // Statement Generator
  const [statementDocId, setStatementDocId] = useState<number | null>(null);
  const [fromDate, setFromDate] = useState(getMonthStartISO());
  const [toDate, setToDate] = useState(getTodayISO());
  const [statement, setStatement] = useState<DoctorStatementResponse | null>(null);

  const loadDoctors = useCallback(async () => {
    try {
      const res = await apiFetch<{ doctors: Doctor[] }>('/api/doctors');
      setDoctors(res.doctors);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load doctors.');
    }
  }, []);

  useEffect(() => {
    loadDoctors();
  }, [loadDoctors]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setDegree('');
    setHospital('');
    setMobile('');
    setCommissionPct('20');
  };

  const handleSaveDoctor = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = {
        name: name.trim(),
        degree: degree.trim(),
        hospital: hospital.trim(),
        mobile: mobile.trim(),
        commission_pct: Number(commissionPct || 0),
      };
      if (editingId) {
        await apiFetch(`/api/admin/doctors/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setSuccess(`Updated ${payload.name}.`);
      } else {
        await apiFetch('/api/admin/doctors', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setSuccess(`Added ${payload.name} to directory.`);
      }
      resetForm();
      await loadDoctors();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save doctor.');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (doc: Doctor) => {
    setEditingId(doc.id);
    setName(doc.name);
    setDegree(doc.degree || '');
    setHospital(doc.hospital || '');
    setMobile(doc.mobile || '');
    setCommissionPct(String(doc.commission_pct ?? 0));
  };

  const handleDelete = async (doc: Doctor) => {
    try {
      await apiFetch(`/api/admin/doctors/${doc.id}`, { method: 'DELETE' });
      await loadDoctors();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove doctor.');
    }
  };

  const loadStatement = async (docId: number, from = fromDate, to = toDate) => {
    setError('');
    try {
      const res = await apiFetch<DoctorStatementResponse>(
        `/api/admin/doctors/${docId}/statement?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      );
      setStatementDocId(docId);
      setStatement(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate statement.');
    }
  };

  return (
    <div className="space-y-6">
      <div className={statement ? 'space-y-6 no-print' : 'space-y-6'}>
      <div className="pb-4 border-b border-slate-200">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
          Referral Doctors & Commission Statements
        </h1>
        <p className="text-sm text-slate-600 mt-0.5">
          Manage referring physicians, custom commission percentages, and generate payable statements.
        </p>
      </div>

      {error && <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">{error}</div>}
      {success && <div className="p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">{success}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Add / Edit Doctor Form */}
        <form onSubmit={handleSaveDoctor} className="xl:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              {editingId ? 'Edit Referral Doctor' : 'Add Referral Doctor'}
            </h2>
            {editingId && (
              <button type="button" onClick={resetForm} className="text-xs text-slate-500 hover:text-slate-900">
                Cancel edit
              </button>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Doctor Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dr. ..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Degree / Qualification</label>
            <input
              type="text"
              value={degree}
              onChange={(e) => setDegree(e.target.value)}
              placeholder="MBBS, FCPS, MD..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Hospital / Clinic</label>
            <input
              type="text"
              value={hospital}
              onChange={(e) => setHospital(e.target.value)}
              placeholder="Kushtia General Hospital"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Mobile</label>
              <input
                type="text"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="017XX-XXXXXX"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Commission (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                step="any"
                value={commissionPct}
                onChange={(e) => setCommissionPct(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {saving ? 'Saving...' : editingId ? 'Update Doctor' : 'Save Doctor'}
          </button>
        </form>

        {/* Right: Doctor Directory */}
        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-xl p-5 overflow-x-auto">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">
            Active Referral Directory ({doctors.length})
          </h2>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-2 pr-3 font-medium">Doctor &amp; Degree</th>
                <th className="py-2 pr-3 font-medium">Hospital / Mobile</th>
                <th className="py-2 pr-3 font-medium text-right">Default Rate</th>
                <th className="py-2 pr-3 font-medium">Last Settled Date</th>
                <th className="py-2 pr-3 font-medium text-right">Unpaid Accrued</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {doctors.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50">
                  <td className="py-3 pr-3">
                    <div className="font-semibold text-slate-900">{d.name}</div>
                    <div className="text-xs text-slate-500">{d.degree || '—'}</div>
                  </td>
                  <td className="py-3 pr-3 text-xs text-slate-600">
                    <div>{d.hospital || '—'}</div>
                    <div className="font-mono tabular-nums text-slate-500">{d.mobile || '—'}</div>
                  </td>
                  <td className="py-3 pr-3 text-right font-mono tabular-nums font-bold text-teal-700">
                    {d.commission_pct ?? 0}%
                  </td>
                  <td className="py-3 pr-3 text-xs font-mono tabular-nums">
                    {d.last_commission_paid_up_to ? (
                      <div>
                        <span className="font-semibold text-emerald-700">{d.last_commission_paid_up_to}</span>
                        {d.last_commission_paid_amount ? (
                          <div className="text-[11px] text-slate-500">
                            Paid {formatBDT(d.last_commission_paid_amount)}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-slate-400">Never settled</span>
                    )}
                  </td>
                  <td className="py-3 pr-3 text-right text-xs font-mono tabular-nums">
                    {(d.unpaid_commission_total || 0) > 0 ? (
                      <div>
                        <div className="font-bold text-amber-700">
                          {formatBDT(d.unpaid_commission_total || 0)}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {d.unpaid_referrals_count || 0} unpaid
                        </div>
                      </div>
                    ) : (
                      <span className="text-emerald-700 font-medium">৳0 (Clear)</span>
                    )}
                  </td>
                  <td className="py-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      {onOpenPayout && (
                        <button
                          type="button"
                          onClick={() => onOpenPayout(d.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-teal-600 rounded-md hover:bg-teal-700 whitespace-nowrap"
                        >
                          <Banknote className="w-3.5 h-3.5" />
                          Payout / Settle
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => loadStatement(d.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 whitespace-nowrap"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        Statement
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEdit(d)}
                        className="p-1.5 text-slate-600 border border-slate-300 rounded-md hover:bg-slate-100"
                        aria-label={`Edit ${d.name}`}
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(d)}
                        className="p-1.5 text-red-600 border border-red-200 rounded-md hover:bg-red-50"
                        aria-label={`Remove ${d.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </div>

      {/* Printable Doctor Commission Statement (Compact & Secret A4 Layout) */}
      {statement && statementDocId && (
        <div className="fixed inset-0 z-50 bg-slate-900/70 overflow-y-auto p-4 sm:p-6 flex flex-col items-center print:block print:static print:inset-auto print:h-auto print:min-h-0 print:overflow-visible print:p-0 print:bg-white">
          <style>{'@media print { @page { size: A4 portrait; margin: 5mm; } }'}</style>
          <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-xl px-4 py-3 mb-4 flex flex-wrap items-center justify-between gap-3 no-print">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-slate-700">Date Range:</span>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="px-2.5 py-1.5 font-mono border border-slate-300 rounded-md"
              />
              <span>to</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="px-2.5 py-1.5 font-mono border border-slate-300 rounded-md"
              />
              <button
                type="button"
                onClick={() => loadStatement(statementDocId, fromDate, toDate)}
                className="px-3 py-1.5 font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap"
              >
                Recalculate
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap"
              >
                <Printer className="w-4 h-4" />
                Print Statement
              </button>
              <button
                type="button"
                onClick={() => setStatement(null)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                <X className="w-4 h-4" />
                Close
              </button>
            </div>
          </div>

          <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-xl p-6 shadow-lg print-statement-sheet print-pure-black text-slate-900 print:p-0 print:border-0 print:rounded-none print:shadow-none print:max-w-none">
            {/* Compact Secret Header: Doctor Name, Period, Last Settled Date only */}
            <div className="border-b border-slate-300 pb-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 print:pb-1.5">
              <div className="font-bold text-slate-900 text-base print:text-sm leading-tight">
                {statement.doctor.name}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs print:text-[10.5px] font-mono tabular-nums text-slate-700 sm:text-right">
                <span>
                  Period: {statement.from} to {statement.to}
                </span>
                <span>
                  Last Settled Date: {statement.doctor.last_commission_paid_up_to || 'None'}
                </span>
              </div>
            </div>

            <div className="overflow-x-auto print-table-wrap mt-3 print:mt-1.5 print:overflow-visible">
              <table className="w-full text-xs print:text-[10px] border-collapse">
                <thead>
                  <tr className="border-b border-slate-300 text-left text-slate-600">
                    <th className="py-2 pr-2 print:py-1 print:pr-1 font-semibold">Date / Inv</th>
                    <th className="py-2 pr-2 print:py-1 print:pr-1 font-semibold">Patient</th>
                    <th className="py-2 pr-2 print:py-1 print:pr-1 font-semibold">Tests Performed</th>
                    <th className="py-2 pr-2 print:py-1 print:pr-1 font-semibold text-right">Gross</th>
                    <th className="py-2 pr-2 print:py-1 print:pr-1 font-semibold text-right">Less</th>
                    <th className="py-2 pr-2 print:py-1 print:pr-1 font-semibold text-right">Net Bill</th>
                    <th className="py-2 pr-2 print:py-1 print:pr-1 font-semibold text-right">Rate</th>
                    <th className="py-2 print:py-1 font-semibold text-right">Commission</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {statement.referrals.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-500">
                        No patient referrals in this date range.
                      </td>
                    </tr>
                  ) : (
                    statement.referrals.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2 pr-2 print:py-1 print:pr-1 font-mono tabular-nums align-top whitespace-nowrap">
                          <div className="font-semibold">{r.invoice_no}</div>
                          <div className="text-[10px] print:text-[9px] text-slate-500">
                            {formatDateTime(r.created_at).split(',')[0]}
                          </div>
                        </td>
                        <td className="py-2 pr-2 print:py-1 print:pr-1 align-top">
                          <div className="font-medium">{r.patient_name}</div>
                          <div className="text-[10px] print:text-[9px] font-mono text-slate-500">{r.patient_uid}</div>
                        </td>
                        <td className="py-2 pr-2 print:py-1 print:pr-1 text-slate-600 max-w-[210px] print:max-w-[190px] align-top">
                          <div className="test-names-clamp-2" title={r.test_names}>
                            {r.test_names}
                          </div>
                        </td>
                        <td className="py-2 pr-2 print:py-1 print:pr-1 text-right font-mono tabular-nums align-top whitespace-nowrap">
                          {formatBDT(r.subtotal)}
                        </td>
                        <td className="py-2 pr-2 print:py-1 print:pr-1 text-right font-mono tabular-nums align-top whitespace-nowrap">
                          {r.discount_amount > 0 ? (
                            <span>
                              -{formatBDT(r.discount_amount)} ({r.discount_pct}%)
                            </span>
                          ) : (
                            '0%'
                          )}
                        </td>
                        <td className="py-2 pr-2 print:py-1 print:pr-1 text-right font-mono tabular-nums font-medium align-top whitespace-nowrap">
                          {formatBDT(r.net_total)}
                        </td>
                        <td className="py-2 pr-2 print:py-1 print:pr-1 text-right font-mono tabular-nums text-slate-600 align-top whitespace-nowrap">
                          {r.commission_type === 'flat'
                            ? `${formatBDT(r.commission_value)} Flat`
                            : r.commission_type === 'per_test'
                            ? `Per-Test (${r.commission_pct}%)`
                            : `${r.commission_pct}%`}
                        </td>
                        <td className="py-2 print:py-1 text-right font-mono tabular-nums font-bold text-teal-800 align-top whitespace-nowrap">
                          {formatBDT(r.commission_amount)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-300 font-bold text-xs print:text-[10.5px]">
                    <td colSpan={6} className="py-2.5 print:py-1.5">
                      Grand Total ({statement.totals.totalPatients} Patients)
                    </td>
                    <td className="py-2.5 pr-2 print:py-1.5 print:pr-1 text-right text-slate-600 whitespace-nowrap">
                      Total Payable:
                    </td>
                    <td className="py-2.5 print:py-1.5 text-right font-mono tabular-nums text-teal-800 text-sm print:text-xs whitespace-nowrap">
                      {formatBDT(statement.totals.totalCommission)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
