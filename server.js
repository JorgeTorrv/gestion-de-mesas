import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { queries, initSchema } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));

// ============ SSE (real-time sync) ============
const sseClients = new Set();
let clientSeq = 0;

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const id = String(++clientSeq);
  const client = { id, res };
  sseClients.add(client);
  res.write(`data: ${JSON.stringify({ type: 'hello', payload: { id } })}\n\n`);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 20000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(client); try { res.end(); } catch {} });
});

function broadcast(type, payload) {
  const msg = `data: ${JSON.stringify({ type, payload })}\n\n`;
  for (const c of sseClients) {
    try { c.res.write(msg); } catch { sseClients.delete(c); }
  }
}
const origin = (req) => String(req.headers['x-client-id'] || '');

// ============ HISTORY (undo) ============
const HISTORY_LIMIT = 20;
const history = [];
async function pushHistory() {
  try {
    history.push(await queries.exportAll());
    while (history.length > HISTORY_LIMIT) history.shift();
  } catch {}
}

async function enrichGuest(g) {
  if (!g) return g;
  const children = await queries.getChildren.all(g.id);
  return { ...g, children };
}

async function enrichTable(t) {
  const guests = await queries.getGuestsByTable.all(t.id);
  return { ...t, guests, count: guests.length };
}

// ============ ROUTES ============

