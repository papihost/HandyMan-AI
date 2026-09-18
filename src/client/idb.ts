/**
 * A small promise wrapper over IndexedDB.
 *
 * IndexedDB rather than localStorage because a device holds a week of jobs, a whole price
 * book and a queue of photo blobs — megabytes, and binary. localStorage is synchronous,
 * string-only, and capped at a few megabytes, which is three photos.
 */

export const DB_NAME = 'handyman-field';
export const DB_VERSION = 1;

export const STORES = {
  meta: 'meta',
  jobs: 'jobs',
  priceBook: 'priceBook',
  vanStock: 'vanStock',
  checklists: 'checklists',
  outbox: 'outbox',
  blobs: 'blobs',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let connection: Promise<IDBDatabase> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;

  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORES.meta)) {
        database.createObjectStore(STORES.meta);
      }
      for (const name of [STORES.jobs, STORES.priceBook, STORES.vanStock, STORES.checklists]) {
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name, { keyPath: 'id' });
        }
      }
      if (!database.objectStoreNames.contains(STORES.outbox)) {
        // Keyed by the device-generated operation id, and ordered by sequence: the queue
        // has to drain in the order the technician did the work.
        const outbox = database.createObjectStore(STORES.outbox, { keyPath: 'clientOpId' });
        outbox.createIndex('sequence', 'sequence');
        outbox.createIndex('status', 'status');
      }
      if (!database.objectStoreNames.contains(STORES.blobs)) {
        database.createObjectStore(STORES.blobs, { keyPath: 'storageKey' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return connection;
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(store, mode);
        const request = work(transaction.objectStore(store));

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
      }),
  );
}

export const idb = {
  get: <T>(store: StoreName, key: IDBValidKey) =>
    run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),

  getAll: <T>(store: StoreName) =>
    run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),

  put: <T>(store: StoreName, value: T, key?: IDBValidKey) =>
    run<IDBValidKey>(store, 'readwrite', (s) => s.put(value, key)),

  delete: (store: StoreName, key: IDBValidKey) =>
    run<undefined>(store, 'readwrite', (s) => s.delete(key)),

  clear: (store: StoreName) => run<undefined>(store, 'readwrite', (s) => s.clear()),

  async putMany<T>(store: StoreName, values: T[]): Promise<void> {
    if (values.length === 0) return;
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      // One transaction for the batch: a pull that wrote four hundred jobs one at a time
      // would take longer than the request that fetched them.
      const transaction = database.transaction(store, 'readwrite');
      const objectStore = transaction.objectStore(store);
      for (const value of values) objectStore.put(value);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  },
};

/** True when IndexedDB is usable. Private browsing and some locked-down devices refuse it. */
export function storageAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}
