// Sync-Engine: Die JSON-Dateien in der Dropbox sind die Wahrheit, IndexedDB ist der lokale Index.
// - Start: sofort aus dem lokalen Cache anzeigen, dann nur die Änderungen seit dem letzten Cursor holen.
// - Schreiben: lokal sofort, Upload im Hintergrund (auch nach Neuladen, solange "dirty").
// - Konflikt: Dropbox lehnt ab, wenn die Datei inzwischen geändert wurde -> feldweise zusammenführen.

import { openCache } from './idb.js';
import { ConflictError, ResetError } from './dropbox.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Drei-Wege-Merge auf Feldebene: Was ich lokal geändert habe, gewinnt; alles andere kommt von remote.
export function merge3(base, local, remote) {
  if (!remote) return local;
  if (!base) return { ...remote, ...local };
  const out = { ...remote };
  for (const k of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (same(local[k], base[k])) continue;
    if (k in local) out[k] = local[k];
    else delete out[k];
  }
  return out;
}

async function parallel(items, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class Store {
  constructor(remote, cacheName) {
    this.remote = remote;
    this.cacheName = cacheName;
    this.records = new Map(); // path -> {path, rev, base, data, dirty, deleted}
    this.listeners = new Set();
    this.status = { state: 'idle', pending: 0, message: '' };
    this.queue = Promise.resolve(); // alle Sync-Schritte laufen nacheinander
    this.flushTimer = null;
    this.stopped = false;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  // dataChanged = false: nur der Sync-Status hat sich geändert
  emit(dataChanged = true) {
    this.status.pending = [...this.records.values()].filter((r) => r.dirty).length;
    for (const fn of this.listeners) fn(dataChanged);
  }

  setStatus(state, message = '') {
    this.status.state = state;
    this.status.message = message;
    this.emit(false);
  }

  async init() {
    this.cache = await openCache(this.cacheName);
    for (const rec of await this.cache.allFiles()) this.records.set(rec.path, rec);
    this.cursor = await this.cache.getMeta('cursor');
    this.emit();
  }

  // ---- Lesen ----

  get(path) {
    const rec = this.records.get(path);
    return rec && !rec.deleted ? rec.data : undefined;
  }

  list(prefix) {
    const out = [];
    for (const rec of this.records.values()) if (!rec.deleted && rec.path.startsWith(prefix)) out.push(rec.data);
    return out;
  }

  // ---- Schreiben (lokal sofort, Upload später) ----

  put(path, data) {
    const rec = this.records.get(path) || { path, rev: null, base: null };
    Object.assign(rec, { data, dirty: true, deleted: false });
    this.records.set(path, rec);
    this.cache.putFile(rec);
    this.emit();
    this.scheduleFlush();
  }

  remove(path) {
    const rec = this.records.get(path);
    if (!rec) return;
    if (!rec.rev) {
      // nie hochgeladen: einfach vergessen
      this.records.delete(path);
      this.cache.deleteFile(path);
    } else {
      Object.assign(rec, { dirty: true, deleted: true });
      this.cache.putFile(rec);
      this.scheduleFlush();
    }
    this.emit();
  }

  // ---- Synchronisation ----

  serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  scheduleFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.sync(), 400);
  }

  async start() {
    await this.sync();
    this.watch();
    addEventListener('online', () => this.sync());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.sync();
    });
  }

  stop() {
    this.stopped = true;
  }

  sync() {
    return this.serial(async () => {
      if (this.stopped) return;
      this.setStatus('syncing');
      try {
        if (this.cursor) await this.pull();
        else await this.fullSync();
        await this.flush();
        this.setStatus('idle');
      } catch (e) {
        console.error(e);
        this.setStatus(navigator.onLine ? 'error' : 'offline', e.message);
      }
    });
  }

  // Wartet im Hintergrund auf Änderungen von anderen Geräten
  async watch() {
    while (!this.stopped) {
      try {
        if (!this.cursor) {
          await sleep(2000);
          continue;
        }
        if (await this.remote.waitForChanges(this.cursor)) await this.sync();
      } catch {
        await sleep(10_000);
      }
    }
  }

  async fullSync() {
    const { entries, cursor } = await this.remote.listFolder();
    const files = entries.filter((e) => !e.folder && !e.deleted && e.path.endsWith('.json'));
    const seen = new Set(files.map((e) => e.path));
    await parallel(files, 6, (e) => this.applyRemote(e));
    for (const rec of [...this.records.values()]) {
      if (!seen.has(rec.path) && rec.rev && !rec.dirty) await this.forget(rec.path);
    }
    await this.saveCursor(cursor);
  }

  async pull() {
    let result;
    try {
      result = await this.remote.listChanges(this.cursor);
    } catch (e) {
      if (!(e instanceof ResetError)) throw e;
      this.cursor = null;
      return this.fullSync();
    }
    const changed = [];
    for (const e of result.entries) {
      if (e.folder || !e.path.endsWith('.json')) continue;
      if (e.deleted) {
        const rec = this.records.get(e.path);
        if (rec && !rec.dirty) await this.forget(e.path);
      } else {
        changed.push(e);
      }
    }
    await parallel(changed, 6, (e) => this.applyRemote(e));
    await this.saveCursor(result.cursor);
  }

  // Eine Datei von remote übernehmen (oder mit lokalen Änderungen zusammenführen)
  async applyRemote(entry) {
    const rec = this.records.get(entry.path);
    if (rec && rec.rev === entry.rev) return; // haben wir schon (z. B. unser eigener Upload)
    const file = await this.remote.download(entry.path);
    if (!file) return;
    let remoteData;
    try {
      remoteData = JSON.parse(file.text);
    } catch {
      console.warn('Keine gültige JSON-Datei, übersprungen:', entry.path);
      return;
    }
    const current = this.records.get(entry.path);
    if (current?.dirty && !current.deleted) {
      current.data = merge3(current.base, current.data, remoteData);
      current.base = remoteData;
      current.rev = file.rev;
      await this.cache.putFile(current);
    } else {
      const fresh = { path: entry.path, rev: file.rev, base: remoteData, data: remoteData, dirty: false, deleted: false };
      this.records.set(entry.path, fresh);
      await this.cache.putFile(fresh);
    }
    this.emit();
  }

  async forget(path) {
    this.records.delete(path);
    await this.cache.deleteFile(path);
    this.emit();
  }

  async saveCursor(cursor) {
    this.cursor = cursor;
    await this.cache.setMeta('cursor', cursor);
  }

  // Lokale Änderungen hochladen – eine Datei nach der anderen
  async flush() {
    for (const rec of [...this.records.values()]) {
      if (!rec.dirty || this.records.get(rec.path) !== rec) continue;
      if (rec.deleted) {
        await this.remote.remove(rec.path);
        if (rec.deleted) await this.forget(rec.path);
        continue;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const sent = rec.data;
        try {
          rec.rev = await this.remote.upload(rec.path, JSON.stringify(sent, null, 2), rec.rev);
          rec.base = sent;
          if (rec.data === sent) rec.dirty = false; // sonst wurde währenddessen weiter editiert
          await this.cache.putFile(rec);
          this.emit();
          break;
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          // Jemand anderes war schneller: Stand holen, zusammenführen, nochmal versuchen
          const file = await this.remote.download(rec.path);
          if (file) {
            const remoteData = JSON.parse(file.text);
            rec.data = merge3(rec.base, rec.data, remoteData);
            rec.base = remoteData;
            rec.rev = file.rev;
          } else {
            rec.rev = null; // remote gelöscht, wir legen sie neu an
          }
        }
      }
    }
  }
}
