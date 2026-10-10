// Aufgabenliste (linke Seite)

import { today, daysBetween, fmtDate, weekdayShort, fmtHours } from './dates.js';
import { sortKey } from './model.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function deadlineInfo(deadline) {
  const d = daysBetween(today(), deadline);
  if (d < 0) return { cls: 'dl-over', text: d === -1 ? 'seit gestern überfällig' : `${-d} Tage überfällig` };
  if (d === 0) return { cls: 'dl-today', text: 'heute fällig' };
  if (d === 1) return { cls: 'dl-soon', text: 'morgen fällig' };
  if (d === 2) return { cls: 'dl-soon', text: 'übermorgen fällig' };
  if (d <= 7) return { cls: 'dl-week', text: `fällig ${weekdayShort(deadline)} ${fmtDate(deadline)}` };
  return { cls: 'dl-later', text: `fällig ${fmtDate(deadline)}` };
}

// Aufgelaufene (eingeplante) Zeit im Vergleich zur Schätzung: bis 110 % grün, ab 200 % rot, dazwischen gelb
export function estimateInfo(spent, estimate) {
  const ratio = spent / estimate;
  const cls = ratio <= 1.1 ? 'est-g' : ratio >= 2 ? 'est-r' : 'est-y';
  return { cls, title: `${Math.round(ratio * 100)} % der geschätzten Dauer im Kalender eingeplant` };
}

export function visibleTasks(model, filter) {
  const t = today();
  return model
    .tasks()
    .filter((task) => {
      if (filter.state === 'active' && !task.activatedAt) return false;
      if (filter.state === 'passive' && task.activatedAt) return false;
      if (filter.archive) return !!task.archivedAt;
      if (task.archivedAt) return false;
      if (!filter.followUps && task.followUp && task.followUp > t) return false;
      return [...filter.tags].every((tag) => (task.tags || []).includes(tag));
    })
    .sort((a, b) => (filter.archive ? b.archivedAt.localeCompare(a.archivedAt) : sortKey(a) - sortKey(b)));
}

export function renderTaskFilters(model, filter) {
  const tags = model.tags();
  const t = today();
  const waiting = model.tasks().filter((x) => !x.archivedAt && x.followUp && x.followUp > t).length;
  const archived = model.tasks().filter((x) => x.archivedAt).length;
  return `
    ${tags.map((tag) => `<button class="chip tag ${filter.tags.has(tag) ? 'on' : ''}" data-filter-tag="${esc(tag)}">#${esc(tag)}</button>`).join('')}
    <span class="filter-spacer"></span>
    <button class="chip toggle ${filter.state === 'active' ? 'on' : ''}" data-filter-state="active" title="Nur Aufgaben, die schon im Kalender waren"><span class="state-dot on"></span>Aktiv</button>
    <button class="chip toggle ${filter.state === 'passive' ? 'on' : ''}" data-filter-state="passive" title="Nur Aufgaben, die noch nie eingeplant waren"><span class="state-dot"></span>Passiv</button>
    <button class="chip toggle ${filter.followUps ? 'on' : ''}" data-filter="followUps" title="Aufgaben mit späterer Wiedervorlage einblenden">Wiedervorlagen${waiting ? ` (${waiting})` : ''}</button>
    <button class="chip toggle ${filter.archive ? 'on' : ''}" data-filter="archive" title="Nur archivierte Aufgaben zeigen">Archiv${archived ? ` (${archived})` : ''}</button>`;
}

export function renderTaskList(model, filter) {
  const tasks = visibleTasks(model, filter);
  if (!tasks.length) {
    const text = filter.archive ? 'Keine archivierten Aufgaben.' : model.tasks().length ? 'Keine passenden Aufgaben.' : 'Keine Aufgaben. Oben eine neue anlegen.';
    return `<li class="empty">${text}</li>`;
  }
  const planned = new Map();
  for (const b of model.bookings()) planned.set(b.taskId, (planned.get(b.taskId) || 0) + b.minutes);
  const t = today();

  return tasks
    .map((task) => {
      const active = !!task.activatedAt;
      const meta = [];
      for (const tag of task.tags || []) meta.push(`<span class="tag-label">#${esc(tag)}</span>`);
      if (task.deadline) {
        const dl = deadlineInfo(task.deadline);
        meta.push(`<span class="badge ${dl.cls}">${dl.text}</span>`);
      }
      if (task.followUp && !task.archivedAt) {
        meta.push(
          task.followUp > t
            ? `<span class="badge wv-later">Wiedervorlage ${fmtDate(task.followUp)}</span>`
            : `<span class="badge wv-due">Wiedervorlage</span>`,
        );
      }
      const spent = planned.get(task.id) || 0;
      if (task.estimateMinutes > 0) {
        const e = estimateInfo(spent, task.estimateMinutes);
        meta.push(`<span class="badge ${e.cls}" title="${e.title}">${fmtHours(spent)} / ${fmtHours(task.estimateMinutes)} h</span>`);
      } else if (spent) meta.push(`<span class="planned">${fmtHours(spent)} h verplant</span>`);
      return `
        <li class="task ${active ? 'active' : 'passive'} ${task.archivedAt ? 'archived' : ''}"
            data-drag="task" data-id="${task.id}" data-label="${esc(task.title)}" data-open-task="${task.id}">
          <span class="state-dot" title="${active ? 'Aktiv – war schon im Kalender' : 'Passiv – noch nie eingeplant'}"></span>
          <div class="task-main">
            <div class="task-title">${esc(task.title)}</div>
            ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
          </div>
        </li>`;
    })
    .join('');
}
