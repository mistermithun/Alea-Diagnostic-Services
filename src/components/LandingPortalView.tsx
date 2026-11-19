import React from 'react';
import { ArrowRight, ClipboardList, ShieldCheck, Stethoscope, UserCheck } from 'lucide-react';
import type { LabSettings } from '../types.ts';
import { BrandLogo } from './BrandLogo.tsx';
import { PWAInstallButton } from './PWAInstallControl.tsx';

interface LandingPortalViewProps {
  settings: LabSettings;
  onSelectAdminLogin: () => void;
  onSelectStaffLogin: () => void;
  onSelectPatientLogin: () => void;
  onSelectDoctorLogin: () => void;
}

export const LandingPortalView: React.FC<LandingPortalViewProps> = ({
  settings,
  onSelectAdminLogin,
  onSelectStaffLogin,
  onSelectPatientLogin,
  onSelectDoctorLogin,
}) => {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Top Bar — 3 zones separated cleanly */}
      <header className="bg-white border-b border-slate-200 px-4 sm:px-8 py-3.5">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-6">
          <div className="flex items-center gap-3 min-w-0">
            <BrandLogo surface="light" className="h-10 sm:h-11 w-auto" />
            <span className="text-base sm:text-lg font-bold tracking-tight text-brand-navy whitespace-nowrap truncate">
              {settings.lab_name}
            </span>
          </div>

          <div className="hidden md:flex items-center gap-6 text-xs text-slate-600">
            <span className="whitespace-nowrap">{settings.lab_address}</span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span className="font-mono tabular-nums font-medium text-brand-navy whitespace-nowrap">
              {settings.lab_phone}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton />
            <button
              type="button"
              onClick={onSelectPatientLogin}
              className="px-4 py-2 text-xs font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark transition-colors whitespace-nowrap shrink-0"
            >
              Patient Report Portal
            </button>
          </div>
        </div>
      </header>

      {/* Main Portal Selection Stage */}
      <main className="flex-1 flex items-center justify-center px-4 sm:px-8 py-10 sm:py-16">
        <div className="max-w-6xl w-full space-y-10">
          {/* Hero Heading */}
          <div className="max-w-2xl space-y-3">
            <p className="text-xs font-semibold text-brand-red tracking-wide uppercase">
              Laboratory Information Management System
            </p>
            <h1 className="text-3xl sm:text-4xl font-bold text-brand-navy tracking-tight leading-tight text-balance">
              Welcome to {settings.lab_name}
            </h1>
            <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
              Select your authorized portal below to access clinical operations, referral tracking, administrative analytics, or personal diagnostic reports.
            </p>
          </div>

          {/* 4-Column Role Entry Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 items-stretch">
            {/* 1. Patient Self-Service Card */}
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col justify-between">
              <div className="h-1 bg-brand-cyan" />
              <div className="p-6 flex-1 flex flex-col justify-between gap-6">
                <div className="space-y-4">
                  <div className="w-11 h-11 rounded-lg bg-brand-cyan text-white flex items-center justify-center">
                    <UserCheck className="w-5 h-5" />
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-lg font-bold text-brand-navy">Patient Self-Service</h2>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Secure patient archive to view your date-wise diagnostic history, inspect abnormal indicators, and download verified digital PDF reports.
                    </p>
                  </div>
                  <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500">
                    Sign in with Patient ID &amp; Memo Password
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onSelectPatientLogin}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-brand-cyan rounded-lg hover:bg-brand-cyan-dark transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Patient Portal Login</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </section>

            {/* 2. Doctor Portal Card */}
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col justify-between">
              <div className="h-1 bg-brand-navy" />
              <div className="p-6 flex-1 flex flex-col justify-between gap-6">
                <div className="space-y-4">
                  <div className="w-11 h-11 rounded-lg bg-brand-navy text-white flex items-center justify-center">
                    <Stethoscope className="w-5 h-5" />
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-lg font-bold text-brand-navy">Doctor Portal</h2>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Referring physician portal for live patient report, for transparent billing and instant PDF report download.
                    </p>
                  </div>
                  <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500">
                    Sign in with Doctor Username &amp; Password
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onSelectDoctorLogin}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-brand-navy bg-white border border-brand-navy/30 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Doctor Portal Login</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </section>

            {/* 3. Reception & Lab Staff Card */}
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col justify-between">
              <div className="h-1 bg-brand-navy-light" />
              <div className="p-6 flex-1 flex flex-col justify-between gap-6">
                <div className="space-y-4">
                  <div className="w-11 h-11 rounded-lg bg-brand-navy-light text-teal-300 flex items-center justify-center">
                    <ClipboardList className="w-5 h-5" />
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-lg font-bold text-brand-navy">Reception &amp; Lab Staff</h2>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Front-desk and pathology workstation for patient registration, cash memo billing, sample processing, lab result entry, and due collection.
                    </p>
                  </div>
                  <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500">
                    Authorized for Lab &amp; Reception Staff
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onSelectStaffLogin}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-brand-navy bg-white border border-brand-navy/30 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Staff Login</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </section>

            {/* 4. Administrator Portal Card */}
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col justify-between">
              <div className="h-1 bg-brand-red" />
              <div className="p-6 flex-1 flex flex-col justify-between gap-6">
                <div className="space-y-4">
                  <div className="w-11 h-11 rounded-lg bg-brand-red text-white flex items-center justify-center">
                    <ShieldCheck className="w-5 h-5" />
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-lg font-bold text-brand-navy">Administrator Portal</h2>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Proprietor &amp; management console for revenue analytics, test catalog pricing, doctor commission statements, expenses, and database backups.
                    </p>
                  </div>
                  <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500">
                    Authorized for {settings.proprietor_name}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onSelectAdminLogin}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Admin Login</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </section>
          </div>
        </div>
      </main>

      {/* Quiet Institutional Footer */}
      <footer className="bg-white border-t border-slate-200 px-4 sm:px-8 py-4">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <div>
            {settings.lab_name} · {settings.lab_address}
          </div>
          <div className="flex items-center gap-3">
            <span>Proprietor: {settings.proprietor_name}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{settings.lab_phone}</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
