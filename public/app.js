// ============ STATE ============
const state = {
  tables: [],
  guests: [],
  filter: 'all',
  search: '',
  currentGuestId: null,
  currentTableId: null,
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
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.8;
const ZOOM_STEP = 0.1;
let lastPointerClient = null;
let edgeScrollRaf = null;

// ============ API ============
const api = {
  async getState() { const r = await fetch('/api/state'); return r.json(); },
  async createTable(data) { return post('/api/tables', data); },
  async updateTable(id, data) { return put(`/api/tables/${id}`, data); },
  async updateTablePosition(id, x, y) { return fetch(`/api/tables/${id}/position`, { method: 'PATCH', headers: json(), body: JSON.stringify({ position_x: x, position_y: y }) }); },
  async deleteTable(id) { return fetch(`/api/tables/${id}`, { method: 'DELETE' }); },
  async createGuest(data) { return post('/api/guests', data); },
  async createGuestsBulk(rows) { return post('/api/guests/bulk', { guests: rows }); },
  async updateGuest(id, data) { return put(`/api/guests/${id}`, data); },
  async assignGuest(id, tableId) { return fetch(`/api/guests/${id}/assign`, { method: 'PATCH', headers: json(), body: JSON.stringify({ table_id: tableId }) }); },
  async setConfirmed(id, confirmed) { return fetch(`/api/guests/${id}/confirm`, { method: 'PATCH', headers: json(), body: JSON.stringify({ confirmed: confirmed ? 1 : 0 }) }); },
  async deleteGuest(id) { return fetch(`/api/guests/${id}`, { method: 'DELETE' }); },
  async reset() { return post('/api/reset', {}); },
  async importPayload(payload) {
    const r = await fetch('/api/import', { method: 'POST', headers: json(), body: JSON.stringify(payload) });
    if (!r.ok) throw new Error((await r.json()).error || 'Error al importar');
    return r.json();
  }
};
const json = () => ({ 'Content-Type': 'application/json' });
async function post(url, body) { const r = await fetch(url, { method: 'POST', headers: json(), body: JSON.stringify(body) }); return r.json(); }
async function put(url, body) { const r = await fetch(url, { method: 'PUT', headers: json(), body: JSON.stringify(body) }); return r.json(); }

// ============ UTIL ============
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toast._tid);
  toast._tid = setTimeout(() => t.classList.add('hidden'), 2400);
}

// ============ LOAD ============
async function refresh() {
  const data = await api.getState();
  state.tables = data.tables;
  state.guests = data.guests;
  state.settings = data.settings || { event_name: '' };
  applyEventName();
  render();
}

function applyEventName() {
  const name = (state.settings.event_name || '').trim();
  const display = name || DEFAULT_TITLE;
  $('#app-title').textContent = display;
  document.title = name ? `${name} — Mesas` : DEFAULT_TITLE;
}

async function renameEvent() {
  const current = state.settings.event_name || '';
  const v = prompt('Nombre del evento (vacio para usar el por defecto):', current);
  if (v === null) return;
  const name = v.trim();
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
function tableSize(t) {
  const count = t.guests.length;
  const cap = Math.max(count, Number(t.capacity) || 10);
  return Math.max(140, Math.min(340, 140 + cap * 10));
}

function updateCanvasSize(extra) {
  const wrap = $('.canvas-wrap');
  const pad = 400;
  let w = Math.ceil(wrap.clientWidth / state.zoom) + 100;
  let h = Math.ceil(wrap.clientHeight / state.zoom) + 100;
  state.tables.forEach(t => {
    const s = tableSize(t);
    w = Math.max(w, t.position_x + s + pad);
    h = Math.max(h, t.position_y + s + pad + 40); // +40 for name label below
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
    const s = tableSize(t);
    minX = Math.min(minX, t.position_x);
    minY = Math.min(minY, t.position_y);
    maxX = Math.max(maxX, t.position_x + s);
    maxY = Math.max(maxY, t.position_y + s + 40);
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
    const baseCap = Number(t.capacity) || 10;
    const displayCap = Math.max(count, baseCap);
    const overBase = count > baseCap;

    const size = Math.max(140, Math.min(340, 140 + displayCap * 10));

    const node = document.createElement('div');
    node.className = 'table-node';
    node.dataset.tableId = t.id;
    node.style.left = `${t.position_x}px`;
    node.style.top = `${t.position_y}px`;

    node.innerHTML = `
      <div class="table-circle" style="width:${size}px;height:${size}px;">
        <div class="table-center">
          <div class="table-count ${overBase ? 'over' : ''}">${count}</div>
          <div class="table-label">de ${displayCap}</div>
        </div>
      </div>
      <div class="table-name">${esc(t.name)}</div>
    `;

    const circle = node.querySelector('.table-circle');
    const seats = displayCap;
    for (let i = 0; i < seats; i++) {
      const angle = (i / seats) * Math.PI * 2 - Math.PI / 2;
      const r = size / 2 + 6;
      const x = size / 2 + r * Math.cos(angle);
      const y = size / 2 + r * Math.sin(angle);
      const dot = document.createElement('div');
      let cls = 'seat';
      if (i < count) cls += ' occupied';
      if (i >= baseCap) cls += ' over-base';
      dot.className = cls;
      dot.style.left = x + 'px';
      dot.style.top = y + 'px';
      circle.appendChild(dot);
    }

    canvas.appendChild(node);
    attachTableInteractions(node, t);
  });
}

function attachTableInteractions(node, table) {
  enableDragOrClick(node, {
    onClick: () => openTableModal(table.id),
    moveTarget: node,
    onPositionChange: async (x, y) => {
      table.position_x = x;
      table.position_y = y;
      await api.updateTablePosition(table.id, x, y);
    }
  });
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
  const { onClick, ghostLabel, onDrop, onPositionChange, moveTarget, skipOn } = opts;
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
    if (e.target.closest('.zoom-controls')) return;
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
      if (!confirm('Eliminar acompanante?')) return;
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
  if (!confirm('Eliminar este invitado y sus acompanantes?')) return;
  await api.deleteGuest(state.currentGuestId);
  closeModal('#modal-guest');
  refresh();
});

