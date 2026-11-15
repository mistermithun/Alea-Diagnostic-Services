import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  createAdminToken,
  createPatientToken,
  createStaffToken,
  decryptPatientQrToken,
  extractTokenFromRequest,
  hashPassword,
  makeRequireAdmin,
  makeRequirePatient,
  makeRequireStaffOrAdmin,
  type PatientTokenPayload,
  verifyAdminToken,
  verifyPassword,
  verifyPatientToken,
  verifyStaffToken,
} from './server/auth.ts';
import { getTodayDateStr } from './server/clinical-rules.ts';
import { createLimsStore, type LimsStore, StoreError } from './server/store.ts';
import type { CreateInvoicePayload, ParamPayload, UpdateInvoicePayload } from './server/store-types.ts';

function getLanUrls(port: number): string[] {
  const nets = os.networkInterfaces();
  const urls: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

function resolvePublicBaseUrl(): string {
  const raw =
    process.env.BASE_URL?.trim() ||
    process.env.VITE_BASE_URL?.trim() ||
    'https://alea-diagnostic-services.onrender.com';
  return raw.replace(/\/+$/, '');
}

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((err: unknown) => {
      if (err instanceof StoreError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      console.error('[API Error]', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal server error.',
      });
    });
  };

function registerRoutes(app: express.Express, store: LimsStore, port: number) {
  const getSecret = () => store.getAuthSecret();
  const requireAdmin = makeRequireAdmin(getSecret);
  const requireStaffOrAdmin = makeRequireStaffOrAdmin(getSecret);
  const requirePatient = makeRequirePatient(getSecret);

  const isAdminRequest = (req: Request): boolean => {
    const token = extractTokenFromRequest(req);
    return verifyAdminToken(token, getSecret()) !== null;
  };

  // Health check
  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      const ok = await store.ping();
      res.json({
        status: ok ? 'ok' : 'degraded',
        storageMode: store.mode,
        storageLabel: store.label,
        storageWarning: store.warning || '',
        time: new Date().toISOString(),
      });
    })
  );

  // System & Lab Branding Info
  app.get(
    '/api/system/info',
    asyncHandler(async (_req, res) => {
      const settings = await store.getAllSettings();
      res.json({
        settings,
        port,
        lanUrls: getLanUrls(port),
        serverDate: getTodayDateStr(),
        publicBaseUrl: resolvePublicBaseUrl(),
        storageMode: store.mode,
        storageLabel: store.label,
        storageWarning: store.warning || '',
      });
    })
  );

  // Authentication
  app.post(
    '/api/auth/admin-login',
    asyncHandler(async (req, res) => {
      const { password } = req.body as { password?: string };
      if (!password) {
        res.status(400).json({ error: 'Password is required.' });
        return;
      }
      const storedHash = await store.getSetting('admin_password_hash');
      if (!verifyPassword(password, storedHash)) {
        res.status(401).json({ error: 'Invalid master password.' });
        return;
      }
      const proprietor = (await store.getSetting('proprietor_name')) || 'Md. Mishkatur Rahman';
      const token = createAdminToken(getSecret(), proprietor, 24);
      res.json({ token, role: 'admin', adminName: proprietor });
    })
  );

  app.post(
    '/api/auth/staff-login',
    asyncHandler(async (req, res) => {
      const { staffName, password } = req.body as { staffName?: string; password?: string };
      if (!password) {
        res.status(400).json({ error: 'Staff access password is required.' });
        return;
      }
      const storedHash = await store.getSetting('staff_password_hash');
      if (!verifyPassword(password, storedHash)) {
        res.status(401).json({ error: 'Invalid staff password.' });
        return;
      }
      const cleanName = staffName?.trim() || 'Reception & Lab Staff';
      const token = createStaffToken(getSecret(), cleanName, 24);
      res.json({ token, role: 'staff', staffName: cleanName });
    })
  );

  app.get('/api/auth/verify', (req, res) => {
    const token = extractTokenFromRequest(req);
    const secret = getSecret();
    const adminPayload = verifyAdminToken(token, secret);
    if (adminPayload) {
      res.json({ authenticated: true, isAdmin: true, role: 'admin', name: adminPayload.name });
      return;
    }
    const staffPayload = verifyStaffToken(token, secret);
    if (staffPayload) {
      res.json({ authenticated: true, isAdmin: false, role: 'staff', name: staffPayload.name });
      return;
    }
    res.json({ authenticated: false, isAdmin: false, role: null, name: '' });
  });

  app.post(
    '/api/admin/change-password',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { currentPassword, newPassword } = req.body as {
        currentPassword?: string;
        newPassword?: string;
      };
      if (!currentPassword || !newPassword || newPassword.length < 4) {
        res.status(400).json({ error: 'Current password and new password (min 4 chars) are required.' });
        return;
      }
      const storedHash = await store.getSetting('admin_password_hash');
      if (!verifyPassword(currentPassword, storedHash)) {
        res.status(400).json({ error: 'Current password is incorrect.' });
        return;
      }
      await store.setSetting('admin_password_hash', hashPassword(newPassword));
      res.json({ success: true });
    })
  );

  app.post(
    '/api/admin/change-staff-password',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { newPassword } = req.body as { newPassword?: string };
      if (!newPassword || newPassword.length < 4) {
        res.status(400).json({ error: 'New staff password (min 4 chars) are required.' });
        return;
      }
      await store.setSetting('staff_password_hash', hashPassword(newPassword));
      res.json({ success: true });
    })
  );

  app.put(
    '/api/admin/settings',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const allowedKeys = [
        'lab_name',
        'lab_address',
        'proprietor_name',
        'lab_phone',
        'max_staff_discount_pct',
        'technologist_name',
        'technologist_title',
        'pathologist_name',
        'pathologist_title',
        'pad_header_margin_in',
        'pad_footer_margin_in',
      ];
      const updates = req.body as Record<string, string | number>;
      const settings = await store.updateSettings(updates, allowedKeys);
      res.json({ settings });
    })
  );

  // Staff-safe Operational Overview
  app.get(
    '/api/staff/overview',
    requireStaffOrAdmin,
    asyncHandler(async (_req, res) => {
      const overview = await store.getStaffOverview();
      res.json(overview);
    })
  );

  // Admin Dashboard Analytics
  app.get(
    '/api/admin/dashboard',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : getTodayDateStr();
      const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : from;
      const dashboard = await store.getAdminDashboard(from, to);
      res.json(dashboard);
    })
  );

  // Test Catalog & Parameters
  app.get(
    '/api/catalog',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const includeInactive = req.query.includeInactive === '1' && isAdminRequest(req);
      const catalog = await store.getCatalog(includeInactive);
      res.json(catalog);
    })
  );

  app.post(
    '/api/admin/categories',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { name } = req.body as { name?: string };
      if (!name || !name.trim()) {
        res.status(400).json({ error: 'Category name is required.' });
        return;
      }
      const created = await store.createCategory(name);
      res.json(created);
    })
  );

  app.delete(
    '/api/admin/categories/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      await store.deleteCategory(Number(req.params.id));
      res.json({ success: true });
    })
  );

  app.post(
    '/api/admin/tests',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { category_id, code, name, price, sample_type, parameters } = req.body as {
        category_id: number;
        code: string;
        name: string;
        price: number;
        sample_type: string;
        parameters?: ParamPayload[];
      };
      if (!category_id || !name?.trim() || price === undefined || !sample_type?.trim()) {
        res.status(400).json({ error: 'Category, test name, price, and sample type are required.' });
        return;
      }
      const created = await store.createTest({ category_id, code, name, price, sample_type, parameters });
      res.json(created);
    })
  );

  app.put(
    '/api/admin/tests/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const { category_id, code, name, price, sample_type, is_active, parameters } = req.body as {
        category_id: number;
        code: string;
        name: string;
        price: number;
        sample_type: string;
        is_active?: number;
        parameters?: ParamPayload[];
      };
      if (!category_id || !name?.trim() || price === undefined || !sample_type?.trim()) {
        res.status(400).json({ error: 'Category, test name, price, and sample type are required.' });
        return;
      }
      await store.updateTest(id, { category_id, code, name, price, sample_type, is_active, parameters });
      res.json({ success: true });
    })
  );

  app.delete(
    '/api/admin/tests/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const result = await store.deleteTest(Number(req.params.id));
      res.json(result);
    })
  );

  // Referral Doctors
  app.get(
    '/api/doctors',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const doctors = await store.listDoctors(isAdminRequest(req));
      res.json({ doctors });
    })
  );

  app.post(
    '/api/admin/doctors',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { name, degree, hospital, mobile, commission_pct } = req.body as {
        name?: string;
        degree?: string;
        hospital?: string;
        mobile?: string;
        commission_pct?: number;
      };
      if (!name?.trim()) {
        res.status(400).json({ error: 'Doctor name is required.' });
        return;
      }
      const created = await store.createDoctor({ name, degree, hospital, mobile, commission_pct });
      res.json(created);
    })
  );

  app.put(
    '/api/admin/doctors/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { name, degree, hospital, mobile, commission_pct } = req.body as {
        name?: string;
        degree?: string;
        hospital?: string;
        mobile?: string;
        commission_pct?: number;
      };
      if (!name?.trim()) {
        res.status(400).json({ error: 'Doctor name is required.' });
        return;
      }
      await store.updateDoctor(Number(req.params.id), { name, degree, hospital, mobile, commission_pct });
      res.json({ success: true });
    })
  );

  app.delete(
    '/api/admin/doctors/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      await store.softDeleteDoctor(Number(req.params.id));
      res.json({ success: true });
    })
  );

  app.get(
    '/api/admin/doctors/:id/statement',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const from =
        typeof req.query.from === 'string' && req.query.from
          ? req.query.from
          : `${getTodayDateStr().slice(0, 7)}-01`;
      const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : getTodayDateStr();
      const statement = await store.getDoctorStatement(id, from, to);
      res.json(statement);
    })
  );

  // Patients & Invoices
  app.get(
    '/api/invoices',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const dueOnly = req.query.dueOnly === '1';
      const todayOnly = req.query.todayOnly === '1';
      const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
      const invoices = await store.listInvoices({
        search,
        dueOnly,
        todayOnly,
        date,
        includeCommission: isAdminRequest(req),
      });
      res.json({ invoices });
    })
  );

  app.get(
    '/api/patients/search',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const patients = await store.searchPatients(q);
      res.json({ patients });
    })
  );

  app.get(
    '/api/invoices/:id',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const full = await store.getFullInvoice(Number(req.params.id), isAdminRequest(req), true);
      if (!full) {
        res.status(404).json({ error: 'Invoice not found.' });
        return;
      }
      res.json(full);
    })
  );

  app.post(
    '/api/invoices',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const body = req.body as Omit<CreateInvoicePayload, 'isAdmin'>;
      if (
        !body.patient?.name?.trim() ||
        !body.patient?.gender ||
        !Array.isArray(body.testIds) ||
        body.testIds.length === 0
      ) {
        res.status(400).json({ error: 'Patient name, gender, and at least one test are required.' });
        return;
      }
      const created = await store.createInvoice({ ...body, isAdmin: isAdminRequest(req) });
      res.json(created);
    })
  );

  app.put(
    '/api/invoices/:id',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const body = req.body as Omit<UpdateInvoicePayload, 'invoiceId' | 'isAdmin'>;
      const updated = await store.updateInvoice({
        ...body,
        invoiceId: Number(req.params.id),
        isAdmin: isAdminRequest(req),
      });
      res.json(updated);
    })
  );

  app.post(
    '/api/invoices/:id/due-payment',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const { amount, paymentMethod, note } = req.body as {
        amount?: number;
        paymentMethod?: string;
        note?: string;
      };
      const updated = await store.addDuePayment({
        invoiceId: Number(req.params.id),
        amount: Number(amount || 0),
        paymentMethod,
        note,
        isAdmin: isAdminRequest(req),
      });
      res.json(updated);
    })
  );

  // Lab Queue & Result Entry
  app.get(
    '/api/lab-queue',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
      const queue = await store.getLabQueue({ search, status });
      res.json({ queue });
    })
  );

  app.get(
    '/api/lab-tests/:invoiceTestId',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const detail = await store.getLabTestDetail(Number(req.params.invoiceTestId));
      if (!detail) {
        res.status(404).json({ error: 'Lab test entry not found.' });
        return;
      }
      res.json(detail);
    })
  );

  app.put(
    '/api/lab-tests/:invoiceTestId/results',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const { results, status, verifiedBy, consultantName, consultantTitle } = req.body as {
        results: Array<{ parameterId: number; value: string }>;
        status: 'Sample Collected' | 'Processing' | 'Verified' | 'Ready';
        verifiedBy?: string;
        consultantName?: string;
        consultantTitle?: string;
      };
      const updated = await store.updateLabTestResults({
        invoiceTestId: Number(req.params.invoiceTestId),
        results,
        status,
        verifiedBy,
        consultantName,
        consultantTitle,
      });
      res.json(updated);
    })
  );

  // Expenses (Admin Only)
  app.get(
    '/api/admin/expenses',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const from =
        typeof req.query.from === 'string' && req.query.from
          ? req.query.from
          : `${getTodayDateStr().slice(0, 7)}-01`;
      const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : getTodayDateStr();
      const data = await store.listExpenses(from, to);
      res.json(data);
    })
  );

  app.post(
    '/api/admin/expenses',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { title, category, amount, expense_date, note } = req.body as {
        title?: string;
        category?: string;
        amount?: number;
        expense_date?: string;
        note?: string;
      };
      if (!title?.trim() || !amount || Number(amount) <= 0) {
        res.status(400).json({ error: 'Expense title and positive amount are required.' });
        return;
      }
      const created = await store.createExpense({ title, category, amount, expense_date, note });
      res.json(created);
    })
  );

  app.delete(
    '/api/admin/expenses/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      await store.deleteExpense(Number(req.params.id));
      res.json({ success: true });
    })
  );

  // Database Backup Download (Admin Only — JSON snapshot for MongoDB Atlas, .db for SQLite)
  app.get(
    '/api/admin/backup',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const payload = await store.createBackupPayload();
      if (payload.type === 'sqlite-file') {
        res.download(payload.filePath, payload.filename, () => {
          fs.unlink(payload.filePath, () => {});
        });
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`);
      res.send(JSON.stringify(payload.data, null, 2));
    })
  );

  // ============================================================================
  // PATIENT PORTAL API (Strictly Isolated from Admin/Staff & Other Patients)
  // ============================================================================
  app.post(
    '/api/patient-auth/login',
    asyncHandler(async (req, res) => {
      const { patientUid, password } = req.body as { patientUid?: string; password?: string };
      if (!patientUid?.trim() || !password?.trim()) {
        res.status(400).json({ error: 'Patient ID and Password are required.' });
        return;
      }
      const normalizedUid = patientUid.trim().toUpperCase();
      const patient = await store.findPatientByUid(normalizedUid);
      if (!patient || !patient.portal_password_hash) {
        res.status(401).json({ error: 'Invalid Patient ID or Password.' });
        return;
      }

      const trimmedPw = password.trim();
      const isValid =
        verifyPassword(trimmedPw, patient.portal_password_hash) ||
        verifyPassword(trimmedPw.toUpperCase(), patient.portal_password_hash);

      if (!isValid) {
        res.status(401).json({ error: 'Invalid Patient ID or Password.' });
        return;
      }

      const token = createPatientToken(getSecret(), patient.id, patient.patient_uid, patient.name, 12);
      res.json({
        token,
        patient: {
          id: patient.id,
          patient_uid: patient.patient_uid,
          name: patient.name,
          age_years: patient.age_years,
          age_months: patient.age_months,
          age_days: patient.age_days,
          gender: patient.gender,
          mobile: patient.mobile,
          address: patient.address,
          created_at: patient.created_at,
        },
      });
    })
  );

  app.get(
    '/api/patient-auth/verify',
    asyncHandler(async (req, res) => {
      const token = extractTokenFromRequest(req);
      const payload = verifyPatientToken(token, getSecret());
      if (!payload) {
        res.json({ authenticated: false });
        return;
      }
      const patient = await store.findPatientPublicById(payload.patientId);
      if (!patient) {
        res.json({ authenticated: false });
        return;
      }
      res.json({ authenticated: true, patient });
    })
  );

  app.get(
    '/api/patient/portal-profile',
    requirePatient,
    asyncHandler(async (req, res) => {
      const auth = (req as Request & { patientAuth: PatientTokenPayload }).patientAuth;
      const profile = await store.getPatientPortalProfile(auth.patientId);
      if (!profile) {
        res.status(404).json({ error: 'Patient record not found.' });
        return;
      }
      res.json(profile);
    })
  );

  app.get(
    '/api/patient-auth/qr-access',
    asyncHandler(async (req, res) => {
      const tokenParam = typeof req.query.token === 'string' ? req.query.token.trim() : '';
      const qrLegacyParam = typeof req.query.qr === 'string' ? req.query.qr.trim() : '';
      const qrParam = tokenParam || qrLegacyParam;
      if (!qrParam) {
        res.status(400).json({ error: 'Encrypted QR report token is required.' });
        return;
      }

      const secret = getSecret();
      const decoded = decryptPatientQrToken(qrParam, secret);
      if (!decoded) {
        res.status(401).json({ error: 'Invalid or tampered report QR code.' });
        return;
      }

      const patient = await store.findPatientByQrSecret(decoded.patientId, decoded.qrSecret);
      if (!patient) {
        res.status(401).json({ error: 'Report QR code could not be verified for this patient.' });
        return;
      }

      const patientId = Number(patient.id);
      const patientUid = String(patient.patient_uid || '');
      const patientName = String(patient.name || '');

      const idParam = typeof req.query.id === 'string' ? req.query.id.trim() : '';
      if (
        idParam &&
        idParam.toUpperCase() !== patientUid.toUpperCase() &&
        idParam !== String(patientId)
      ) {
        res.status(401).json({ error: 'Patient ID does not match the encrypted report token.' });
        return;
      }

      const profile = await store.getPatientPortalProfile(patientId);
      if (!profile) {
        res.status(404).json({ error: 'Patient record not found.' });
        return;
      }

      const invRaw = typeof req.query.inv === 'string' ? Number(req.query.inv) : 0;
      const testRaw = typeof req.query.test === 'string' ? Number(req.query.test) : 0;
      let targetInvoiceId = Number.isFinite(invRaw) && invRaw > 0 ? invRaw : 0;

      if (!targetInvoiceId && profile.archive.length > 0) {
        const latest = profile.archive[0] as { invoice_id?: number };
        targetInvoiceId = Number(latest?.invoice_id || 0);
      }

      let activeReport: Record<string, unknown> | null = null;
      if (targetInvoiceId > 0) {
        activeReport = await store.getPatientReportIfOwned(targetInvoiceId, patientId);
        if (!activeReport) {
          res.status(403).json({ error: 'Requested report does not belong to this patient QR code.' });
          return;
        }
      }

      let focusTestId: number | null = null;
      if (activeReport && Number.isFinite(testRaw) && testRaw > 0) {
        const tests = Array.isArray(activeReport.tests)
          ? (activeReport.tests as Array<{ id?: number }>)
          : [];
        if (tests.some((t) => Number(t.id) === testRaw)) {
          focusTestId = testRaw;
        }
      }

      const token = createPatientToken(secret, patientId, patientUid, patientName, 12);
      res.json({
        token,
        patient: profile.patient,
        archive: profile.archive,
        report: activeReport,
        focusTestId,
      });
    })
  );

  app.get(
    '/api/patient/reports/:invoiceId',
    requirePatient,
    asyncHandler(async (req, res) => {
      const auth = (req as Request & { patientAuth: PatientTokenPayload }).patientAuth;
      const invoiceId = Number(req.params.invoiceId);
      const full = await store.getPatientReportIfOwned(invoiceId, auth.patientId);
      if (!full) {
        res.status(404).json({ error: 'Report not found or access denied.' });
        return;
      }
      res.json(full);
    })
  );
}

function resolveServerPort(): number {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  const envPort = process.env.PORT ? Number(process.env.PORT) : 0;
  const nginxPort = process.env.NGINX_PORT ? Number(process.env.NGINX_PORT) : 0;
  if (envPort > 0 && nginxPort > 0 && envPort === nginxPort) {
    return Number(process.env.DEFAULT_APP_PORT || 3000);
  }
  return envPort > 0 ? envPort : Number(process.env.DEFAULT_APP_PORT || 3000);
}

async function startServer() {
  const store = await createLimsStore();
  const app = express();
  const PORT = resolveServerPort();

  app.use(express.json({ limit: '5mb' }));
  registerRoutes(app, store, PORT);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.use('/admin', express.static(distDir));
    app.use('/staff', express.static(distDir));
    app.use('/patient-dashboard', express.static(distDir));
    app.use('/report', express.static(distDir));
    app.use('/view-report', express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n=== Alea Diagnostic Services LIMS ===`);
    console.log(`Storage Engine: ${store.label}`);
    console.log(`Local access:   http://localhost:${PORT}`);
    const lanUrls = getLanUrls(PORT);
    for (const url of lanUrls) {
      console.log(`Network (LAN):  ${url}`);
    }
    console.log(`=====================================\n`);
  });
}

startServer().catch((err) => {
  console.error('[FATAL] Failed to start Alea Diagnostic Services LIMS:', err);
  process.exit(1);
});
