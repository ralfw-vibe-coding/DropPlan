// Einstieg: Verbinden, Store starten, Oberfläche zeichnen und Eingaben verarbeiten

import { DROPBOX_APP_KEY } from './config.js';
import { Dropbox } from './dropbox.js';
import { FakeRemote } from './fakeremote.js';
import { Store } from './store.js';
import { deleteCache } from './idb.js';
import { Model } from './model.js';
import { setupDrag } from './drag.js';
import { renderTaskFilters, renderTaskList, estimateInfo, esc, TASK_COLORS } from './ui-tasks.js';
import { renderWeek, renderMonth, timeAt, range, percentOf, minutesPerPx } from './ui-calendar.js';
import { Calendars, calSettings } from './calendars.js';
import { Google, preload as preloadGoogle } from './google.js';
import {
  today, addDays, addMonths, startOfWeek, startOfMonth, isoWeek, daysBetween, monthTitle, weekdayShort, fmtDate, fmtDateLong,
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
  anchor: startOfWeek(today()), // Woche: erster sichtbarer Tag · Monat: ein Tag im Monat
  selected: null, // in der Monatsansicht angeklickter Tag, in der Woche umrandet
  armed: null, // {id, act}: Aufgaben-Knopf, der auf die Bestätigung wartet
  busy: false, // läuft gerade eine Ziehgeste, die nicht unterbrochen werden darf?
  renderPending: false,
  collapsed: !!prefs.collapsed, // Aufgabenliste eingeklappt
  listWidth: prefs.listWidth || null, // Breite der Liste in px (null = ein Drittel)
  filter: { tags: new Set(prefs.tags || []), state: prefs.state || null, followUps: false, archive: false },
};
function savePrefs() {
  try {
    localStorage.setItem(
      'dropplan.prefs',
      JSON.stringify({ view: ui.view, tags: [...ui.filter.tags], state: ui.filter.state, collapsed: ui.collapsed, listWidth: ui.listWidth }),
    );
  } catch {
    // egal
  }
}

let store, model, dbx, cal;

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
  cal = new Calendars(model, `dropplan.calendars.${cacheName}`, () => {
    renderCalStatus();
    scheduleRender();
  });

  $('#app').hidden = false;
  $('#btn-settings').hidden = false;
  // Kalender-Einstellungen können sich auch durch ein anderes Gerät ändern (settings.json in der Dropbox)
  let calSig = JSON.stringify(calSettings(model.settings()));
  store.onChange((dataChanged) => {
    renderSync();
    if (!dataChanged) return;
    const sig = JSON.stringify(calSettings(model.settings()));
    if (sig !== calSig) {
      calSig = sig;
      cal.settingsChanged();
    }
    scheduleRender();
  });
  render();
  renderSync();
  renderCalStatus();
  setInterval(renderCalStatus, 30_000);
  cal.start();
  setupDrag({ accepts, describe, hover, onDrop });
  setupPan();
  setupListLayout();
  watchCalendarWidth();
  wireEvents();
  store.start();
}

// gebündelt neu zeichnen (setTimeout statt requestAnimationFrame, das in Hintergrund-Tabs pausiert)
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    if (ui.busy) ui.renderPending = true; // z. B. während die Dauer gezogen wird
    else render();
  }, 0);
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
  list.innerHTML = renderTaskList(model, ui.filter, ui.armed);
  $('.strip-label').textContent = `Aufgaben (${list.querySelectorAll('.task').length})`;
  // Umsortieren nur in der normalen Liste, nicht im Archiv
  if (ui.filter.archive) delete list.dataset.drop;
  else list.dataset.drop = 'list';
  renderCalendar();
}

// Wochenansicht: fortlaufender Streifen von Tagen rund um ui.anchor (= erster sichtbarer Tag)
const WEEKS_AROUND = 6;
const STRIP_DAYS = 7 * (2 * WEEKS_AROUND + 1);
let colw = 120; // Breite einer Tagesspalte in px
let scrollTimer = null;

function computeColWidth() {
  return Math.max(110, ($('#cal-body').clientWidth - 52) / 7);
}

const firstVisibleDate = (sc) => addDays(sc.dataset.start, Math.round(sc.scrollLeft / colw));

