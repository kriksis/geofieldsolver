// IndexedDB storage.
//   caches: analysed candidate caches (keyPath code)
//   user:   your answers per cache, never overwritten by imports
//   seen:   every GC code ever imported, so later imports only add new caches

const DB = 'geofieldsolver';
let dbp;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      for (const s of ['caches', 'user', 'seen']) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'code' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
export const get = (store, code) => tx(store, 'readonly', (s) => s.get(code));
export const put = (store, obj) => tx(store, 'readwrite', (s) => { s.put(obj); });
export const putMany = (store, objs) => tx(store, 'readwrite', (s) => { for (const o of objs) s.put(o); });
export const del = (store, code) => tx(store, 'readwrite', (s) => { s.delete(code); });
export const clear = (store) => tx(store, 'readwrite', (s) => { s.clear(); });
