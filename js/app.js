// Einstieg: Verbinden, Store starten, Oberfläche zeichnen und Eingaben verarbeiten

import { DROPBOX_APP_KEY } from './config.js';
import { Dropbox } from './dropbox.js';
import { FakeRemote } from './fakeremote.js';
import { Store } from './store.js';
import { deleteCache } from './idb.js';
import { Model } from './model.js';
import { setupDrag } from './drag.js';
import { renderTaskFilters, renderTaskList, esc } from './ui-tasks.js';
import { renderWeek, renderMonth, timeAt, range, percentOf, minutesPerPx } from './ui-calendar.js';
import {
  today, addDays, addMonths, startOfWeek, isoWeek, monthTitle, weekdayShort, fmtDate, fmtDateLong,
  fmtDuration, fmtHours, parseDuration, toHHMM, fromHHMM, weekdayIndex, WEEKDAYS,
} from './dates.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const localDevice = params.has('local') ? params.get('local') || 'a' : null;
const CACHE_DROPBOX = 'dropplan-dropbox';

// Kleine Bequemlichkeiten pro Browser (Ansicht, Filter) – nicht synchronisiert
const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem('dropplan.prefs') || '{}');
  } catch {
    return {};
  }
})();
const ui = {
  view: prefs.view || 'week',
  anchor: today(),
  selected: null, // in der Monatsansicht angeklickter Tag, in der Woche umrandet
  filter: { tags: new Set(prefs.tags || []), state: prefs.state || null, followUps: false, archive: false },
};
function savePrefs() {
  try {
    localStorage.setItem('dropplan.prefs', JSON.stringify({ view: ui.view, tags: [...ui.filter.tags], state: ui.filter.state }));
  } catch {
    // egal
  }
}

let store, model, dbx;

// ---------- Start ----------

async function main() {
  let remote, cacheName;
  if (localDevice) {
    remote = new FakeRemote();
    cacheName = `dropplan-local-${localDevice}`;
    $('#mode').textContent = `Testmodus ohne Dropbox · Gerät „${localDevice}“`;
  } else {
    dbx = new Dropbox(DROPBOX_APP_KEY);
    try {
      if (await dbx.handleRedirect()) await deleteCache(CACHE_DROPBOX); // frisch verbunden: alten Cache verwerfen
    } catch (e) {
      showConnect(`Verbinden hat nicht geklappt: ${e.message}`);
      return;
    }
    if (!dbx.isConnected()) {
      showConnect();
      return;
    }
    remote = dbx;
    cacheName = CACHE_DROPBOX;
  }

  store = new Store(remote, cacheName);
  model = new Model(store);
  await store.init();

  $('#app').hidden = false;
  $('#btn-settings').hidden = false;
  let queued = false;
  store.onChange((dataChanged) => {
    renderSync();
    if (!dataChanged || queued) return;
    queued = true;
    // gebündelt neu zeichnen (setTimeout statt requestAnimationFrame, das in Hintergrund-Tabs pausiert)
    setTimeout(() => {
      queued = false;
      render();
    }, 0);
  });
  render();
  renderSync();
  setupDrag({ accepts, describe, hover, onDrop });
  setupPan();
  wireEvents();
  store.start();
}

function showConnect(message = '') {
  $('#connect').hidden = false;
  const hint = $('#connect-hint');
  if (!DROPBOX_APP_KEY) {
    $('#btn-connect').disabled = true;
    hint.innerHTML = `Es ist noch kein Dropbox App key eingetragen (<code>js/config.js</code>).<br>
      Zum Ausprobieren ohne Dropbox: <a href="?local">Testmodus öffnen</a>`;
  } else {
    hint.textContent = message;
  }
  $('#btn-connect').onclick = () => dbx.login();
}

// ---------- Zeichnen ----------

function render() {
  $('#filters').innerHTML = renderTaskFilters(model, ui.filter);
  const list = $('#task-list');
  list.innerHTML = renderTaskList(model, ui.filter);
  // Umsortieren nur in der normalen Liste, nicht im Archiv
  if (ui.filter.archive) delete list.dataset.drop;
  else list.dataset.drop = 'list';
  renderCalendar();
}