function updateWeekTitle(sc) {
  const d = firstVisibleDate(sc);
  const e = addDays(d, 6);
  const kw = isoWeek(d) === isoWeek(e) ? `KW ${isoWeek(d)}` : `KW ${isoWeek(d)}/${isoWeek(e)}`;
  $('#cal-title').textContent = `${kw} · ${fmtDate(d)}–${fmtDate(e)}${e.slice(0, 4)}`;
}

function onWeekScroll(e) {
  const sc = e.currentTarget;
  if (!sc.isConnected) return; // alter Streifen nach dem Wechsel in den Monat
  updateWeekTitle(sc);
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (!sc.isConnected) return;
    ui.anchor = firstVisibleDate(sc);
    // nahe am Ende des Streifens: neu um den sichtbaren Tag herum aufbauen
    const idx = daysBetween(sc.dataset.start, ui.anchor);
    if (idx < 14 || idx > STRIP_DAYS - 21) renderCalendar();
  }, 200);
}

// jump = true: zu ui.anchor springen; sonst sichtbare Position beibehalten
function renderCalendar({ jump = false } = {}) {
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));
  const body = $('#cal-body');
  if (ui.view === 'month') {
    $('#cal-title').textContent = monthTitle(ui.anchor);
    const gridStart = startOfWeek(startOfMonth(ui.anchor));
    cal.ensureWindow(gridStart, addDays(gridStart, 42));
    body.innerHTML = renderMonth(model, cal, ui.anchor, ui.selected);
    body.classList.add('pannable');
    return;
  }
  body.classList.remove('pannable');
  const old = body.querySelector('.week-scroll');
  // Position in Tagen merken (nicht in Pixeln – die Spaltenbreite kann sich geändert haben)
  const keep = !jump && old ? { start: old.dataset.start, days: old.scrollLeft / colw } : null;
  const start = addDays(startOfWeek(ui.anchor), -7 * WEEKS_AROUND);
  colw = computeColWidth();
  cal.ensureWindow(start, addDays(start, STRIP_DAYS));
  body.innerHTML = renderWeek(model, cal, start, STRIP_DAYS, ui.selected);
  const sc = body.querySelector('.week-scroll');
  sc.style.setProperty('--colw', `${colw}px`);
  sc.scrollLeft = (keep ? keep.days + daysBetween(start, keep.start) : daysBetween(start, ui.anchor)) * colw;
  updateWeekTitle(sc);
  sc.addEventListener('scroll', onWeekScroll, { passive: true });
}

// Spaltenbreite anpassen, wenn sich die Kalenderbreite ändert (Fenster, Liste ein-/ausklappen, Trenner)
function watchCalendarWidth() {
  new ResizeObserver(() => {
    const sc = $('#cal-body .week-scroll');
    if (!sc) return;
    const first = Math.round(sc.scrollLeft / colw);
    colw = computeColWidth();
    sc.style.setProperty('--colw', `${colw}px`);
    sc.scrollLeft = first * colw;
  }).observe($('#cal-body'));
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

// Zeiger an ein Element binden, damit Ziehen auch außerhalb weiterläuft
function capture(el, pointerId) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Zeiger schon wieder weg – dann eben ohne
  }
}

// ---------- Liste einklappen & Breite ----------

function applyListLayout() {
  const app = $('#app');
  app.classList.toggle('collapsed', ui.collapsed);
  if (ui.listWidth) {
    app.style.setProperty('--list-w', `${ui.listWidth}px`);
    app.style.setProperty('--cal-w', '1fr');
  }
}

