// ============ STATE ============
const state = {
  tables: [],
  guests: [],
  filter: 'all',
  search: '',
  view: 'guests',
  currentGuestId: null,
  currentTableId: null,
  selectedTableId: null,
  pendingChildren: [],
  importRows: [],
  importHeaders: [],
  zoom: 1,
  dragActive: false,
  dragTick: null,
  canvasW: 2000,
  canvasH: 1400,
  settings: { event_name: '' }
};
const DEFAULT_TITLE = 'Gestion de Mesas';
const TABLE_COLORS = ['#b38138', '#4a7256', '#3f6b8c', '#8c4a6b', '#7a5c9e', '#c05f3a', '#4b7a7a', '#5a6b3f'];

// ============ SEAT GEOMETRY ============
const SEAT_GAP = 34;   // spacing between adjacent seats on an edge
const RECT_PAD = 30;   // border inset from the seat rows
const RECT_MIN_W = 128;
const RECT_MIN_H = 108;
const RECT_MAX = 560;
const SEAT_OFF = 10;   // how far a seat sits outside the table border

function circleGeometry(count, capacity) {
  const cap = Math.max(count, Number(capacity) || 10, 1);
  const base = Math.max(140, Math.min(340, 140 + cap * 10));
  const seats = [];
  // number 1 at the top (12 o'clock), then clockwise
  for (let i = 0; i < cap; i++) {
    const angle = (i / cap) * Math.PI * 2 - Math.PI / 2;
    const r = base / 2 + 8;
    seats.push({ x: base / 2 + r * Math.cos(angle), y: base / 2 + r * Math.sin(angle), n: i + 1 });
  }
  return { w: base, h: base, shape: 'circle', seats, capacity: cap };
}

function defaultLayoutFor(capacity) {
  const cap = Math.max(2, Number(capacity) || 10);
  const rem = Math.max(0, cap - 2);            // seats after 1 per cabecera
  const side = Math.ceil(rem / 2);
  const drop = Math.max(0, Math.min(side, side * 2 - rem)); // keep exact total
  return { head: 1, side, corners: false, drop };
}

// Rectangular: head seats per short end (x2), side seats per long edge (x2),
// optional 4 corner seats. `drop` removes trailing slots from the BOTTOM edge
// only — the remaining seats keep the same x as the TOP edge (stay aligned).
function rectGeometry(count, layout) {
  const L = layout || defaultLayoutFor(10);
  const head = Math.max(0, L.head | 0);
  const side = Math.max(0, L.side | 0);
  const corners = !!L.corners;
  const drop = Math.max(0, Math.min(side, L.drop | 0));

  const baseCap = Math.max(1, head * 2 + side * 2 + (corners ? 4 : 0) - drop);
  // Grow the long edges if more guests than seats.
  let effSide = side;
  if (count > baseCap) effSide = side + Math.ceil((count - baseCap) / 2);

  const cols = Math.max(effSide, 1);
  const rows = Math.max(head, 1);
  const w = Math.max(RECT_MIN_W, Math.min(RECT_MAX, cols * SEAT_GAP + 2 * RECT_PAD));
  const h = Math.max(RECT_MIN_H, Math.min(RECT_MAX, rows * SEAT_GAP + 2 * RECT_PAD));

  const along = (k, total, length) => (length / (total + 1)) * (k + 1);
  const seats = [];
  // Walk the perimeter so that, with the tables rotated +90deg (the usual
  // orientation here), the numbers read 1,2,3... clockwise starting at the
  // cabecera shown on top. In table-local terms: left head bottom->top,
  // top edge left->right, right head bottom->top, bottom edge left->right.
  for (let k = head - 1; k >= 0; k--)             seats.push({ x: -SEAT_OFF,           y: along(k, head, h) });       // left head  B->T
  if (corners)                                    seats.push({ x: -SEAT_OFF,           y: -SEAT_OFF });              // top-left corner
  for (let k = 0; k < effSide; k++)               seats.push({ x: along(k, effSide, w), y: -SEAT_OFF });             // top        L->R
  if (corners)                                    seats.push({ x: w + SEAT_OFF,        y: -SEAT_OFF });              // top-right corner
  for (let k = head - 1; k >= 0; k--)             seats.push({ x: w + SEAT_OFF,        y: along(k, head, h) });      // right head B->T
  if (corners)                                    seats.push({ x: w + SEAT_OFF,        y: h + SEAT_OFF });           // bottom-right corner
  for (let k = 0; k < effSide - drop; k++)        seats.push({ x: along(k, effSide, w), y: h + SEAT_OFF });          // bottom     L->R (drop trims the right end)
  if (corners)                                    seats.push({ x: -SEAT_OFF,           y: h + SEAT_OFF });           // bottom-left corner

  seats.forEach((s, i) => { s.n = i + 1; });
  return { w, h, shape: 'square', seats, capacity: baseCap };
}

function tableGeometry(t) {
  const count = t.guests ? t.guests.length : 0;
  if (t.shape === 'square') {
    return rectGeometry(count, t.seat_layout || defaultLayoutFor(t.capacity));
  }
  return circleGeometry(count, t.capacity);
}

// Resolve which guest sits in which seat: honour pinned `seat`, then fill the
// rest into the lowest free seats in list order.
function computeSeating(t) {
  const geo = tableGeometry(t);
  const guests = t.guests || [];
  const seatCount = Math.max(geo.seats.length, guests.length, 1);
  const guestAt = new Array(seatCount).fill(null);
  const seatOf = new Map();
  const floating = [];
  for (const g of guests) {
    const s = Number(g.seat);
    if (Number.isInteger(s) && s >= 1 && s <= seatCount && guestAt[s - 1] == null) {
      guestAt[s - 1] = g;
      seatOf.set(g.id, s);
    } else {
      floating.push(g);
    }
  }
  let cursor = 0;
  for (const g of floating) {
    while (cursor < seatCount && guestAt[cursor] != null) cursor++;
    if (cursor >= seatCount) break;
    guestAt[cursor] = g;
    seatOf.set(g.id, cursor + 1);
    cursor++;
  }
  return { geo, seatCount, guestAt, seatOf };
}
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.8;
const ZOOM_STEP = 0.1;
let lastPointerClient = null;
let edgeScrollRaf = null;

// ============ API ============
let myClientId = null;
const json = () => ({ 'Content-Type': 'application/json', 'x-client-id': myClientId || '' });
async function post(url, body) { const r = await fetch(url, { method: 'POST', headers: json(), body: JSON.stringify(body) }); return r.json(); }
async function put(url, body) { const r = await fetch(url, { method: 'PUT', headers: json(), body: JSON.stringify(body) }); return r.json(); }

const api = {
  async getState() { const r = await fetch('/api/state'); return r.json(); },
  async createTable(data) { return post('/api/tables', data); },
  async updateTable(id, data) { return put(`/api/tables/${id}`, data); },
  async updateTablePosition(id, x, y) { return fetch(`/api/tables/${id}/position`, { method: 'PATCH', headers: json(), body: JSON.stringify({ position_x: x, position_y: y }) }); },
  async deleteTable(id) { return fetch(`/api/tables/${id}`, { method: 'DELETE' }); },
  async createGuest(data) { return post('/api/guests', data); },
  async createGuestsBulk(rows) { return post('/api/guests/bulk', { guests: rows }); },
  async updateGuest(id, data) { return put(`/api/guests/${id}`, data); },
  async assignGuest(id, tableId, seat) {
    const body = { table_id: tableId };
    if (seat !== undefined) body.seat = seat;
    return fetch(`/api/guests/${id}/assign`, { method: 'PATCH', headers: json(), body: JSON.stringify(body) });
  },
  async setGuestSeat(id, seat) { return fetch(`/api/guests/${id}/seat`, { method: 'PATCH', headers: json(), body: JSON.stringify({ seat: seat ?? null }) }); },
  async setConfirmed(id, confirmed) { return fetch(`/api/guests/${id}/confirm`, { method: 'PATCH', headers: json(), body: JSON.stringify({ confirmed: confirmed ? 1 : 0 }) }); },
  async deleteGuest(id) { return fetch(`/api/guests/${id}`, { method: 'DELETE' }); },
  async reset() { return post('/api/reset', {}); },
  async undo() { return fetch('/api/history/undo', { method: 'POST', headers: json() }); },
  async importPayload(payload) {
    const r = await fetch('/api/import', { method: 'POST', headers: json(), body: JSON.stringify(payload) });
    if (!r.ok) throw new Error((await r.json()).error || 'Error al importar');
    return r.json();
  }
};

// ============ UTIL ============
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// ============ IN-PAGE DIALOG ============
function showDialog({ title, message, input = false, defaultValue = '', okText = 'Aceptar', cancelText = 'Cancelar', danger = false } = {}) {
  return new Promise(resolve => {
    const modal = $('#modal-dialog');
    const wrap = $('#md-input-wrap');
    const inp = $('#md-input');
    const ok = $('#md-ok');
    const cancel = $('#md-cancel');

    $('#md-title').textContent = title || 'Confirmar';
    $('#md-message').textContent = message || '';
    ok.textContent = okText;
    cancel.textContent = cancelText;
    ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');

    if (input) {
      wrap.style.display = '';
      inp.value = defaultValue || '';
    } else {
      wrap.style.display = 'none';
    }

    function cleanup(result) {
      modal.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function onOk() { cleanup(input ? inp.value.trim() : true); }
    function onCancel() { cleanup(input ? null : false); }
    function onBackdrop(e) { if (e.target === modal) onCancel(); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter' && (!input || document.activeElement === inp)) { e.preventDefault(); e.stopPropagation(); onOk(); }
    }

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);

    modal.classList.remove('hidden');
    if (input) setTimeout(() => { inp.focus(); inp.select(); }, 50);
    else setTimeout(() => ok.focus(), 50);
  });
}
const confirmDialog = (message, opts = {}) => showDialog({ message, ...opts });
const promptDialog = (message, defaultValue = '', opts = {}) => showDialog({ message, input: true, defaultValue, ...opts });

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toast._tid);
  toast._tid = setTimeout(() => t.classList.add('hidden'), 2400);
}

// ============ REAL-TIME (SSE) ============
let refreshDebounce = null;
let pendingRefresh = false;

function scheduleRefresh() {
  if (state.dragActive) { pendingRefresh = true; return; }
  if (refreshDebounce) clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(() => {
    refreshDebounce = null;
    pendingRefresh = false;
    refresh();
  }, 150);
}

function applyRemoteDrag({ id, position_x, position_y }) {
  const t = state.tables.find(x => x.id === id);
  if (t) { t.position_x = position_x; t.position_y = position_y; }
  const node = document.querySelector(`.table-node[data-table-id="${id}"]`);
  if (!node) return;
  const ox = Number(node.dataset.offx) || 0, oy = Number(node.dataset.offy) || 0;
  node.classList.add('remote-moving');
  node.style.left = Math.max(0, position_x - ox) + 'px';
  node.style.top = Math.max(0, position_y - oy) + 'px';
  clearTimeout(node._remoteTimer);
  node._remoteTimer = setTimeout(() => node.classList.remove('remote-moving'), 260);
}

