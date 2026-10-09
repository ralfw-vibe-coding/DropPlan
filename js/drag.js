// Ziehen & Ablegen mit Pointer-Events (Maus und Touch).
// Ziehbare Elemente: [data-drag="task|booking"][data-id]. Ablageziele: [data-drop].
// Touch: erst nach kurzem Gedrückthalten, damit normales Scrollen weiter funktioniert.

const EDGE = 48;

export function setupDrag({ describe, onDrop }) {
  let pending = null;
  let drag = null;
  let last = { x: 0, y: 0 };

  function start() {
    const { el } = pending;
    const rect = el.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.innerHTML = `<div class="drag-title"></div><div class="drag-where"></div>`;
    ghost.querySelector('.drag-title').textContent = el.dataset.label || el.textContent.trim();
    document.body.append(ghost);
    document.body.classList.add('dragging');
    el.classList.add('drag-source');
    drag = {
      el,
      ghost,
      target: null,
      payload: { kind: el.dataset.drag, id: el.dataset.id, offsetY: el.dataset.drag === 'booking' && el.classList.contains('block') ? pending.y - rect.top : 0 },
    };
    clearTimeout(pending.timer);
    pending = null;
    move(last.x, last.y);
    requestAnimationFrame(autoscroll);
    navigator.vibrate?.(10);
  }

  function move(x, y) {
    last = { x, y };
    drag.ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
    const target = document.elementFromPoint(x, y)?.closest('[data-drop]') || null;
    if (target !== drag.target) {
      drag.target?.classList.remove('drop-hover');
      target?.classList.add('drop-hover');
      drag.target = target;
    }
    drag.ghost.querySelector('.drag-where').textContent = target ? describe(drag.payload, target, { x, y }) : '';
  }

  // Scrollbereiche am Rand automatisch mitscrollen lassen
  function autoscroll() {
    if (!drag) return;
    const under = document.elementFromPoint(last.x, last.y);
    for (let el = under; el && el !== document.body; el = el.parentElement) {
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
        if (last.y < r.top + EDGE) el.scrollTop -= 12;
        else if (last.y > r.bottom - EDGE) el.scrollTop += 12;
      }
      if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth) {
        if (last.x < r.left + EDGE) el.scrollLeft -= 12;
        else if (last.x > r.right - EDGE) el.scrollLeft += 12;
      }
    }
    requestAnimationFrame(autoscroll);
  }

  function end(drop) {
    if (drag) {
      const { payload, target } = drag;
      drag.ghost.remove();
      drag.el.classList.remove('drag-source');
      target?.classList.remove('drop-hover');
      document.body.classList.remove('dragging');
      drag = null;
      // den Klick, der direkt nach dem Loslassen folgt, verschlucken
      addEventListener('click', swallow, { capture: true });
      setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
      if (drop && target) onDrop(payload, target, last);
    }
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }
  const swallow = (e) => e.stopPropagation();

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-nodrag], button, input, textarea, select')) return;
    const el = e.target.closest('[data-drag]');
    if (!el) return;
    last = { x: e.clientX, y: e.clientY };
    pending = { el, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', timer: null };
    if (pending.touch) pending.timer = setTimeout(start, 350);
  });

  document.addEventListener('pointermove', (e) => {
    if (drag) return move(e.clientX, e.clientY);
    if (!pending) return;
    last = { x: e.clientX, y: e.clientY };
    const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
    if (dist > 6) {
      if (pending.touch) end(false); // Finger bewegt sich vor dem Halten: das ist Scrollen
      else start();
    }
  });

  document.addEventListener('pointerup', () => end(true));
  document.addEventListener('pointercancel', () => end(false));
  // Während des Ziehens auf Touch-Geräten das Scrollen der Seite verhindern
  document.addEventListener('touchmove', (e) => drag && e.preventDefault(), { passive: false });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && end(false));
}
