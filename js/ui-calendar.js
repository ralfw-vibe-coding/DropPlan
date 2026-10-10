// Kalender (rechte Seite): Monatsansicht mit Auslastungsbalken, Wochenansicht mit Stundenraster

import {
  today, addDays, startOfWeek, startOfMonth, weekdayShort, weekdayIndex, fmtDate, fmtHours, fmtDuration,
  toHHMM, fromHHMM, parse, isoWeek, WEEKDAYS,
} from './dates.js';
import { esc } from './ui-tasks.js';

// Ampel: bis 66 % grün, bis 85 % gelb, darüber rot
export function loadClass(ratio) {
  if (ratio <= 0.66) return 'g';
  if (ratio <= 0.85) return 'y';
  return 'r';
}

// Auslastungsbalken; der Anteil der Kalendertermine ist schraffiert
function bar(load) {
  if (!load.minutes) return `<div class="bar"></div>`;
  const pct = Math.min(load.ratio, 1) * 100;
  const over = load.ratio > 1;
  const ext = load.external ? (load.external / load.minutes) * 100 : 0;
  const title = load.external ? ` title="davon ${fmtHours(load.external)} h Kalendertermine"` : '';
  return `<div class="bar"${title}><div class="bar-fill ${loadClass(load.ratio)} ${over ? 'over' : ''}" style="width:${pct}%">${
    ext ? `<div class="bar-ext" style="width:${ext}%"></div>` : ''
  }</div></div>`;
}

// ---------- Kalendertermine (Google, iCal) ----------

function extTooltip(x) {
  const when = x.allDay ? 'ganztägig' : `${toHHMM(x.s)}–${toHHMM(Math.min(x.e, 24 * 60))}`;
  const flags = [x.ev.busy ? 'beschäftigt' : 'frei', x.cal.count ? 'zählt mit' : 'zählt nicht'];
  return esc(`${x.ev.title}\n${when} · ${x.cal.name}\n${flags.join(' · ')}`);
}

const calColor = (x) => esc(x.cal.color || '#64748b');

function extAllDay(list) {
  const all = list.filter((x) => x.allDay);
  if (!all.length) return '';
  const shown = all.slice(0, 3);
  return `<div class="ext-allday-list">${shown
    .map((x) => `<div class="ext-allday ${x.ev.busy ? 'busy' : 'free'}" style="--cal:${calColor(x)}" title="${extTooltip(x)}">${esc(x.ev.title)}</div>`)
    .join('')}${all.length > 3 ? `<div class="ext-more">+${all.length - 3}</div>` : ''}</div>`;
}

// Position im Stundenraster; Termine außerhalb des sichtbaren Zeitraums an den Rand legen, damit sie nicht verschwinden
function place(s, e, r, lane, lanes) {
  const top = Math.min(Math.max(pct(s, r), 0), 97);
  const bottom = Math.min(Math.max(pct(e, r), top + 3), 100);
  return `top:${top}%;height:${bottom - top}%;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px)`;
}

function extBlock({ x, s, e, lane, lanes }, r) {
  return `<div class="ext-event ${x.ev.busy ? 'busy' : 'free'}" style="--cal:${calColor(x)};${place(s, e, r, lane, lanes)}" title="${extTooltip(x)}"><span>${esc(x.ev.title)}</span><small>${toHHMM(x.s)}–${toHHMM(Math.min(x.e, 24 * 60))}</small></div>`;
}

function extDots(list) {
  if (!list.length) return '';
  const title = esc(list.map((x) => `${x.allDay ? 'ganztägig' : toHHMM(x.s)} ${x.ev.title}`).join('\n'));
  return `<div class="mday-ext" title="${title}">${list
    .slice(0, 5)
    .map((x) => `<i class="${x.allDay ? 'allday' : ''}" style="--cal:${calColor(x)}"></i>`)
    .join('')}${list.length > 5 ? `<span>+${list.length - 5}</span>` : ''}</div>`;
}

function loadText(load) {
  const base = `${fmtHours(load.minutes)} / ${fmtHours(load.capacity)} h`;
  const over = load.minutes - load.capacity;
  return over > 0 && load.minutes > 0 ? `${base} <b class="overtime">+${fmtHours(over)} h</b>` : base;
}

function percent(load) {
  if (!load.minutes) return '';
  return load.capacity > 0 ? `${Math.round(load.ratio * 100)} %` : 'Überstunden';
}