function applyRemoteSpin({ id, rotation }) {
  const rot = ((Number(rotation) % 360) + 360) % 360 || 0;
  const t = state.tables.find(x => x.id === id);
  if (t) t.rotation = rot;
  const rotor = document.querySelector(`.table-node[data-table-id="${id}"] .table-rotor`);
  if (!rotor) return;
  rotor.classList.add('remote-moving');
  rotor.style.transform = `rotate(${rot}deg)`;
  rotor.style.setProperty('--rot', rot + 'deg');
  const center = rotor.querySelector('.table-center');
  if (center) center.style.transform = `translate(-50%,-50%) rotate(${-rot}deg)`;
  clearTimeout(rotor._remoteTimer);
  rotor._remoteTimer = setTimeout(() => rotor.classList.remove('remote-moving'), 260);
}

function connectSSE() {
  let es = null;
  let backoff = 1000;
  function open() {
    try { es?.close(); } catch {}
    es = new EventSource('/api/events');
    es.onopen = () => { backoff = 1000; if (_hasBooted) scheduleRefresh(); };
    es.onmessage = (e) => {
      try {
        const { type, payload } = JSON.parse(e.data);
        if (type === 'hello') { myClientId = payload.id; return; }
        if (payload?.originId && payload.originId === myClientId) return;
        if (type === 'state.changed') scheduleRefresh();
        else if (type === 'table.drag') applyRemoteDrag(payload);
        else if (type === 'table.spin') applyRemoteSpin(payload);
      } catch {}
    };
    es.onerror = () => {
      try { es.close(); } catch {}
      setTimeout(open, Math.min(backoff, 15000));
      backoff *= 2;
    };
  }
  open();
}

// ============ LOAD ============
let _hasBooted = false;
async function refresh() {
  const data = await api.getState();
  state.tables = data.tables;
  state.guests = data.guests;
  state.settings = data.settings || { event_name: '' };
  applyEventName();
  render();
  if (!_hasBooted) {
    _hasBooted = true;
    if (window.innerWidth <= 760 && state.tables.length) {
      setTimeout(() => fitView(), 60);
    }
  }
}

function applyEventName() {
  const name = (state.settings.event_name || '').trim();
  const display = name || DEFAULT_TITLE;
  $('#app-title').textContent = display;
  document.title = name ? `${name} — Mesas` : DEFAULT_TITLE;
}

async function renameEvent() {
  const current = state.settings.event_name || '';
  const v = await promptDialog('Elige un nombre para este evento. Dejar vacio usa el nombre por defecto.', current, {
    title: 'Renombrar evento',
    okText: 'Guardar'
  });
  if (v === null) return;
  const name = v;
  state.settings.event_name = name;
  applyEventName();
  await fetch('/api/settings', {
    method: 'PUT',
    headers: json(),
    body: JSON.stringify({ event_name: name })
  });
  toast(name ? 'Nombre actualizado' : 'Nombre restablecido', 'success');
}

function render() {
  renderGuestList();
  renderTableList();
  renderCanvas();
  renderCounts();
}

// ============ COUNTS ============
function renderCounts() {
  const total = state.guests.length;
  const assigned = state.guests.filter(g => g.table_id).length;
  $('#count-total').textContent = total;
  $('#count-assigned').textContent = assigned;
  $('#count-unassigned').textContent = total - assigned;
  $('#count-tables').textContent = state.tables.length;
}

// ============ GUEST LIST ============
function renderGuestList() {
  const list = $('#guest-list');
  const q = state.search.toLowerCase().trim();

  let items = state.guests.filter(g => {
    if (state.filter === 'assigned' && !g.table_id) return false;
    if (state.filter === 'unassigned' && g.table_id) return false;
    if (q) {
      const hay = (g.name + ' ' + (g.phone || '') + ' ' + (g.email || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!items.length) {
    list.innerHTML = `<div class="guest-empty">Sin invitados.<br/>Importa un Excel o agrega manualmente.</div>`;
    return;
  }

  list.innerHTML = items.map(g => {
    const table = g.table_id ? state.tables.find(t => t.id === g.table_id) : null;
    return `
      <div class="guest-card ${g.is_plus_one ? 'is-plus-one' : ''} ${g.confirmed ? 'is-confirmed' : ''}" data-guest-id="${g.id}">
        <button class="confirm-toggle ${g.confirmed ? 'on' : ''}" data-confirm="${g.id}" aria-pressed="${g.confirmed ? 'true' : 'false'}" title="${g.confirmed ? 'Confirmado' : 'Marcar confirmado'}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <div class="guest-main">
          <div class="guest-name">${esc(g.name)}</div>
          <div class="guest-meta">
            ${g.phone ? esc(g.phone) : '<span style="opacity:.6">sin telefono</span>'}
          </div>
        </div>
        <div class="guest-tags">
          ${g.is_plus_one ? `<span class="tag tag-plus">+1</span>` : ''}
          ${g.phone ? `<span class="tag tag-phone">tel</span>` : ''}
          ${table ? `<span class="tag tag-table">${esc(table.name)}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  $$('.guest-card', list).forEach(el => {
    const id = Number(el.dataset.guestId);
    enableDragOrClick(el, {
      onClick: () => openGuestModal(id),
      ghostLabel: () => state.guests.find(x => x.id === id)?.name || '',
      skipOn: '.confirm-toggle',
      onDrop: async (target) => {
        const tableEl = target.closest('.table-node');
        if (!tableEl) return;
        const tableId = Number(tableEl.dataset.tableId);
        await api.assignGuest(id, tableId);
        const t = state.tables.find(t => t.id === tableId);
        toast(`Asignado a ${t?.name || 'mesa'}`, 'success');
        await refresh();
      }
    });
  });

  $$('.confirm-toggle', list).forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.confirm);
      const g = state.guests.find(x => x.id === id);
      if (!g) return;
      const next = g.confirmed ? 0 : 1;
      g.confirmed = next;
      btn.classList.toggle('on', !!next);
      btn.closest('.guest-card')?.classList.toggle('is-confirmed', !!next);
      btn.setAttribute('aria-pressed', next ? 'true' : 'false');
      await api.setConfirmed(id, next);
    });
  });
}

// ============ ZOOM / CANVAS SIZE / EDGE SCROLL ============
// The on-canvas node is a square that holds the table at any rotation.
// Returns that square's size plus the offset of the (unrotated) table inside it.
function tableBox(t) {
  const g = tableGeometry(t);
  const OH = SEAT_OFF + 22;
  const S = Math.ceil(Math.hypot(g.w + OH * 2, g.h + OH * 2));
  return { S, offX: (S - g.w) / 2, offY: (S - g.h) / 2, gw: g.w, gh: g.h };
}
// Extent from position_x/position_y to the far edge of the node box (for canvas sizing).
function tableDim(t) {
  const b = tableBox(t);
  return { w: b.S - b.offX, h: b.S - b.offY + 30, base: b.S };
}
function tableSize(t) { return tableBox(t).S; }

// ============ TABLE COLOR (tonal) ============
function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255, g = ((int >> 8) & 255) / 255, b = (int & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0, s = 0; const l = (max + min) / 2;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}
const _hsl = (h, s, l) =>
  `hsl(${h.toFixed(0)} ${Math.max(0, Math.min(100, s)).toFixed(0)}% ${Math.max(0, Math.min(100, l)).toFixed(0)}%)`;

function applyTableColor(node, hex) {
  const base = hexToHsl(hex);
  if (!base) return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const { h, s } = base;
  const set = (k, v) => node.style.setProperty(k, v);
  if (dark) {
    set('--tbl-fill-1', _hsl(h, s * 0.55, 27));
    set('--tbl-fill-2', _hsl(h, s * 0.62, 17));
    set('--tbl-border', _hsl(h, s * 0.52, 48));
    set('--tbl-ink',    _hsl(h, s * 0.40, 84));
    set('--tbl-seat',   _hsl(h, s * 0.50, 58));
  } else {
    set('--tbl-fill-1', _hsl(h, s * 0.70, 94));
    set('--tbl-fill-2', _hsl(h, s * 0.78, 83));
    set('--tbl-border', _hsl(h, s * 0.58, 55));
    set('--tbl-ink',    _hsl(h, s * 0.70, 31));
    set('--tbl-seat',   _hsl(h, s * 0.55, 50));
  }
  node.classList.add('has-color');
}

function updateCanvasSize(extra) {
  const wrap = $('.canvas-wrap');
  const pad = 400;
  let w = Math.ceil(wrap.clientWidth / state.zoom) + 100;
  let h = Math.ceil(wrap.clientHeight / state.zoom) + 100;
  state.tables.forEach(t => {
    const d = tableDim(t);
    w = Math.max(w, t.position_x + d.w + pad);
    h = Math.max(h, t.position_y + d.h + pad + 40); // +40 for name label below
  });
  if (extra) {
    w = Math.max(w, extra.x + pad);
    h = Math.max(h, extra.y + pad);
  }
  state.canvasW = w;
  state.canvasH = h;
  $('#canvas').style.width = w + 'px';
  $('#canvas').style.height = h + 'px';
  applyZoomSize();
}

function applyZoomSize() {
  $('#canvas').style.transform = `scale(${state.zoom})`;
  const outer = $('#canvas-outer');
  outer.style.width = (state.canvasW * state.zoom) + 'px';
  outer.style.height = (state.canvasH * state.zoom) + 'px';
  const label = $('#zoom-label');
  if (label) label.textContent = Math.round(state.zoom * 100) + '%';
}

function setZoom(z, centerClientX, centerClientY) {
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  if (Math.abs(newZoom - state.zoom) < 0.001) return;
  const wrap = $('.canvas-wrap');
  if (centerClientX !== undefined && centerClientY !== undefined) {
    const rect = wrap.getBoundingClientRect();
    const cx = centerClientX - rect.left;
    const cy = centerClientY - rect.top;
    const canvasCx = (cx + wrap.scrollLeft) / state.zoom;
    const canvasCy = (cy + wrap.scrollTop) / state.zoom;
    state.zoom = newZoom;
    applyZoomSize();
    wrap.scrollLeft = canvasCx * newZoom - cx;
    wrap.scrollTop = canvasCy * newZoom - cy;
  } else {
    // zoom toward current viewport center
    const rect = wrap.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const canvasCx = (cx + wrap.scrollLeft) / state.zoom;
    const canvasCy = (cy + wrap.scrollTop) / state.zoom;
    state.zoom = newZoom;
    applyZoomSize();
    wrap.scrollLeft = canvasCx * newZoom - cx;
    wrap.scrollTop = canvasCy * newZoom - cy;
  }
  updateCanvasSize();
}

function fitView() {
  if (!state.tables.length) {
    state.zoom = 1;
    updateCanvasSize();
    return;
  }
  const wrap = $('.canvas-wrap');
  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  state.tables.forEach(t => {
    const b = tableBox(t);
    const left = Math.max(0, t.position_x - b.offX);
    const top = Math.max(0, t.position_y - b.offY);
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, left + b.S);
    maxY = Math.max(maxY, top + b.S + 30);
  });
  const contentW = Math.max(1, maxX - minX + 120);
  const contentH = Math.max(1, maxY - minY + 120);
  const zX = (wrap.clientWidth - 40) / contentW;
  const zY = (wrap.clientHeight - 40) / contentH;
  state.zoom = Math.max(ZOOM_MIN, Math.min(1, Math.min(zX, zY)));
  updateCanvasSize();
  wrap.scrollLeft = (minX - 20) * state.zoom;
  wrap.scrollTop = (minY - 20) * state.zoom;
}

