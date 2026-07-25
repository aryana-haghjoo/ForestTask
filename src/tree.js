/* tree.js — dependency-free horizontal tidy-tree layout + SVG renderer.
   Kept separate from app state so it can be reused or swapped out. */
'use strict';

const NS = 'http://www.w3.org/2000/svg';
const ROW = 30;        // vertical pitch between sibling leaves
const PROJECT_GAP = 22; // extra breathing room between project branches
const COLS = [0, 190, 470]; // base x per depth: root, project, task
const CHAR_W = 8.4;         // rough advance width of the 14px project label

const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

/* ---------- date helpers ---------- */
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

function dueInfo(due) {
  if (!due) return null;
  const d = new Date(due + 'T00:00:00');
  if (isNaN(d)) return null;
  const diff = Math.round((d - startOfToday()) / 86400000);
  if (diff < 0) return { kind: 'overdue', diff, label: diff === -1 ? '1 day overdue' : `${-diff} days overdue` };
  if (diff === 0) return { kind: 'soon', diff, label: 'due today' };
  if (diff <= 7) return { kind: 'soon', diff, label: `in ${diff}d` };
  return { kind: 'future', diff, label: `in ${diff}d` };
}

function statusColor(status) {
  return status === 'Done' ? 'var(--done)'
    : status === 'In progress' ? 'var(--progress)'
    : 'var(--notstarted)';
}

/* Colour a task node: due-date urgency overrides status, but never for Done. */
function taskVisual(task) {
  const di = dueInfo(task.due);
  if (task.status !== 'Done' && di) {
    if (di.kind === 'overdue') return { fill: 'var(--overdue)', glow: true, di };
    if (di.kind === 'soon') return { fill: 'var(--soon)', glow: true, di };
  }
  return { fill: statusColor(task.status), glow: false, di };
}

/* ---------- hierarchy + layout ---------- */

/* Build the render tree from app data, applying search / hide-done filters. */
function buildHierarchy(data, opts = {}) {
  const q = (opts.query || '').trim().toLowerCase();
  const hideDone = !!opts.hideDone;
  const collapsed = opts.collapsed || new Set();

  const projects = data.projects.map(p => {
    let tasks = p.tasks.filter(t => {
      if (hideDone && t.status === 'Done') return false;
      if (q && !(t.name.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))) return false;
      return true;
    });
    return {
      id: p.id, type: 'project', name: p.name, ref: p,
      collapsed: collapsed.has(p.id),
      totalTasks: p.tasks.length,
      doneTasks: p.tasks.filter(t => t.status === 'Done').length,
      children: tasks.map(t => ({ id: t.id, type: 'task', name: t.name, ref: t, proj: p, children: [] }))
    };
  }).filter(p => {
    if (!q) return true;
    return p.children.length > 0 || p.name.toLowerCase().includes(q);
  });

  return { id: '__root__', type: 'root', name: 'My Work', children: projects };
}

/* Assign x/y. Leaves stack downward; parents centre on their children.
   The task column is pushed right far enough to clear the widest project
   pill, so long project names never collide with their tasks. */
function layout(root) {
  let cursor = 0;
  const all = [];

  const longest = root.children.reduce((m, p) => Math.max(m, p.name.length), 0);
  const taskCol = Math.max(COLS[2], COLS[1] + longest * CHAR_W + 56);

  (function walk(node, depth) {
    node.depth = depth;
    node.x = depth >= 2 ? taskCol : COLS[depth];
    all.push(node);

    const kids = node.collapsed ? [] : (node.children || []);
    if (kids.length === 0) {
      node.y = cursor;
      cursor += ROW;
    } else {
      kids.forEach(k => walk(k, depth + 1));
      node.y = (kids[0].y + kids[kids.length - 1].y) / 2;
      if (depth === 1) cursor += PROJECT_GAP;
    }
  })(root, 0);

  return all;
}

function linkPath(s, t) {
  const mx = (s.x + t.x) / 2;
  return `M${s.x},${s.y}C${mx},${s.y} ${mx},${t.y} ${t.x},${t.y}`;
}

/* ---------- renderer ---------- */

class TreeView {
  constructor(svg, handlers) {
    this.svg = svg;
    this.handlers = handlers; // { onSelect(node), onToggle(projectId) }
    this.g = el('g');
    this.linkLayer = el('g');
    this.nodeLayer = el('g');
    this.g.appendChild(this.linkLayer);
    this.g.appendChild(this.nodeLayer);
    this.svg.appendChild(this.g);
    this.t = { x: 80, y: 60, k: 1 };
    this._installPanZoom();
  }

  _applyTransform() {
    this.g.setAttribute('transform', `translate(${this.t.x},${this.t.y}) scale(${this.t.k})`);
  }