function renderCalendar() {
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));
  const body = $('#cal-body');
  if (ui.view === 'month') {
    $('#cal-title').textContent = monthTitle(ui.anchor);
    body.innerHTML = renderMonth(model, ui.anchor, ui.selected);
    body.dataset.week = '';
    body.classList.add('pannable');
    return;
  }
  const start = startOfWeek(ui.anchor);
  const end = addDays(start, 6);
  $('#cal-title').textContent = `KW ${isoWeek(start)} · ${fmtDate(start)}–${fmtDate(end)}${end.slice(0, 4)}`;
  // Horizontale Scrollposition (schmale Bildschirme) beim Neuzeichnen derselben Woche behalten
  const old = body.querySelector('.week-scroll');
  const keepLeft = old && body.dataset.week === start ? old.scrollLeft : null;
  body.innerHTML = renderWeek(model, ui.anchor, ui.selected);
  body.dataset.week = start;
  const sc = body.querySelector('.week-scroll');
  const overflowX = sc.scrollWidth > sc.clientWidth;
  if (keepLeft !== null) sc.scrollLeft = keepLeft;
  else if (overflowX) {
    const col = sc.querySelector('.wday-head.selected') || sc.querySelector('.wday-head.today');
    if (col) sc.scrollLeft = col.offsetLeft - 52;
  }
  // Blättern per Wischen nur, wenn die Woche nicht ohnehin seitlich scrollt
  body.classList.toggle('pannable', !overflowX);
}

function renderSync() {
  const { state, pending, message } = store.status;
  const el = $('#sync');
  const texts = {
    idle: pending ? `${pending} Änderung(en) offen` : 'gespeichert',
    syncing: 'synchronisiere …',
    offline: `offline${pending ? ` · ${pending} offen` : ''}`,
    error: `Sync-Fehler: ${message.replace(/^Dropbox: /, '')}`,
  };
  el.className = `sync ${state}`;
  el.textContent = texts[state];
  el.title = message || '';
  // Berechtigungen der Dropbox-App wurden geändert: die alte Anmeldung kennt sie noch nicht
  if (state === 'error' && dbx && /missing_scope|required scope/.test(message)) {
    el.innerHTML = `Dropbox-Berechtigung fehlt · <a href="#" id="reconnect">neu verbinden</a>`;
    $('#reconnect').onclick = async (e) => {
      e.preventDefault();
      store.stop();
      await dbx.logout();
      await deleteCache(CACHE_DROPBOX).catch(() => {});
      dbx.login();
    };
  }
}

// ---------- Ziehen & Ablegen ----------

const durationOf = (payload) =>
  payload.kind === 'booking' ? model.booking(payload.id)?.minutes ?? 30 : model.settings().defaultMinutes;

function accepts(payload, target) {
  return target.dataset.drop !== 'list' || payload.kind === 'task';
}

// Zwischen welche Aufgaben der Liste würde eingefügt?
function listSlot(payload, point) {
  const items = [...document.querySelectorAll('#task-list .task')].filter((li) => li.dataset.id !== payload.id);
  const i = items.findIndex((li) => {
    const r = li.getBoundingClientRect();
    return point.y < r.top + r.height / 2;
  });
  const idx = i < 0 ? items.length : i;
  return { prev: items[idx - 1] || null, next: items[idx] || null };
}

function dropTarget(payload, target, point) {
  const date = target.dataset.date;
  if (target.dataset.drop === 'day') return { date, start: null };
  const r = range(model.settings());
  return { date, start: toHHMM(timeAt(target, point.y, payload.offsetY, durationOf(payload), r)) };
}

function describe(payload, target, point) {
  if (target.dataset.drop === 'list') return '';
  const { date, start } = dropTarget(payload, target, point);
  return `→ ${weekdayShort(date)} ${fmtDate(date)}${start ? ` · ${start}` : ' · reservieren'}`;
}

// Einfügemarke: Strich in der Liste, Vorschau im Stundenraster, Platzhalter im Tageskopf
const marker = document.createElement('div');

