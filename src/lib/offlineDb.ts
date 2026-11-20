import type {
  ExpenseItem,
  FullInvoice,
  InvoiceSummary,
  LabQueueItem,
  OtherRevenueItem,
  PatientProfile,
  ReagentItem,
  TestResultRow,
} from '../types.ts';

const DB_NAME = 'alea_lims_offline_v1';
const DB_VERSION = 2;

export type OfflineStoreName =
  | 'snapshots'
  | 'invoices'
  | 'fullInvoices'
  | 'labQueue'
  | 'labTestDetails'
  | 'patients'
  | 'expenses'
  | 'otherRevenues'
  | 'reagents'
  | 'apiCache'
  | 'syncQueue'
  | 'idRemaps';

export type OfflineEntityType =
  | 'invoice_create'
  | 'invoice_update'
  | 'invoice_due_payment'
  | 'invoice_adjust_bill'
  | 'invoice_remove_test'
  | 'invoice_delete'
  | 'invoice_commission'
  | 'invoice_disburse_commission'
  | 'lab_results'
  | 'catalog_category_create'
  | 'catalog_category_delete'
  | 'catalog_test_create'
  | 'catalog_test_update'
  | 'catalog_test_delete'
  | 'doctor_create'
  | 'doctor_update'
  | 'doctor_delete'
  | 'doctor_settle'
  | 'expense_create'
  | 'expense_delete'
  | 'other_revenue_create'
  | 'other_revenue_delete'
  | 'reagent_create'
  | 'reagent_adjust'
  | 'reagent_delete'
  | 'settings_update';

export interface OfflineQueueItem {
  seq?: number;
  clientMutationId: string;
  createdAt: string;
  method: 'POST' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  entityType: OfflineEntityType;
  label: string;
  tempIds?: {
    invoiceId?: number;
    patientId?: number;
    testId?: number;
    categoryId?: number;
    doctorId?: number;
    expenseId?: number;
    otherRevenueId?: number;
    reagentId?: number;
    invoiceTestIdByTestId?: Record<number, number>;
    addedInvoiceTestIdsByTestId?: Record<number, number>;
  };
  retryCount: number;
  lastError?: string;
  status: 'pending' | 'syncing' | 'failed';
}

export interface StoredFullInvoice {
  id: number;
  data: FullInvoice;
  updatedAt: number;
}

export interface StoredLabTestDetail {
  id: number;
  item: LabQueueItem;
  results: TestResultRow[];
  updatedAt: number;
}

export interface IdRemapRecord {
  key: string; // `${entity}:${tempId}`
  entity: 'invoice' | 'patient' | 'invoiceTest' | 'test' | 'category' | 'doctor' | 'expense' | 'otherRevenue' | 'reagent' | 'parameter';
  tempId: number;
  realId: number;
  createdAt: number;
}

export interface SnapshotRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
}

