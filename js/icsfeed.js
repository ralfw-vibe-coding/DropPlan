// iCal-Abos (ICS): über die Netlify-Funktion abholen und mit ical.js in einheitliche Termin-Objekte umwandeln.
// ical.js übernimmt Zeitzonen (VTIMEZONE), Wiederholungen (RRULE, EXDATE) und geänderte Einzeltermine (RECURRENCE-ID).

import ICAL from './vendor/ical.min.js';
import { ICS_PROXY_URL } from './config.js';

const pad = (n) => String(n).padStart(2, '0');
const dateOf = (t) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;

// from/to ("YYYY-MM-DD"): nur diesen Ausschnitt des Kalenders vom Server holen
export async function fetchIcs(url, from, to) {
  const res = await fetch(ICS_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, from, to }),
  });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res.text();
}

// Termin-Objekt wie bei Google: {id, title, allDay, startDate/endDate | start/end (ms), busy}
function toEvent(item, start, end, key) {
  const comp = item.component;
  if (String(comp.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return null;
  const busy = String(comp.getFirstPropertyValue('transp') || 'OPAQUE').toUpperCase() !== 'TRANSPARENT';
  const title = item.summary || '(ohne Titel)';
  if (start.isDate) {
    const startDate = dateOf(start);
    let endDate = end ? dateOf(end) : startDate;
    if (endDate <= startDate) {
      const next = start.clone();
      next.adjust(1, 0, 0, 0);
      endDate = dateOf(next);
    }
    return { id: key, title, allDay: true, startDate, endDate, busy };
  }
  const s = start.toJSDate().getTime();
  const e = end ? end.toJSDate().getTime() : s;
  return { id: key, title, allDay: false, start: s, end: Math.max(e, s), busy };
}

// Alle Termine, die den Zeitraum [from, to) (ms) berühren
export function parseIcs(text, from, to) {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      // unbekanntes Zeitzonenformat: Zeiten gelten dann als lokale Zeit
    }
  }

  const masters = new Map();
  const exceptions = [];
  for (const v of root.getAllSubcomponents('vevent')) {
    if (v.hasProperty('recurrence-id')) exceptions.push(v);
    else masters.set(String(v.getFirstPropertyValue('uid') ?? Math.random()), new ICAL.Event(v));
  }
  for (const ex of exceptions) {
    const master = masters.get(String(ex.getFirstPropertyValue('uid')));
    if (master) master.relateException(ex);
    else masters.set(`${ex.getFirstPropertyValue('uid')}#${ex.getFirstPropertyValue('recurrence-id')}`, new ICAL.Event(ex));
  }

  const out = [];
  for (const [uid, ev] of masters) {
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) {
      const e = toEvent(ev, ev.startDate, ev.endDate, uid);
      if (e && overlaps(e, from, to)) out.push(e);
      continue;
    }
    const it = ev.iterator();
    for (let n = 0, next; (next = it.next()) && n < 20_000; n++) {
      // nach dem ursprünglichen Termin abbrechen, nicht nach einem verschobenen Einzeltermin
      if (next.toJSDate().getTime() >= to) break;
      const det = ev.getOccurrenceDetails(next);
      const e = toEvent(det.item, det.startDate, det.endDate, `${uid}@${next.toString()}`);
      if (e && overlaps(e, from, to)) out.push(e);
    }
  }
  return out;
}

function overlaps(e, from, to) {
  if (!e.allDay) return e.end > from && e.start < to;
  const s = new Date(`${e.startDate}T00:00`).getTime();
  const end = new Date(`${e.endDate}T00:00`).getTime();
  return end > from && s < to;
}
