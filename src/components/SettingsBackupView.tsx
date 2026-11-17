import React, { useState } from 'react';
import { Database, Download, KeyRound, Network, Save } from 'lucide-react';
import { apiFetch, getAdminToken, resolveApiUrl } from '../lib/api.ts';
import type { LabSettings, SystemInfo } from '../types.ts';

interface SettingsBackupViewProps {
  systemInfo: SystemInfo;
  onSettingsUpdated: (settings: LabSettings) => void;
}

export const SettingsBackupView: React.FC<SettingsBackupViewProps> = ({
  systemInfo,
  onSettingsUpdated,
}) => {
  const [form, setForm] = useState<LabSettings>({ ...systemInfo.settings });
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState('');
  const [settingsErr, setSettingsErr] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  const [staffNewPw, setStaffNewPw] = useState('');
  const [staffConfirmPw, setStaffConfirmPw] = useState('');
  const [staffPwMsg, setStaffPwMsg] = useState('');
  const [staffPwErr, setStaffPwErr] = useState('');
  const [savingStaffPw, setSavingStaffPw] = useState(false);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsMsg('');
    setSettingsErr('');
    try {
      const res = await apiFetch<{ settings: LabSettings }>('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      onSettingsUpdated(res.settings);
      setSettingsMsg('Laboratory settings and signatories saved.');
    } catch (err) {
      setSettingsErr(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg('');
    setPwErr('');
    if (newPassword !== confirmPassword) {
      setPwErr('New password and confirmation do not match.');
      return;
    }
    setSavingPw(true);
    try {
      await apiFetch('/api/admin/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPwMsg('Master Admin password updated successfully.');
    } catch (err) {
      setPwErr(err instanceof Error ? err.message : 'Failed to update password.');
    } finally {
      setSavingPw(false);
    }
  };

  const handleChangeStaffPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setStaffPwMsg('');
    setStaffPwErr('');
    if (staffNewPw !== staffConfirmPw) {
      setStaffPwErr('New staff password and confirmation do not match.');
      return;
    }
    setSavingStaffPw(true);
    try {
      await apiFetch('/api/admin/change-staff-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword: staffNewPw }),
      });
      setStaffNewPw('');
      setStaffConfirmPw('');
      setStaffPwMsg('Staff access password updated successfully.');
    } catch (err) {
      setStaffPwErr(err instanceof Error ? err.message : 'Failed to update staff password.');
    } finally {
      setSavingStaffPw(false);
    }
  };

  const handleDownloadBackup = () => {
    const token = getAdminToken();
    if (!token) return;
    const url = resolveApiUrl(`/api/admin/backup?token=${encodeURIComponent(token)}`);
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-slate-200">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
          System Settings, Security & Database Backup
        </h1>
        <p className="text-sm text-slate-600 mt-0.5">
          Configure laboratory credentials, discount limits, clinical signatories, cloud database status, and backups.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Lab Branding & Signatories */}
        <form onSubmit={handleSaveSettings} className="xl:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900 pb-2 border-b border-slate-200">
            Laboratory Profile, Discount Cap & Report Signatories
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Laboratory Name</label>
              <input
                type="text"
                value={form.lab_name}
                onChange={(e) => setForm({ ...form, lab_name: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Proprietor / Admin Name</label>
              <input
                type="text"
                value={form.proprietor_name}
                onChange={(e) => setForm({ ...form, proprietor_name: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                required
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Address</label>
              <input
                type="text"
                value={form.lab_address}
                onChange={(e) => setForm({ ...form, lab_address: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Official Contact Number</label>
              <input
                type="text"
                value={form.lab_phone}
                onChange={(e) => setForm({ ...form, lab_phone: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Max Staff Discount Limit (%)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={form.max_staff_discount_pct}
                onChange={(e) => setForm({ ...form, max_staff_discount_pct: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                required
              />
              <p className="text-[11px] text-slate-500 mt-1">
                0–100% (100% lets staff authorize up to 100% complimentary/free testing).
              </p>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Medical Technologist Name</label>
              <input
                type="text"
                value={form.technologist_name}
                onChange={(e) => setForm({ ...form, technologist_name: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Technologist Designation</label>
              <input
                type="text"
                value={form.technologist_title}
                onChange={(e) => setForm({ ...form, technologist_title: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Pathologist Name</label>
              <input
                type="text"
                value={form.pathologist_name}
                onChange={(e) => setForm({ ...form, pathologist_name: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Pathologist Designation</label>
              <input
                type="text"
                value={form.pathologist_title}
                onChange={(e) => setForm({ ...form, pathologist_title: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Pre-Printed Pad Header Margin (inches)
              </label>
              <input
                type="number"
                min={0}
                max={4}
                step="0.05"
                value={form.pad_header_margin_in || '1.5'}
                onChange={(e) => setForm({ ...form, pad_header_margin_in: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                required
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Blank top clearance on lab offset pad (default 1.5&quot;).
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Pre-Printed Pad Footer Margin (inches)
              </label>
              <input
                type="number"
                min={0}
                max={3}
                step="0.05"
                value={form.pad_footer_margin_in || '0.4'}
                onChange={(e) => setForm({ ...form, pad_footer_margin_in: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                required
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Blank bottom clearance on lab offset pad (default 0.4&quot;).
              </p>
            </div>
          </div>

          {settingsErr && <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">{settingsErr}</div>}
          {settingsMsg && <div className="p-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">{settingsMsg}</div>}

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={savingSettings}
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {savingSettings ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>

        {/* Right Column: Password, SQLite Backup, LAN Deployment */}
        <div className="xl:col-span-5 space-y-6">
          {/* Cloud / Database Status & Backup */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Database className="w-4 h-4 text-teal-700" />
                Database Storage &amp; Backup
              </div>
              <span
                className={`px-2 py-0.5 text-[11px] font-semibold rounded border ${
                  systemInfo.storageMode === 'mongodb'
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    : 'bg-amber-50 text-amber-800 border-amber-200'
                }`}
              >
                {systemInfo.storageMode === 'mongodb' ? 'MongoDB Atlas' : 'Local SQLite'}
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              {systemInfo.storageMode === 'mongodb' ? (
                <>
                  Connected to <span className="font-semibold text-slate-900">MongoDB Atlas</span> via{' '}
                  <span className="font-mono">MONGO_URI</span>. All patient entries, lab reports, and settings persist permanently across Render redeployments.
                </>
              ) : (
                <>
                  Running in local SQLite fallback mode. For permanent persistence across Render deployments, configure{' '}
                  <span className="font-mono font-semibold text-slate-800">MONGO_URI</span> in your host environment variables.
                </>
              )}
            </p>
            {systemInfo.storageWarning && (
              <div className="p-2.5 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg leading-relaxed">
                {systemInfo.storageWarning}
              </div>
            )}
            <button
              type="button"
              onClick={handleDownloadBackup}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
            >
              <Download className="w-4 h-4" />
              {systemInfo.storageMode === 'mongodb'
                ? 'Download Cloud Database Backup (.json)'
                : 'Download SQLite Backup (.db)'}
            </button>
          </div>

          {/* Local Network (LAN) Multi-Device Access */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Network className="w-4 h-4 text-teal-700" />
              Local Network (Wi-Fi / LAN) Access
            </div>
            <p className="text-xs text-slate-600">
              Server binds to <span className="font-mono font-semibold">0.0.0.0:{systemInfo.port}</span>. Open any of the addresses below on reception PCs, tablets, or phones connected to the same Wi-Fi/LAN:
            </p>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
              {systemInfo.lanUrls.length === 0 ? (
                <div className="text-xs font-mono text-slate-700">http://localhost:{systemInfo.port}</div>
              ) : (
                systemInfo.lanUrls.map((u) => (
                  <div key={u} className="text-xs font-mono font-semibold text-teal-800">
                    {u}
                  </div>
                ))
              )}
            </div>
            <div className="text-[11px] text-slate-500 space-y-1">
              <div>Windows PC host: run <span className="font-mono text-slate-700">ipconfig</span> in Command Prompt to check IPv4 Address.</div>
              <div>Start server: <span className="font-mono text-slate-700">npm install &amp;&amp; npm run dev</span></div>
            </div>
          </div>

          {/* Master Password Change */}
          <form onSubmit={handleChangePassword} className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <KeyRound className="w-4 h-4 text-teal-700" />
              Change Master Admin Password
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Current Password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={4}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Confirm New Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={4}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                required
              />
            </div>

            {pwErr && <div className="p-2.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">{pwErr}</div>}
            {pwMsg && <div className="p-2.5 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">{pwMsg}</div>}

            <button
              type="submit"
              disabled={savingPw}
              className="w-full py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50"
            >
              {savingPw ? 'Updating...' : 'Update Master Password'}
            </button>
          </form>

          {/* Staff Access Password Change */}
          <form onSubmit={handleChangeStaffPassword} className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <KeyRound className="w-4 h-4 text-slate-700" />
              Change Staff Desk Password
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">New Staff Password</label>
              <input
                type="password"
                value={staffNewPw}
                onChange={(e) => setStaffNewPw(e.target.value)}
                minLength={4}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Confirm Staff Password</label>
              <input
                type="password"
                value={staffConfirmPw}
                onChange={(e) => setStaffConfirmPw(e.target.value)}
                minLength={4}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                required
              />
            </div>

            {staffPwErr && <div className="p-2.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">{staffPwErr}</div>}
            {staffPwMsg && <div className="p-2.5 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">{staffPwMsg}</div>}

            <button
              type="submit"
              disabled={savingStaffPw}
              className="w-full py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {savingStaffPw ? 'Updating...' : 'Update Staff Password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
