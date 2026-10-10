// Externe Kalender (Google, iCal-Abos) im Hintergrund des Planers.
// - Welche Kalender angezeigt werden und mitzählen, steht in settings.json (Dropbox, für alle Geräte).
// - Die Termine selbst holt jedes Gerät selbst und hält sie im Browser zwischengespeichert.
// - Aktualisiert wird beim Start, periodisch (Standard 5 min) solange die Seite sichtbar ist, und auf Knopfdruck.

import { Google, NotConnectedError, preload } from './google.js';
import { fetchIcs, parseIcs } from './icsfeed.js';
import { today, addDays, addMonths, startOfMonth, parse, iso } from './dates.js';

// Einstellungen mit Standardwerten auffüllen
export function calSettings(settings) {
  const c = settings.calendars || {};
  return {
    refreshMinutes: c.refreshMinutes || 5,
    google: { enabled: !!c.google?.enabled, calendars: { ...(c.google?.calendars || {}) } },
    ical: { enabled: !!c.ical?.enabled, feeds: (c.ical?.feeds || []).map((f) => ({ ...f })) },
  };
}

const minDate = (a, b) => (a < b ? a : b);
const maxDate = (a, b) => (a > b ? a : b);

export class Calendars {
  constructor(model, storageKey, onChange) {
    this.model = model;
    this.storageKey = storageKey;
    this.onChange = onChange;
    this.cache = {}; // Kalender-Schlüssel -> {events, fetchedAt, error}
    this.window = null; // geladener Zeitraum {from, to} als Datum
    this.lastRefresh = 0;
    this.refreshing = false;
    this.index = null;
    this.restore();
    if (this.settings().google.enabled) preload().catch(() => {});
  }

  settings() {
    return calSettings(this.model.settings());
  }

  anyEnabled() {
    const s = this.settings();
    return s.google.enabled || s.ical.enabled;
  }

  // 'off' | 'ok' | 'expired' (war verbunden, Token abgelaufen) | 'disconnected'
  googleState() {
    if (!this.settings().google.enabled) return 'off';
    if (Google.token()) return 'ok';
    return Google.known() ? 'expired' : 'disconnected';
  }

  // Kalender, die angezeigt werden oder mitzählen
  active() {
    const s = this.settings();
    const list = [];
    if (s.google.enabled) {
      for (const [id, c] of Object.entries(s.google.calendars)) {
        if (c.show || c.count) list.push({ ...c, key: `g:${id}`, source: 'google', id });
      }
    }
    if (s.ical.enabled) {
      for (const f of s.ical.feeds) if (f.url && (f.show || f.count)) list.push({ ...f, key: `i:${f.id}`, source: 'ical' });
    }
    return list;
  }

  errors() {
    return this.active()
      .filter((c) => this.cache[c.key]?.error)
      .map((c) => ({ key: c.key, name: c.name, error: this.cache[c.key].error }));
  }

  errorFor(key) {
    return this.cache[key]?.error || null;
  }

  // ---- Zwischenspeicher im Browser ----

  restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey) || 'null');
      if (saved) Object.assign(this, { cache: saved.cache || {}, window: saved.window || null, lastRefresh: saved.lastRefresh || 0 });
    } catch {
      // kein Zwischenspeicher: dann eben frisch laden
    }
  }

  persist() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ cache: this.cache, window: this.window, lastRefresh: this.lastRefresh }));
    } catch {
      // Speicher voll oder gesperrt: nur im Speicher behalten
    }
  }

  // ---- Laden ----

  defaultWindow() {
    const m = startOfMonth(today());
    return { from: addMonths(m, -1), to: addMonths(m, 4) };
  }

  // Sicherstellen, dass der angezeigte Zeitraum geladen ist (beim Blättern weit in die Zukunft/Vergangenheit)
  ensureWindow(from, to) {
    if (!this.anyEnabled()) return;
    const w = this.window || this.defaultWindow();
    if (from >= w.from && to <= w.to) return;
    this.window = { from: minDate(w.from, addDays(from, -7)), to: maxDate(w.to, addDays(to, 7)) };
    this.refresh();
  }

  async refresh() {
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    this.onChange();
    this.window ||= this.defaultWindow();
    const from = parse(this.window.from).getTime();
    const to = parse(this.window.to).getTime();
    const googleOk = this.googleState() === 'ok';

    await Promise.all(
      this.active().map(async (c) => {
        try {
          let events;
          if (c.source === 'google') {
            if (!googleOk) return; // alte Termine bleiben sichtbar, bis neu verbunden ist
            events = await Google.events(c.id, from, to);
          } else {
            events = parseIcs(await fetchIcs(c.url), from, to);
          }
          this.cache[c.key] = { events, fetchedAt: Date.now(), error: null };
        } catch (e) {
          if (e instanceof NotConnectedError) return;
          console.warn('Kalender', c.name, e);
          this.cache[c.key] = { events: this.cache[c.key]?.events || [], fetchedAt: this.cache[c.key]?.fetchedAt || 0, error: e.message };
        }
      }),
    );

    const keys = new Set(this.active().map((c) => c.key));
    for (const k of Object.keys(this.cache)) if (!keys.has(k)) delete this.cache[k];
    this.lastRefresh = Date.now();
    this.refreshing = false;
    this.index = null;
    this.persist();
    this.onChange();
    if (this.again) {
      this.again = false;
      this.refresh();
    }
  }

  // Einstellungen wurden geändert: Anzeige sofort anpassen, dann neu laden
  settingsChanged() {
    this.index = null;
    if (this.settings().google.enabled) preload().catch(() => {});
    if (this.anyEnabled()) this.refresh();
    else this.onChange();
  }

  // periodisch aktualisieren, solange die Seite sichtbar ist
  start() {
    const due = () => Date.now() - this.lastRefresh >= this.settings().refreshMinutes * 60_000;
    const check = () => {
      if (this.anyEnabled() && document.visibilityState === 'visible' && due()) this.refresh();
    };
    setInterval(check, 30_000);
    document.addEventListener('visibilitychange', check);
    if (this.anyEnabled()) this.refresh();
  }

  // ---- Abfragen für die Anzeige ----

  // Datum -> Termine dieses Tages; mehrtägige Termine werden auf die Tage verteilt
  buildIndex() {
    const index = new Map();
    const add = (date, item) => {
      if (!index.has(date)) index.set(date, []);
      index.get(date).push(item);
    };
    for (const cal of this.active()) {
      for (const ev of this.cache[cal.key]?.events || []) {
        if (ev.allDay) {
          for (let d = ev.startDate, n = 0; d < ev.endDate && n < 400; d = addDays(d, 1), n++) add(d, { cal, ev, allDay: true });
          continue;
        }
        let d = iso(new Date(ev.start));
        const last = iso(new Date(Math.max(ev.end - 1, ev.start)));
        for (let n = 0; d <= last && n < 400; d = addDays(d, 1), n++) {
          const dayStart = parse(d).getTime();
          const dayEnd = parse(addDays(d, 1)).getTime();
          const s = Math.max(ev.start, dayStart);
          const e = Math.min(ev.end, dayEnd);
          add(d, { cal, ev, allDay: false, s: Math.round((s - dayStart) / 60_000), e: Math.round((e - dayStart) / 60_000) });
        }
      }
    }
    for (const list of index.values()) list.sort((a, b) => (a.allDay === b.allDay ? (a.s ?? 0) - (b.s ?? 0) : a.allDay ? -1 : 1));
    return index;
  }

  on(date) {
    this.index ||= this.buildIndex();
    return this.index.get(date) || [];
  }

  // Termine, die im Kalender zu sehen sein sollen
  shown(date) {
    return this.on(date).filter((x) => x.cal.show);
  }

  // Minuten, die Kalendertermine an diesem Tag von der Kapazität belegen:
  // ganztägig + "beschäftigt" = ganze Kapazität; sonst die Vereinigung der Zeiten (Überschneidungen nur einmal)
  busyMinutes(date, capacity) {
    const items = this.on(date).filter((x) => x.cal.count && x.ev.busy);
    if (!items.length) return 0;
    if (items.some((x) => x.allDay)) return capacity;
    const spans = items.map((x) => [x.s, x.e]).sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [cs, ce] = spans[0];
    for (const [s, e] of spans.slice(1)) {
      if (s > ce) {
        total += ce - cs;
        [cs, ce] = [s, e];
      } else ce = Math.max(ce, e);
    }
    return total + (ce - cs);
  }
}