function startEdgeScroll() {
  if (edgeScrollRaf) return;
  edgeScrollRaf = requestAnimationFrame(edgeScrollTick);
}
function edgeScrollTick() {
  edgeScrollRaf = null;
  if (!state.dragActive || !lastPointerClient) return;
  const wrap = $('.canvas-wrap');
  const rect = wrap.getBoundingClientRect();
  const edge = 70;
  const maxSpeed = 18;
  const px = lastPointerClient.x, py = lastPointerClient.y;
  let dx = 0, dy = 0;
  if (px < rect.left + edge) dx = -maxSpeed * ((rect.left + edge - px) / edge);
  else if (px > rect.right - edge) dx = maxSpeed * ((px - (rect.right - edge)) / edge);
  if (py < rect.top + edge) dy = -maxSpeed * ((rect.top + edge - py) / edge);
  else if (py > rect.bottom - edge) dy = maxSpeed * ((py - (rect.bottom - edge)) / edge);
  if (dx || dy) {
    const beforeL = wrap.scrollLeft, beforeT = wrap.scrollTop;
    wrap.scrollLeft = beforeL + dx;
    wrap.scrollTop = beforeT + dy;
    // If we hit the max scroll, grow canvas so we can keep scrolling
    if (dx > 0 && wrap.scrollLeft === beforeL) {
      state.canvasW += dx * 4;
      $('#canvas').style.width = state.canvasW + 'px';
      applyZoomSize();
      wrap.scrollLeft = beforeL + dx;
    }
    if (dy > 0 && wrap.scrollTop === beforeT) {
      state.canvasH += dy * 4;
      $('#canvas').style.height = state.canvasH + 'px';
      applyZoomSize();
      wrap.scrollTop = beforeT + dy;
    }
    if (state.dragTick) state.dragTick();
  }
  edgeScrollRaf = requestAnimationFrame(edgeScrollTick);
}

// ============ CANVAS ============
function renderCanvas() {
  const canvas = $('#canvas');
  canvas.innerHTML = '';
  updateCanvasSize();

  state.tables.forEach(t => {
    const count = t.guests.length;
    const { geo: g, seatCount, guestAt } = computeSeating(t);
    const baseCap = g.capacity;
    const displayCap = Math.max(count, baseCap);
    const overBase = count > baseCap;
    const rot = Number(t.rotation) || 0;

    // The node reserves a square big enough for any rotation, with the table
    // centred inside it — so a rotated table never spills past its own box.
    const OH = SEAT_OFF + 22;
    const S = Math.ceil(Math.hypot(g.w + OH * 2, g.h + OH * 2));
    const offX = (S - g.w) / 2, offY = (S - g.h) / 2;

    // Heal positions too close to the canvas edge for the (bigger) box to fit.
    if (!t._healedBox && (t.position_x < offX || t.position_y < offY)) {
      t._healedBox = true;
      t.position_x = Math.max(offX, t.position_x);
      t.position_y = Math.max(offY, t.position_y);
      api.updateTablePosition(t.id, Math.round(t.position_x), Math.round(t.position_y));
    }

    const node = document.createElement('div');
    node.className = 'table-node' + (t.id === state.selectedTableId ? ' selected' : '');
    node.dataset.tableId = t.id;
    node.dataset.offx = offX;
    node.dataset.offy = offY;
    node.style.left = Math.max(0, t.position_x - offX) + 'px';
    node.style.top = Math.max(0, t.position_y - offY) + 'px';
    node.style.width = S + 'px';
    node.style.height = (S + 30) + 'px';
    if (t.color) applyTableColor(node, t.color);

    const rotor = document.createElement('div');
    rotor.className = 'table-rotor' + (t.shape === 'square' ? ' square' : '');
    rotor.style.left = offX + 'px';
    rotor.style.top = offY + 'px';
    rotor.style.width = g.w + 'px';
    rotor.style.height = g.h + 'px';
    rotor.style.setProperty('--rot', rot + 'deg');
    rotor.style.transform = `rotate(${rot}deg)`;

    const shapeEl = document.createElement('div');
    shapeEl.className = 'table-shape';
    rotor.appendChild(shapeEl);

    const cxr = g.w / 2, cyr = g.h / 2;
    for (let i = 0; i < seatCount; i++) {
      const s = g.seats[i] || g.seats[g.seats.length - 1] || { x: g.w / 2, y: g.h + SEAT_OFF, n: i + 1 };
      const seatNum = s.n ?? (i + 1);
      const who = guestAt[i] || null;
      const dot = document.createElement('div');
      let cls = 'seat';
      if (who) cls += ' occupied';
      if (i >= baseCap) cls += ' over-base';
      dot.className = cls;
      dot.style.left = s.x + 'px';
      dot.style.top = s.y + 'px';
      dot.dataset.seatNum = seatNum;
      if (who) {
        dot.dataset.name = who.name || '';
        attachSeatTooltip(dot);
      }
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        openSeatPicker(t.id, seatNum);
      });
      rotor.appendChild(dot);

      const num = document.createElement('div');
      num.className = 'seat-num' + (who ? ' is-taken' : '');
      num.textContent = seatNum;
      const dx = s.x - cxr, dy = s.y - cyr;
      const len = Math.hypot(dx, dy) || 1;
      num.style.left = (s.x + (dx / len) * 13) + 'px';
      num.style.top = (s.y + (dy / len) * 13) + 'px';
      num.style.transform = `translate(-50%,-50%) rotate(${-rot}deg)`;
      rotor.appendChild(num);
    }

    const center = document.createElement('div');
    center.className = 'table-center';
    center.style.transform = `translate(-50%,-50%) rotate(${-rot}deg)`;
    center.innerHTML =
      `<div class="table-count ${overBase ? 'over' : ''}">${count}</div>` +
      `<div class="table-label">de ${displayCap}</div>`;
    rotor.appendChild(center);
    node.appendChild(rotor);

    const handle = document.createElement('div');
    handle.className = 'rotate-handle';
    handle.title = 'Girar mesa (Shift: libre)';
    handle.style.left = '50%';
    handle.style.top = (offY - 30) + 'px';
    handle.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;
    node.appendChild(handle);

    const nameEl = document.createElement('div');
    nameEl.className = 'table-name';
    nameEl.textContent = t.name;
    nameEl.style.left = '50%';
    nameEl.style.top = (offY + g.h + 12) + 'px';
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      selectTable(t.id);
      openTableModal(t.id);
    });
    node.appendChild(nameEl);

    canvas.appendChild(node);
    attachTableInteractions(rotor, node, t);
    attachRotateHandle(handle, node, t);
  });
}

function attachSeatTooltip(seatEl) {
  seatEl.addEventListener('mouseenter', () => {
    const tip = $('#seat-tip');
    tip.textContent = seatEl.dataset.name || '';
    tip.classList.remove('hidden');
    positionSeatTip(seatEl);
  });
  seatEl.addEventListener('mouseleave', () => {
    $('#seat-tip').classList.add('hidden');
  });
}
function positionSeatTip(seatEl) {
  const tip = $('#seat-tip');
  const rect = seatEl.getBoundingClientRect();
  tip.style.left = (rect.left + rect.width / 2) + 'px';
  tip.style.top = rect.top + 'px';
}

// ============ TABLE LIST (sidebar) ============
function renderTableList() {
  const list = $('#table-list');
  const q = state.search.toLowerCase().trim();
  const items = state.tables.filter(t => !q || t.name.toLowerCase().includes(q));

  if (!items.length) {
    list.innerHTML = `<div class="guest-empty">Sin mesas.<br/>Agrega una con el boton de arriba.</div>`;
    return;
  }

  list.innerHTML = items.map(t => {
    const count = t.guests.length;
    const cap = Number(t.capacity) || 10;
    const shape = t.shape === 'square' ? 'square' : 'circle';
    const over = count > cap;
    const full = count >= cap && !over;
    const countCls = over ? 'over' : (full ? 'full' : '');
    return `
      <div class="table-card" data-table-id="${t.id}">
        <span class="tc-shape ${shape}"></span>
        <div class="tc-main">
          <div class="tc-name">${esc(t.name)}</div>
          <div class="tc-meta">Capacidad ${cap}${over ? ` · +${count - cap} extra` : ''}</div>
        </div>
        <span class="tc-count ${countCls}">${count}/${cap}</span>
      </div>`;
  }).join('');

  $$('.table-card', list).forEach(el => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.tableId);
      openTableModal(id);
    });
  });
}

let _lastDragBroadcast = 0;
function broadcastTableDrag(id, x, y) {
  if (!myClientId) return;
  const now = performance.now();
  if (now - _lastDragBroadcast < 33) return;
  _lastDragBroadcast = now;
  fetch(`/api/tables/${id}/drag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-client-id': myClientId },
    body: JSON.stringify({ position_x: x, position_y: y }),
    keepalive: true
  }).catch(() => {});
}

let _lastSpinBroadcast = 0;
function broadcastTableSpin(id, rotation) {
  if (!myClientId) return;
  const now = performance.now();
  if (now - _lastSpinBroadcast < 33) return;
  _lastSpinBroadcast = now;
  fetch(`/api/tables/${id}/spin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-client-id': myClientId },
    body: JSON.stringify({ rotation }),
    keepalive: true
  }).catch(() => {});
}

function selectTable(id) {
  state.selectedTableId = id;
  $$('.table-node').forEach(n => n.classList.toggle('selected', Number(n.dataset.tableId) === id));
}
function clearTableSelection() {
  if (state.selectedTableId == null) return;
  state.selectedTableId = null;
  $$('.table-node.selected').forEach(n => n.classList.remove('selected'));
}

function attachTableInteractions(hitEl, node, table) {
  const ox = () => Number(node.dataset.offx) || 0;
  const oy = () => Number(node.dataset.offy) || 0;
  // Listen on the rotor (its hitbox follows the real, rotated table shape) but
  // move the whole node so positions stay in node-box space.
  enableDragOrClick(hitEl, {
    onClick: () => { selectTable(table.id); openTableModal(table.id); },
    moveTarget: node,
    skipOn: '.seat',
    // drag math runs in node-box space; add the box offset back for real coords
    onDragTick: (x, y) => broadcastTableDrag(table.id, x + ox(), y + oy()),
    onPositionChange: async (x, y) => {
      const px = Math.max(0, Math.round(x + ox()));
      const py = Math.max(0, Math.round(y + oy()));
      table.position_x = px;
      table.position_y = py;
      node.dataset.px = px;
      node.dataset.py = py;
      await api.updateTablePosition(table.id, px, py);
    }
  });
}

