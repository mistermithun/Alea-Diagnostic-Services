import React, { useState } from 'react';
import { Lock, ShieldCheck, UserCheck, X } from 'lucide-react';
import { apiFetch, setAdminToken } from '../lib/api.ts';
import type { LabSettings } from '../types.ts';
import { BrandLogo } from './BrandLogo.tsx';

interface LoginModalProps {
  isOpen: boolean;
  isAdmin: boolean;
  settings: LabSettings;
  onClose: () => void;
  onAuthenticated: (adminName: string) => void;
  onSwitchToStaff: () => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({
  isOpen,
  isAdmin,
  settings,
  onClose,
  onAuthenticated,
  onSwitchToStaff,
}) => {
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; adminName: string }>('/api/auth/admin-login', {
        method: 'POST',
        body: JSON.stringify({ password, rememberMe }),
      });
      setAdminToken(res.token, rememberMe);
      setPassword('');
      onAuthenticated(res.adminName);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-navy-dark/60 p-4 backdrop-blur-[2px] no-print">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-brand-red via-brand-navy to-brand-cyan" />
        <div className="bg-brand-navy text-white px-6 py-5 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <BrandLogo surface="dark" className="h-10 w-auto" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-teal-300 tracking-wide truncate">
                {settings.lab_name}
              </p>
              <h2 className="text-lg font-semibold mt-0.5">Access Control & Mode Switch</h2>
              <p className="text-xs text-slate-200 mt-0.5 truncate">{settings.lab_address}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-300 hover:text-white p-1.5 rounded-lg transition-colors shrink-0"
            aria-label="Close access dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-1 pb-4 border-b border-slate-200">
            <span className="font-medium text-slate-800">Proprietor: {settings.proprietor_name}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{settings.lab_phone}</span>
          </div>

          {isAdmin ? (
            <div className="space-y-4">
              <div className="p-4 bg-teal-50/70 border border-teal-200 rounded-lg flex items-start gap-3">
                <ShieldCheck className="w-5 h-5 text-brand-navy shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-brand-navy">Admin Session Active</p>
                  <p className="text-xs text-slate-600 mt-1">
                    Signed in as {settings.proprietor_name}. Full financial, catalog, doctor commission, and database controls are unlocked.
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setAdminToken(null);
                    onSwitchToStaff();
                    onClose();
                  }}
                  className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                >
                  Lock & Switch to Staff Mode
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark transition-colors whitespace-nowrap shrink-0"
                >
                  Continue as Admin
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleAdminSubmit} className="space-y-4">
              <div>
                <label htmlFor="admin-password-input" className="block text-sm font-medium text-slate-800 mb-1.5">
                  Admin Master Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="admin-password-input"
                    type="password"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter master password"
                    className="w-full pl-10 pr-4 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-navy focus:border-brand-navy"
                    required
                  />
                </div>
              </div>

              <label className="flex items-center gap-2.5 py-1 cursor-pointer select-none text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 accent-brand-navy rounded"
                />
                <span>Keep me logged in on this device (30 days)</span>
              </label>

              {error && (
                <div className="p-3 text-xs font-medium text-brand-red-dark bg-red-50 border border-red-200 rounded-lg">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    onSwitchToStaff();
                    onClose();
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <UserCheck className="w-4 h-4 text-slate-500" />
                  Stay in Staff Mode
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-5 py-2 text-sm font-medium text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                >
                  {loading ? 'Verifying...' : 'Unlock Admin Panel'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