function setupListLayout() {
  applyListLayout();
  $('#btn-collapse').addEventListener('click', () => {
    ui.collapsed = true;
    applyListLayout();
    savePrefs();
  });
  $('#btn-expand').addEventListener('click', () => {
    ui.collapsed = false;
    applyListLayout();
    savePrefs();
  });

  // Trenner ziehen = Breite der Liste ändern
  const splitter = $('#splitter');
  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    capture(splitter, e.pointerId);
    splitter.classList.add('active');
    document.body.classList.add('resizing');
    const app = $('#app').getBoundingClientRect();
    const move = (ev) => {
      ui.listWidth = Math.round(Math.max(220, Math.min(ev.clientX - app.left - 12, app.width - 24 - 12 - 360)));
      applyListLayout();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      splitter.classList.remove('active');
      document.body.classList.remove('resizing');
      savePrefs();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

// ---------- Kalender-Status oben rechts ----------

function ago(ms) {
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  return `vor ${Math.floor(min / 60)} h`;
}

function renderCalStatus() {
  const box = $('#cal-status');
  box.hidden = !cal.anyEnabled();
  if (box.hidden) return;
  $('#btn-cal-refresh').classList.toggle('spinning', cal.refreshing);
  const text = $('#cal-status-text');
  const g = cal.googleState();
  const errors = cal.errors();
  text.title = errors.map((e) => `${e.name}: ${e.error}`).join('\n');
  if (g === 'expired' || g === 'disconnected') {
    text.innerHTML = `<a href="#" data-google-connect>Google ${g === 'expired' ? 'neu verbinden' : 'verbinden'}</a>`;
  } else if (cal.refreshing) {
    text.textContent = 'Kalender …';
  } else if (errors.length) {
    text.innerHTML = `<span class="cal-error">⚠ Kalender</span>`;
  } else {
    text.textContent = cal.lastRefresh ? `Kalender ${ago(cal.lastRefresh)}` : '';
  }
}

// Google-Anmeldung muss direkt aus dem Klick heraus starten
function connectGoogle(after) {
  Google.connect()
    .then(() => {
      after?.();
      cal.refresh();
    })
    .catch((e) => alert(`Google: ${e.message}`))
    .finally(renderCalStatus);
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

// Monat: beim Ziehen kurz am linken/rechten Kalenderrand verweilen = blättern
const flip = { dir: 0, timer: null };

function edgeFlip(payload, point) {
  const body = $('#cal-body');
  const r = body.getBoundingClientRect();
  const sc = body.querySelector('.week-scroll');
  let dir = 0;
  // nur im Monat; die Woche scrollt beim Ziehen am Rand von selbst weiter
  if (payload && ui.view === 'month' && point.y > r.top && point.y < r.bottom) {
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

// Woche: mit der Maus seitlich ziehen = fließend scrollen (Touch und Trackpad scrollen ohnehin nativ).
// Monat: ziehen oder wischen = blättern.
function setupPan() {
  const body = $('#cal-body');
  let pan = null;
  const swallow = (e) => e.stopPropagation();

  body.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-drag], [data-nodrag], button, input, a')) return;
    const sc = body.querySelector('.week-scroll');
    if (sc && e.pointerType !== 'mouse') return;
    if (!sc && !body.classList.contains('pannable')) return;
    pan = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false, sc, left: sc?.scrollLeft };
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
      capture(body, e.pointerId);
      body.classList.add('panning');
    }
    if (pan.sc) pan.sc.scrollLeft = pan.left - dx;
    else body.firstElementChild.style.transform = `translateX(${dx}px)`;
  });
  const finish = (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    const p = pan;
    pan = null;
    if (!p.active) return;
    body.classList.remove('panning');
    addEventListener('click', swallow, { capture: true });
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
    if (p.sc) {
      // an der nächsten Tagesgrenze einrasten
      p.sc.scrollTo({ left: Math.round(p.sc.scrollLeft / colw) * colw, behavior: 'smooth' });
      return;
    }
    const dx = e.clientX - p.x;
    const content = body.firstElementChild;
    content.style.transform = '';
    if (e.type === 'pointerup' && Math.abs(dx) > Math.min(120, body.clientWidth * 0.2)) slide(dx < 0 ? 1 : -1);
    else content.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
  };
  body.addEventListener('pointerup', finish);
  body.addEventListener('pointercancel', finish);

  // Monat: auf dem Trackpad seitlich wischen = blättern
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

// Dauer eines Termins im Raster am unteren Rand ziehen:
// der Block folgt dem Zeiger fließend, die Uhrzeit zeigt das auf 15 min gerundete Ende, beim Loslassen rastet er ein
function startResize(e, id) {
  e.preventDefault();
  e.stopPropagation();
  const b = model.booking(id);
  const handle = e.target.closest('[data-resize]');
  const block = handle.closest('.block');
  const r = range(model.settings());
  const mpp = minutesPerPx(block.closest('.wday-grid'), r);
  const startY = e.clientY;
  const startMin = b.minutes;
  const s0 = fromHHMM(b.start);
  const maxMin = 24 * 60 - s0;
  const top = Math.min(Math.max(percentOf(s0, r), 0), 97);
  const heightFor = (min) => `${Math.max(Math.min(percentOf(s0 + min, r), 100) - top, 3)}%`;
  let minutes = startMin;
  ui.busy = true; // währenddessen nicht neu zeichnen, sonst reißt der Block ab
  capture(handle, e.pointerId);
  block.classList.add('resizing');
  document.body.classList.add('resizing-block');

  const move = (ev) => {
    const raw = Math.max(15, Math.min(maxMin, startMin + (ev.clientY - startY) * mpp));
    minutes = Math.max(15, Math.min(maxMin, Math.round(raw / 15) * 15));
    block.style.height = heightFor(raw);
    block.querySelector('.block-time').textContent = `${b.start}–${toHHMM(s0 + minutes)} · ${fmtDuration(minutes)}`;
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    block.style.height = heightFor(minutes);
    block.classList.remove('resizing');
    document.body.classList.remove('resizing-block');
    // den Klick nach dem Loslassen verschlucken, sonst öffnet sich das Termin-Fenster
    const swallow = (ev) => ev.stopPropagation();
    addEventListener('click', swallow, { capture: true });
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
    ui.busy = false;
    if (minutes !== startMin) model.updateBooking(id, { minutes });
    else if (ui.renderPending) render();
    ui.renderPending = false;
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

// ---------- Popover (Termin, Kapazität) ----------

const popover = $('#popover');

function openPopover(anchorEl, html, wire) {
  popover.innerHTML = `<button type="button" class="close-x" data-close title="Schließen" aria-label="Schließen">×</button>${html}`;
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
  quickPreview.remove();
}

// ---------- Aufgabe direkt im Kalender anlegen ----------

const quickPreview = document.createElement('div');
quickPreview.className = 'drop-preview';

// Klick auf eine freie Stelle: im Stundenraster mit Uhrzeit, im Reservierungsbereich ohne
function openQuickAdd(e, date, grid) {
  const minutes = model.settings().defaultMinutes;
  let start = null;
  if (grid) {
    const r = range(model.settings());
    const rect = grid.getBoundingClientRect();
    const raw = r.from + ((e.clientY - rect.top) / rect.height) * (r.to - r.from);
    start = Math.max(r.from, Math.min(Math.floor(raw / 15) * 15, r.to - 15));
  }
  const showPreview = (min) => {
    if (start === null) return;
    const r = range(model.settings());
    quickPreview.textContent = `${toHHMM(start)}–${toHHMM(Math.min(start + min, 24 * 60))}`;
    quickPreview.style.cssText = `top:${percentOf(start, r)}%;height:${Math.min(percentOf(start + min, r), 100) - percentOf(start, r)}%`;
    grid.append(quickPreview);
  };
  const anchor = { getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) };
  openPopover(
    anchor,
    `<div class="pop-title">Neue Aufgabe · ${weekdayShort(date)} ${fmtDate(date)} · ${start === null ? 'reservieren' : toHHMM(start)}</div>
     <form class="quick-add">
       <input name="title" placeholder="Titel" aria-label="Titel" autocomplete="off">
       <div class="pop-row">
         <input name="dur" value="${fmtHours(minutes)}" aria-label="Dauer in Stunden" title="Dauer in Stunden, z. B. 1,5 oder 1:30"><span>h</span>
         <span class="filter-spacer"></span>
         <button class="primary">Anlegen</button>
       </div>
     </form>`,
    (p) => {
      const form = p.querySelector('form');
      showPreview(minutes);
      form.dur.addEventListener('input', () => {
        const min = parseDuration(form.dur.value);
        if (min > 0) showPreview(min);
      });
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const title = form.title.value.trim();
        const min = parseDuration(form.dur.value);
        form.title.classList.toggle('invalid', !title);
        form.dur.classList.toggle('invalid', !(min > 0));
        if (!title || !(min > 0)) return;
        const task = model.addTask(title);
        model.plan(task.id, date, start === null ? null : toHHMM(start), min);
        closePopover();
      });
      form.title.focus();
    },
  );
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

// Schätzung aus einem Eingabefeld: Minuten, null (leer) oder undefined (ungültig, Feld wird markiert)
function estimateFrom(input) {
  const text = input.value.trim();
  input.classList.remove('invalid');
  if (!text) return null;
  const min = parseDuration(text);
  if (!(min > 0)) {
    input.classList.add('invalid');
    input.focus();
    return undefined;
  }
  return min;
}

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
  f.estimate.value = task.estimateMinutes ? fmtHours(task.estimateMinutes) : '';
  f.estimate.classList.remove('invalid');
  $('#tag-list').innerHTML = model.tags().map((t) => `<option value="${esc(t)}">`).join('');
  renderTaskDetails();
  $('#task-dialog').showModal();
}

