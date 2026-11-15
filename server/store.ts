import { MongoLimsStore } from './mongo-store.ts';
import type { LimsStore } from './store-types.ts';

export { StoreError, type LimsStore, type StorageMode } from './store-types.ts';

function sanitizeEnvValue(raw: string | undefined): string {
  if (!raw) return '';
  let val = raw.trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1).trim();
  }
  return val;
}

export async function createLimsStore(): Promise<LimsStore> {
  const mongoUri = sanitizeEnvValue(process.env.MONGO_URI);
  let fallbackWarning: string | undefined;

  if (mongoUri) {
    const store = new MongoLimsStore(mongoUri, sanitizeEnvValue(process.env.MONGO_DB_NAME));
    try {
      await store.init();
      console.log('[DB] Connected to MongoDB Atlas (permanent cloud database via MONGO_URI).');
      return store;
    } catch (err) {
      await store.close();
      const msg = err instanceof Error ? err.message : String(err);
      const isSslOrWhitelist =
        msg.includes('ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR') ||
        msg.includes('tlsv1 alert internal error') ||
        msg.includes('MongoServerSelectionError');
      fallbackWarning = isSslOrWhitelist
        ? 'MongoDB Atlas connection failed (check Atlas Network Access IP whitelist 0.0.0.0/0 and MONGO_URI). Running on local SQLite fallback so the app remains online.'
        : `MongoDB Atlas connection failed (${msg}). Running on local SQLite fallback.`;
      console.error(`[DB WARNING] ${fallbackWarning}`);
      console.error('[DB WARNING] Underlying MongoDB error:', err);
    }
  } else if (process.env.NODE_ENV === 'production' && process.env.RENDER) {
    fallbackWarning =
      'MONGO_URI environment variable is not set on Render. Set MONGO_URI in Render Environment Variables for permanent cloud persistence.';
    console.warn(`[DB WARNING] ${fallbackWarning}`);
  } else {
    console.log('[DB] MONGO_URI not set — using local SQLite database (data/alea_lims.db).');
  }

  const { SqliteLimsStore } = await import('./sqlite-store.ts');
  const fallback = new SqliteLimsStore(fallbackWarning);
  await fallback.init();
  return fallback;
}
