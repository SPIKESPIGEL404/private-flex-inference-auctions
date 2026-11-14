// Opaque fx session bytes, isolated by buyer. No provider credentials are stored.
interface RecordValue { key: string; id: string; bytes: Uint8Array; revision: string; updatedAtMs: number }
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('private-market-playground', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'key' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
// Surface storage failures through adapter calls, not unhandled promise rejection.
void database.catch(() => {});
export function sessionStore(buyerId: string) {
  return {
    async load(id: string) {
      const db = await database;
      return new Promise<{ bytes: Uint8Array; revision: string } | null>((resolve, reject) => {
        const req = db.transaction('sessions').objectStore('sessions').get(`${buyerId}:${id}`);
        req.onsuccess = () => resolve(req.result ? { bytes: req.result.bytes, revision: req.result.revision } : null);
        req.onerror = () => reject(req.error);
      });
    },
    async commit(id: string, bytes: Uint8Array, expectedRevision: string | undefined) {
      const db = await database;
      return new Promise<{ revision: string }>((resolve, reject) => {
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        const key = `${buyerId}:${id}`;
        const req = store.get(key);
        let revision = '';
        let conflict: Error | undefined;
        req.onsuccess = () => {
          if (req.result?.revision !== expectedRevision) {
            conflict = Object.assign(new Error('Session revision conflict'), { code: 'FX_SESSION_REVISION_CONFLICT' });
            tx.abort(); return;
          }
          revision = crypto.randomUUID();
          store.put({ key, id, bytes: new Uint8Array(bytes), revision, updatedAtMs: Date.now() } satisfies RecordValue);
        };
        tx.oncomplete = () => resolve({ revision });
        tx.onabort = () => reject(conflict ?? tx.error ?? new Error('Session save failed'));
        tx.onerror = () => reject(tx.error);
      });
    },
    async list() {
      const db = await database;
      return new Promise<Array<{ id: string; updatedAtMs: number }>>((resolve, reject) => {
        const req = db.transaction('sessions').objectStore('sessions').getAll();
        req.onsuccess = () => resolve((req.result as RecordValue[]).filter(r => r.key.startsWith(`${buyerId}:`)).map(({ id, updatedAtMs }) => ({ id, updatedAtMs })));
        req.onerror = () => reject(req.error);
      });
    },
    async remove(id: string) {
      const db = await database;
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').delete(`${buyerId}:${id}`);
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
    },
  };
}