function hover(payload, target, point) {
  edgeFlip(payload, point);
  marker.remove();
  if (!payload || !target) return;
  const kind = target.dataset.drop;
  if (kind === 'list') {
    const { prev, next } = listSlot(payload, point);
    marker.className = 'insert-line';
    marker.textContent = '';
    marker.style.cssText = `top:${(next ? next.offsetTop : prev ? prev.offsetTop + prev.offsetHeight : 0) - 1}px`;
    target.append(marker);
  } else if (kind === 'time') {
    const r = range(model.settings());
    const s = fromHHMM(dropTarget(payload, target, point).start);
    const e = s + durationOf(payload);
    marker.className = 'drop-preview';
    marker.textContent = `${toHHMM(s)}–${toHHMM(e)}`;
    marker.style.cssText = `top:${percentOf(s, r)}%;height:${percentOf(e, r) - percentOf(s, r)}%`;
    target.append(marker);
  } else if (target.classList.contains('wday-head')) {
    marker.className = 'chip-placeholder';
    marker.textContent = `+ ${fmtDuration(durationOf(payload))}`;
    marker.style.cssText = '';
    target.querySelector('.reserved').append(marker);
  }
}

function onDrop(payload, target, point) {
  if (target.dataset.drop === 'list') {
    const { prev, next } = listSlot(payload, point);
    model.moveTask(payload.id, prev?.dataset.id, next?.dataset.id);
    return;
  }
  const { date, start } = dropTarget(payload, target, point);
  if (payload.kind === 'task') model.plan(payload.id, date, start);
  else model.updateBooking(payload.id, { date, start });
}

// Beim Ziehen kurz am linken/rechten Kalenderrand verweilen = blättern
const flip = { dir: 0, timer: null };

function edgeFlip(payload, point) {
  const body = $('#cal-body');
  const r = body.getBoundingClientRect();
  const sc = body.querySelector('.week-scroll');
  let dir = 0;
  if (payload && point.y > r.top && point.y < r.bottom) {
    if (point.x >= r.left && point.x < r.left + 28) dir = -1;
    else if (point.x <= r.right && point.x > r.right - 28) dir = 1;
  }
  // solange die Woche noch seitlich scrollen kann, erst scrollen statt blättern
  if (sc && dir < 0 && sc.scrollLeft > 0) dir = 0;
  if (sc && dir > 0 && sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 1) dir = 0;
  body.classList.toggle('flip-prev', dir < 0);
  body.classList.toggle('flip-next', dir > 0);
  if (dir === flip.dir) return;
  clearInterval(flip.timer);
  flip.dir = dir;
  if (dir) flip.timer = setInterval(() => slide(dir), 900);
}

// Blättern mit kleiner Animation
function slide(dir) {
  navigate(dir);
  $('#cal-body').firstElementChild?.animate(
    [{ transform: `translateX(${dir * 30}%)`, opacity: 0.2 }, { transform: 'none', opacity: 1 }],
    { duration: 220, easing: 'ease-out' },
  );
}

// Kalender mit Maus/Finger seitlich ziehen oder auf dem Trackpad wischen = blättern
function setupPan() {
  const body = $('#cal-body');
  let pan = null;
  const swallow = (e) => e.stopPropagation();

  body.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !body.classList.contains('pannable')) return;
    if (e.target.closest('[data-drag], [data-nodrag], button, input, a')) return;
    pan = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false };
  });
  body.addEventListener('pointermove', (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (!pan.active) {
      if (Math.abs(dx) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        pan = null;
        return;
      }
      pan.active = true;
      body.setPointerCapture(e.pointerId);
      body.classList.add('panning');
    }
    body.firstElementChild.style.transform = `translateX(${dx}px)`;
  });
  const finish = (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    const p = pan;
    pan = null;
    if (!p.active) return;
    body.classList.remove('panning');
    addEventListener('click', swallow, { capture: true });
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
    const dx = e.clientX - p.x;
    const content = body.firstElementChild;
    if (e.type === 'pointerup' && Math.abs(dx) > Math.min(120, body.clientWidth * 0.2)) {
      content.style.transform = '';
      slide(dx < 0 ? 1 : -1);
    } else {
      content.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
      content.style.transform = '';
    }
  };
  body.addEventListener('pointerup', finish);
  body.addEventListener('pointercancel', finish);

  let acc = 0;
  let lockUntil = 0;
  body.addEventListener(
    'wheel',
    (e) => {
      if (!body.classList.contains('pannable') || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (Date.now() < lockUntil) return; // Nachschwingen des Trackpads ignorieren
      acc += e.deltaX;
      if (Math.abs(acc) > 80) {
        slide(acc > 0 ? 1 : -1);
        acc = 0;
        lockUntil = Date.now() + 900;
      }
    },
    { passive: false },
  );
}

