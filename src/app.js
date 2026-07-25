/* app.js — state, persistence, manual editing, and the shared op engine.
   The AI panel (ai.js) drives the exact same ops the UI buttons do, so a
   chat edit and a hand edit are indistinguishable to the data layer. */
'use strict';

const STATUSES = ['Not started', 'In progress', 'Done'];
const uid = p => p + '_' + Math.random().toString(36).slice(2, 9);

const State = {
  data: { version: 1, projects: [] },
  selectedId: null,
  collapsed: new Set(),
  hideDone: false,
  query: '',
  undoStack: []
};

let view = null;
let saveTimer = null;

/* ---------- persistence ---------- */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.data.save(State.data), 250);
}

function snapshot() {
  State.undoStack.push(JSON.stringify(State.data));
  if (State.undoStack.length > 50) State.undoStack.shift();
}

function undo() {
  const prev = State.undoStack.pop();
  if (!prev) return false;
  State.data = JSON.parse(prev);
  refresh();
  return true;
}

function refresh() {
  view.render(State.data, {
    query: State.query,
    hideDone: State.hideDone,
    collapsed: State.collapsed,
    selectedId: State.selectedId
  });
  renderProjectSelect();
  renderDetail();
  scheduleSave();
}

/* ---------- lookups ---------- */
const norm = s => (s || '').trim().toLowerCase();

function findProject(ref) {
  if (!ref) return null;
  const r = norm(ref);
  return State.data.projects.find(p => p.id === ref)
    || State.data.projects.find(p => norm(p.name) === r)
    || State.data.projects.find(p => norm(p.name).includes(r))
    || null;
}

function findTask(ref, projectRef) {
  if (!ref) return null;
  const r = norm(ref);
  const scope = projectRef ? [findProject(projectRef)].filter(Boolean) : State.data.projects;
  const hits = [];
  for (const p of scope) {
    for (const t of p.tasks) {
      if (t.id === ref) return { task: t, project: p };
      if (norm(t.name) === r) hits.unshift({ task: t, project: p });
      else if (norm(t.name).includes(r) || r.includes(norm(t.name))) hits.push({ task: t, project: p });
    }
  }
  return hits[0] || null;
}

/* ---------- op engine (shared by UI + AI) ---------- */
function applyOps(ops) {
  const applied = [];
  const failed = [];

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'add_project': {
          if (!op.name) throw new Error('name required');
          if (findProject(op.name) && norm(findProject(op.name).name) === norm(op.name)) {
            throw new Error(`project "${op.name}" already exists`);
          }
          State.data.projects.push({ id: uid('p'), name: op.name, tasks: [] });
          applied.push(`Added project “${op.name}”`);
          break;
        }
        case 'rename_project': {
          const p = findProject(op.project);
          if (!p) throw new Error(`no project matching "${op.project}"`);
          const old = p.name; p.name = op.name || p.name;
          applied.push(`Renamed “${old}” → “${p.name}”`);
          break;
        }
        case 'delete_project': {
          const p = findProject(op.project);
          if (!p) throw new Error(`no project matching "${op.project}"`);
          State.data.projects = State.data.projects.filter(x => x.id !== p.id);
          applied.push(`Deleted project “${p.name}” (${p.tasks.length} task(s))`);
          break;
        }
        case 'add_task': {
          const p = findProject(op.project);
          if (!p) throw new Error(`no project matching "${op.project}"`);
          if (!op.name) throw new Error('name required');
          const status = STATUSES.includes(op.status) ? op.status : 'Not started';
          p.tasks.push({ id: uid('t'), name: op.name, status, due: op.due || '' });
          applied.push(`Added “${op.name}” to ${p.name}`);
          break;
        }
        case 'update_task': {
          const hit = findTask(op.task, op.from_project);
          if (!hit) throw new Error(`no task matching "${op.task}"`);
          const { task, project } = hit;
          const bits = [];
          if (op.name && op.name !== task.name) { bits.push(`renamed to “${op.name}”`); task.name = op.name; }
          if (op.status) {
            if (!STATUSES.includes(op.status)) throw new Error(`bad status "${op.status}"`);
            if (op.status !== task.status) { bits.push(`status → ${op.status}`); task.status = op.status; }
          }
          if (op.due !== undefined && op.due !== task.due) {
            bits.push(op.due ? `due ${op.due}` : 'due date cleared');
            task.due = op.due || '';
          }
          if (op.project) {
            const np = findProject(op.project);
            if (!np) throw new Error(`no project matching "${op.project}"`);
            if (np.id !== project.id) {
              project.tasks = project.tasks.filter(t => t.id !== task.id);
              np.tasks.push(task);
              bits.push(`moved to ${np.name}`);
            }
          }
          applied.push(bits.length ? `${task.name}: ${bits.join(', ')}` : `${task.name}: no change`);
          break;
        }
        case 'delete_task': {
          const hit = findTask(op.task, op.from_project);
          if (!hit) throw new Error(`no task matching "${op.task}"`);
          hit.project.tasks = hit.project.tasks.filter(t => t.id !== hit.task.id);
          applied.push(`Deleted “${hit.task.name}”`);
          break;
        }
        default:
          throw new Error(`unknown op "${op.op}"`);
      }
    } catch (e) {
      failed.push(`${op.op || '?'}: ${e.message}`);
    }
  }
  return { applied, failed };
}

