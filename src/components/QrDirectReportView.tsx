import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, KeyRound, ShieldCheck } from 'lucide-react';
import { patientApiFetch, setPatientToken } from '../lib/api.ts';
import type { FullInvoice, LabSettings, PatientProfile } from '../types.ts';
import { ReportPrintModal } from './ReportPrintModal.tsx';

interface QrDirectReportViewProps {
  settings: LabSettings;
  publicBaseUrl?: string;
  patientIdParam?: string;
  qrToken: string;
  invoiceId?: number;
  testId?: number;
  onQrAuthenticated: () => void;
  onOpenFullArchive: () => void;
  onGoToManualLogin: () => void;
  onBackToHome: () => void;
}

export const QrDirectReportView: React.FC<QrDirectReportViewProps> = ({
  settings,
  publicBaseUrl,
  patientIdParam,
  qrToken,
  invoiceId,
  testId,
  onQrAuthenticated,
  onOpenFullArchive,
  onGoToManualLogin,
  onBackToHome,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [patient, setPatient] = useState<PatientProfile | null>(null);
  const [report, setReport] = useState<FullInvoice | null>(null);
  const [focusTestId, setFocusTestId] = useState<number | null>(testId ?? null);
  const onQrAuthenticatedRef = useRef(onQrAuthenticated);
  onQrAuthenticatedRef.current = onQrAuthenticated;

  useEffect(() => {
    let active = true;
    const loadViaQr = async () => {
      if (!qrToken) {
        setError('Missing encrypted QR code parameter.');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (patientIdParam) params.set('id', patientIdParam);
        params.set('token', qrToken);
        if (invoiceId && invoiceId > 0) params.set('inv', String(invoiceId));
        if (testId && testId > 0) params.set('test', String(testId));

        const res = await patientApiFetch<{
          token: string;
          patient: PatientProfile;
          report: FullInvoice | null;
          focusTestId: number | null;
        }>(`/api/patient-auth/qr-access?${params.toString()}`);

        if (!active) return;
        setPatientToken(res.token);
        onQrAuthenticatedRef.current();
        setPatient(res.patient);
        setReport(res.report);
        setFocusTestId(res.focusTestId ?? null);
        if (!res.report) {
          setError('No diagnostic reports were found for this patient yet.');
        }
      } catch (err) {
        if (!active) return;
        setError(
          err instanceof Error
            ? err.message
            : 'Unable to verify QR report link. Please log in manually with your Patient ID and Password.'
        );
      } finally {
        if (active) setLoading(false);
      }
    };

    loadViaQr();
    return () => {
      active = false;
    };
  }, [patientIdParam, qrToken, invoiceId, testId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="bg-white border border-slate-200 rounded-xl px-6 py-8 max-w-sm w-full shadow-sm space-y-2">
          <div className="text-sm font-bold text-slate-900">{settings.lab_name}</div>
          <div className="text-xs text-slate-600">Verifying encrypted patient report link...</div>
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-between p-4 sm:p-6">
        <header className="max-w-lg w-full mx-auto pt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={onBackToHome}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 py-1.5"
          >
            <ArrowLeft className="w-4 h-4" />
            Portal Home
          </button>
          <span className="text-xs font-semibold text-teal-800">{settings.lab_name}</span>
        </header>

        <main className="w-full max-w-lg mx-auto my-8 bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4 text-center">
          <div className="text-base font-bold text-slate-900">QR Report Verification</div>
          <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {error || 'Report could not be loaded.'}
          </div>
          <p className="text-xs text-slate-600">
            You can still view and download all your diagnostic reports using your Patient ID and Portal Password printed on your cash memo.
          </p>
          <div className="flex flex-col sm:flex-row gap-2.5 justify-center pt-1">
            <button
              type="button"
              onClick={onGoToManualLogin}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700"
            >
              <KeyRound className="w-4 h-4" />
              Patient ID &amp; Password Login
            </button>
            <button
              type="button"
              onClick={onBackToHome}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Back to Home
            </button>
          </div>
        </main>

        <footer className="max-w-lg w-full mx-auto text-center text-[11px] text-slate-500 pb-2">
          {settings.lab_name} · Helpline: <span className="font-mono tabular-nums">{settings.lab_phone}</span>
        </footer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col print:block print:min-h-0 print:h-auto print:bg-white">
      {/* Verified Patient Banner (Hidden during print) */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 sm:px-6 py-3 no-print">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-bold text-slate-900 truncate">
              <ShieldCheck className="w-4 h-4 text-teal-600 shrink-0" />
              <span className="truncate">{settings.lab_name}</span>
            </div>
            <div className="text-[11px] text-slate-600 truncate">
              Instant QR Digital Report · {patient?.name} ({patient?.patient_uid})
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onBackToHome}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Home
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 print:block">
        <ReportPrintModal
          data={report}
          focusTestId={focusTestId}
          settings={settings}
          publicBaseUrl={publicBaseUrl}
          portalMode={true}
          inlinePageMode={true}
          onViewAllArchive={onOpenFullArchive}
          onClose={onBackToHome}
        />
      </main>
    </div>
  );
};
