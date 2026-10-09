// Kalender (rechte Seite): Monatsansicht mit Auslastungsbalken, Wochenansicht mit Stundenraster

import {
  today, addDays, startOfWeek, startOfMonth, weekdayShort, fmtDate, fmtHours, fmtDuration,
  toHHMM, fromHHMM, parse, WEEKDAYS,
} from './dates.js';
import { esc } from './ui-tasks.js';

// Ampel: bis 66 % grün, bis 85 % gelb, darüber rot
export function loadClass(ratio) {
  if (ratio <= 0.66) return 'g';
  if (ratio <= 0.85) return 'y';
  return 'r';
}

function bar(load) {
  if (!load.minutes) return `<div class="bar"></div>`;
  const pct = Math.min(load.ratio, 1) * 100;
  const over = load.ratio > 1;
  return `<div class="bar"><div class="bar-fill ${loadClass(load.ratio)} ${over ? 'over' : ''}" style="width:${pct}%"></div></div>`;
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

// ---------- Monat ----------

export function renderMonth(model, anchor, selected) {
  const first = startOfMonth(anchor);
  const month = first.slice(0, 7);
  const start = startOfWeek(first);
  const t = today();
  const byDate = groupByDate(model.bookings());
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const date = addDays(start, i);
    if (i === 35 && date.slice(0, 7) !== month) break; // nur 5 Wochen, wenn der Monat hineinpasst
    const load = model.load(date, byDate.get(date) || []);
    cells += `
      <div class="mday ${date.slice(0, 7) !== month ? 'other' : ''} ${date === t ? 'today' : ''} ${date === selected ? 'selected' : ''} ${load.capacity === 0 ? 'off' : ''}"
           data-drop="day" data-date="${date}" data-goto-week="${date}" title="Zur Wochenansicht">
        <div class="mday-top">
          <span class="mday-num">${parse(date).getDate()}</span>${date === t ? '<span class="today-tag">heute</span>' : ''}
          ${load.count ? `<span class="mday-count">${load.count} ${load.count === 1 ? 'Aufgabe' : 'Aufgaben'}</span>` : ''}
        </div>
        ${bar(load)}
        <div class="mday-hours">${load.minutes || load.capacity ? loadText(load) : ''}</div>
        <div class="mday-pct">${percent(load)}</div>
      </div>`;
  }
  return `
    <div class="month">
      <div class="month-head">${WEEKDAYS.map((d) => `<div>${d}</div>`).join('')}</div>
      <div class="month-grid">${cells}</div>
    </div>`;
}

// ---------- Woche ----------

// Sichtbarer Zeitraum der Wochenansicht in Minuten (Einstellung "von/bis")
export function range(settings) {
  return { from: settings.coreStart * 60, to: settings.coreEnd * 60 };
}

const pct = (min, r) => ((min - r.from) / (r.to - r.from)) * 100;

export function renderWeek(model, anchor, selected) {
  const start = startOfWeek(anchor);
  const t = today();
  const r = range(model.settings());
  const hours = (r.to - r.from) / 60;
  const byDate = groupByDate(model.bookings());
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const titleOf = (b) => model.task(b.taskId)?.title ?? '(gelöschte Aufgabe)';
  const dayClass = (date) => `${date === t ? 'today' : ''} ${date === selected ? 'selected' : ''} ${model.capacity(date) === 0 ? 'off' : ''}`;

  const heads = days
    .map((date) => {
      const list = byDate.get(date) || [];
      const load = model.load(date, list);
      const reserved = list.filter((b) => !b.start).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return `
        <div class="wday-head ${dayClass(date)}" data-drop="day" data-date="${date}">
          <div class="wday-title"><b>${weekdayShort(date)}</b> ${fmtDate(date)}${date === t ? ' <span class="today-tag">heute</span>' : ''}</div>
          ${bar(load)}
          <div class="wday-load">
            <span>${fmtHours(load.minutes)} / <button class="cap" data-cap="${date}" title="Kapazität für diesen Tag ändern">${fmtHours(load.capacity)} h</button>
              ${load.minutes > load.capacity && load.minutes ? `<b class="overtime">+${fmtHours(load.minutes - load.capacity)} h</b>` : ''}</span>
            <span>${percent(load)}</span>
          </div>
          <div class="reserved">
            ${reserved
              .map(
                (b) => `<div class="chip-booking" data-drag="booking" data-id="${b.id}" data-booking="${b.id}" data-label="${esc(titleOf(b))}">
                  <span class="cb-title">${esc(titleOf(b))}</span><span class="cb-dur">${fmtDuration(b.minutes)}</span></div>`,
              )
              .join('')}
            ${reserved.length ? '' : `<div class="reserved-hint">hierher ziehen = Zeit reservieren</div>`}
          </div>
        </div>`;
    })
    .join('');

  const labels = Array.from({ length: hours }, (_, i) => `<div class="hlabel" style="top:${(i / hours) * 100}%">${String(r.from / 60 + i).padStart(2, '0')}:00</div>`).join('');

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const cols = days
    .map((date) => {
      const scheduled = (byDate.get(date) || []).filter((b) => b.start);
      const blocks = layout(scheduled)
        .map(({ b, lane, lanes }) => {
          const startMin = fromHHMM(b.start);
          const endMin = Math.min(startMin + b.minutes, 24 * 60);
          // Termine außerhalb des sichtbaren Zeitraums an den Rand legen, damit sie nicht verschwinden
          const top = Math.min(Math.max(pct(startMin, r), 0), 97);
          const bottom = Math.min(Math.max(pct(endMin, r), top + 3), 100);
          return `<div class="block ${startMin < r.from || endMin > r.to ? 'outside' : ''}" data-drag="booking" data-id="${b.id}" data-booking="${b.id}" data-label="${esc(titleOf(b))}"
                       style="top:${top}%;height:${bottom - top}%;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px)">
                    <div class="block-title">${esc(titleOf(b))}</div>
                    <div class="block-time">${b.start}–${toHHMM(endMin)} · ${fmtDuration(b.minutes)}</div>
                    <div class="resize" data-nodrag data-resize="${b.id}" title="Dauer ziehen"></div>
                  </div>`;
        })
        .join('');
      return `
        <div class="wday-grid ${dayClass(date)}" data-drop="time" data-date="${date}">
          ${date === t && nowMin >= r.from && nowMin <= r.to ? `<div class="now" style="top:${pct(nowMin, r)}%"></div>` : ''}
          ${blocks}
        </div>`;
    })
    .join('');

  return `
    <div class="week-scroll">
      <div class="week" style="--hours:${hours}">
        <div class="corner"></div>
        ${heads}
        <div class="hours">${labels}</div>
        ${cols}
      </div>
    </div>`;
}

// Überlappende Termine nebeneinander legen
function layout(bookings) {
  const items = bookings
    .map((b) => ({ b, s: fromHHMM(b.start), e: fromHHMM(b.start) + b.minutes, lane: 0, lanes: 1 }))
    .sort((x, y) => x.s - y.s || y.e - x.e);
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