// Wochenende: grau · Tag ohne Kapazität (Wochenende, Urlaub, Feiertag): schraffiert
function offClasses(date, capacity) {
  return [weekdayIndex(date) >= 5 && 'weekend', capacity === 0 && 'nocap'].filter(Boolean).join(' ');
}

// ---------- Monat ----------

export function renderMonth(model, cal, anchor, selected) {
  const first = startOfMonth(anchor);
  const month = first.slice(0, 7);
  const start = startOfWeek(first);
  const t = today();
  const byDate = groupByDate(model.bookings());
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const date = addDays(start, i);
    if (i === 35 && date.slice(0, 7) !== month) break; // nur 5 Wochen, wenn der Monat hineinpasst
    const load = model.load(date, byDate.get(date) || [], (cap) => cal.busyMinutes(date, cap));
    cells += `
      <div class="mday ${date.slice(0, 7) !== month ? 'other' : ''} ${date === t ? 'today' : ''} ${date === selected ? 'selected' : ''} ${offClasses(date, load.capacity)}"
           data-drop="day" data-date="${date}" data-goto-week="${date}" title="Zur Wochenansicht">
        <div class="mday-top">
          <span class="mday-num">${parse(date).getDate()}</span>${date === t ? '<span class="today-tag">heute</span>' : ''}
          ${load.count ? `<span class="mday-count">${load.count} ${load.count === 1 ? 'Aufgabe' : 'Aufgaben'}</span>` : ''}
        </div>
        ${bar(load)}
        <div class="mday-hours">${load.minutes || load.capacity ? loadText(load) : ''}</div>
        <div class="mday-pct">${percent(load)}</div>
        ${extDots(cal.shown(date))}
      </div>`;
  }
  return `
    <div class="month">
      <div class="month-head">${WEEKDAYS.map((d) => `<div>${d}</div>`).join('')}</div>
      <div class="month-grid">${cells}</div>
    </div>`;
}

// ---------- Woche ----------

const CLOCK_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// Sichtbarer Zeitraum der Wochenansicht in Minuten (Einstellung "von/bis")
export function range(settings) {
  return { from: settings.coreStart * 60, to: settings.coreEnd * 60 };
}

const pct = (min, r) => ((min - r.from) / (r.to - r.from)) * 100;