app.get('/api/state', async (req, res) => {
  try {
    const [tableRows, guests, settings] = await Promise.all([
      queries.listTables.all(),
      queries.listGuests.all(),
      queries.getSettings.get()
    ]);
    const tables = await Promise.all(tableRows.map(enrichTable));
    res.json({ tables, guests, settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings', async (req, res) => {
  try {
    await pushHistory();
    const updated = await queries.updateSettings.run(req.body || {});
    res.json(updated);
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tables', async (req, res) => {
  try {
    const { name, position_x = 0, position_y = 0, capacity = 10, shape = 'circle' } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    await pushHistory();
    const info = await queries.createTable.run(name.trim(), position_x, position_y, capacity, shape);
    res.json(await enrichTable(await queries.getTable.get(info.lastInsertRowid)));
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tables/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await queries.getTable.get(id);
    if (!existing) return res.status(404).json({ error: 'Mesa no encontrada' });
    const {
      name = existing.name,
      position_x = existing.position_x,
      position_y = existing.position_y,
      capacity = existing.capacity,
      shape = existing.shape
    } = req.body || {};
    await pushHistory();
    await queries.updateTable.run(name, position_x, position_y, capacity, id, shape);
    res.json(await enrichTable(await queries.getTable.get(id)));
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Live drag (ephemeral — broadcast only, no persist)
app.post('/api/tables/:id/drag', (req, res) => {
  const id = Number(req.params.id);
  const { position_x, position_y } = req.body || {};
  broadcast('table.drag', { id, position_x, position_y, originId: origin(req) });
  res.json({ ok: true });
});

app.patch('/api/tables/:id/position', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { position_x, position_y } = req.body || {};
    await pushHistory();
    await queries.updateTablePosition.run(position_x, position_y, id);
    res.json({ ok: true });
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tables/arrange', async (req, res) => {
  try {
    const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
    await pushHistory();
    await Promise.all(positions.map(p => {
      const id = Number(p.id);
      if (!id) return Promise.resolve();
      return queries.updateTablePosition.run(Number(p.position_x) || 0, Number(p.position_y) || 0, id);
    }));
    res.json({ ok: true });
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tables/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pushHistory();
    await queries.unassignGuestsFromTable.run(id);
    await queries.deleteTable.run(id);
    res.json({ ok: true });
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/guests', async (req, res) => {
  try {
    const {
      name, phone = null, email = null, extra_info = null,
      table_id = null, parent_id = null, is_plus_one = 0, confirmed = 0
    } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    await pushHistory();
    const info = await queries.createGuest.run(
      name.trim(), phone, email, extra_info, table_id, parent_id,
      is_plus_one ? 1 : 0, confirmed ? 1 : 0
    );
    res.json(await enrichGuest(await queries.getGuest.get(info.lastInsertRowid)));
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/guests/bulk', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.guests) ? req.body.guests : [];
    if (!rows.length) return res.status(400).json({ error: 'Lista vacia' });
    await pushHistory();
    const ids = [];
    for (const g of rows) {
      const name = String(g?.name || '').trim();
      if (!name) continue;
      const info = await queries.createGuest.run(
        name, g.phone || null, g.email || null, g.extra_info || null,
        null, null, 0, 0
      );
      const parentId = info.lastInsertRowid;
      ids.push(parentId);
      const size = Math.max(1, Math.min(20, Number(g.group_size) || 1));
      for (let i = 1; i < size; i++) {
        const p = await queries.createGuest.run(
          `${name} (+${i})`, null, null, null, null, parentId, 1, 0
        );
        ids.push(p.lastInsertRowid);
      }
    }
    res.json({ inserted: ids.length });
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tables/bulk', async (req, res) => {
  try {
    const tables = Array.isArray(req.body?.tables) ? req.body.tables : [];
    if (!tables.length) return res.status(400).json({ error: 'Lista vacia' });
    await pushHistory();
    let created = 0;
    for (const t of tables) {
      const name = String(t?.name || '').trim();
      if (!name) continue;
      await queries.createTable.run(
        name,
        Number(t.position_x) || 0, Number(t.position_y) || 0,
        Number(t.capacity) || 10,
        t.shape === 'square' ? 'square' : 'circle'
      );
      created++;
    }
    res.json({ created });
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/guests/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await queries.getGuest.get(id);
    if (!existing) return res.status(404).json({ error: 'Invitado no encontrado' });
    const {
      name = existing.name, phone = existing.phone,
      email = existing.email, extra_info = existing.extra_info
    } = req.body || {};
    await pushHistory();
    await queries.updateGuest.run(name, phone, email, extra_info, id);
    res.json(await enrichGuest(await queries.getGuest.get(id)));
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/guests/:id/assign', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { table_id } = req.body || {};
    const existing = await queries.getGuest.get(id);
    if (!existing) return res.status(404).json({ error: 'Invitado no encontrado' });
    await pushHistory();
    await queries.assignGuest.run(table_id ?? null, id);
    res.json(await enrichGuest(await queries.getGuest.get(id)));
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/guests/:id/confirm', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { confirmed } = req.body || {};
    const existing = await queries.getGuest.get(id);
    if (!existing) return res.status(404).json({ error: 'Invitado no encontrado' });
    await pushHistory();
    await queries.setConfirmed.run(confirmed ? 1 : 0, id);
    res.json(await enrichGuest(await queries.getGuest.get(id)));
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/guests/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pushHistory();
    await queries.deleteGuest.run(id);
    res.json({ ok: true });
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reset', async (req, res) => {
  try {
    await pushHistory();
    await queries.clearAll();
    res.json({ ok: true });
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/history/undo', async (req, res) => {
  try {
    if (!history.length) return res.status(400).json({ error: 'Nada que deshacer' });
    const snap = history.pop();
    await queries.replaceAll(snap);
    res.json({ ok: true, remaining: history.length });
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/export', async (req, res) => {
  try {
    const payload = await queries.exportAll();
    const filename = `mesas-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/import', async (req, res) => {
  try {
    await pushHistory();
    await queries.replaceAll(req.body);
    res.json({ ok: true, tables: req.body.tables?.length || 0, guests: req.body.guests?.length || 0 });
    broadcast('state.changed', { originId: origin(req) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ============ START ============
initSchema()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n  Gestion de Mesas corriendo en:`);
      console.log(`    Puerto:  ${PORT}`);
      console.log(`    Local:   http://localhost:${PORT}\n`);
    });
  })
  .catch(err => {
    console.error('Error iniciando servidor:', err);
    process.exit(1);
  });