function renderTaskDetails() {
  const task = model.task(editingId);
  if (!task) return;
  $('#task-colors').innerHTML = TASK_COLORS.map(
    (c) => `<button type="button" class="${(task.color || null) === c.key ? 'on' : ''}" style="--swatch:${c.hex}" data-color="${c.key ?? ''}" title="${c.name}" aria-label="${c.name}"></button>`,
  ).join('');
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
    ? `<div class="pop-label">Im Kalender · ${fmtHours(total)} h${
        task.estimateMinutes > 0 ? ` <span class="badge ${estimateInfo(total, task.estimateMinutes).cls}">${Math.round((total / task.estimateMinutes) * 100)} % von ${fmtHours(task.estimateMinutes)} h geschätzt</span>` : ''
      }</div>
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
    ...(() => {
      const estimate = estimateFrom(f.estimate);
      return estimate === undefined ? {} : { estimateMinutes: estimate }; // ungültige Eingabe: alten Wert behalten
    })(),
  });
  renderTaskDetails();
}

// Archivieren / Wiederherstellen / Löschen direkt in der Liste: erster Klick zeigt "?", zweiter führt aus
let disarmTimer = null;

function taskAction(id, act) {
  clearTimeout(disarmTimer);
  const confirmed = ui.armed?.id === id && ui.armed.act === act;
  ui.armed = confirmed ? null : { id, act };
  if (confirmed) {
    if (act === 'delete') model.deleteTask(id);
    else model.updateTask(id, { archivedAt: act === 'archive' ? new Date().toISOString() : null });
  } else {
    disarmTimer = setTimeout(() => {
      ui.armed = null;
      render();
    }, 3000);
  }
  render();
}

// ---------- Einstellungen ----------

let calDraft = null; // Kalender-Einstellungen, bis "Speichern" gedrückt wird

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#db2777', '#65a30d'];

function openSettings() {
  const s = model.settings();
  const f = $('#settings-form');
  f.defaultMinutes.value = s.defaultMinutes;
  f.coreStart.value = s.coreStart;
  f.coreEnd.value = s.coreEnd;
  $('#weekday-caps').innerHTML = WEEKDAYS.map(
    (d, i) => `<label>${d}<input type="number" name="cap${i}" min="0" max="24" step="0.25" value="${s.weekdayCapacity[i] / 60}"></label>`,
  ).join('');
  calDraft = calSettings(s);
  f.refreshMinutes.value = calDraft.refreshMinutes;
  f.googleEnabled.checked = calDraft.google.enabled;
  f.icalEnabled.checked = calDraft.ical.enabled;
  renderCalSettings();
  if (calDraft.google.enabled && Google.token()) loadGoogleCalendars();
  $('#btn-disconnect').hidden = !!localDevice;
  $('#settings-dialog').showModal();
}

function calRow(key, { name, color, show, count }, extra = '') {
  const error = cal.errorFor(key);
  return `
    <div class="cal-row" data-key="${esc(key)}">
      <div class="cal-row-main">
        ${extra || `<span class="cal-dot" style="background:${esc(color || '#64748b')}"></span><span class="cal-name">${esc(name)}</span>`}
      </div>
      <label class="check"><input type="checkbox" data-field="show" ${show ? 'checked' : ''}> anzeigen</label>
      <label class="check" title="Termine, die als „beschäftigt“ markiert sind, belegen Kapazität; ganztägige die ganze Tageskapazität"><input type="checkbox" data-field="count" ${count ? 'checked' : ''}> zählt mit</label>
      ${error ? `<div class="cal-row-error">⚠ ${esc(error)}</div>` : ''}
    </div>`;
}

function renderCalSettings() {
  // Google
  const g = $('#google-settings');
  g.hidden = !calDraft.google.enabled;
  if (!g.hidden) {
    const state = Google.token() ? 'ok' : Google.known() ? 'expired' : 'disconnected';
    const status =
      state === 'ok'
        ? `Verbunden${Google.email() ? ` als <b>${esc(Google.email())}</b>` : ''} <button type="button" data-g-act="reload">Kalender neu laden</button> <button type="button" data-g-act="disconnect">Trennen</button>`
        : state === 'expired'
          ? `Anmeldung abgelaufen. <button type="button" class="primary" data-g-act="connect">Neu verbinden</button>`
          : `<button type="button" class="primary" data-g-act="connect">Mit Google verbinden</button> <small>Die Anmeldung gilt nur für diesen Browser.</small>`;
    const cals = Object.entries(calDraft.google.calendars).sort(([, a], [, b]) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || a.name.localeCompare(b.name, 'de'));
    g.innerHTML = `
      <div class="cal-status-line">${status}</div>
      ${cals.length ? cals.map(([id, c]) => calRow(`g:${id}`, c)).join('') : '<p class="hint">Nach dem Verbinden erscheinen hier deine Google-Kalender.</p>'}`;
  }
  // iCal
  const i = $('#ical-settings');
  i.hidden = !calDraft.ical.enabled;
  if (!i.hidden) {
    i.innerHTML = `
      ${calDraft.ical.feeds
        .map((f) =>
          calRow(
            `i:${f.id}`,
            f,
            `<input type="color" data-field="color" value="${esc(f.color)}" title="Farbe">
             <input data-field="name" value="${esc(f.name)}" placeholder="Name" class="cal-name-input">
             <input data-field="url" value="${esc(f.url)}" placeholder="https://… oder webcal://…" class="cal-url-input">
             <button type="button" class="close-x inline-x" data-ical-remove title="Entfernen">×</button>`,
          ),
        )
        .join('')}
      <button type="button" data-ical-add>+ Kalender-Abo hinzufügen</button>
      <p class="hint">Abo-Adresse z. B. aus Google („Privatadresse im iCal-Format“), Apple iCloud (Kalender teilen → „Öffentlicher Kalender“) oder Outlook („Kalender veröffentlichen“).</p>`;
  }
}

async function loadGoogleCalendars() {
  try {
    const list = await Google.calendars();
    const next = {};
    for (const c of list) {
      const old = calDraft.google.calendars[c.id];
      // neue Kalender: anzeigen, wenn sie auch in Google angezeigt werden; mitzählen nur auf Wunsch
      next[c.id] = { name: c.name, color: c.color, primary: c.primary, show: old ? old.show : c.selected, count: old ? old.count : false };
    }
    calDraft.google.calendars = next;
  } catch (e) {
    alert(e.message);
  }
  renderCalSettings();
}

function wireCalSettings() {
  const f = $('#settings-form');
  f.googleEnabled.addEventListener('change', () => {
    calDraft.google.enabled = f.googleEnabled.checked;
    if (calDraft.google.enabled) preloadGoogle().catch(() => {}); // damit der erste Klick auf "Verbinden" klappt
    renderCalSettings();
    if (calDraft.google.enabled && Google.token() && !Object.keys(calDraft.google.calendars).length) loadGoogleCalendars();
  });
  f.icalEnabled.addEventListener('change', () => {
    calDraft.ical.enabled = f.icalEnabled.checked;
    if (calDraft.ical.enabled && !calDraft.ical.feeds.length) addFeed();
    renderCalSettings();
  });
  const addFeed = () =>
    calDraft.ical.feeds.push({
      id: Date.now().toString(36),
      name: `Kalender ${calDraft.ical.feeds.length + 1}`,
      url: '',
      color: PALETTE[calDraft.ical.feeds.length % PALETTE.length],
      show: true,
      count: false,
    });

  const box = $('.cal-settings');
  box.addEventListener('click', (e) => {
    const act = e.target.closest('[data-g-act]')?.dataset.gAct;
    if (act === 'connect') connectGoogle(loadGoogleCalendars);
    else if (act === 'reload') loadGoogleCalendars();
    else if (act === 'disconnect') {
      Google.disconnect();
      renderCalSettings();
      renderCalStatus();
    } else if (e.target.closest('[data-ical-add]')) {
      addFeed();
      renderCalSettings();
    } else if (e.target.closest('[data-ical-remove]')) {
      const key = e.target.closest('.cal-row').dataset.key;
      calDraft.ical.feeds = calDraft.ical.feeds.filter((x) => `i:${x.id}` !== key);
      renderCalSettings();
    }
  });
  // Eingaben in den Kalenderzeilen in den Entwurf übernehmen
  box.addEventListener('input', (e) => {
    const field = e.target.dataset.field;
    const key = e.target.closest('.cal-row')?.dataset.key;
    if (!field || !key) return;
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    const target = key.startsWith('g:') ? calDraft.google.calendars[key.slice(2)] : calDraft.ical.feeds.find((x) => `i:${x.id}` === key);
    if (target) target[field] = value;
  });
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
    calendars: {
      refreshMinutes: Math.max(1, Math.round(Number(f.refreshMinutes.value) || 5)),
      google: calDraft.google,
      ical: { ...calDraft.ical, feeds: calDraft.ical.feeds.filter((x) => x.url.trim()).map((x) => ({ ...x, url: x.url.trim() })) },
    },
  });
}

// ---------- Ereignisse ----------

function navigate(dir) {
  if (dir === 0) {
    ui.anchor = ui.view === 'week' ? startOfWeek(today()) : today();
    ui.selected = null;
    return renderCalendar({ jump: true });
  }
  if (ui.view === 'week') {
    $('#cal-body .week-scroll').scrollBy({ left: dir * 7 * colw, behavior: 'smooth' });
    return;
  }
  ui.anchor = addMonths(ui.anchor, dir);
  renderCalendar();
}

function wireEvents() {
  $('#new-task').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = e.target.title.value.trim();
    if (!title) return;
    const estimate = estimateFrom(e.target.estimate);
    if (estimate === undefined) return;
    ui.filter.archive = false;
    model.addTask(title, estimate);
    e.target.reset();
    e.target.title.focus();
  });

  document.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      if (ui.view === b.dataset.view) return;
      ui.view = b.dataset.view;
      if (ui.view === 'week') {
        // aus dem Monat: Woche von heute, falls der Monat heute enthält, sonst erste Woche des Monats
        ui.anchor = startOfWeek(ui.anchor.slice(0, 7) === today().slice(0, 7) ? today() : ui.anchor);
      }
      savePrefs();
      renderCalendar({ jump: true });
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
    const act = e.target.closest('[data-task-act]');
    if (act) return taskAction(act.dataset.id, act.dataset.taskAct);
    const cap = e.target.closest('[data-cap]');
    if (cap) return openCapacityPopover(cap, cap.dataset.cap);
    const booking = e.target.closest('[data-booking]');
    if (booking) return openBookingPopover(booking, booking.dataset.booking);
    const task = e.target.closest('[data-open-task]');
    if (task) return openTask(task.dataset.openTask);
    // freie Stelle im Kalender: Aufgabe direkt anlegen
    if (!e.target.closest('.block, .ext-event, .chip-booking, .ext-allday-list')) {
      const grid = e.target.closest('.wday-grid');
      if (grid) return openQuickAdd(e, grid.dataset.date, grid);
      const reserved = e.target.closest('.wday-head .reserved');
      if (reserved) return openQuickAdd(e, reserved.closest('.wday-head').dataset.date, null);
    }
    const goto = e.target.closest('[data-goto-week]');
    if (goto) {
      if ($('#task-dialog').open) $('#task-dialog').close();
      ui.view = 'week';
      ui.anchor = startOfWeek(goto.dataset.gotoWeek);
      ui.selected = goto.dataset.gotoWeek;
      savePrefs();
      renderCalendar({ jump: true });
    }
  });

  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-resize]');
    if (handle) startResize(e, handle.dataset.resize);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopover();
  });

  // Kleines × oben rechts: Popover bzw. Dialog schließen (Einstellungen ohne Speichern)
  document.addEventListener('click', (e) => {
    const x = e.target.closest('[data-close]');
    if (!x) return;
    e.stopPropagation();
    if (popover.contains(x)) return closePopover();
    x.closest('dialog')?.close('cancel');
  }, true);

  // Aufgabendialog: Änderungen sofort speichern
  const form = $('#task-form');
  form.addEventListener('change', saveTaskForm);
  $('#task-dialog').addEventListener('close', () => {
    saveTaskForm();
    editingId = null;
  });
  // Farbe wählen: sofort speichern
  $('#task-colors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b || !editingId) return;
    model.updateTask(editingId, { color: b.dataset.color || null });
    renderTaskDetails();
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
  wireCalSettings();
  $('#btn-cal-refresh').addEventListener('click', () => cal.refresh());
  $('#cal-status').addEventListener('click', (e) => {
    if (!e.target.closest('[data-google-connect]')) return;
    e.preventDefault();
    connectGoogle();
  });
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