// Fortlaufender Tagesstreifen: count Tage ab start, seitlich scrollbar
export function renderWeek(model, cal, start, count, selected) {
  const t = today();
  const r = range(model.settings());
  const hours = (r.to - r.from) / 60;
  const byDate = groupByDate(model.bookings());
  const days = Array.from({ length: count }, (_, i) => addDays(start, i));
  const titleOf = (b) => model.task(b.taskId)?.title ?? '(gelöschte Aufgabe)';
  const dayClass = (date) => `${date === t ? 'today' : ''} ${date === selected ? 'selected' : ''} ${offClasses(date, model.capacity(date))}`;

  const heads = days
    .map((date) => {
      const list = byDate.get(date) || [];
      const load = model.load(date, list, (cap) => cal.busyMinutes(date, cap));
      const reserved = list.filter((b) => !b.start).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return `
        <div class="wday-head ${dayClass(date)} ${weekdayShort(date) === 'Mo' ? 'monday' : ''}" data-drop="day" data-date="${date}">
          <div class="wday-title"><b>${weekdayShort(date)}</b> ${fmtDate(date)}${date === t ? ' <span class="today-tag">heute</span>' : ''}${weekdayShort(date) === 'Mo' ? `<span class="kw">KW ${isoWeek(date)}</span>` : ''}</div>
          ${bar(load)}
          <div class="wday-load">
            <span>${fmtHours(load.minutes)} / <button class="cap" data-cap="${date}" title="Kapazität für diesen Tag ändern">${fmtHours(load.capacity)} h</button>
              ${load.minutes > load.capacity && load.minutes ? `<b class="overtime">+${fmtHours(load.minutes - load.capacity)} h</b>` : ''}</span>
            <span>${percent(load)}</span>
          </div>
          ${extAllDay(cal.shown(date))}
          <div class="reserved">
            ${reserved
              .map(
                (b) => `<div class="chip-booking" data-drag="booking" data-id="${b.id}" data-booking="${b.id}" data-label="${esc(titleOf(b))}">
                  <span class="cb-title">${esc(titleOf(b))}</span><span class="cb-dur">${fmtDuration(b.minutes)}</span></div>`,
              )
              .join('')}
            ${reserved.length ? '' : `<div class="reserved-hint" title="Hierher ziehen: Zeit reservieren (ohne Uhrzeit)">${CLOCK_ICON}</div>`}
          </div>
        </div>`;
    })
    .join('');

  const labels = Array.from({ length: hours }, (_, i) => `<div class="hlabel" style="top:${(i / hours) * 100}%">${String(r.from / 60 + i).padStart(2, '0')}:00</div>`).join('');

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const cols = days
    .map((date) => {
      // eigene Termine und Kalendertermine gemeinsam anordnen: was sich überschneidet, steht nebeneinander
      const spans = [
        ...(byDate.get(date) || [])
          .filter((b) => b.start)
          .map((b) => ({ b, s: fromHHMM(b.start), e: fromHHMM(b.start) + Math.max(b.minutes, 15) })),
        ...cal
          .shown(date)
          .filter((x) => !x.allDay)
          .map((x) => ({ x, s: x.s, e: Math.max(x.e, x.s + 15) })),
      ];
      const items = layoutSpans(spans)
        .map((it) => {
          if (it.x) return extBlock(it, r);
          const { b, lane, lanes } = it;
          const startMin = fromHHMM(b.start);
          const endMin = Math.min(startMin + b.minutes, 24 * 60);
          return `<div class="block ${startMin < r.from || endMin > r.to ? 'outside' : ''}" data-drag="booking" data-id="${b.id}" data-booking="${b.id}" data-label="${esc(titleOf(b))}"
                       style="${place(startMin, endMin, r, lane, lanes)}">
                    <div class="block-title">${esc(titleOf(b))}</div>
                    <div class="block-time">${b.start}–${toHHMM(endMin)} · ${fmtDuration(b.minutes)}</div>
                    <div class="resize" data-nodrag data-resize="${b.id}" title="Dauer ziehen"></div>
                  </div>`;
        })
        .join('');
      return `
        <div class="wday-grid ${dayClass(date)} ${weekdayShort(date) === 'Mo' ? 'monday' : ''}" data-drop="time" data-date="${date}">
          ${date === t && nowMin >= r.from && nowMin <= r.to ? `<div class="now" style="top:${pct(nowMin, r)}%"></div>` : ''}
          ${items}
        </div>`;
    })
    .join('');

  return `
    <div class="week-scroll" data-start="${start}">
      <div class="week" style="--hours:${hours};--days:${count}">
        <div class="corner"></div>
        ${heads}
        <div class="hours">${labels}</div>
        ${cols}
      </div>
    </div>`;
}

// Überlappende Termine nebeneinander legen
// items: {s, e, …} in Minuten; ergänzt lane (Spalte) und lanes (Spalten im Überlappungsblock)
function layoutSpans(spans) {
  const items = spans.map((x) => ({ ...x, lane: 0, lanes: 1 })).sort((x, y) => x.s - y.s || y.e - x.e);
  let cluster = [];
  let clusterEnd = -1;
  const close = () => {
    const n = Math.max(1, ...cluster.map((i) => i.lane + 1));
    cluster.forEach((i) => (i.lanes = n));
    cluster = [];
  };
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) close();
    const used = cluster.filter((c) => c.e > it.s).map((c) => c.lane);
    while (used.includes(it.lane)) it.lane++;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) close();
  return items;
}

function groupByDate(bookings) {
  const map = new Map();
  for (const b of bookings) {
    if (!map.has(b.date)) map.set(b.date, []);
    map.get(b.date).push(b);
  }
  return map;
}

// Startzeit aus der Zeigerposition in einer Tagesspalte (auf 15 min gerundet, innerhalb des Zeitraums)
export function timeAt(target, y, offsetY, minutes, r) {
  const rect = target.getBoundingClientRect();
  const raw = r.from + ((y - rect.top - offsetY) / rect.height) * (r.to - r.from);
  const snapped = Math.round(raw / 15) * 15;
  return Math.max(r.from, Math.min(snapped, r.to - Math.min(minutes, r.to - r.from)));
}

// Minuten pro Pixel in einer Tagesspalte (für das Ziehen der Dauer)
export function minutesPerPx(grid, r) {
  return (r.to - r.from) / grid.getBoundingClientRect().height;
}

// Position einer Uhrzeit in Prozent der Spaltenhöhe
export const percentOf = pct;