function attachRotateHandle(handle, node, table) {
  const rotor = node.querySelector('.table-rotor');
  const center = rotor.querySelector('.table-center');
  let dragging = false, startPointer = 0, startRot = 0, curRot = Number(table.rotation) || 0;

  const angleAt = (e) => {
    const r = rotor.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  };
  const paint = (deg) => {
    rotor.style.transform = `rotate(${deg}deg)`;
    rotor.style.setProperty('--rot', deg + 'deg');
    if (center) center.style.transform = `translate(-50%,-50%) rotate(${-deg}deg)`;
  };
  const onDown = (e) => {
    e.stopPropagation(); e.preventDefault();
    dragging = true;
    startPointer = angleAt(e);
    startRot = Number(table.rotation) || 0;
    curRot = startRot;
    node.classList.add('rotating');
    state.dragActive = true;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  const onMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    let next = startRot + (angleAt(e) - startPointer);
    next = ((next % 360) + 360) % 360;
    if (!e.shiftKey) next = (Math.round(next / 15) * 15) % 360;
    curRot = next;
    paint(next);
    broadcastTableSpin(table.id, next);
  };
  const onUp = async () => {
    if (!dragging) return;
    dragging = false;
    node.classList.remove('rotating');
    state.dragActive = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    table.rotation = curRot;
    await fetch(`/api/tables/${table.id}/rotation`, {
      method: 'PATCH', headers: json(), body: JSON.stringify({ rotation: curRot })
    }).catch(() => {});
    updateCanvasSize();
    if (pendingRefresh) scheduleRefresh();
  };
  handle.addEventListener('pointerdown', onDown);
}

// ============ POINTER DRAG HELPER ============
// Unified drag-or-click for both guest cards (drag-to-table) and table nodes (reposition)
// Supports mouse + touch + pen via pointer events.
function pointerToCanvas(clientX, clientY) {
  const wrap = $('.canvas-wrap');
  const rect = wrap.getBoundingClientRect();
  return {
    cx: (clientX - rect.left + wrap.scrollLeft) / state.zoom,
    cy: (clientY - rect.top + wrap.scrollTop) / state.zoom
  };
}

function enableDragOrClick(el, opts) {
  const { onClick, ghostLabel, onDrop, onPositionChange, onDragTick, moveTarget, skipOn } = opts;
  const isRepositionMode = !!onPositionChange;

  let pointerId = null;
  let started = false;
  let moved = false;
  let startX = 0, startY = 0;
  let origX = 0, origY = 0;
  let offCanvasX = 0, offCanvasY = 0;
  let longPressTimer = null;
  let dragArmed = false;
  const threshold = 6;

  const clearHover = () => {
    $$('.table-node.over, .table-node.over-full').forEach(n => n.classList.remove('over','over-full'));
  };

  const applyPosition = () => {
    if (!lastPointerClient) return;
    const { cx, cy } = pointerToCanvas(lastPointerClient.x, lastPointerClient.y);
    const nx = Math.max(0, cx - offCanvasX);
    const ny = Math.max(0, cy - offCanvasY);
    moveTarget.style.left = nx + 'px';
    moveTarget.style.top = ny + 'px';
  };

  const onDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (skipOn && e.target.closest(skipOn)) return;
    if (pinch.active) return; // two-finger pinch takes precedence
    pointerId = e.pointerId;
    started = true;
    moved = false;
    dragArmed = !isRepositionMode && e.pointerType !== 'touch';
    startX = e.clientX; startY = e.clientY;
    lastPointerClient = { x: e.clientX, y: e.clientY };
    if (isRepositionMode) {
      origX = parseFloat(moveTarget.style.left) || 0;
      origY = parseFloat(moveTarget.style.top) || 0;
      const { cx, cy } = pointerToCanvas(e.clientX, e.clientY);
      offCanvasX = cx - origX;
      offCanvasY = cy - origY;
    }
    if (!isRepositionMode && e.pointerType === 'touch') {
      longPressTimer = setTimeout(() => {
        dragArmed = true;
        showGhost(ghostLabel?.() || '', e.clientX, e.clientY);
        document.body.classList.add('is-dragging');
        if (navigator.vibrate) navigator.vibrate(15);
      }, 280);
    }
    try { el.setPointerCapture(pointerId); } catch {}
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { passive: false });
    window.addEventListener('pointercancel', onCancel);
  };

  const onMove = (e) => {
    if (!started) return;
    if (pinch.active) { onCancel(); return; }
    lastPointerClient = { x: e.clientX, y: e.clientY };
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dist = Math.abs(dx) + Math.abs(dy);

    if (!moved && dist > threshold) moved = true;

    if (longPressTimer && moved && !dragArmed) {
      clearTimeout(longPressTimer); longPressTimer = null;
      started = false;
      releaseCapture();
      return;
    }

    if (!moved) return;

    if (isRepositionMode) {
      moveTarget.classList.add('drag-moving');
      e.preventDefault();
      applyPosition();
      if (onDragTick) {
        const fx = parseFloat(moveTarget.style.left) || 0;
        const fy = parseFloat(moveTarget.style.top) || 0;
        onDragTick(fx, fy);
      }
      if (!state.dragActive) {
        state.dragActive = true;
        state.dragTick = applyPosition;
      }
      startEdgeScroll();
    } else if (dragArmed) {
      e.preventDefault();
      el.classList.add('dragging');
      if ($('#drag-ghost').classList.contains('hidden')) {
        showGhost(ghostLabel?.() || '', e.clientX, e.clientY);
        document.body.classList.add('is-dragging');
      }
      moveGhost(e.clientX, e.clientY);
      highlightUnderPointer(e.clientX, e.clientY);
    }
  };

  const highlightUnderPointer = (x, y) => {
    hideGhost(true);
    const under = document.elementFromPoint(x, y);
    showGhost();
    clearHover();
    const t = under?.closest?.('.table-node');
    if (t) {
      const id = Number(t.dataset.tableId);
      const tb = state.tables.find(x => x.id === id);
      const cnt = tb ? tb.guests.length : 0;
      const cap = tb ? (Number(tb.capacity) || 10) : 10;
      t.classList.add(cnt >= cap ? 'over-full' : 'over');
    }
  };

  const releaseCapture = () => {
    try { el.releasePointerCapture(pointerId); } catch {}
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };

  const onUp = async (e) => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (!started) return;
    releaseCapture();
    const wasMoved = moved;
    const wasDragArmed = dragArmed;
    started = false;
    dragArmed = false;
    state.dragActive = false;
    state.dragTick = null;

    if (isRepositionMode) {
      moveTarget.classList.remove('drag-moving');
      if (wasMoved) {
        const fx = parseFloat(moveTarget.style.left) || 0;
        const fy = parseFloat(moveTarget.style.top) || 0;
        await onPositionChange?.(fx, fy);
        updateCanvasSize();
      } else {
        onClick?.();
      }
      if (pendingRefresh) scheduleRefresh();
      return;
    }

    el.classList.remove('dragging');
    hideGhost();
    document.body.classList.remove('is-dragging');
    if (wasMoved && wasDragArmed) {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      clearHover();
      if (under) await onDrop?.(under);
    } else if (!wasMoved) {
      onClick?.();
    }
  };

  const onCancel = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    releaseCapture();
    started = false; moved = false; dragArmed = false;
    state.dragActive = false;
    state.dragTick = null;
    el.classList.remove('dragging');
    if (moveTarget) moveTarget.classList.remove('drag-moving');
    hideGhost();
    document.body.classList.remove('is-dragging');
    clearHover();
  };

  el.addEventListener('pointerdown', onDown);
}

// ============ ZOOM CONTROLS: wheel + buttons + pinch ============
const pinch = { active: false, pointers: new Map(), startDist: 0, startZoom: 1 };

function setupZoomControls() {
  const wrap = $('.canvas-wrap');

  // Ctrl+wheel zoom
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = -e.deltaY;
    const factor = delta > 0 ? 1.1 : 0.9;
    setZoom(state.zoom * factor, e.clientX, e.clientY);
  }, { passive: false });

  // Buttons
  $('#zoom-in').addEventListener('click', () => setZoom(state.zoom + ZOOM_STEP));
  $('#zoom-out').addEventListener('click', () => setZoom(state.zoom - ZOOM_STEP));
  $('#zoom-label').addEventListener('click', () => fitView());

  // Touch pinch-zoom
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    pinch.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.pointers.size === 2) {
      const [a, b] = [...pinch.pointers.values()];
      pinch.active = true;
      pinch.startDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinch.startZoom = state.zoom;
    }
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!pinch.pointers.has(e.pointerId)) return;
    pinch.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.active && pinch.pointers.size >= 2) {
      const [a, b] = [...pinch.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.startDist > 0) {
        const ratio = dist / pinch.startDist;
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        setZoom(pinch.startZoom * ratio, cx, cy);
      }
      e.preventDefault();
    }
  }, { passive: false });

  const endPinch = (e) => {
    if (!pinch.pointers.has(e.pointerId)) return;
    pinch.pointers.delete(e.pointerId);
    if (pinch.pointers.size < 2) pinch.active = false;
  };
  wrap.addEventListener('pointerup', endPinch);
  wrap.addEventListener('pointercancel', endPinch);

  // Mouse/pen pan (hand drag). Touch already scrolls natively via touch-action.
  let panning = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (e.button !== 0) return;
    if (e.target.closest('.table-node')) return;
    if (e.target.closest('.zoom-controls, .floating-btn, button')) return;
    clearTableSelection();
    panning = {
      id: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      startSL: wrap.scrollLeft, startST: wrap.scrollTop,
      moved: false
    };
    wrap.classList.add('is-panning');
    try { wrap.setPointerCapture(e.pointerId); } catch {}
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!panning || e.pointerId !== panning.id) return;
    const dx = e.clientX - panning.startX;
    const dy = e.clientY - panning.startY;
    if (!panning.moved && (Math.abs(dx) + Math.abs(dy) > 4)) panning.moved = true;
    if (panning.moved) {
      wrap.scrollLeft = panning.startSL - dx;
      wrap.scrollTop = panning.startST - dy;
    }
  });
  const endPan = (e) => {
    if (!panning || e.pointerId !== panning.id) return;
    try { wrap.releasePointerCapture(panning.id); } catch {}
    panning = null;
    wrap.classList.remove('is-panning');
  };
  wrap.addEventListener('pointerup', endPan);
  wrap.addEventListener('pointercancel', endPan);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(state.zoom + ZOOM_STEP); }
    else if (e.key === '-') { e.preventDefault(); setZoom(state.zoom - ZOOM_STEP); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
  });

  window.addEventListener('resize', () => updateCanvasSize());
}

// Ghost helpers
function showGhost(label, x, y) {
  const g = $('#drag-ghost');
  if (label != null) g.textContent = label;
  if (typeof x === 'number') { g.style.left = x + 'px'; g.style.top = y + 'px'; }
  g.classList.remove('hidden');
  g.style.visibility = 'visible';
}
function moveGhost(x, y) {
  const g = $('#drag-ghost');
  g.style.left = x + 'px'; g.style.top = y + 'px';
}
function hideGhost(keepDOM) {
  const g = $('#drag-ghost');
  if (keepDOM) { g.style.visibility = 'hidden'; return; }
  g.classList.add('hidden');
  g.style.visibility = '';
}

