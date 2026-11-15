import React, { useCallback, useEffect, useState } from 'react';
import { Edit2, FileSpreadsheet, Plus, Printer, Trash2, X } from 'lucide-react';
import { apiFetch, formatBDT, formatDateTime, getMonthStartISO, getTodayISO } from '../lib/api.ts';
import type { Doctor, LabSettings } from '../types.ts';

interface DoctorsViewProps {
  settings: LabSettings;
}

interface DoctorStatementResponse {
  doctor: Doctor;
  from: string;
  to: string;
  referrals: Array<{
    id: number;
    invoice_no: string;
    created_at: string;
    patient_uid: string;
    patient_name: string;
    test_names: string;
    subtotal: number;
    discount_amount: number;
    net_total: number;
    paid_amount: number;
    due_amount: number;
    commission_pct: number;
    commission_amount: number;
  }>;
  totals: {
    totalPatients: number;
    totalGross: number;
    totalDiscount: number;
    totalNet: number;
    totalPaid: number;
    totalDue: number;
    totalCommission: number;
  };
}

export const DoctorsView: React.FC<DoctorsViewProps> = ({ settings }) => {
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
                <th className="py-2 pr-3 font-medium">Doctor & Degree</th>
                <th className="py-2 pr-3 font-medium">Hospital / Mobile</th>
                <th className="py-2 pr-3 font-medium text-right">Commission</th>
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
                  <td className="py-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
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

      {/* Printable Doctor Commission Statement */}
      {statement && statementDocId && (
        <div className="fixed inset-0 z-50 bg-slate-900/70 overflow-y-auto p-4 sm:p-6 flex flex-col items-center print:block print:static print:inset-auto print:h-auto print:min-h-0 print:overflow-visible print:p-0 print:bg-white">
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

          <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-xl p-8 shadow-lg print-sheet text-slate-900">
            <div className="border-b-2 border-slate-900 pb-4 flex justify-between items-end">
              <div>
                <h2 className="text-xl font-bold">{settings.lab_name}</h2>
                <p className="text-xs text-slate-600">{settings.lab_address}</p>
                <p className="text-xs text-slate-600">Proprietor: {settings.proprietor_name} · {settings.lab_phone}</p>
              </div>
              <div className="text-right">
                <div className="text-xs font-bold uppercase tracking-wider text-teal-700">
                  Doctor Referral & Commission Statement
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-600 mt-1">
                  {statement.from} to {statement.to}
                </div>
              </div>
            </div>

            <div className="py-4 border-b border-slate-200 flex flex-wrap justify-between gap-4 text-sm">
              <div>
                <div className="font-bold text-slate-900">{statement.doctor.name}</div>
                <div className="text-xs text-slate-600">
                  {statement.doctor.degree} {statement.doctor.hospital ? `· ${statement.doctor.hospital}` : ''}
                </div>
              </div>
              <div className="text-right text-xs">
                <div>Default Rate: <span className="font-mono font-bold">{statement.doctor.commission_pct}%</span></div>
                <div>Total Referrals: <span className="font-mono font-bold">{statement.totals.totalPatients}</span></div>
              </div>
            </div>

            <table className="w-full text-xs border-collapse mt-4">
              <thead>
                <tr className="border-b border-slate-300 text-left text-slate-600">
                  <th className="py-2 pr-2 font-semibold">Date / Inv</th>
                  <th className="py-2 pr-2 font-semibold">Patient</th>
                  <th className="py-2 pr-2 font-semibold">Tests</th>
                  <th className="py-2 pr-2 font-semibold text-right">Gross</th>
                  <th className="py-2 pr-2 font-semibold text-right">Less</th>
                  <th className="py-2 pr-2 font-semibold text-right">Net Bill</th>
                  <th className="py-2 font-semibold text-right">Commission</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {statement.referrals.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      No patient referrals in this date range.
                    </td>
                  </tr>
                ) : (
                  statement.referrals.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 pr-2 font-mono tabular-nums">
                        <div className="font-semibold">{r.invoice_no}</div>
                        <div className="text-[10px] text-slate-500">{formatDateTime(r.created_at).split(',')[0]}</div>
                      </td>
                      <td className="py-2 pr-2">
                        <div className="font-medium">{r.patient_name}</div>
                        <div className="text-[10px] font-mono text-slate-500">{r.patient_uid}</div>
                      </td>
                      <td className="py-2 pr-2 text-slate-600 max-w-[200px]">{r.test_names}</td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums">{formatBDT(r.subtotal)}</td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums">{formatBDT(r.discount_amount)}</td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums font-medium">{formatBDT(r.net_total)}</td>
                      <td className="py-2 text-right font-mono tabular-nums font-bold text-teal-800">
                        {formatBDT(r.commission_amount)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-900 font-bold text-xs">
                  <td colSpan={3} className="py-3">Total ({statement.totals.totalPatients} Patients)</td>
                  <td className="py-3 pr-2 text-right font-mono tabular-nums">{formatBDT(statement.totals.totalGross)}</td>
                  <td className="py-3 pr-2 text-right font-mono tabular-nums">{formatBDT(statement.totals.totalDiscount)}</td>
                  <td className="py-3 pr-2 text-right font-mono tabular-nums">{formatBDT(statement.totals.totalNet)}</td>
                  <td className="py-3 text-right font-mono tabular-nums text-teal-800 text-sm">
                    {formatBDT(statement.totals.totalCommission)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
