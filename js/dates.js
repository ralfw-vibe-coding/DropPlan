// Datums- und Zeithelfer. Ein Tag ist immer ein String "YYYY-MM-DD" in lokaler Zeit.

const pad = (n) => String(n).padStart(2, '0');

export function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const today = () => iso(new Date());

export function addDays(s, n) {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}

export function addMonths(s, n) {
  const d = parse(s);
  return iso(new Date(d.getFullYear(), d.getMonth() + n, 1));
}

// Montag = 0 … Sonntag = 6
export const weekdayIndex = (s) => (parse(s).getDay() + 6) % 7;

export const startOfWeek = (s) => addDays(s, -weekdayIndex(s));

export const startOfMonth = (s) => s.slice(0, 8) + '01';

export function daysBetween(a, b) {
  return Math.round((parse(b) - parse(a)) / 86_400_000);
}

export function isoWeek(s) {
  const d = parse(s);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - jan4) / 86_400_000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const weekdayShort = (s) => WD[weekdayIndex(s)];
export const WEEKDAYS = WD;

export function fmtDate(s) {
  const d = parse(s);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
}

export function fmtDateLong(s) {
  return parse(s).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

export function monthTitle(s) {
  return parse(s).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

// 150 -> "2 h 30", 30 -> "30 min", 120 -> "2 h"
export function fmtDuration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h} h ${pad(r)}` : `${h} h`;
}

// 150 -> "2,5"
export function fmtHours(min) {
  return (Math.round((min / 60) * 100) / 100).toLocaleString('de-DE');
}

// "2", "2,5", "1:30", "90m", "45 min" -> Minuten
export function parseDuration(text) {
  const t = String(text).trim().toLowerCase().replace(',', '.');
  let m;
  if ((m = t.match(/^(\d+):(\d{1,2})$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = t.match(/^(\d+)\s*(m|min)$/))) return Number(m[1]);
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*h?$/))) return Math.round(Number(m[1]) * 60);
  return NaN;
}

export const toHHMM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

export function fromHHMM(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
