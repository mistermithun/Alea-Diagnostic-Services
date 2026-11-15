import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

interface TokenPayload {
  role: 'admin';
  name: string;
  exp: number;
}

export interface StaffTokenPayload {
  role: 'staff';
  name: string;
  exp: number;
}

export function createAdminToken(secret: string, name: string, ttlHours = 24): string {
  const payload: TokenPayload = {
    role: 'admin',
    name,
    exp: Date.now() + ttlHours * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyAdminToken(token: string | undefined | null, secret: string): TokenPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload;
    if (parsed.role !== 'admin' || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function createStaffToken(secret: string, name: string, ttlHours = 24): string {
  const payload: StaffTokenPayload = {
    role: 'staff',
    name,
    exp: Date.now() + ttlHours * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyStaffToken(token: string | undefined | null, secret: string): StaffTokenPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StaffTokenPayload;
    if (parsed.role !== 'staff' || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function extractTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const headerToken = req.headers['x-admin-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  if (typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }
  return null;
}

export function makeRequireAdmin(getSecret: () => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractTokenFromRequest(req);
    const verified = verifyAdminToken(token, getSecret());
    if (!verified) {
      res.status(401).json({ error: 'Admin authentication required.' });
      return;
    }
    next();
  };
}

export function makeRequireStaffOrAdmin(getSecret: () => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractTokenFromRequest(req);
    const secret = getSecret();
    const admin = verifyAdminToken(token, secret);
    if (admin) {
      next();
      return;
    }
    const staff = verifyStaffToken(token, secret);
    if (staff) {
      next();
      return;
    }
    res.status(401).json({ error: 'Staff or Admin authentication required.' });
  };
}

export interface PatientTokenPayload {
  role: 'patient';
  patientId: number;
  patientUid: string;
  name: string;
  exp: number;
}

export function createPatientToken(
  secret: string,
  patientId: number,
  patientUid: string,
  name: string,
  ttlHours = 12
): string {
  const payload: PatientTokenPayload = {
    role: 'patient',
    patientId,
    patientUid,
    name,
    exp: Date.now() + ttlHours * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyPatientToken(
  token: string | undefined | null,
  secret: string
): PatientTokenPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PatientTokenPayload;
    if (parsed.role !== 'patient' || typeof parsed.patientId !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function makeRequirePatient(getSecret: () => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractTokenFromRequest(req);
    const verified = verifyPatientToken(token, getSecret());
    if (!verified) {
      res.status(401).json({ error: 'Patient authentication required.' });
      return;
    }
    (req as Request & { patientAuth?: PatientTokenPayload }).patientAuth = verified;
    next();
  };
}

export function generatePortalPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function deriveAesKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptPortalPassword(plain: string, secret: string): string {
  const key = deriveAesKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptPortalPassword(stored: string, secret: string): string {
  if (!stored) return '';
  const parts = stored.split(':');
  if (parts.length !== 3) return '';
  try {
    const key = deriveAesKey(secret);
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const enc = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function generatePatientQrSecret(): string {
  return crypto.randomBytes(12).toString('hex');
}

function normalizeQrSecretBytes(qrSecret: string): Buffer {
  if (/^[0-9a-f]{24}$/i.test(qrSecret)) {
    return Buffer.from(qrSecret, 'hex');
  }
  return crypto.createHash('sha256').update(qrSecret).digest().subarray(0, 12);
}

export function createEncryptedPatientQrToken(
  patientId: number,
  qrSecret: string,
  authSecret: string
): string {
  const key = deriveAesKey(authSecret);
  const iv = crypto.randomBytes(12);
  const payload = Buffer.alloc(16);
  payload.writeUInt32BE(patientId >>> 0, 0);
  normalizeQrSecretBytes(qrSecret).copy(payload, 4, 0, 12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

export function decryptPatientQrToken(
  token: string | undefined | null,
  authSecret: string
): { patientId: number; qrSecret: string } | null {
  if (!token || typeof token !== 'string') return null;
  try {
    const raw = Buffer.from(token.trim(), 'base64url');
    if (raw.length !== 44) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28, 44);
    const key = deriveAesKey(authSecret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    if (plain.length !== 16) return null;
    const patientId = plain.readUInt32BE(0);
    const qrSecret = plain.subarray(4, 16).toString('hex');
    if (!patientId || !qrSecret) return null;
    return { patientId, qrSecret };
  } catch {
    return null;
  }
}

export function verifyQrSecretMatch(storedSecret: string | undefined | null, tokenSecret: string): boolean {
  if (!storedSecret || !tokenSecret) return false;
  const a = normalizeQrSecretBytes(storedSecret);
  const b = normalizeQrSecretBytes(tokenSecret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

