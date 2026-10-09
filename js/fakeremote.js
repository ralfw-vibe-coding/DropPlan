// Nachbildung der Dropbox im localStorage – zum Ausprobieren ohne Dropbox (Adresse mit ?local).
// Mehrere Tabs mit ?local=a und ?local=b verhalten sich wie zwei Geräte an derselben Dropbox.

import { ConflictError, ResetError } from './dropbox.js';

const KEY = 'dropplan.fakeremote';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() {
  return JSON.parse(localStorage.getItem(KEY) || '{"seq":0,"files":{},"log":[]}');
}
function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}
const newRev = () => Math.random().toString(16).slice(2, 14);

export class FakeRemote {
  async listFolder() {
    await sleep(80);
    const s = load();
    const entries = Object.entries(s.files).map(([path, f]) => ({ path, rev: f.rev, deleted: false, folder: false }));
    return { entries, cursor: String(s.seq) };
  }

  async listChanges(cursor) {
    await sleep(50);
    const s = load();
    if (Number(cursor) > s.seq) throw new ResetError();
    const paths = new Set(s.log.filter((l) => l.seq > Number(cursor)).map((l) => l.path));
    const entries = [...paths].map((path) =>
      s.files[path] ? { path, rev: s.files[path].rev, deleted: false, folder: false } : { path, deleted: true, folder: false },
    );
    return { entries, cursor: String(s.seq) };
  }

  async waitForChanges(cursor) {
    for (let i = 0; i < 60; i++) {
      if (load().seq > Number(cursor)) return true;
      await sleep(500);
    }
    return false;
  }

  async download(path) {
    await sleep(30);
    const f = load().files[path];
    return f ? { rev: f.rev, text: f.text } : null;
  }

  async upload(path, text, rev) {
    await sleep(60);
    const s = load();
    const current = s.files[path];
    if ((current?.rev ?? null) !== (rev ?? null)) throw new ConflictError(path);
    const r = newRev();
    s.files[path] = { rev: r, text };
    s.log.push({ seq: ++s.seq, path });
    save(s);
    return r;
  }

  async remove(path) {
    await sleep(40);
    const s = load();
    if (!s.files[path]) return;
    delete s.files[path];
    s.log.push({ seq: ++s.seq, path });
    save(s);
  }
}