// Dauer eines Termins im Raster am unteren Rand ziehen
function startResize(e, id) {
  e.preventDefault();
  e.stopPropagation();
  const b = model.booking(id);
  const block = e.target.closest('.block');
  const r = range(model.settings());
  const mpp = minutesPerPx(block.closest('.wday-grid'), r);
  const startY = e.clientY;
  const startMin = b.minutes;
  const s0 = fromHHMM(b.start);
  const maxMin = 24 * 60 - s0;
  const top = Math.min(Math.max(percentOf(s0, r), 0), 97);
  let minutes = startMin;
  const move = (ev) => {
    minutes = Math.max(15, Math.min(maxMin, startMin + Math.round(((ev.clientY - startY) * mpp) / 15) * 15));
    block.style.height = `${Math.max(Math.min(percentOf(s0 + minutes, r), 100) - top, 3)}%`;
    block.querySelector('.block-time').textContent = `${b.start}–${toHHMM(s0 + minutes)} · ${fmtDuration(minutes)}`;
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (minutes !== startMin) model.updateBooking(id, { minutes });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

// ---------- Popover (Termin, Kapazität) ----------

const popover = $('#popover');

function openPopover(anchorEl, html, wire) {
  popover.innerHTML = html;
  popover.hidden = false;
  const r = anchorEl.getBoundingClientRect();
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;
  let left = Math.min(r.left, innerWidth - pw - 8);
  let top = r.bottom + 6;
  if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  popover.style.left = `${Math.max(8, left)}px`;
  popover.style.top = `${top}px`;
  wire(popover);
}

function closePopover() {
  popover.hidden = true;
  popover.innerHTML = '';
}

const QUICK = [15, 30, 45, 60, 90, 120, 180, 240];

function openBookingPopover(el, id) {
  const b = model.booking(id);
  if (!b) return;
  const task = model.task(b.taskId);
  openPopover(
    el,
    `<div class="pop-title">${esc(task?.title ?? '(gelöschte Aufgabe)')}</div>
     <div class="pop-label">Dauer</div>
     <div class="quick">${QUICK.map((m) => `<button data-min="${m}" class="${m === b.minutes ? 'on' : ''}">${fmtDuration(m)}</button>`).join('')}</div>
     <form class="pop-row" data-form="dur"><input name="dur" value="${fmtHours(b.minutes)}" aria-label="Dauer in Stunden"><span>h</span><button>OK</button></form>
     <div class="pop-label">Tag &amp; Uhrzeit</div>
     <div class="pop-row">
       <input type="date" name="date" value="${b.date}">
       <input type="time" name="start" step="900" value="${b.start ?? ''}">
     </div>
     <div class="pop-actions">
       ${b.start ? `<button data-act="unschedule">Ohne Uhrzeit</button>` : ''}
       ${task ? `<button data-act="open">Aufgabe öffnen</button>` : ''}
       <button data-act="remove" class="danger">Aus Kalender entfernen</button>
     </div>`,
    (p) => {
      p.querySelectorAll('[data-min]').forEach((btn) =>
        btn.addEventListener('click', () => {
          model.updateBooking(id, { minutes: Number(btn.dataset.min) });
          closePopover();
        }),
      );
      p.querySelector('[data-form="dur"]').addEventListener('submit', (e) => {
        e.preventDefault();
        const min = parseDuration(e.target.dur.value);
        if (min > 0) {
          model.updateBooking(id, { minutes: min });
          closePopover();
        } else e.target.dur.classList.add('invalid');
      });
      p.querySelector('[name="date"]').addEventListener('change', (e) => e.target.value && model.updateBooking(id, { date: e.target.value }));
      p.querySelector('[name="start"]').addEventListener('change', (e) => model.updateBooking(id, { start: e.target.value || null }));
      p.querySelector('[data-act="unschedule"]')?.addEventListener('click', () => {
        model.updateBooking(id, { start: null });
        closePopover();
      });
      p.querySelector('[data-act="open"]')?.addEventListener('click', () => {
        closePopover();
        openTask(b.taskId);
      });
      p.querySelector('[data-act="remove"]').addEventListener('click', () => {
        model.deleteBooking(id);
        closePopover();
      });
    },
  );
}

function openCapacityPopover(el, date) {
  const cap = model.capacity(date);
  const standard = model.settings().weekdayCapacity[weekdayIndex(date)];
  openPopover(
    el,
    `<div class="pop-title">Kapazität ${weekdayShort(date)} ${fmtDate(date)}</div>
     <form class="pop-row"><input name="cap" value="${fmtHours(cap)}" aria-label="Stunden"><span>h</span><button>OK</button></form>
     <div class="pop-actions"><button data-act="std">Standard (${fmtHours(standard)} h)</button></div>`,
    (p) => {
      p.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const min = parseDuration(e.target.cap.value);
        if (min >= 0) {
          model.setCapacity(date, min);
          closePopover();
        } else e.target.cap.classList.add('invalid');
      });
      p.querySelector('[data-act="std"]').addEventListener('click', () => {
        model.setCapacity(date, standard);
        closePopover();
      });
      p.querySelector('input').select();
    },
  );
}