// ============ GUEST MODAL ============
function openGuestModal(id) {
  const g = state.guests.find(x => x.id === id);
  if (!g) return;
  state.currentGuestId = id;

  $('#mg-name').textContent = g.name;
  $('#mg-name-input').value = g.name;
  $('#mg-phone-input').value = g.phone || '';
  $('#mg-email-input').value = g.email || '';
  $('#mg-extra-input').value = g.extra_info || '';
  $('#mg-confirmed-input').checked = !!g.confirmed;

  // Table selector
  const sel = $('#mg-table-select');
  sel.innerHTML =
    `<option value="">— sin mesa —</option>` +
    state.tables.map(t => `<option value="${t.id}" ${g.table_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

  state.pendingChildren = [];
  const children = state.guests.filter(x => x.parent_id === id);
  renderChildren(children);

  openModal('#modal-guest');
}

function renderChildren(existing) {
  const host = $('#mg-children');
  host.innerHTML = '';

  existing.forEach(c => host.appendChild(buildChildRow(c, false)));
  state.pendingChildren.forEach((c, idx) => host.appendChild(buildChildRow(c, true, idx)));

  if (!existing.length && !state.pendingChildren.length) {
    host.innerHTML = '<div class="hint" style="padding:6px 0;">Sin acompanantes. Agrega con el boton de arriba.</div>';
  }
}

function buildChildRow(child, pending, pendingIdx) {
  const parent = state.guests.find(g => g.id === state.currentGuestId);
  const row = document.createElement('div');
  row.className = 'child-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = child.name || '';
  nameInput.placeholder = 'Nombre acompanante';

  const sel = document.createElement('select');
  const sameSelected = pending
    ? (!child._assign || child._assign === 'same')
    : (child.table_id && parent && child.table_id === parent.table_id);
  const noneSelected = pending
    ? child._assign === 'none'
    : !child.table_id;

  sel.innerHTML = [
    `<option value="same" ${sameSelected ? 'selected' : ''}>Misma mesa</option>`,
    `<option value="none" ${noneSelected ? 'selected' : ''}>Sin mesa</option>`,
    ...state.tables
      .filter(t => !parent || t.id !== parent.table_id)
      .map(t => {
        const sel = pending
          ? String(child._assign) === String(t.id)
          : child.table_id === t.id;
        return `<option value="${t.id}" ${sel ? 'selected' : ''}>${esc(t.name)}</option>`;
      })
  ].join('');

  const del = document.createElement('button');
  del.textContent = '×';
  del.title = 'Eliminar';

  if (pending) {
    nameInput.addEventListener('input', () => { state.pendingChildren[pendingIdx].name = nameInput.value; });
    sel.addEventListener('change', () => { state.pendingChildren[pendingIdx]._assign = sel.value; });
    state.pendingChildren[pendingIdx]._assign = state.pendingChildren[pendingIdx]._assign || 'same';
    del.addEventListener('click', () => {
      state.pendingChildren.splice(pendingIdx, 1);
      const children = state.guests.filter(x => x.parent_id === state.currentGuestId);
      renderChildren(children);
    });
  } else {
    nameInput.addEventListener('change', async () => {
      await api.updateGuest(child.id, { name: nameInput.value });
      toast('Acompanante actualizado', 'success');
      await refresh();
    });
    sel.addEventListener('change', async () => {
      let target = null;
      if (sel.value === 'same') target = parent?.table_id ?? null;
      else if (sel.value === 'none') target = null;
      else target = Number(sel.value);
      await api.assignGuest(child.id, target);
      toast('Mesa actualizada', 'success');
      await refresh();
      openGuestModal(state.currentGuestId);
    });
    del.addEventListener('click', async () => {
      if (!(await confirmDialog('Se eliminara este acompanante. No se puede deshacer.', { title: 'Eliminar acompanante', okText: 'Eliminar', danger: true }))) return;
      await api.deleteGuest(child.id);
      await refresh();
      openGuestModal(state.currentGuestId);
    });
  }

  row.appendChild(nameInput);
  row.appendChild(sel);
  row.appendChild(del);
  return row;
}

$('#mg-add-plus').addEventListener('click', () => {
  state.pendingChildren.push({ name: '', _assign: 'same' });
  const children = state.guests.filter(x => x.parent_id === state.currentGuestId);
  renderChildren(children);
});

$('#mg-save').addEventListener('click', async () => {
  const id = state.currentGuestId;
  const parent = state.guests.find(g => g.id === id);
  const newName = $('#mg-name-input').value.trim() || parent.name;
  const selectedTableId = $('#mg-table-select').value;
  const newTableId = selectedTableId === '' ? null : Number(selectedTableId);

  await api.updateGuest(id, {
    name: newName,
    phone: $('#mg-phone-input').value.trim() || null,
    email: $('#mg-email-input').value.trim() || null,
    extra_info: $('#mg-extra-input').value.trim() || null
  });

  const newConfirmed = $('#mg-confirmed-input').checked ? 1 : 0;
  if (newConfirmed !== (parent.confirmed || 0)) {
    await api.setConfirmed(id, newConfirmed);
  }

  if (newTableId !== parent.table_id) {
    await api.assignGuest(id, newTableId);
  }

  for (const c of state.pendingChildren) {
    if (!c.name?.trim()) continue;
    let table_id = null;
    if (c._assign === 'same') table_id = newTableId;
    else if (c._assign === 'none') table_id = null;
    else table_id = Number(c._assign);
    await api.createGuest({
      name: c.name.trim(),
      parent_id: id,
      is_plus_one: 1,
      table_id
    });
  }
  state.pendingChildren = [];
  toast('Guardado', 'success');
  closeModal('#modal-guest');
  refresh();
});

$('#mg-delete').addEventListener('click', async () => {
  if (!(await confirmDialog('Se eliminara el invitado y todos sus acompanantes. Esta accion no se puede deshacer.', { title: 'Eliminar invitado', okText: 'Eliminar', danger: true }))) return;
  await api.deleteGuest(state.currentGuestId);
  closeModal('#modal-guest');
  refresh();
});

// ============ TABLE EDITOR CONTROLS (layout / color / rotation) ============
const CAP_ID = { mt: 'mt-capacity-input', nt: 'nt-capacity' };
const ROT_ID = { mt: 'mt-rot-input', nt: 'nt-rot-input' };
const _layoutDrop = { mt: 0, nt: 0 };
const _colorPick = { mt: null, nt: null };

function layoutTotal(L) {
  return Math.max(1, (L.head | 0) * 2 + (L.side | 0) * 2 + (L.corners ? 4 : 0) - (L.drop | 0));
}
// Keep head + corners, solve `side` to hit a target total as evenly as possible.
// Any odd seat left over is dropped from the trailing slot of one lateral.
function solveLayout({ head, corners, total }) {
  head = Math.max(0, head | 0);
  const cor = corners ? 4 : 0;
  const remain = Math.max(0, (total | 0) - head * 2 - cor);
  const side = Math.ceil(remain / 2);
  const drop = Math.max(0, Math.min(side, side * 2 - remain));
  return { head, side, corners: !!corners, drop };
}
function readLayoutFields(prefix) {
  return {
    head: Math.max(0, Math.min(12, parseInt($(`#${prefix}-lay-head`).value, 10) || 0)),
    side: Math.max(0, Math.min(60, parseInt($(`#${prefix}-lay-side`).value, 10) || 0)),
    corners: $(`#${prefix}-lay-corners`).checked,
    drop: 0
  };
}
function currentLayout(prefix) {
  const L = readLayoutFields(prefix);
  L.drop = _layoutDrop[prefix] || 0;
  if (L.drop > L.side) L.drop = 0;
  return L;
}
function readRot(prefix) {
  let n = parseInt($(`#${ROT_ID[prefix]}`).value, 10);
  if (!Number.isFinite(n)) n = 0;
  return ((n % 360) + 360) % 360;
}

