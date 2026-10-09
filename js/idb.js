// Kleiner Wrapper um IndexedDB: lokaler Cache der Dropbox-Dateien pro Gerät.
// Store "files": ein Eintrag pro Datei {path, rev, base, data, dirty, deleted}
// Store "meta":  Schlüssel/Wert, z. B. der Dropbox-Cursor

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function openCache(name) {
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore('files', { keyPath: 'path' });
    open.result.createObjectStore('meta');
  };
  const db = await req(open);
  db.onversionchange = () => db.close(); // sonst blockiert deleteCache() in diesem Tab
  const tx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);
  return {
    allFiles: () => req(tx('files').getAll()),
    putFile: (rec) => req(tx('files', 'readwrite').put(rec)),
    deleteFile: (path) => req(tx('files', 'readwrite').delete(path)),
    getMeta: (key) => req(tx('meta').get(key)),
    setMeta: (key, value) => req(tx('meta', 'readwrite').put(value, key)),
    async clear() {
      await req(tx('files', 'readwrite').clear());
      await req(tx('meta', 'readwrite').clear());
    },
  };
}

export function deleteCache(name) {
  return req(indexedDB.deleteDatabase(name));
}