// ---------- Aufgabe bearbeiten ----------

let editingId = null;

function openTask(id) {
  const task = model.task(id);
  if (!task) return;
  editingId = id;
  const f = $('#task-form');
  f.title.value = task.title;
  f.notes.value = task.notes || '';
  f.tags.value = (task.tags || []).join(', ');
  f.deadline.value = task.deadline || '';
  f.followUp.value = task.followUp || '';
  $('#tag-list').innerHTML = model.tags().map((t) => `<option value="${esc(t)}">`).join('');
  renderTaskDetails();
  $('#task-dialog').showModal();
}

function renderTaskDetails() {
  const task = model.task(editingId);
  if (!task) return;
  const status = task.archivedAt
    ? `Archiviert${task.activatedAt ? ' · war aktiv' : ''}`
    : task.activatedAt
      ? `<span class="state-dot on"></span> Aktiv seit ${fmtDateLong(task.activatedAt.slice(0, 10))}`
      : `<span class="state-dot"></span> Passiv – noch nie eingeplant`;
  $('#task-status').innerHTML = status;
  $('#btn-archive-task').textContent = task.archivedAt ? 'Wiederherstellen' : 'Archivieren';
  const bookings = model.bookingsOf(editingId);
  const total = bookings.reduce((s, b) => s + b.minutes, 0);
  $('#task-bookings').innerHTML = bookings.length
    ? `<div class="pop-label">Im Kalender · ${fmtHours(total)} h</div>
       <ul>${bookings.map((b) => `<li data-goto-week="${b.date}">${weekdayShort(b.date)} ${fmtDate(b.date)}${b.date.slice(0, 4)} · ${b.start ? `${b.start} · ` : ''}${fmtDuration(b.minutes)}</li>`).join('')}</ul>`
    : '';
}