// Live preview — uses the SAME geometry as the canvas, shows seat numbers,
// follows the table rotation, and tints seats/numbers that are already taken.
function drawLayoutPreview(prefix) {
  const svg = $(`#${prefix}-lay-preview`);
  if (!svg) return;
  const L = currentLayout(prefix);
  const rot = readRot(prefix);

  let occ = new Set();
  let count = 0;
  if (prefix === 'mt' && state.currentTableId != null) {
    const t = state.tables.find(x => x.id === state.currentTableId);
    if (t) {
      count = t.guests.length;
      for (const n of computeSeating(t).seatOf.values()) occ.add(n);
    }
  }

  const { w, h, seats } = rectGeometry(count, L);
  const cx = w / 2, cy = h / 2;
  const rad = rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const rotate = (px, py) => [
    cx + (px - cx) * cos - (py - cy) * sin,
    cy + (px - cx) * sin + (py - cy) * cos
  ];

  const PAD = SEAT_OFF + 22;
  const half = Math.hypot(w / 2 + PAD, h / 2 + PAD);
  svg.setAttribute('viewBox', `${(cx - half).toFixed(1)} ${(cy - half).toFixed(1)} ${(2 * half).toFixed(1)} ${(2 * half).toFixed(1)}`);
  const r = Math.max(4.5, half * 0.032);
  const fs = Math.max(7, half * 0.05);

  let dots = '', labels = '';
  seats.forEach((s) => {
    const [rx, ry] = rotate(s.x, s.y);
    const taken = occ.has(s.n);
    dots += `<circle cx="${rx.toFixed(1)}" cy="${ry.toFixed(1)}" r="${r.toFixed(1)}" class="mp-seat${taken ? ' mp-taken' : ''}"/>`;
    const dx = s.x - cx, dy = s.y - cy, len = Math.hypot(dx, dy) || 1;
    const [lx, ly] = rotate(s.x + (dx / len) * (r + fs * 0.9), s.y + (dy / len) * (r + fs * 0.9));
    labels += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="${fs.toFixed(1)}" class="mp-num${taken ? ' mp-num-taken' : ''}" text-anchor="middle" dominant-baseline="central">${s.n}</text>`;
  });

  svg.innerHTML =
    `<g transform="rotate(${rot} ${cx} ${cy})"><rect x="0" y="0" width="${w}" height="${h}" rx="14" class="mp-table"/></g>` +
    dots + labels;
}
function refreshLayoutUI(prefix) {
  $(`#${prefix}-lay-total`).textContent = layoutTotal(currentLayout(prefix));
  drawLayoutPreview(prefix);
}
function syncCapacityField(prefix) {
  const shapeEl = document.querySelector(`input[name="${prefix}-shape"]:checked`);
  const isRect = shapeEl && shapeEl.value === 'square';
  const cap = $(`#${CAP_ID[prefix]}`);
  if (isRect) {
    cap.value = layoutTotal(currentLayout(prefix));
    cap.readOnly = true;
    cap.classList.add('is-derived');
  } else {
    cap.readOnly = false;
    cap.classList.remove('is-derived');
  }
}
function syncShapeUI(prefix) {
  const shapeEl = document.querySelector(`input[name="${prefix}-shape"]:checked`);
  const isRect = shapeEl && shapeEl.value === 'square';
  const led = $(`#${prefix}-layout`);
  if (led) led.hidden = !isRect;
  if (isRect) refreshLayoutUI(prefix);
  syncCapacityField(prefix);
}
function bindLayoutEditor(prefix) {
  ['head', 'side'].forEach(k => {
    $(`#${prefix}-lay-${k}`).addEventListener('input', () => {
      _layoutDrop[prefix] = 0; refreshLayoutUI(prefix); syncCapacityField(prefix);
    });
  });
  $(`#${prefix}-lay-corners`).addEventListener('change', () => {
    // Toggling corners keeps the head count fixed — the 4 corner seats are
    // taken from / given back to the laterals so the total stays the same.
    const f = readLayoutFields(prefix);
    const prevDrop = _layoutDrop[prefix] || 0;
    const before = Math.max(2 * f.head + 2, 2 * f.head + 2 * f.side + (f.corners ? 0 : 4) - prevDrop);
    const solved = solveLayout({ head: f.head, corners: f.corners, total: before });
    _layoutDrop[prefix] = solved.drop;
    $(`#${prefix}-lay-side`).value = solved.side;
    refreshLayoutUI(prefix); syncCapacityField(prefix);
  });
  $(`#${prefix}-lay-apply`).addEventListener('click', () => {
    const total = parseInt($(`#${prefix}-lay-target`).value, 10);
    if (!Number.isFinite(total) || total < 2) { toast('Escribe un total valido', 'error'); return; }
    const cur = readLayoutFields(prefix);
    const solved = solveLayout({ head: cur.head, corners: cur.corners, total });
    _layoutDrop[prefix] = solved.drop;
    $(`#${prefix}-lay-side`).value = solved.side;
    refreshLayoutUI(prefix); syncCapacityField(prefix);
  });
}
function buildColorRow(prefix) {
  const host = $(`#${prefix}-color-row`);
  host.innerHTML =
    `<button type="button" class="sw sw-none" data-c="" title="Sin color">&#10005;</button>` +
    TABLE_COLORS.map(c => `<button type="button" class="sw" data-c="${c}" style="--sw:${c}"></button>`).join('') +
    `<label class="sw sw-custom" title="Personalizado"><input type="color" id="${prefix}-color-custom" /></label>`;
  host.querySelectorAll('.sw[data-c]').forEach(b => b.addEventListener('click', () => setColor(prefix, b.dataset.c || null)));
  $(`#${prefix}-color-custom`).addEventListener('input', e => setColor(prefix, e.target.value));
}
function setColor(prefix, hex) {
  hex = hex ? String(hex).toLowerCase() : null;
  _colorPick[prefix] = hex;
  const host = $(`#${prefix}-color-row`);
  const inPreset = hex && TABLE_COLORS.some(c => c.toLowerCase() === hex);
  host.querySelectorAll('.sw').forEach(b => {
    if (b.classList.contains('sw-custom')) {
      b.classList.toggle('on', !!hex && !inPreset);
      b.style.setProperty('--sw', hex && !inPreset ? hex : 'transparent');
    } else if (b.classList.contains('sw-none')) {
      b.classList.toggle('on', !hex);
    } else {
      b.classList.toggle('on', !!hex && b.dataset.c.toLowerCase() === hex);
    }
  });
}
function bindRotRow(prefix) {
  const input = $(`#${ROT_ID[prefix]}`);
  input.closest('.rotate-row').querySelectorAll('.rot-btn').forEach(b => {
    b.addEventListener('click', () => {
      const cur = parseInt(input.value, 10) || 0;
      input.value = (cur + Number(b.dataset.rot) + 360) % 360;
      drawLayoutPreview(prefix);
    });
  });
  input.addEventListener('input', () => drawLayoutPreview(prefix));
}
function initTableEditors() {
  ['mt', 'nt'].forEach(p => {
    buildColorRow(p);
    bindLayoutEditor(p);
    bindRotRow(p);
    $$(`input[name="${p}-shape"]`).forEach(r => r.addEventListener('change', () => syncShapeUI(p)));
  });
}

// ============ TABLE MODAL ============
function openTableModal(id) {
  const t = state.tables.find(x => x.id === id);
  if (!t) return;
  state.currentTableId = id;

  $('#mt-name').textContent = t.name;
  $('#mt-count').textContent = t.guests.length;
  $('#mt-name-input').value = t.name;
  $('#mt-capacity-input').value = t.capacity || 10;

  const shape = t.shape === 'square' ? 'square' : 'circle';
  const shapeInput = document.querySelector(`input[name="mt-shape"][value="${shape}"]`);
  if (shapeInput) shapeInput.checked = true;

  const L = (shape === 'square' && t.seat_layout) ? t.seat_layout : defaultLayoutFor(t.capacity);
  _layoutDrop.mt = L.drop || 0;
  $('#mt-lay-head').value = L.head | 0;
  $('#mt-lay-side').value = L.side | 0;
  $('#mt-lay-corners').checked = !!L.corners;
  $('#mt-lay-target').value = '';

  setColor('mt', t.color || null);
  $('#mt-rot-input').value = Math.round(Number(t.rotation) || 0);
  syncShapeUI('mt');

  renderTableMembers(t);
  updateQuickList();
  $('#mt-quick').value = '';
  $('#mt-new').value = '';

  openModal('#modal-table');
}

function renderTableMembers(t) {
  const host = $('#mt-members');
  if (!t.guests.length) {
    host.innerHTML = '<div class="hint" style="padding:6px 0;">Mesa vacia. Usa los campos de abajo para agregar.</div>';
    return;
  }
  const { seatCount, seatOf, guestAt } = computeSeating(t);
  const takenBy = {};
  guestAt.forEach((g, i) => { if (g) takenBy[i + 1] = g; });

  host.innerHTML = t.guests.map(g => {
    const at = seatOf.get(g.id);
    const pinned = Number.isInteger(Number(g.seat));
    const opts = [`<option value="">auto${at ? ` (${at})` : ''}</option>`];
    for (let n = 1; n <= seatCount; n++) {
      const occ = takenBy[n];
      const label = occ && occ.id !== g.id ? `${n} · ${occ.name.split(' ')[0]}` : `${n}`;
      opts.push(`<option value="${n}" ${pinned && Number(g.seat) === n ? 'selected' : ''}>${esc(label)}</option>`);
    }
    return `
    <div class="member-row ${g.confirmed ? 'is-confirmed' : ''}" data-guest-id="${g.id}">
      <div class="left">
        <button class="confirm-toggle ${g.confirmed ? 'on' : ''}" data-confirm="${g.id}" aria-pressed="${g.confirmed ? 'true' : 'false'}" title="${g.confirmed ? 'Confirmado' : 'Marcar confirmado'}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <div>
          <div class="name">${esc(g.name)} ${g.is_plus_one ? '<span class="tag tag-plus">+1</span>' : ''}</div>
          <div class="phone">${g.phone ? esc(g.phone) : 'sin telefono'}</div>
        </div>
      </div>
      <div class="member-actions">
        <label class="member-seat" title="Asiento">
          <span>#</span>
          <select data-seat-for="${g.id}">${opts.join('')}</select>
        </label>
        <button data-act="info">Ver</button>
        <button data-act="remove" title="Sacar">Sacar</button>
      </div>
    </div>`;
  }).join('');

  $$('.member-row', host).forEach(row => {
    const id = Number(row.dataset.guestId);
    row.querySelector('[data-act="info"]').addEventListener('click', () => {
      closeModal('#modal-table');
      openGuestModal(id);
    });
    row.querySelector('select[data-seat-for]').addEventListener('change', async (e) => {
      const v = e.target.value ? Number(e.target.value) : null;
      await api.assignGuest(id, state.currentTableId, v);
      await refresh();
      const updated = state.tables.find(x => x.id === state.currentTableId);
      if (updated) { $('#mt-count').textContent = updated.guests.length; renderTableMembers(updated); updateQuickList(); }
    });
    row.querySelector('[data-act="remove"]').addEventListener('click', async () => {
      await api.assignGuest(id, null);
      await refresh();
      const updated = state.tables.find(x => x.id === state.currentTableId);
      $('#mt-count').textContent = updated.guests.length;
      renderTableMembers(updated);
      updateQuickList();
    });
    row.querySelector('.confirm-toggle').addEventListener('click', async (e) => {
      e.stopPropagation();
      const g = state.guests.find(x => x.id === id);
      if (!g) return;
      const next = g.confirmed ? 0 : 1;
      g.confirmed = next;
      e.currentTarget.classList.toggle('on', !!next);
      row.classList.toggle('is-confirmed', !!next);
      e.currentTarget.setAttribute('aria-pressed', next ? 'true' : 'false');
      await api.setConfirmed(id, next);
    });
  });
}

function updateQuickList() {
  const list = $('#mt-quick-list');
  const unassigned = state.guests.filter(g => !g.table_id);
  list.innerHTML = unassigned
    .map(g => `<option value="${esc(g.name)}${g.phone ? ' — ' + esc(g.phone) : ''}"></option>`)
    .join('');
}

$('#mt-quick-add').addEventListener('click', async () => {
  const val = $('#mt-quick').value.trim();
  if (!val) return;
  const unassigned = state.guests.filter(g => !g.table_id);
  const match = unassigned.find(g => val.startsWith(g.name));
  if (!match) { toast('No se encontro invitado sin mesa', 'error'); return; }
  await api.assignGuest(match.id, state.currentTableId);
  toast('Agregado', 'success');
  await refresh();
  const updated = state.tables.find(x => x.id === state.currentTableId);
  $('#mt-count').textContent = updated.guests.length;
  renderTableMembers(updated);
  updateQuickList();
  $('#mt-quick').value = '';
});

$('#mt-new-add').addEventListener('click', async () => {
  const name = $('#mt-new').value.trim();
  if (!name) return;
  await api.createGuest({ name, table_id: state.currentTableId });
  toast('Invitado creado y agregado', 'success');
  await refresh();
  const updated = state.tables.find(x => x.id === state.currentTableId);
  $('#mt-count').textContent = updated.guests.length;
  renderTableMembers(updated);
  updateQuickList();
  $('#mt-new').value = '';
});

$('#mt-save').addEventListener('click', async () => {
  const shapeEl = document.querySelector('input[name="mt-shape"]:checked');
  const shape = shapeEl ? shapeEl.value : 'circle';
  const body = {
    name: $('#mt-name-input').value.trim() || 'Mesa',
    shape,
    color: _colorPick.mt,
    rotation: readRot('mt')
  };
  if (shape === 'square') {
    body.seat_layout = currentLayout('mt');
  } else {
    body.seat_layout = null;
    body.capacity = Number($('#mt-capacity-input').value) || 10;
  }
  await api.updateTable(state.currentTableId, body);
  toast('Mesa actualizada', 'success');
  closeModal('#modal-table');
  refresh();
});

$('#mt-delete').addEventListener('click', async () => {
  if (!(await confirmDialog('Los invitados asignados quedaran sin mesa. La mesa se elimina de forma permanente.', { title: 'Eliminar mesa', okText: 'Eliminar', danger: true }))) return;
  await api.deleteTable(state.currentTableId);
  closeModal('#modal-table');
  refresh();
});

// ============ SEAT PICKER ============
let _seatPick = { tableId: null, seat: null };

function openSeatPicker(tableId, seatNum) {
  const t = state.tables.find(x => x.id === tableId);
  if (!t) return;
  _seatPick = { tableId, seat: seatNum };
  const { guestAt } = computeSeating(t);
  const occ = guestAt[seatNum - 1] || null;
  $('#ms-title').textContent = `${t.name} · asiento ${seatNum}`;
  $('#ms-current').textContent = occ ? `Ocupa: ${occ.name}` : 'Asiento libre';
  $('#ms-clear').style.display = occ ? '' : 'none';
  $('#ms-search').value = '';
  renderSeatPickList('');
  openModal('#modal-seat');
  setTimeout(() => $('#ms-search').focus(), 50);
}

function renderSeatPickList(q) {
  const t = state.tables.find(x => x.id === _seatPick.tableId);
  const host = $('#ms-list');
  if (!t) { host.innerHTML = ''; return; }
  q = (q || '').toLowerCase().trim();
  const { seatOf, guestAt } = computeSeating(t);
  const here = guestAt[_seatPick.seat - 1] || null;
  const cands = state.guests.filter(g => {
    if (g.id === here?.id) return false;                 // already in this seat
    if (g.table_id && g.table_id !== t.id) return false; // busy at another table
    if (q && !g.name.toLowerCase().includes(q)) return false;
    return true;
  }).slice(0, 80);

  host.innerHTML = cands.length
    ? cands.map(g => {
        const at = seatOf.get(g.id);
        const meta = g.table_id === t.id ? (at ? `asiento ${at}` : 'en la mesa') : 'sin mesa';
        return `<button class="seat-pick-item" data-gid="${g.id}">
          <span class="spi-name">${esc(g.name)}${g.is_plus_one ? ' <span class="tag tag-plus">+1</span>' : ''}</span>
          <span class="spi-meta">${meta}</span>
        </button>`;
      }).join('')
    : '<div class="hint" style="padding:12px 2px;">Nadie disponible.</div>';

  $$('.seat-pick-item', host).forEach(b => b.addEventListener('click', async () => {
    await api.assignGuest(Number(b.dataset.gid), _seatPick.tableId, _seatPick.seat);
    toast('Asiento asignado', 'success');
    closeModal('#modal-seat');
    await refresh();
    if (!$('#modal-table').classList.contains('hidden')) {
      const t2 = state.tables.find(x => x.id === state.currentTableId);
      if (t2) { $('#mt-count').textContent = t2.guests.length; renderTableMembers(t2); updateQuickList(); }
    }
  }));
}

$('#ms-search').addEventListener('input', (e) => renderSeatPickList(e.target.value));
$('#ms-clear').addEventListener('click', async () => {
  const t = state.tables.find(x => x.id === _seatPick.tableId);
  if (!t) return;
  const occ = computeSeating(t).guestAt[_seatPick.seat - 1];
  if (occ) await api.assignGuest(occ.id, null);   // out of the table
  closeModal('#modal-seat');
  await refresh();
  if (!$('#modal-table').classList.contains('hidden')) {
    const t2 = state.tables.find(x => x.id === state.currentTableId);
    if (t2) { $('#mt-count').textContent = t2.guests.length; renderTableMembers(t2); updateQuickList(); }
  }
});

// ============ NEW GUEST / NEW TABLE ============
$('#btn-new-guest').addEventListener('click', () => {
  $('#ng-name').value = ''; $('#ng-phone').value = ''; $('#ng-email').value = '';
  openModal('#modal-new-guest');
  setTimeout(() => $('#ng-name').focus(), 50);
});
$('#ng-save').addEventListener('click', async () => {
  const name = $('#ng-name').value.trim();
  if (!name) { toast('Nombre requerido', 'error'); return; }
  await api.createGuest({
    name,
    phone: $('#ng-phone').value.trim() || null,
    email: $('#ng-email').value.trim() || null
  });
  closeModal('#modal-new-guest');
  toast('Invitado creado', 'success');
  refresh();
});

function getNextTableNumber() {
  let max = 0;
  state.tables.forEach(t => {
    const m = /^mesa\s+(\d+)$/i.exec(t.name || '');
    if (m) max = Math.max(max, Number(m[1]));
  });
  return max + 1;
}

$('#btn-new-table').addEventListener('click', () => {
  $('#nt-name').value = `Mesa ${getNextTableNumber()}`;
  $('#nt-capacity').value = 10;
  $('#nt-count').value = 1;
  const circleRadio = document.querySelector('input[name="nt-shape"][value="circle"]');
  if (circleRadio) circleRadio.checked = true;
  _layoutDrop.nt = 0;
  const L = defaultLayoutFor(10);
  $('#nt-lay-head').value = L.head;
  $('#nt-lay-side').value = L.side;
  $('#nt-lay-corners').checked = false;
  $('#nt-lay-target').value = '';
  setColor('nt', null);
  $('#nt-rot-input').value = 0;
  syncShapeUI('nt');
  openModal('#modal-new-table');
});
$('#nt-save').addEventListener('click', async () => {
  const count = Math.max(1, Math.min(50, Number($('#nt-count').value) || 1));
  const shapeEl = document.querySelector('input[name="nt-shape"]:checked');
  const shape = shapeEl ? shapeEl.value : 'circle';
  const common = {
    shape,
    color: _colorPick.nt,
    rotation: readRot('nt'),
    ...(shape === 'square'
      ? { seat_layout: currentLayout('nt') }
      : { capacity: Number($('#nt-capacity').value) || 10 })
  };
  const cols = 4;
  const startIdx = state.tables.length;
  const tables = [];

  if (count === 1) {
    const name = $('#nt-name').value.trim();
    if (!name) { toast('Nombre requerido', 'error'); return; }
    tables.push({
      name,
      position_x: 80 + (startIdx % cols) * 280,
      position_y: 80 + Math.floor(startIdx / cols) * 280,
      ...common
    });
  } else {
    const startNum = getNextTableNumber();
    for (let i = 0; i < count; i++) {
      const idx = startIdx + i;
      tables.push({
        name: `Mesa ${startNum + i}`,
        position_x: 80 + (idx % cols) * 280,
        position_y: 80 + Math.floor(idx / cols) * 280,
        ...common
      });
    }
  }

  await fetch('/api/tables/bulk', { method: 'POST', headers: json(), body: JSON.stringify({ tables }) });
  closeModal('#modal-new-table');
  toast(count === 1 ? 'Mesa creada' : `${count} mesas creadas`, 'success');
  refresh();
});

// ============ EXPORT / IMPORT BACKUP ============
$('#btn-export').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/export');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mesas-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Respaldo descargado', 'success');
  } catch (err) {
    toast('Error al exportar', 'error');
  }
});

