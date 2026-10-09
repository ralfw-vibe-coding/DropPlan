// Einstieg: Verbinden, Store starten, Oberfläche zeichnen und Eingaben verarbeiten

import { DROPBOX_APP_KEY } from './config.js';
import { Dropbox } from './dropbox.js';
import { FakeRemote } from './fakeremote.js';
import { Store } from './store.js';
import { deleteCache } from './idb.js';
import { Model } from './model.js';
import { setupDrag } from './drag.js';
import { renderTaskFilters, renderTaskList, esc } from './ui-tasks.js';
import { renderWeek, renderMonth, timeAt, HOUR_PX } from './ui-calendar.js';
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
  filter: { tags: new Set(prefs.tags || []), followUps: false, archive: false },
};
function savePrefs() {
  try {
    localStorage.setItem('dropplan.prefs', JSON.stringify({ view: ui.view, tags: [...ui.filter.tags] }));
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
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  });
  render();
  renderSync();
  setupDrag({ describe, onDrop });
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
  $('#task-list').innerHTML = renderTaskList(model, ui.filter);
  renderCalendar();
}

function renderCalendar() {
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));
  const body = $('#cal-body');
  if (ui.view === 'month') {
    $('#cal-title').textContent = monthTitle(ui.anchor);
    body.innerHTML = renderMonth(model, ui.anchor);
    return;
  }
  const start = startOfWeek(ui.anchor);
  const end = addDays(start, 6);
  $('#cal-title').textContent = `KW ${isoWeek(start)} · ${fmtDate(start)}–${fmtDate(end)}${end.slice(0, 4)}`;
  // Scrollposition beim Neuzeichnen derselben Woche behalten
  const old = body.querySelector('.week-scroll');
  const keep = old && body.dataset.week === start ? { top: old.scrollTop, left: old.scrollLeft } : null;
  body.innerHTML = renderWeek(model, ui.anchor);
  body.dataset.week = start;
  const sc = body.querySelector('.week-scroll');
  if (keep) {
    sc.scrollTop = keep.top;
    sc.scrollLeft = keep.left;
  } else {
    sc.scrollTop = Math.max(0, (model.settings().coreStart - 1) * HOUR_PX);
    const todayCol = sc.querySelector('.wday-head.today');
    if (todayCol && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = todayCol.offsetLeft - 52;
  }
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

function titleFor(payload) {
  if (payload.kind === 'task') return model.task(payload.id)?.title;
  const b = model.booking(payload.id);
  return b && model.task(b.taskId)?.title;
}

function dropTarget(payload, target, point) {
  const date = target.dataset.date;
  if (target.dataset.drop === 'day') return { date, start: null };
  const minutes = payload.kind === 'booking' ? model.booking(payload.id)?.minutes ?? 30 : model.settings().defaultMinutes;
  return { date, start: toHHMM(timeAt(target, point.y, payload.offsetY, minutes)) };
}

function describe(payload, target, point) {
  const { date, start } = dropTarget(payload, target, point);
  return `→ ${weekdayShort(date)} ${fmtDate(date)}${start ? ` · ${start}` : ' · reservieren'}`;
}

function onDrop(payload, target, point) {
  const { date, start } = dropTarget(payload, target, point);
  if (payload.kind === 'task') model.plan(payload.id, date, start);
  else model.updateBooking(payload.id, { date, start });
}

// Dauer eines Termins im Raster am unteren Rand ziehen
function startResize(e, id) {
  e.preventDefault();
  e.stopPropagation();
  const b = model.booking(id);
  const block = e.target.closest('.block');
  const startY = e.clientY;
  const startMin = b.minutes;
  const maxMin = 24 * 60 - fromHHMM(b.start);
  let minutes = startMin;
  const move = (ev) => {
    minutes = Math.max(15, Math.min(maxMin, startMin + Math.round(((ev.clientY - startY) / HOUR_PX) * 4) * 15));
    block.style.height = `${(minutes / 60) * HOUR_PX}px`;
    block.querySelector('.block-time').textContent = `${b.start}–${toHHMM(fromHHMM(b.start) + minutes)} · ${fmtDuration(minutes)}`;
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
  if (dir === 0) ui.anchor = today();
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
    if (tagBtn) {
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
