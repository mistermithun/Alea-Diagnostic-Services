import React, { useState } from 'react';
import { ArrowLeft, ClipboardList, Lock, ShieldCheck, User } from 'lucide-react';
import { apiFetch, setAdminToken, setStaffToken } from '../lib/api.ts';
import type { LabSettings } from '../types.ts';

interface AdminLoginViewProps {
  settings: LabSettings;
  onAuthenticated: (adminName: string) => void;
  onBackToHome: () => void;
}

export const AdminLoginView: React.FC<AdminLoginViewProps> = ({
  settings,
  onAuthenticated,
  onBackToHome,
}) => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; adminName: string }>('/api/auth/admin-login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setAdminToken(res.token);
      setPassword('');
      onAuthenticated(res.adminName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Admin authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between p-4 sm:p-6">
      <header className="max-w-md w-full mx-auto pt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={onBackToHome}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 py-1.5 whitespace-nowrap"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Portal Home
        </button>
        <span className="text-xs font-medium text-slate-700">Admin Access</span>
      </header>

      <main className="w-full max-w-md mx-auto my-8 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="bg-slate-900 text-white px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-teal-600 text-white flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight leading-snug">{settings.lab_name}</h1>
              <p className="text-xs text-slate-300 mt-0.5">{settings.lab_address}</p>
            </div>
          </div>
          <div className="mt-5 pt-4 border-t border-slate-800">
            <h2 className="text-base font-semibold text-white">Administrator Control Login</h2>
            <p className="text-xs text-slate-300 mt-1">
              Authorized for Proprietor {settings.proprietor_name}. Unlocks financial analytics, test pricing, doctor commissions, and backups.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label htmlFor="admin-master-pw" className="block text-xs font-semibold text-slate-800 mb-1.5">
              Master Admin Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                id="admin-master-pw"
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter master password"
                className="w-full pl-10 pr-4 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                required
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-1.5">
              Default initial Admin password: <span className="font-mono font-semibold text-slate-700">alea2026</span>
            </p>
          </div>

          {error && (
            <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            {loading ? 'Verifying...' : 'Sign In to Admin Panel'}
          </button>
        </form>
      </main>

      <footer className="max-w-md w-full mx-auto text-center text-[11px] text-slate-500 pb-2">
        {settings.lab_name} · Proprietor: {settings.proprietor_name}
      </footer>
    </div>
  );
};

interface StaffLoginViewProps {
  settings: LabSettings;
  onAuthenticated: (staffName: string) => void;
  onBackToHome: () => void;
}

export const StaffLoginView: React.FC<StaffLoginViewProps> = ({
  settings,
  onAuthenticated,
  onBackToHome,
}) => {
  const [staffName, setStaffName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; staffName: string }>('/api/auth/staff-login', {
        method: 'POST',
        body: JSON.stringify({ staffName: staffName.trim(), password }),
      });
      setStaffToken(res.token);
      setPassword('');
      onAuthenticated(res.staffName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Staff authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between p-4 sm:p-6">
      <header className="max-w-md w-full mx-auto pt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={onBackToHome}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 py-1.5 whitespace-nowrap"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Portal Home
        </button>
        <span className="text-xs font-medium text-slate-700">Reception &amp; Lab Desk</span>
      </header>

      <main className="w-full max-w-md mx-auto my-8 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="bg-slate-800 text-white px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-teal-600 text-white flex items-center justify-center shrink-0">
              <ClipboardList className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight leading-snug">{settings.lab_name}</h1>
              <p className="text-xs text-slate-300 mt-0.5">{settings.lab_address}</p>
            </div>
          </div>
          <div className="mt-5 pt-4 border-t border-slate-700">
            <h2 className="text-base font-semibold text-white">Staff &amp; Technologist Login</h2>
            <p className="text-xs text-slate-300 mt-1">
              Access patient registration, invoice billing, lab result entry, report printing, and due collection.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label htmlFor="staff-operator-name" className="block text-xs font-semibold text-slate-800 mb-1.5">
              Staff / Operator Name (Optional)
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                id="staff-operator-name"
                type="text"
                autoFocus
                value={staffName}
                onChange={(e) => setStaffName(e.target.value)}
                placeholder="e.g. Reception Desk 1"
                className="w-full pl-10 pr-4 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <div>
            <label htmlFor="staff-access-pw" className="block text-xs font-semibold text-slate-800 mb-1.5">
              Staff Access Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                id="staff-access-pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter staff password"
                className="w-full pl-10 pr-4 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                required
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-1.5">
              Default initial Staff password: <span className="font-mono font-semibold text-slate-700">staff2026</span>
            </p>
          </div>

          {error && (
            <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            {loading ? 'Verifying...' : 'Sign In to Staff Desk'}
          </button>
        </form>
      </main>

      <footer className="max-w-md w-full mx-auto text-center text-[11px] text-slate-500 pb-2">
        {settings.lab_name} · Helpline: <span className="font-mono tabular-nums">{settings.lab_phone}</span>
      </footer>
    </div>
  );
};
