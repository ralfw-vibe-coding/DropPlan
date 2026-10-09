// Kalender (rechte Seite): Monatsansicht mit Auslastungsbalken, Wochenansicht mit Stundenraster

import {
  today, addDays, startOfWeek, startOfMonth, weekdayShort, fmtDate, fmtHours, fmtDuration,
  toHHMM, fromHHMM, parse, WEEKDAYS,
} from './dates.js';
import { esc } from './ui-tasks.js';

export const HOUR_PX = 44;

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

export function renderMonth(model, anchor) {
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
      <div class="mday ${date.slice(0, 7) !== month ? 'other' : ''} ${date === t ? 'today' : ''} ${load.capacity === 0 ? 'off' : ''}"
           data-drop="day" data-date="${date}" data-goto-week="${date}" title="Zur Wochenansicht">
        <div class="mday-top">
          <span class="mday-num">${parse(date).getDate()}</span>
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

export function renderWeek(model, anchor) {
  const start = startOfWeek(anchor);
  const t = today();
  const s = model.settings();
  const byDate = groupByDate(model.bookings());
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const titleOf = (b) => model.task(b.taskId)?.title ?? '(gelöschte Aufgabe)';

  const heads = days
    .map((date) => {
      const list = byDate.get(date) || [];
      const load = model.load(date, list);
      const reserved = list.filter((b) => !b.start).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return `
        <div class="wday-head ${date === t ? 'today' : ''}" data-drop="day" data-date="${date}">
          <div class="wday-title"><b>${weekdayShort(date)}</b> ${fmtDate(date)}</div>
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

  const hours = Array.from({ length: 24 }, (_, h) => `<div class="hlabel" style="top:${h * HOUR_PX}px">${String(h).padStart(2, '0')}:00</div>`).join('');

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const cols = days
    .map((date) => {
      const scheduled = (byDate.get(date) || []).filter((b) => b.start);
      const blocks = layout(scheduled)
        .map(({ b, lane, lanes }) => {
          const top = (fromHHMM(b.start) / 60) * HOUR_PX;
          const height = Math.max((b.minutes / 60) * HOUR_PX, 18);
          const end = toHHMM(Math.min(fromHHMM(b.start) + b.minutes, 24 * 60));
          return `<div class="block" data-drag="booking" data-id="${b.id}" data-booking="${b.id}" data-label="${esc(titleOf(b))}"
                       style="top:${top}px;height:${height}px;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px)">
                    <div class="block-title">${esc(titleOf(b))}</div>
                    <div class="block-time">${b.start}–${end} · ${fmtDuration(b.minutes)}</div>
                    <div class="resize" data-nodrag data-resize="${b.id}" title="Dauer ziehen"></div>
                  </div>`;
        })
        .join('');
      return `
        <div class="wday-grid ${date === t ? 'today' : ''}" data-drop="time" data-date="${date}" style="height:${24 * HOUR_PX}px">
          <div class="core" style="top:${s.coreStart * HOUR_PX}px;height:${(s.coreEnd - s.coreStart) * HOUR_PX}px"></div>
          ${date === t ? `<div class="now" style="top:${(nowMin / 60) * HOUR_PX}px"></div>` : ''}
          ${blocks}
        </div>`;
    })
    .join('');

  return `
    <div class="week-scroll">
      <div class="week">
        <div class="corner"></div>
        ${heads}
        <div class="hours" style="height:${24 * HOUR_PX}px">${hours}</div>
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

// Startzeit aus der Zeigerposition in einer Tagesspalte (auf 15 min gerundet)
export function timeAt(target, y, offsetY, minutes) {
  const rect = target.getBoundingClientRect();
  const raw = ((y - rect.top - offsetY) / HOUR_PX) * 60;
  const snapped = Math.round(raw / 15) * 15;
  return Math.max(0, Math.min(snapped, 24 * 60 - Math.min(minutes, 24 * 60)));
}