$('#backup-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!Array.isArray(payload.tables) || !Array.isArray(payload.guests)) {
      toast('Archivo no valido', 'error'); return;
    }
    const ok = await confirmDialog(
      `Se cargaran ${payload.tables.length} mesas y ${payload.guests.length} invitados. Esto reemplaza TODO lo que tienes actualmente.`,
      { title: 'Cargar respaldo', okText: 'Reemplazar', danger: true }
    );
    if (!ok) { e.target.value = ''; return; }
    await api.importPayload(payload);
    toast('Respaldo cargado', 'success');
    await refresh();
  } catch (err) {
    toast('Archivo invalido', 'error');
  }
  e.target.value = '';
});

// ============ RESET ============
$('#btn-reset').addEventListener('click', async () => {
  if (!(await confirmDialog('Se borraran TODAS las mesas e invitados. Esta accion no se puede deshacer.', { title: 'Borrar todo', okText: 'Borrar todo', danger: true }))) return;
  await api.reset();
  toast('Todo borrado', 'success');
  refresh();
});

// ============ SEARCH / FILTERS ============
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderGuestList();
  renderTableList();
});
$$('.chip').forEach(c => {
  c.addEventListener('click', () => {
    $$('.chip').forEach(x => x.classList.remove('chip-active'));
    c.classList.add('chip-active');
    state.filter = c.dataset.filter;
    renderGuestList();
  });
});

// ============ AUTO-ARRANGE TABLES ============
async function autoArrangeTables() {
  if (!state.tables.length) { toast('No hay mesas', 'error'); return; }
  const wrap = $('.canvas-wrap');
  const maxW = Math.max(900, Math.floor(wrap.clientWidth / state.zoom) - 80);
  const pad = 40;
  const nameGap = 36;
  let x = pad, y = pad, rowH = 0;
  const updates = [];
  const sorted = [...state.tables].sort((a, b) => a.id - b.id);

  for (const t of sorted) {
    const b = tableBox(t);
    const fullH = b.S + nameGap;
    if (x > pad && x + b.S > maxW) {
      x = pad;
      y += rowH + pad;
      rowH = 0;
    }
    // pack the node box at (x,y); store position as the table origin inside it
    updates.push({ id: t.id, position_x: Math.round(x + b.offX), position_y: Math.round(y + b.offY), _boxX: x, _boxY: y });
    x += b.S + pad;
    if (fullH > rowH) rowH = fullH;
  }

  for (const u of updates) {
    const node = document.querySelector(`.table-node[data-table-id="${u.id}"]`);
    if (node) {
      node.classList.add('rearrange');
      node.style.left = u._boxX + 'px';
      node.style.top = u._boxY + 'px';
      setTimeout(() => node.classList.remove('rearrange'), 700);
    }
    const t = state.tables.find(x => x.id === u.id);
    if (t) { t.position_x = u.position_x; t.position_y = u.position_y; }
  }
  updateCanvasSize();

  await fetch('/api/tables/arrange', {
    method: 'POST',
    headers: json(),
    body: JSON.stringify({ positions: updates })
  });
  toast('Mesas ordenadas', 'success');
}

// ============ UNDO ============
async function undoLast() {
  const r = await api.undo();
  if (!r.ok) { toast('Nada que deshacer', 'error'); return; }
  toast('Deshecho', 'success');
  await refresh();
}

// ============ SIDEBAR VIEW TABS ============
function setView(view) {
  state.view = view;
  $$('.tab-btn').forEach(b => b.classList.toggle('tab-active', b.dataset.view === view));
  const showGuests = view === 'guests';
  $('#guest-list').style.display = showGuests ? '' : 'none';
  $('#table-list').style.display = showGuests ? 'none' : '';
  $('#guest-filters').style.display = showGuests ? '' : 'none';
  $('#search').placeholder = showGuests ? 'Buscar invitado...' : 'Buscar mesa...';
}
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

