import React, { useEffect, useState } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { apiFetch, formatBDT } from '../lib/api.ts';

export interface DeletePatientTarget {
  id: number;
  invoice_no: string;
  patient_id?: number;
  patient_uid: string;
  patient_name: string;
  net_total: number;
  total_tests?: number;
}

export interface DeletePatientResponse {
  success: boolean;
  deletedInvoiceId: number;
  invoiceNo: string;
  deletedPatientId: number;
  patientUid: string;
  patientName: string;
  patientDeleted: boolean;
  deletedTestsCount: number;
  deletedResultsCount: number;
}

interface DeletePatientConfirmModalProps {
  target: DeletePatientTarget | null;
  onClose: () => void;
  onDeleted: (result: DeletePatientResponse) => Promise<void> | void;
}

export const DeletePatientConfirmModal: React.FC<DeletePatientConfirmModalProps> = ({
  target,
  onClose,
  onDeleted,
}) => {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    setDeleting(false);
  }, [target?.id]);

  useEffect(() => {
    if (!target) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [target, deleting, onClose]);

  if (!target) return null;

  const handleConfirmDelete = async () => {
    setDeleting(true);
    setError('');
    try {
      const result = await apiFetch<DeletePatientResponse>(`/api/invoices/${target.id}`, {
        method: 'DELETE',
      });
      await onDeleted(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete patient record.');
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-[1px] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-patient-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-red-50 border border-red-200 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <h3
                id="delete-patient-modal-title"
                className="text-base font-bold text-slate-900 leading-snug"
              >
                Delete Patient Record
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">Permanent Admin Deletion</p>
            </div>
          </div>

          <button
            type="button"
            disabled={deleting}
            onClick={onClose}
            aria-label="Close confirmation dialog"
            className="p-1 text-slate-400 hover:text-slate-600 rounded-md hover:bg-slate-100 disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm font-medium text-slate-800">
            Are you sure you want to delete this patient record?
          </p>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">Patient Name</span>
              <span className="font-bold text-slate-900 text-right">{target.patient_name}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">Patient ID</span>
              <span className="font-mono font-semibold text-slate-800 tabular-nums">
                {target.patient_uid}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">Invoice No</span>
              <span className="font-mono font-semibold text-slate-800 tabular-nums">
                {target.invoice_no}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">Net Billed</span>
              <span className="font-mono font-semibold text-slate-900 tabular-nums">
                {formatBDT(target.net_total)}
              </span>
            </div>
            {typeof target.total_tests === 'number' && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Associated Tests</span>
                <span className="font-mono font-semibold text-slate-800 tabular-nums">
                  {target.total_tests} test{target.total_tests === 1 ? '' : 's'}
                </span>
              </div>
            )}
          </div>

          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 leading-relaxed">
            This will permanently erase the invoice, all associated lab test entries, test results,
            and payment records from the database. This action cannot be undone.
          </p>

          {error && (
            <div className="p-2.5 text-xs font-medium text-red-800 bg-red-100 border border-red-300 rounded-lg">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2.5">
          <button
            type="button"
            disabled={deleting}
            onClick={onClose}
            className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={handleConfirmDelete}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {deleting ? 'Deleting...' : 'Delete Permanently'}
          </button>
        </div>
      </div>
    </div>
  );
};