/* ---------- detail panel (manual editing) ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function renderDetail() {
  const box = $('detail');
  const id = State.selectedId;
  if (!id) {
    box.innerHTML = `<div id="detailEmpty">
      Click any node to edit it here.<br><br>
      Drag the canvas to pan, scroll to zoom, <span class="kbd">⌘0</span> to fit.
      Click a project's chevron to collapse its branch.</div>`;
    return;
  }

  const proj = State.data.projects.find(p => p.id === id);
  if (proj) {
    box.innerHTML = `<div class="sect">
      <h2>Project</h2>
      <label class="fld">Name</label>
      <input id="dName" value="${esc(proj.name)}">
      <div class="note">${proj.tasks.length} task(s) · ${proj.tasks.filter(t => t.status === 'Done').length} done</div>
      <div class="row" style="margin-top:14px">
        <button id="dSave">Save</button>
        <button id="dDel" class="danger">Delete</button>
      </div></div>`;
    $('dSave').onclick = () => {
      snapshot();
      applyOps([{ op: 'rename_project', project: proj.id, name: $('dName').value.trim() || proj.name }]);
      refresh();
    };
    $('dDel').onclick = () => {
      if (!confirm(`Delete “${proj.name}” and its ${proj.tasks.length} task(s)?`)) return;
      snapshot();
      applyOps([{ op: 'delete_project', project: proj.id }]);
      State.selectedId = null;
      refresh();
    };
    return;
  }

  const hit = findTask(id);
  if (!hit) { State.selectedId = null; renderDetail(); return; }
  const { task, project } = hit;
  box.innerHTML = `<div class="sect">
    <h2>Task</h2>
    <label class="fld">Name</label>
    <input id="dName" value="${esc(task.name)}">
    <label class="fld">Status</label>
    <select id="dStatus">${STATUSES.map(s => `<option ${s === task.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <label class="fld">Due date</label>
    <div class="row">
      <input id="dDue" type="date" value="${task.due || ''}">
      <button id="dClear" class="ghost" style="flex:0 0 66px">Clear</button>
    </div>
    <label class="fld">Project</label>
    <select id="dProj">${State.data.projects.map(p =>
      `<option value="${p.id}" ${p.id === project.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <div class="row" style="margin-top:16px">
      <button id="dSave">Save</button>
      <button id="dDel" class="danger">Delete</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button id="dToggle" class="ghost">${task.status === 'Done' ? 'Reopen' : 'Mark done'}</button>
    </div></div>`;

  $('dClear').onclick = () => { $('dDue').value = ''; };
  $('dSave').onclick = () => {
    snapshot();
    applyOps([{
      op: 'update_task', task: task.id,
      name: $('dName').value.trim() || task.name,
      status: $('dStatus').value,
      due: $('dDue').value,
      project: $('dProj').value
    }]);
    refresh();
  };
  $('dToggle').onclick = () => {
    snapshot();
    applyOps([{ op: 'update_task', task: task.id, status: task.status === 'Done' ? 'Not started' : 'Done' }]);
    refresh();
  };
  $('dDel').onclick = () => {
    if (!confirm(`Delete “${task.name}”?`)) return;
    snapshot();
    applyOps([{ op: 'delete_task', task: task.id }]);
    State.selectedId = null;
    refresh();
  };
}

function renderProjectSelect() {
  const sel = $('taskProj');
  const keep = sel.value;
  sel.innerHTML = State.data.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if (keep && State.data.projects.some(p => p.id === keep)) sel.value = keep;
}

/* ---------- wiring ---------- */
async function boot() {
  State.data = await window.api.data.load();

  view = new window.TreeKit.TreeView($('svg'), {
    onSelect: node => { State.selectedId = node ? node.id : null; refresh(); },
    onToggle: pid => {
      State.collapsed.has(pid) ? State.collapsed.delete(pid) : State.collapsed.add(pid);
      refresh();
    }
  });

  $('addProj').onclick = () => {
    const name = $('npName').value.trim();
    if (!name) return;
    snapshot();
    applyOps([{ op: 'add_project', name }]);
    $('npName').value = '';
    refresh();
  };
  $('npName').addEventListener('keydown', e => { if (e.key === 'Enter') $('addProj').click(); });

  $('addTask').onclick = () => {
    const name = $('ntName').value.trim();
    if (!name) return;
    snapshot();
    applyOps([{
      op: 'add_task', project: $('taskProj').value, name,
      status: $('ntStatus').value, due: $('ntDue').value
    }]);
    $('ntName').value = ''; $('ntDue').value = '';
    refresh();
  };
  $('ntName').addEventListener('keydown', e => { if (e.key === 'Enter') $('addTask').click(); });

  $('search').addEventListener('input', e => { State.query = e.target.value; refresh(); });
  $('hideDone').onclick = () => {
    State.hideDone = !State.hideDone;
    $('hideDone').classList.toggle('on', State.hideDone);
    refresh();
  };
  $('fitBtn').onclick = () => view.fit();
  $('collapseBtn').onclick = () => {
    const allCollapsed = State.data.projects.every(p => State.collapsed.has(p.id));
    State.collapsed = allCollapsed ? new Set() : new Set(State.data.projects.map(p => p.id));
    $('collapseBtn').textContent = allCollapsed ? 'Collapse all' : 'Expand all';
    refresh();
    setTimeout(() => view.fit(), 30);
  };

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      const target = e.target.tagName;
      if (target === 'INPUT' || target === 'TEXTAREA' || target === 'SELECT') return;
      e.preventDefault();
      undo();
    }
  });

  window.api.on('menu:fit', () => view.fit());
  window.api.on('menu:new-project', () => $('npName').focus());
  window.api.on('menu:new-task', () => $('ntName').focus());
  window.api.on('menu:export', async () => { await window.api.data.exportFile(State.data); });
  window.api.on('menu:import', async () => {
    const r = await window.api.data.importFile();
    if (r.ok) { snapshot(); State.data = r.data; State.selectedId = null; refresh(); view.fit(); }
    else if (r.error) alert('Import failed: ' + r.error);
  });

  refresh();
  setTimeout(() => view.fit(), 60);
}

window.Store = { State, applyOps, snapshot, undo, refresh, findProject, findTask, STATUSES, fit: () => view.fit() };
window.addEventListener('DOMContentLoaded', boot);
window.addEventListener('resize', () => { if (view) refresh(); });
