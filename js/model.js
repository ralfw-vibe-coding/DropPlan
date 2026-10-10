// Fachlogik: Aufgaben, Einplanungen, Tageskapazität, Einstellungen.
//
// Dateien im App-Ordner:
//   /tasks/<id>.json      eine Aufgabe (Titel, Notiz, Tags, Deadline, Wiedervorlage, aktiv/archiviert)
//   /bookings/<id>.json   eine Einplanung einer Aufgabe an einem Tag (Dauer, optional Uhrzeit)
//   /days/<datum>.json    abweichende Kapazität für einen Tag (nur wenn geändert)
//   /settings.json        Einstellungen für alle Geräte

import { weekdayIndex } from './dates.js';

export const DEFAULT_SETTINGS = {
  defaultMinutes: 30,
  weekdayCapacity: [480, 480, 480, 480, 480, 0, 0], // Mo..So in Minuten
  coreStart: 8,
  coreEnd: 18,
};

// Reihenfolge in der Liste: kleiner = weiter oben. Ältere Aufgaben ohne "order" nach Anlagezeit (neueste oben).
export const sortKey = (task) => task.order ?? -Date.parse(task.createdAt) / 1e6;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const now = () => new Date().toISOString();

export class Model {
  constructor(store) {
    this.store = store;
  }

  // ---- Lesen ----

  settings() {
    return { ...DEFAULT_SETTINGS, ...this.store.get('/settings.json') };
  }

  tasks() {
    return this.store.list('/tasks/');
  }

  task(id) {
    return this.store.get(`/tasks/${id}.json`);
  }

  bookings() {
    return this.store.list('/bookings/');
  }

  booking(id) {
    return this.store.get(`/bookings/${id}.json`);
  }

  bookingsOn(date) {
    return this.bookings().filter((b) => b.date === date);
  }

  bookingsOf(taskId) {
    return this.bookings()
      .filter((b) => b.taskId === taskId)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  capacity(date) {
    const day = this.store.get(`/days/${date}.json`);
    return day ? day.capacityMinutes : this.settings().weekdayCapacity[weekdayIndex(date)];
  }

  // Auslastung eines Tages
  // Auslastung eines Tages; calendarMinutes(capacity) liefert die von Kalenderterminen belegte Zeit
  load(date, bookings = this.bookingsOn(date), calendarMinutes = () => 0) {
    const planned = bookings.reduce((sum, b) => sum + b.minutes, 0);
    const capacity = this.capacity(date);
    const external = calendarMinutes(capacity);
    const minutes = planned + external;
    const ratio = capacity > 0 ? minutes / capacity : minutes > 0 ? Infinity : 0;
    return { minutes, planned, external, capacity, count: bookings.length, ratio };
  }

  tags() {
    const all = new Set();
    for (const t of this.tasks()) for (const tag of t.tags || []) all.add(tag);
    return [...all].sort((a, b) => a.localeCompare(b, 'de'));
  }

  // ---- Aufgaben ----

  addTask(title) {
    const keys = this.tasks().map(sortKey);
    const task = {
      id: newId(),
      order: (keys.length ? Math.min(...keys) : 0) - 1,
      title,
      notes: '',
      tags: [],
      deadline: null,
      followUp: null,
      createdAt: now(),
      activatedAt: null,
      archivedAt: null,
    };
    this.store.put(`/tasks/${task.id}.json`, task);
    return task;
  }

  updateTask(id, patch) {
    const task = this.task(id);
    if (task) this.store.put(`/tasks/${id}.json`, { ...task, ...patch });
  }

  // Aufgabe in der Liste zwischen zwei andere schieben (null = Anfang bzw. Ende)
  moveTask(id, beforeId, afterId) {
    const before = beforeId && this.task(beforeId);
    const after = afterId && this.task(afterId);
    let order;
    if (before && after) order = (sortKey(before) + sortKey(after)) / 2;
    else if (before) order = sortKey(before) + 1;
    else if (after) order = sortKey(after) - 1;
    else return;
    this.updateTask(id, { order });
  }

  deleteTask(id) {
    for (const b of this.bookingsOf(id)) this.store.remove(`/bookings/${b.id}.json`);
    this.store.remove(`/tasks/${id}.json`);
  }

  // ---- Einplanen ----

  // Aufgabe an einem Tag einplanen; start = "HH:MM" oder null (nur Zeit reservieren)
  plan(taskId, date, start = null) {
    const task = this.task(taskId);
    if (!task) return;
    const booking = {
      id: newId(),
      taskId,
      date,
      minutes: this.settings().defaultMinutes,
      start,
      createdAt: now(),
    };
    this.store.put(`/bookings/${booking.id}.json`, booking);
    if (!task.activatedAt) this.updateTask(taskId, { activatedAt: now() });
    return booking;
  }

  updateBooking(id, patch) {
    const b = this.booking(id);
    if (b) this.store.put(`/bookings/${id}.json`, { ...b, ...patch });
  }

  deleteBooking(id) {
    this.store.remove(`/bookings/${id}.json`);
  }

  // ---- Kapazität & Einstellungen ----

  setCapacity(date, minutes) {
    const path = `/days/${date}.json`;
    const standard = this.settings().weekdayCapacity[weekdayIndex(date)];
    if (minutes === standard) this.store.remove(path);
    else this.store.put(path, { date, capacityMinutes: minutes });
  }

  saveSettings(patch) {
    this.store.put('/settings.json', { ...this.settings(), ...patch });
  }
}