function saveTaskForm() {
  if (!editingId) return;
  const f = $('#task-form');
  const tags = [...new Set(f.tags.value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];
  model.updateTask(editingId, {
    title: f.title.value.trim() || model.task(editingId)?.title,
    notes: f.notes.value,
    tags,
    deadline: f.deadline.value || null,
    followUp: f.followUp.value || null,
  });
}

// ---------- Einstellungen ----------

function openSettings() {
  const s = model.settings();
  const f = $('#settings-form');
  f.defaultMinutes.value = s.defaultMinutes;
  f.coreStart.value = s.coreStart;
  f.coreEnd.value = s.coreEnd;
  $('#weekday-caps').innerHTML = WEEKDAYS.map(
    (d, i) => `<label>${d}<input type="number" name="cap${i}" min="0" max="24" step="0.25" value="${s.weekdayCapacity[i] / 60}"></label>`,
  ).join('');
  $('#btn-disconnect').hidden = !!localDevice;
  $('#settings-dialog').showModal();
}

function saveSettings() {
  const f = $('#settings-form');
  const coreStart = Number(f.coreStart.value);
  const coreEnd = Number(f.coreEnd.value);
  model.saveSettings({
    defaultMinutes: Math.max(5, Number(f.defaultMinutes.value) || 30),
    weekdayCapacity: WEEKDAYS.map((_, i) => Math.round(Number(f[`cap${i}`].value || 0) * 60)),
    coreStart: Math.min(coreStart, coreEnd - 1),
    coreEnd,
  });
}

// ---------- Ereignisse ----------

function navigate(dir) {
  if (dir === 0) {
    ui.anchor = today();
    ui.selected = null;
  }
  else if (ui.view === 'week') ui.anchor = addDays(ui.anchor, dir * 7);
  else ui.anchor = addMonths(ui.anchor, dir);
  renderCalendar();
}

function wireEvents() {
  $('#new-task').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = e.target.title.value.trim();
    if (!title) return;
    ui.filter.archive = false;
    model.addTask(title);
    e.target.reset();
  });

  document.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      ui.view = b.dataset.view;
      savePrefs();
      renderCalendar();
    }),
  );
  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => navigate(Number(b.dataset.nav))));

  $('#filters').addEventListener('click', (e) => {
    const tagBtn = e.target.closest('[data-filter-tag]');
    const toggle = e.target.closest('[data-filter]');
    const stateBtn = e.target.closest('[data-filter-state]');
    if (stateBtn) {
      // aktiv / passiv / alle: zweiter Klick schaltet wieder aus
      const state = stateBtn.dataset.filterState;
      ui.filter.state = ui.filter.state === state ? null : state;
      savePrefs();
    } else if (tagBtn) {
      const tag = tagBtn.dataset.filterTag;
      ui.filter.tags.has(tag) ? ui.filter.tags.delete(tag) : ui.filter.tags.add(tag);
      savePrefs();
    } else if (toggle) {
      ui.filter[toggle.dataset.filter] = !ui.filter[toggle.dataset.filter];
    } else return;
    render();
  });

  // Klicks im Kalender und in der Liste
  document.addEventListener('click', (e) => {
    if (!popover.hidden && !popover.contains(e.target)) {
      closePopover();
      if (!e.target.closest('[data-booking], [data-cap]')) return;
    }
    const cap = e.target.closest('[data-cap]');
    if (cap) return openCapacityPopover(cap, cap.dataset.cap);
    const booking = e.target.closest('[data-booking]');
    if (booking) return openBookingPopover(booking, booking.dataset.booking);
    const task = e.target.closest('[data-open-task]');
    if (task) return openTask(task.dataset.openTask);
    const goto = e.target.closest('[data-goto-week]');
    if (goto) {
      if ($('#task-dialog').open) $('#task-dialog').close();
      ui.view = 'week';
      ui.anchor = goto.dataset.gotoWeek;
      ui.selected = goto.dataset.gotoWeek;
      savePrefs();
      renderCalendar();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-resize]');
    if (handle) startResize(e, handle.dataset.resize);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopover();
  });

  // Aufgabendialog: Änderungen sofort speichern
  const form = $('#task-form');
  form.addEventListener('change', saveTaskForm);
  $('#task-dialog').addEventListener('close', () => {
    saveTaskForm();
    editingId = null;
  });
  $('#btn-archive-task').addEventListener('click', () => {
    saveTaskForm();
    const task = model.task(editingId);
    model.updateTask(editingId, { archivedAt: task.archivedAt ? null : new Date().toISOString() });
    $('#task-dialog').close();
  });
  $('#btn-delete-task').addEventListener('click', () => {
    const n = model.bookingsOf(editingId).length;
    const msg = n ? `Aufgabe löschen? Sie ist ${n}× im Kalender eingeplant, diese Einträge verschwinden mit.` : 'Aufgabe löschen?';
    if (!confirm(msg)) return;
    const id = editingId;
    editingId = null;
    model.deleteTask(id);
    $('#task-dialog').close();
  });

  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-dialog').addEventListener('close', () => {
    if ($('#settings-dialog').returnValue === 'save') saveSettings();
  });
  $('#btn-disconnect').addEventListener('click', async () => {
    if (!confirm('Diesen Browser von Dropbox trennen? Die Daten in der Dropbox bleiben erhalten.')) return;
    store.stop();
    await dbx.logout();
    await deleteCache(CACHE_DROPBOX).catch(() => {});
    location.reload();
  });
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<div class="fatal">Fehler beim Start: ${esc(e.message)}</div>`);
});
