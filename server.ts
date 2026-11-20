process.env.TZ = 'Asia/Dhaka';
import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  createAdminToken,
  createDoctorToken,
  createPatientToken,
  createStaffToken,
  decryptPatientQrToken,
  type DoctorTokenPayload,
  extractTokenFromRequest,
  hashPassword,
  makeRequireAdmin,
  makeRequireDoctor,
  makeRequirePatient,
  makeRequireStaffOrAdmin,
  type PatientTokenPayload,
  verifyAdminToken,
  verifyDoctorToken,
  verifyPassword,
  verifyPatientToken,
  verifyStaffToken,
} from './server/auth.ts';
import { BANGLADESH_TIMEZONE, getLocalTimestampStr, getTodayDateStr } from './server/clinical-rules.ts';
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
    'https://aleadiagnostic.com';
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

const doctorUpdateBus = new EventEmitter();
doctorUpdateBus.setMaxListeners(200);

function emitDoctorSync(doctorId?: number | null) {
  doctorUpdateBus.emit('sync', {
    doctorId: doctorId && doctorId > 0 ? Number(doctorId) : null,
    at: Date.now(),
  });
}

function registerRoutes(app: express.Express, store: LimsStore, port: number) {
  const getSecret = () => store.getAuthSecret();
  const requireAdmin = makeRequireAdmin(getSecret);
  const requireStaffOrAdmin = makeRequireStaffOrAdmin(getSecret);
  const requirePatient = makeRequirePatient(getSecret);
  const requireDoctor = makeRequireDoctor(getSecret);

  const idempotencyStore = new Map<string, { status: number; body: unknown; expiresAt: number }>();
  const idempotencyInFlight = new Map<string, Promise<{ status: number; body: unknown }>>();

  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const rawId = req.headers['x-offline-mutation-id'];
    const mutationId = typeof rawId === 'string' ? rawId.trim() : '';
    if (!mutationId) {
      next();
      return;
    }

    const now = Date.now();
    if (idempotencyStore.size > 1500) {
      for (const [k, entry] of idempotencyStore.entries()) {
        if (entry.expiresAt <= now) {
          idempotencyStore.delete(k);
        }
      }
    }

    const cacheKey = `${req.method}:${req.path}:${mutationId}`;
    const existing = idempotencyStore.get(cacheKey);
    if (existing && existing.expiresAt > now) {
      res.status(existing.status).json(existing.body);
      return;
    }

    const inFlight = idempotencyInFlight.get(cacheKey);
    if (inFlight) {
      inFlight
        .then((result) => {
          if (!res.headersSent) {
            res.status(result.status).json(result.body);
          }
        })
        .catch(() => next());
      return;
    }

    let resolveInFlight!: (val: { status: number; body: unknown }) => void;
    let rejectInFlight!: (err: unknown) => void;
    const promise = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      resolveInFlight = resolve;
      rejectInFlight = reject;
    });
    idempotencyInFlight.set(cacheKey, promise);

    const origJson = res.json.bind(res);
    let settled = false;
    res.json = ((body: unknown) => {
      if (!settled) {
        settled = true;
        const statusCode = res.statusCode || 200;
        if (statusCode >= 200 && statusCode < 300) {
          idempotencyStore.set(cacheKey, {
            status: statusCode,
            body,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          });
          resolveInFlight({ status: statusCode, body });
        } else {
          rejectInFlight(new Error(`HTTP ${statusCode}`));
        }
        idempotencyInFlight.delete(cacheKey);
      }
      return origJson(body);
    }) as typeof res.json;

    res.on('close', () => {
      if (!settled) {
        settled = true;
        idempotencyInFlight.delete(cacheKey);
        rejectInFlight(new Error('Request closed before completion'));
      }
    });

    next();
  });

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
        time: getLocalTimestampStr(),
        timezone: BANGLADESH_TIMEZONE,
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
      const { password, rememberMe } = req.body as { password?: string; rememberMe?: boolean };
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
      const ttlHours = rememberMe === false ? 24 : 24 * 30;
      const token = createAdminToken(getSecret(), proprietor, ttlHours);
      res.json({ token, role: 'admin', adminName: proprietor });
    })
  );

  app.post(
    '/api/auth/staff-login',
    asyncHandler(async (req, res) => {
      const { staffName, password, rememberMe } = req.body as {
        staffName?: string;
        password?: string;
        rememberMe?: boolean;
      };
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
      const ttlHours = rememberMe === false ? 24 : 24 * 30;
      const token = createStaffToken(getSecret(), cleanName, ttlHours);
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
      const from =
        typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from.trim())
          ? req.query.from.trim()
          : undefined;
      const to =
        typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to.trim())
          ? req.query.to.trim()
          : undefined;
      const doctors = await store.listDoctors(
        isAdminRequest(req),
        from || to ? { from, to } : undefined
      );
      res.json({ doctors });
    })
  );

  app.post(
    '/api/admin/doctors',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { name, degree, hospital, mobile, commission_pct, portal_username, portal_password, portal_enabled } =
        req.body as {
          name?: string;
          degree?: string;
          hospital?: string;
          mobile?: string;
          commission_pct?: number;
          portal_username?: string;
          portal_password?: string;
          portal_enabled?: number;
        };
      if (!name?.trim()) {
        res.status(400).json({ error: 'Doctor name is required.' });
        return;
      }
      const created = await store.createDoctor({
        name,
        degree,
        hospital,
        mobile,
        commission_pct,
        portal_username,
        portal_password,
        portal_enabled,
      });
      res.json(created);
    })
  );

  app.put(
    '/api/admin/doctors/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { name, degree, hospital, mobile, commission_pct, portal_username, portal_password, portal_enabled } =
        req.body as {
          name?: string;
          degree?: string;
          hospital?: string;
          mobile?: string;
          commission_pct?: number;
          portal_username?: string;
          portal_password?: string;
          portal_enabled?: number;
        };
      if (!name?.trim()) {
        res.status(400).json({ error: 'Doctor name is required.' });
        return;
      }
      const docId = Number(req.params.id);
      await store.updateDoctor(docId, {
        name,
        degree,
        hospital,
        mobile,
        commission_pct,
        portal_username,
        portal_password,
        portal_enabled,
      });
      emitDoctorSync(docId);
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
      const from = typeof req.query.from === 'string' && req.query.from.trim() ? req.query.from.trim() : undefined;
      const to = typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim() : undefined;
      const rawStatus = typeof req.query.status === 'string' ? req.query.status.trim() : 'all';
      const status: 'unpaid' | 'all' | 'paid' =
        rawStatus === 'unpaid' || rawStatus === 'paid' ? rawStatus : 'all';
      const statement = await store.getDoctorStatement(id, from, to, status);
      res.json(statement);
    })
  );

  app.post(
    '/api/admin/doctors/:id/settle-commission',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const doctorId = Number(req.params.id);
      const { paidUpToDate, fromDate, note } = req.body as {
        paidUpToDate?: string;
        fromDate?: string;
        note?: string;
      };
      if (!paidUpToDate || !paidUpToDate.trim()) {
        res.status(400).json({ error: 'Paid Up To Date is required.' });
        return;
      }
      const token = extractTokenFromRequest(req);
      const adminPayload = verifyAdminToken(token, getSecret());
      const result = await store.settleDoctorCommission({
        doctorId,
        paidUpToDate: paidUpToDate.trim(),
        fromDate: fromDate?.trim(),
        note: note?.trim(),
        settledBy: adminPayload?.name || 'Admin',
      });
      emitDoctorSync(doctorId);
      res.json(result);
    })
  );

  app.put(
    '/api/admin/invoices/:id/commission',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const invoiceId = Number(req.params.id);
      const { commissionMode, commissionType, commissionValue, testCommissions } = req.body as {
        commissionMode?: 'doctor_default' | 'custom_invoice' | 'custom_per_test';
        commissionType?: 'percent' | 'flat';
        commissionValue?: number;
        testCommissions?: Array<{ testId: number; commissionType: 'percent' | 'flat'; commissionValue: number }>;
      };
      if (!commissionMode) {
        res.status(400).json({ error: 'Commission mode is required.' });
        return;
      }
      const updated = await store.updateInvoiceCommission({
        invoiceId,
        commissionMode,
        commissionType,
        commissionValue,
        testCommissions,
      });
      const updatedInv = (updated as { invoice?: { doctor_id?: number | null } }).invoice;
      emitDoctorSync(updatedInv?.doctor_id ?? null);
      res.json(updated);
    })
  );

  app.post(
    '/api/admin/invoices/:id/disburse-commission',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const invoiceId = Number(req.params.id);
      const { note } = (req.body || {}) as { note?: string };
      const token = extractTokenFromRequest(req);
      const adminPayload = verifyAdminToken(token, getSecret());
      const result = await store.disburseInvoiceCommission({
        invoiceId,
        note: note?.trim(),
        settledBy: adminPayload?.name || 'Admin',
      });
      const docId = Number((result as { doctorId?: number | null }).doctorId || 0) || null;
      emitDoctorSync(docId);
      res.json(result);
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
      const createdInv = (created as { invoice?: { doctor_id?: number | null } }).invoice;
      emitDoctorSync(createdInv?.doctor_id ?? body.doctorId ?? null);
      res.json(created);
    })
  );

  app.put(
    '/api/invoices/:id',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const body = req.body as Omit<UpdateInvoicePayload, 'invoiceId' | 'isAdmin' | 'adjustedBy'>;
      const adminPayload = verifyAdminToken(extractTokenFromRequest(req), getSecret());
      const updated = await store.updateInvoice({
        ...body,
        invoiceId: Number(req.params.id),
        isAdmin: Boolean(adminPayload),
        adjustedBy: adminPayload?.name || undefined,
      });
      const updatedInv = (updated as { invoice?: { doctor_id?: number | null } }).invoice;
      emitDoctorSync(updatedInv?.doctor_id ?? body.doctorId ?? null);
      res.json(updated);
    })
  );

  app.post(
    '/api/admin/invoices/:id/adjust-bill',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const invoiceId = Number(req.params.id);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        res.status(400).json({ error: 'Invalid invoice ID.' });
        return;
      }
      const { targetNetTotal, reductionAmount, reason, refundExcess, refundMethod } = req.body as {
        targetNetTotal?: number;
        reductionAmount?: number;
        reason?: string;
        refundExcess?: boolean;
        refundMethod?: string;
      };
      const adminPayload = verifyAdminToken(extractTokenFromRequest(req), getSecret());
      const updated = await store.adjustInvoiceBill({
        invoiceId,
        targetNetTotal,
        reductionAmount,
        reason,
        refundExcess,
        refundMethod,
        adjustedBy: adminPayload?.name || 'Admin',
      });
      const adjustedInv = (updated as { invoice?: { doctor_id?: number | null } }).invoice;
      emitDoctorSync(adjustedInv?.doctor_id ?? null);
      res.json(updated);
    })
  );

  app.delete(
    '/api/invoices/:id/tests/:invoiceTestId',
    requireStaffOrAdmin,
    asyncHandler(async (req, res) => {
      const invoiceId = Number(req.params.id);
      const invoiceTestId = Number(req.params.invoiceTestId);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0 || !Number.isInteger(invoiceTestId) || invoiceTestId <= 0) {
        res.status(400).json({ error: 'Invalid invoice ID or invoice test ID.' });
        return;
      }
      const updated = await store.removeInvoiceTest({
        invoiceId,
        invoiceTestId,
        isAdmin: isAdminRequest(req),
      });
      const updatedInv = (updated as { invoice?: { doctor_id?: number | null } }).invoice;
      emitDoctorSync(updatedInv?.doctor_id ?? null);
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
      const updatedInv = (updated as { invoice?: { doctor_id?: number | null } }).invoice;
      emitDoctorSync(updatedInv?.doctor_id ?? null);
      res.json(updated);
    })
  );

  app.delete(
    '/api/invoices/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const invoiceId = Number(req.params.id);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        res.status(400).json({ error: 'Invalid invoice/patient entry ID.' });
        return;
      }
      const deleted = await store.deleteInvoiceEntry(invoiceId);
      emitDoctorSync(null);
      res.json(deleted);
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
      emitDoctorSync(null);
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

  // Daily Cash Balance Ledger & Revenue from Others (Admin Only)
  app.get(
    '/api/admin/balance-ledger',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const today = getTodayDateStr();
      const from =
        typeof req.query.from === 'string' && req.query.from.trim()
          ? req.query.from.trim()
          : `${today.slice(0, 7)}-01`;
      const to =
        typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim() : today;
      const data = await store.getBalanceLedger(from, to);
      res.json(data);
    })
  );

  app.post(
    '/api/admin/other-revenues',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { source, category, amount, revenue_date, note } = req.body as {
        source?: string;
        category?: string;
        amount?: number;
        revenue_date?: string;
        note?: string;
      };
      if (!source?.trim() || !amount || Number(amount) <= 0) {
        res.status(400).json({ error: 'Income source description and positive amount are required.' });
        return;
      }
      const adminPayload = verifyAdminToken(extractTokenFromRequest(req), getSecret());
      const created = await store.createOtherRevenue({
        source,
        category,
        amount: Number(amount),
        revenue_date,
        note,
        createdBy: adminPayload?.name || 'Admin',
      });
      res.json(created);
    })
  );

  app.delete(
    '/api/admin/other-revenues/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid other revenue entry ID.' });
        return;
      }
      await store.deleteOtherRevenue(id);
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
      const { patientUid, password, rememberMe } = req.body as {
        patientUid?: string;
        password?: string;
        rememberMe?: boolean;
      };
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

      const ttlHours = rememberMe === false ? 12 : 24 * 30;
      const token = createPatientToken(getSecret(), patient.id, patient.patient_uid, patient.name, ttlHours);
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

  // ============================================================================
  // DOCTOR PORTAL API (Strictly Isolated to Authenticated Referring Doctor)
  // ============================================================================
  app.post(
    '/api/doctor-auth/login',
    asyncHandler(async (req, res) => {
      const { username, password, rememberMe } = req.body as {
        username?: string;
        password?: string;
        rememberMe?: boolean;
      };
      if (!username?.trim() || !password?.trim()) {
        res.status(400).json({ error: 'Username and password are required.' });
        return;
      }

      const normalizedUsername = username.trim().toLowerCase();
      const doctor = await store.findDoctorByPortalUsername(normalizedUsername);
      if (!doctor || !doctor.portal_password_hash) {
        res.status(401).json({ error: 'Invalid username or password.' });
        return;
      }
      if (Number(doctor.portal_enabled ?? 1) === 0) {
        res.status(403).json({ error: 'Doctor portal access has been disabled by the administrator.' });
        return;
      }
      if (!verifyPassword(password.trim(), doctor.portal_password_hash)) {
        res.status(401).json({ error: 'Invalid username or password.' });
        return;
      }

      const ttlHours = rememberMe === false ? 24 : 24 * 30;
      const token = createDoctorToken(
        getSecret(),
        doctor.id,
        doctor.portal_username,
        doctor.name,
        ttlHours
      );

      res.json({
        token,
        doctor: {
          id: doctor.id,
          name: doctor.name,
          degree: doctor.degree,
          hospital: doctor.hospital,
          mobile: doctor.mobile,
          commission_pct: doctor.commission_pct,
          portal_username: doctor.portal_username,
          last_commission_paid_up_to: doctor.last_commission_paid_up_to,
        },
      });
    })
  );

  app.get(
    '/api/doctor-auth/verify',
    asyncHandler(async (req, res) => {
      const token = extractTokenFromRequest(req);
      const payload = verifyDoctorToken(token, getSecret());
      if (!payload) {
        res.json({ authenticated: false });
        return;
      }
      const doctor = await store.findDoctorPortalProfileById(payload.doctorId);
      if (!doctor || Number(doctor.portal_enabled ?? 1) === 0) {
        res.json({ authenticated: false });
        return;
      }
      res.json({ authenticated: true, doctor });
    })
  );

  app.get(
    '/api/doctor/portal-dashboard',
    requireDoctor,
    asyncHandler(async (req, res) => {
      const auth = (req as Request & { doctorAuth: DoctorTokenPayload }).doctorAuth;
      const daysRaw = typeof req.query.days === 'string' ? Number(req.query.days) : 30;
      const days = Number.isFinite(daysRaw) ? Math.min(31, Math.max(1, daysRaw)) : 30;
      const data = await store.getDoctorPortalDashboard(auth.doctorId, days);
      if (!data) {
        res.status(403).json({ error: 'Doctor portal access unavailable or disabled.' });
        return;
      }
      res.json(data);
    })
  );

  app.get(
    '/api/doctor/reports/:invoiceId',
    requireDoctor,
    asyncHandler(async (req, res) => {
      const auth = (req as Request & { doctorAuth: DoctorTokenPayload }).doctorAuth;
      const invoiceId = Number(req.params.invoiceId);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        res.status(400).json({ error: 'Invalid report ID.' });
        return;
      }
      const full = await store.getDoctorReportIfOwned(invoiceId, auth.doctorId);
      if (!full) {
        res.status(404).json({ error: 'Report not found or access denied.' });
        return;
      }
      res.json(full);
    })
  );

  app.get('/api/doctor/stream', requireDoctor, (req, res) => {
    const auth = (req as Request & { doctorAuth: DoctorTokenPayload }).doctorAuth;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (eventName: string, data: Record<string, unknown>) => {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('connected', { doctorId: auth.doctorId, at: Date.now() });

    const onSync = (payload: { doctorId: number | null; at: number }) => {
      if (payload.doctorId === null || payload.doctorId === auth.doctorId) {
        sendEvent('refresh', { at: payload.at });
      }
    };

    doctorUpdateBus.on('sync', onSync);
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      doctorUpdateBus.off('sync', onSync);
    });
  });

  app.get('/api/lab/live-stream', requireStaffOrAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (eventName: string, data: Record<string, unknown>) => {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('connected', { at: Date.now() });

    const onSync = (payload: { doctorId: number | null; at: number }) => {
      sendEvent('refresh', { at: payload.at });
    };

    doctorUpdateBus.on('sync', onSync);
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      doctorUpdateBus.off('sync', onSync);
    });
  });
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
  app.use((req, res, next) => {
    if (req.path === '/sw.js') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    } else if (req.path === '/manifest.json') {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    next();
  });
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
    app.use('/live-display', express.static(distDir));
    app.use('/patient-dashboard', express.static(distDir));
    app.use('/doctor-login', express.static(distDir));
    app.use('/doctor-dashboard', express.static(distDir));
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