// ============ EXCEL IMPORT ============
$('#excel-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) { toast('Archivo vacio', 'error'); return; }

  const headers = rows[0].map(String);
  const data = rows.slice(1).filter(r => r.some(c => String(c).trim() !== ''));

  state.importHeaders = headers;
  state.importRows = data;

  const optHtml = (includeNone) => {
    const opts = includeNone ? ['<option value="-1">— ninguno —</option>'] : [];
    headers.forEach((h, i) => opts.push(`<option value="${i}">${esc(h || `Col ${i+1}`)}</option>`));
    return opts.join('');
  };

  $('#imp-name').innerHTML = optHtml(false);
  $('#imp-phone').innerHTML = optHtml(true);
  $('#imp-email').innerHTML = optHtml(true);
  $('#imp-extra').innerHTML = optHtml(true);
  $('#imp-size').innerHTML = optHtml(true);

  const findIdx = (re) => headers.findIndex(h => re.test(String(h).toLowerCase()));
  const nameIdx = findIdx(/nombre|name|invitado/);
  const phoneIdx = findIdx(/tel|phone|celular|movil|whats/);
  const emailIdx = findIdx(/mail|correo|email/);
  const sizeIdx = findIdx(/cantidad|personas|cant|tam|size|grupo|pax/);
  if (nameIdx >= 0) $('#imp-name').value = nameIdx;
  $('#imp-phone').value = phoneIdx >= 0 ? phoneIdx : -1;
  $('#imp-email').value = emailIdx >= 0 ? emailIdx : -1;
  $('#imp-extra').value = -1;
  $('#imp-size').value = sizeIdx >= 0 ? sizeIdx : -1;

  $('#imp-thead').innerHTML = `<tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>`;
  $('#imp-tbody').innerHTML = data.slice(0, 8).map(r =>
    `<tr>${headers.map((_, i) => `<td>${esc(r[i])}</td>`).join('')}</tr>`
  ).join('');
  $('#imp-count').textContent = `${data.length} filas detectadas (tras encabezado).`;

  openModal('#modal-import');
  e.target.value = '';
});

$('#imp-confirm').addEventListener('click', async () => {
  const nI = Number($('#imp-name').value);
  const pI = Number($('#imp-phone').value);
  const eI = Number($('#imp-email').value);
  const xI = Number($('#imp-extra').value);
  const sI = Number($('#imp-size').value);

  if (nI < 0) { toast('Elige columna de nombre', 'error'); return; }

  const parseSize = (v) => {
    const n = parseInt(String(v ?? '').trim(), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(20, n);
  };

  const payload = state.importRows.map(r => ({
    name: String(r[nI] ?? '').trim(),
    phone: pI >= 0 ? String(r[pI] ?? '').trim() || null : null,
    email: eI >= 0 ? String(r[eI] ?? '').trim() || null : null,
    extra_info: xI >= 0 ? String(r[xI] ?? '').trim() || null : null,
    group_size: sI >= 0 ? parseSize(r[sI]) : 1
  })).filter(g => g.name);

  if (!payload.length) { toast('Sin filas validas', 'error'); return; }

  const res = await api.createGuestsBulk(payload);
  closeModal('#modal-import');
  toast(`${res.inserted} invitados importados`, 'success');
  refresh();
});

// ============ MOBILE DRAWER ============
$('#btn-menu').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-open');
});
$('#sidebar-backdrop').addEventListener('click', () => {
  document.body.classList.remove('sidebar-open');
});
// Close drawer when a guest card or table card is clicked on mobile
document.addEventListener('click', (e) => {
  if (window.innerWidth > 760) return;
  if (e.target.closest('.guest-card') || e.target.closest('.table-card')) {
    setTimeout(() => document.body.classList.remove('sidebar-open'), 100);
  }
});

// ============ MODAL HELPERS ============
function openModal(sel) { $(sel).classList.remove('hidden'); }
function closeModal(sel) {
  $(sel).classList.add('hidden');
  if (sel === '#modal-table') clearTableSelection();
}
$$('.modal').forEach(m => {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.hasAttribute('data-close')) {
      m.classList.add('hidden');
      if (m.id === 'modal-table') clearTableSelection();
    }
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $$('.modal').forEach(m => m.classList.add('hidden'));
    clearTableSelection();
  }
});

// ============ RENAME EVENT ============
$('#app-title').addEventListener('click', renameEvent);

// ============ THEME TOGGLE ============
let themeTransitionTimer = null;
function applyTheme(theme, animate = false) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-transition');
    clearTimeout(themeTransitionTimer);
    themeTransitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 350);
  }
  root.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#15171b' : '#faf9f5');
  try { localStorage.setItem('theme', theme); } catch {}
}
$('#btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark', true);
  renderCanvas(); // recompute per-table color tones for the new theme
});

// ============ AUTO-ARRANGE / UNDO UI ============
$('#btn-arrange').addEventListener('click', autoArrangeTables);
$('#btn-undo').addEventListener('click', undoLast);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    if (e.target.closest('input, textarea, select')) return;
    e.preventDefault();
    undoLast();
  }
});

// ============ PRINT / PDF ============
// Seat number for a guest, honouring pinned seats (same resolver as the canvas).
function guestSeatInfo(guestId) {
  const g = state.guests.find(x => x.id === guestId);
  if (!g || !g.table_id) return null;
  const t = state.tables.find(x => x.id === g.table_id);
  if (!t) return null;
  const seat = computeSeating(t).seatOf.get(guestId);
  if (!seat) return null;
  return { table: t, seat };
}

function tableSVG(t) {
  const { geo, seatCount, guestAt } = computeSeating(t);
  const count = t.guests.length;
  const baseCap = geo.capacity;
  const px = t.position_x, py = t.position_y;
  const rot = Number(t.rotation) || 0;
  const cx = px + geo.w / 2, cy = py + geo.h / 2;
  const cxr = geo.w / 2, cyr = geo.h / 2;

  let fill = '#ffffff', stroke = '#c9c4b6', ink = '#23211d', seatFill = '#23211d';
  if (t.color) {
    const b = hexToHsl(t.color);
    if (b) {
      fill = _hsl(b.h, b.s * 0.55, 95);
      stroke = _hsl(b.h, b.s * 0.5, 52);
      ink = _hsl(b.h, b.s * 0.6, 30);
      seatFill = ink;
    }
  }

  const shapeEl = t.shape === 'square'
    ? `<rect x="${px}" y="${py}" width="${geo.w}" height="${geo.h}" rx="16" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${geo.w / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;

  let seatsEl = '';
  for (let i = 0; i < seatCount; i++) {
    const s = geo.seats[i] || geo.seats[geo.seats.length - 1] || { x: cxr, y: geo.h + SEAT_OFF, n: i + 1 };
    const ax = px + s.x, ay = py + s.y;
    const occ = guestAt[i] != null;
    seatsEl += `<circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="5.5" fill="${occ ? seatFill : '#ffffff'}" stroke="${occ ? seatFill : stroke}" stroke-width="1.5"/>`;
    const dx = s.x - cxr, dy = s.y - cyr, len = Math.hypot(dx, dy) || 1;
    const nx = px + s.x + (dx / len) * 15, ny = py + s.y + (dy / len) * 15;
    seatsEl += `<text x="${nx.toFixed(1)}" y="${ny.toFixed(1)}" font-size="9" font-weight="${occ ? 700 : 400}" fill="${occ ? ink : '#9a968c'}" text-anchor="middle" dominant-baseline="central" transform="rotate(${-rot} ${nx.toFixed(1)} ${ny.toFixed(1)})">${s.n ?? i + 1}</text>`;
  }

  const centerEl =
    `<text x="${cx}" y="${cy - 4}" font-size="22" font-weight="700" fill="${ink}" text-anchor="middle" dominant-baseline="central" transform="rotate(${-rot} ${cx} ${cy})">${count}</text>` +
    `<text x="${cx}" y="${cy + 14}" font-size="8" fill="#8b8881" letter-spacing="1" text-anchor="middle" dominant-baseline="central" transform="rotate(${-rot} ${cx} ${cy})">DE ${Math.max(count, baseCap)}</text>`;

  const rotated = `<g transform="rotate(${rot} ${cx} ${cy})">${shapeEl}${seatsEl}${centerEl}</g>`;
  const nameEl = `<text x="${cx}" y="${(py + geo.h + 26).toFixed(1)}" font-size="11" font-weight="600" fill="#1b1a17" text-anchor="middle">${esc(t.name)}</text>`;

  const half = Math.hypot(geo.w / 2 + 30, geo.h / 2 + 30);
  return {
    svg: rotated + nameEl,
    minX: cx - half, minY: cy - half,
    maxX: cx + half, maxY: cy + half + 22
  };
}

function buildPrintMap() {
  if (!state.tables.length) return '<p class="pp-empty">Sin mesas para mostrar.</p>';
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, body = '';
  state.tables.forEach(t => {
    const r = tableSVG(t);
    body += r.svg;
    minX = Math.min(minX, r.minX); minY = Math.min(minY, r.minY);
    maxX = Math.max(maxX, r.maxX); maxY = Math.max(maxY, r.maxY);
  });
  const pad = 26;
  const w = (maxX - minX) + pad * 2, h = (maxY - minY) + pad * 2;
  return `<svg class="pp-map" viewBox="${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
}

function buildPrintRoster() {
  const primaries = state.guests
    .filter(g => !g.is_plus_one)
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (!primaries.length) return '<p class="pp-empty">Sin invitados.</p>';
  const rows = primaries.map(g => {
    const kids = state.guests.filter(x => x.parent_id === g.id);
    const locs = [];
    const own = guestSeatInfo(g.id);
    if (own) locs.push(`${esc(own.table.name)} &middot; asiento ${own.seat}`);
    kids.forEach(k => {
      const ks = guestSeatInfo(k.id);
      if (ks) locs.push(`${esc(ks.table.name)} &middot; asiento ${ks.seat} <span class="pp-dim">(${esc(k.name)})</span>`);
    });
    return `<tr>
      <td>${esc(g.name)}</td>
      <td class="pp-center">${kids.length || '—'}</td>
      <td>${locs.length ? locs.join('<br>') : '<span class="pp-dim">Sin asignar</span>'}</td>
    </tr>`;
  }).join('');
  return `<table class="pp-roster">
    <thead><tr><th>Invitado</th><th>Extras</th><th>Asientos ocupados</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function printPlan() {
  const root = $('#print-root');
  const name = (state.settings.event_name || '').trim() || DEFAULT_TITLE;
  const date = new Date().toLocaleDateString('es', { year: 'numeric', month: 'long', day: 'numeric' });
  const total = state.guests.length;
  const assigned = state.guests.filter(g => g.table_id).length;
  root.innerHTML = `
    <section class="pp-page">
      <header class="pp-head">
        <h1>${esc(name)}</h1>
        <div class="pp-meta">${date} &middot; ${total} invitados &middot; ${assigned} asignados &middot; ${state.tables.length} mesas</div>
      </header>
      ${buildPrintMap()}
    </section>
    <section class="pp-page pp-break">
      <header class="pp-head">
        <h1>${esc(name)}</h1>
        <div class="pp-meta">Lista de invitados y asientos</div>
      </header>
      ${buildPrintRoster()}
    </section>`;
  window.print();
}
$('#btn-print').addEventListener('click', printPlan);

// ============ BOOT ============
initTableEditors();
setupZoomControls();
connectSSE();
refresh();