  _installPanZoom() {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;

    this.svg.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; ox = this.t.x; oy = this.t.y;
      this.svg.classList.add('grabbing');
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      this.t.x = ox + dx; this.t.y = oy + dy;
      this._applyTransform();
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      this.svg.classList.remove('grabbing');
    });
    this.svg.addEventListener('click', e => {
      if (moved) return;
      if (e.target === this.svg) this.handlers.onSelect(null);
    });

    this.svg.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      // Trackpad pinch arrives as ctrlKey+wheel; plain wheel scrolls the canvas.
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        this._zoomAt(mx, my, factor);
      } else {
        this.t.x -= e.deltaX; this.t.y -= e.deltaY;
        this._applyTransform();
      }
    }, { passive: false });
  }

  _zoomAt(mx, my, factor) {
    const k = Math.max(0.25, Math.min(2.5, this.t.k * factor));
    const real = k / this.t.k;
    this.t.x = mx - (mx - this.t.x) * real;
    this.t.y = my - (my - this.t.y) * real;
    this.t.k = k;
    this._applyTransform();
  }

  render(data, opts) {
    const root = buildHierarchy(data, opts);
    const nodes = layout(root);
    const selectedId = opts.selectedId;

    this.linkLayer.textContent = '';
    this.nodeLayer.textContent = '';

    // links
    for (const n of nodes) {
      const kids = n.collapsed ? [] : (n.children || []);
      for (const k of kids) {
        const p = el('path', { class: 'link' + (selectedId && (k.id === selectedId || n.id === selectedId) ? ' hot' : ''), d: linkPath(n, k) });
        this.linkLayer.appendChild(p);
      }
    }

    // nodes
    for (const n of nodes) {
      const gEl = el('g', {
        class: 'node ' + n.type + (n.id === selectedId ? ' sel' : ''),
        transform: `translate(${n.x},${n.y})`
      });

      if (n.type === 'root') {
        gEl.appendChild(el('circle', { r: 7, fill: 'var(--accent)' }));
        const t = el('text', { class: 'label', x: 15, 'font-weight': '700' });
        t.textContent = n.name;
        gEl.appendChild(t);

      } else if (n.type === 'project') {
        const box = el('rect', { class: 'box', x: -8, y: -15, rx: 9, height: 30, fill: 'var(--panel2)', stroke: 'var(--line)' });
        gEl.appendChild(box);
        const t = el('text', { class: 'label', x: 20, y: -4 });
        t.textContent = n.name;
        gEl.appendChild(t);
        const sub = el('text', { class: 'sub', x: 20, y: 8 });
        sub.textContent = `${n.doneTasks}/${n.totalTasks} done`;
        gEl.appendChild(sub);

        const chev = el('text', { class: 'chev', x: 4, y: 1 });
        chev.textContent = n.collapsed ? '▶' : '▼';
        chev.addEventListener('click', ev => { ev.stopPropagation(); this.handlers.onToggle(n.id); });
        gEl.appendChild(chev);

        gEl.addEventListener('click', ev => { ev.stopPropagation(); this.handlers.onSelect(n); });
        this.nodeLayer.appendChild(gEl);
        // width needs the text in the DOM to measure
        const w = Math.max(t.getComputedTextLength(), sub.getComputedTextLength()) + 34;
        box.setAttribute('width', w);
        continue;

      } else { // task
        const v = taskVisual(n.ref);
        if (v.glow) {
          gEl.appendChild(el('circle', { r: 11, fill: v.fill, opacity: .22 }));
        }
        gEl.appendChild(el('circle', { class: 'knob', r: 6.5, fill: v.fill }));

        const done = n.ref.status === 'Done';
        const t = el('text', {
          class: 'label', x: 16, y: v.di ? -5 : 0,
          fill: done ? 'var(--muted)' : 'var(--text)'
        });
        if (done) t.setAttribute('text-decoration', 'line-through');
        t.textContent = n.name;
        gEl.appendChild(t);

        if (v.di) {
          const sub = el('text', { class: 'sub', x: 16, y: 8 });
          // A finished task is never late — show its date plainly.
          sub.setAttribute('fill', done ? 'var(--muted)'
            : v.di.kind === 'overdue' ? 'var(--overdue)'
            : v.di.kind === 'soon' ? 'var(--soon)' : 'var(--muted)');
          sub.textContent = done ? n.ref.due : `${n.ref.due} · ${v.di.label}`;
          gEl.appendChild(sub);
        }
        gEl.addEventListener('click', ev => { ev.stopPropagation(); this.handlers.onSelect(n); });
      }

      this.nodeLayer.appendChild(gEl);
    }

    this._lastBBox = null;
  }

  fit() {
    const b = this.g.getBBox();
    if (!b.width || !b.height) return;
    const w = this.svg.clientWidth, h = this.svg.clientHeight;
    const k = Math.max(0.25, Math.min(1.6, 0.92 / Math.max(b.width / w, b.height / h)));
    this.t.k = k;
    this.t.x = w / 2 - k * (b.x + b.width / 2);
    this.t.y = h / 2 - k * (b.y + b.height / 2);
    this._applyTransform();
  }
}

window.TreeKit = { TreeView, dueInfo, statusColor };