// ============ TABLE MODAL ============
function openTableModal(id) {
  const t = state.tables.find(x => x.id === id);
  if (!t) return;
  state.currentTableId = id;

  $('#mt-name').textContent = t.name;
  $('#mt-count').textContent = t.guests.length;
  $('#mt-name-input').value = t.name;
  $('#mt-capacity-input').value = t.capacity || 10;

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
  host.innerHTML = t.guests.map(g => `
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
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button data-act="info">Ver</button>
        <button data-act="remove" title="Sacar">Sacar</button>
      </div>
    </div>
  `).join('');

  $$('.member-row', host).forEach(row => {
    const id = Number(row.dataset.guestId);
    row.querySelector('[data-act="info"]').addEventListener('click', () => {
      closeModal('#modal-table');
      openGuestModal(id);
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
  await api.updateTable(state.currentTableId, {
    name: $('#mt-name-input').value.trim() || 'Mesa',
    capacity: Number($('#mt-capacity-input').value) || 10
  });
  toast('Mesa actualizada', 'success');
  closeModal('#modal-table');
  refresh();
});

$('#mt-delete').addEventListener('click', async () => {
  if (!confirm('Eliminar esta mesa? Los invitados quedaran sin mesa.')) return;
  await api.deleteTable(state.currentTableId);
  closeModal('#modal-table');
  refresh();
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
  openModal('#modal-new-table');
});
$('#nt-save').addEventListener('click', async () => {
  const count = Math.max(1, Math.min(50, Number($('#nt-count').value) || 1));
  const capacity = Number($('#nt-capacity').value) || 10;
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
      capacity
    });
  } else {
    const startNum = getNextTableNumber();
    for (let i = 0; i < count; i++) {
      const idx = startIdx + i;
      tables.push({
        name: `Mesa ${startNum + i}`,
        position_x: 80 + (idx % cols) * 280,
        position_y: 80 + Math.floor(idx / cols) * 280,
        capacity
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
    if (!confirm(`Cargar respaldo con ${payload.tables.length} mesas y ${payload.guests.length} invitados? Esto reemplaza TODO lo actual.`)) {
      e.target.value = ''; return;
    }
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
  if (!confirm('Borrar TODO (mesas e invitados)? Esta accion no se puede deshacer.')) return;
  await api.reset();
  toast('Todo borrado', 'success');
  refresh();
});

// ============ SEARCH / FILTERS ============
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderGuestList();
});
$$('.chip').forEach(c => {
  c.addEventListener('click', () => {
    $$('.chip').forEach(x => x.classList.remove('chip-active'));
    c.classList.add('chip-active');
    state.filter = c.dataset.filter;
    renderGuestList();
  });
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
// Close drawer when a guest card is clicked on mobile
document.addEventListener('click', (e) => {
  if (window.innerWidth > 760) return;
  if (e.target.closest('.guest-card')) {
    setTimeout(() => document.body.classList.remove('sidebar-open'), 100);
  }
});

// ============ MODAL HELPERS ============
function openModal(sel) { $(sel).classList.remove('hidden'); }
function closeModal(sel) { $(sel).classList.add('hidden'); }
$$('.modal').forEach(m => {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.hasAttribute('data-close')) {
      m.classList.add('hidden');
    }
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal').forEach(m => m.classList.add('hidden'));
});

// ============ RENAME EVENT ============
$('#app-title').addEventListener('click', renameEvent);
$('#btn-rename').addEventListener('click', renameEvent);

// ============ BOOT ============
setupZoomControls();
refresh();