export interface ApiCacheRecord<T = unknown> {
  key: string;
  data: T;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openOfflineDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable in this environment.'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('invoices')) {
        db.createObjectStore('invoices', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('fullInvoices')) {
        db.createObjectStore('fullInvoices', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('labQueue')) {
        db.createObjectStore('labQueue', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('labTestDetails')) {
        db.createObjectStore('labTestDetails', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('patients')) {
        db.createObjectStore('patients', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('expenses')) {
        db.createObjectStore('expenses', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('otherRevenues')) {
        db.createObjectStore('otherRevenues', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('reagents')) {
        db.createObjectStore('reagents', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('apiCache')) {
        db.createObjectStore('apiCache', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('syncQueue')) {
        const qStore = db.createObjectStore('syncQueue', { keyPath: 'seq', autoIncrement: true });
        qStore.createIndex('by_mutation_id', 'clientMutationId', { unique: true });
      }
      if (!db.objectStoreNames.contains('idRemaps')) {
        db.createObjectStore('idRemaps', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('Failed to open IndexedDB offline storage.'));
    };
  });

  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
  });
}

export async function idbGet<T>(store: OfflineStoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll<T>(store: OfflineStoreName): Promise<T[]> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve((req.result as T[]) || []);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut<T>(store: OfflineStoreName, value: T): Promise<IDBValidKey> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    let insertedKey: IDBValidKey;
    req.onsuccess = () => {
      insertedKey = req.result;
    };
    tx.oncomplete = () => resolve(insertedKey);
    tx.onerror = () => reject(tx.error || req.error);
  });
}

export async function idbPutMany<T>(store: OfflineStoreName, values: T[]): Promise<void> {
  if (values.length === 0) return;
  const db = await openOfflineDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const val of values) {
    os.put(val);
  }
  await txDone(tx);
}

export async function idbDelete(store: OfflineStoreName, key: IDBValidKey): Promise<void> {
  const db = await openOfflineDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

export async function idbClearAndPutMany<T>(
  store: OfflineStoreName,
  values: T[],
  preservePredicate?: (existing: T) => boolean
): Promise<void> {
  const db = await openOfflineDb();
  const existing = preservePredicate ? await idbGetAll<T>(store) : [];
  const preserved = preservePredicate ? existing.filter(preservePredicate) : [];
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  os.clear();
  for (const val of values) {
    os.put(val);
  }
  for (const val of preserved) {
    os.put(val);
  }
  await txDone(tx);
}

// High-level Domain Helpers
export async function getSnapshot<T>(key: string): Promise<T | undefined> {
  const rec = await idbGet<SnapshotRecord<T>>('snapshots', key);
  return rec?.value;
}

export async function setSnapshot<T>(key: string, value: T): Promise<void> {
  await idbPut<SnapshotRecord<T>>('snapshots', {
    key,
    value,
    updatedAt: Date.now(),
  });
}

export async function getApiCache<T>(key: string): Promise<T | undefined> {
  const rec = await idbGet<ApiCacheRecord<T>>('apiCache', key);
  return rec?.data;
}

export async function setApiCache<T>(key: string, data: T): Promise<void> {
  await idbPut<ApiCacheRecord<T>>('apiCache', {
    key,
    data,
    updatedAt: Date.now(),
  });
}

export async function getSyncQueue(): Promise<OfflineQueueItem[]> {
  const items = await idbGetAll<OfflineQueueItem>('syncQueue');
  return items.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
}

export async function enqueueSyncMutation(item: Omit<OfflineQueueItem, 'seq'>): Promise<number> {
  const key = await idbPut('syncQueue', item);
  return Number(key);
}

export async function updateSyncQueueItem(item: OfflineQueueItem): Promise<void> {
  await idbPut('syncQueue', item);
}

export async function removeSyncQueueItem(seq: number): Promise<void> {
  await idbDelete('syncQueue', seq);
}

export async function recordIdRemap(
  entity: IdRemapRecord['entity'],
  tempId: number,
  realId: number
): Promise<void> {
  if (tempId >= 0 || realId <= 0) return;
  await idbPut<IdRemapRecord>('idRemaps', {
    key: `${entity}:${tempId}`,
    entity,
    tempId,
    realId,
    createdAt: Date.now(),
  });
}

export async function resolveRemappedId(
  entity: IdRemapRecord['entity'],
  id: number
): Promise<number> {
  if (id >= 0) return id;
  const rec = await idbGet<IdRemapRecord>('idRemaps', `${entity}:${id}`);
  return rec ? rec.realId : id;
}

export async function getAllInvoicesLocal(): Promise<InvoiceSummary[]> {
  return idbGetAll<InvoiceSummary>('invoices');
}

export async function getAllLabQueueLocal(): Promise<LabQueueItem[]> {
  return idbGetAll<LabQueueItem>('labQueue');
}

export async function getAllPatientsLocal(): Promise<PatientProfile[]> {
  return idbGetAll<PatientProfile>('patients');
}

export async function getAllExpensesLocal(): Promise<ExpenseItem[]> {
  return idbGetAll<ExpenseItem>('expenses');
}

export async function getAllOtherRevenuesLocal(): Promise<OtherRevenueItem[]> {
  return idbGetAll<OtherRevenueItem>('otherRevenues');
}

export async function getAllReagentsLocal(): Promise<ReagentItem[]> {
  return idbGetAll<ReagentItem>('reagents');
}

export async function getFullInvoiceLocal(invoiceId: number): Promise<FullInvoice | undefined> {
  const rec = await idbGet<StoredFullInvoice>('fullInvoices', invoiceId);
  return rec?.data;
}

export async function saveFullInvoiceLocal(full: FullInvoice): Promise<void> {
  await idbPut<StoredFullInvoice>('fullInvoices', {
    id: full.invoice.id,
    data: full,
    updatedAt: Date.now(),
  });
}

export async function getLabTestDetailLocal(
  invoiceTestId: number
): Promise<{ item: LabQueueItem; results: TestResultRow[] } | undefined> {
  const rec = await idbGet<StoredLabTestDetail>('labTestDetails', invoiceTestId);
  if (!rec) return undefined;
  return { item: rec.item, results: rec.results };
}

export async function saveLabTestDetailLocal(
  item: LabQueueItem,
  results: TestResultRow[]
): Promise<void> {
  await idbPut<StoredLabTestDetail>('labTestDetails', {
    id: item.id,
    item,
    results,
    updatedAt: Date.now(),
  });
}
