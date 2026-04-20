import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db, { queries, transaction } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));

function enrichGuest(g) {
  if (!g) return g;
  const children = queries.getChildren.all(g.id);
  return { ...g, children };
}

function enrichTable(t) {
  const guests = queries.getGuestsByTable.all(t.id);
  return { ...t, guests, count: guests.length };
}

app.get('/api/state', (req, res) => {
  const tables = queries.listTables.all().map(enrichTable);
  const guests = queries.listGuests.all();
  res.json({ tables, guests });
});

app.post('/api/tables', (req, res) => {
  const { name, position_x = 0, position_y = 0, capacity = 10 } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const info = queries.createTable.run(name.trim(), position_x, position_y, capacity);
  res.json(enrichTable(queries.getTable.get(info.lastInsertRowid)));
});

app.put('/api/tables/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = queries.getTable.get(id);
  if (!existing) return res.status(404).json({ error: 'Mesa no encontrada' });
  const {
    name = existing.name,
    position_x = existing.position_x,
    position_y = existing.position_y,
    capacity = existing.capacity
  } = req.body || {};
  queries.updateTable.run(name, position_x, position_y, capacity, id);
  res.json(enrichTable(queries.getTable.get(id)));
});

app.patch('/api/tables/:id/position', (req, res) => {
  const id = Number(req.params.id);
  const { position_x, position_y } = req.body || {};
  queries.updateTablePosition.run(position_x, position_y, id);
  res.json({ ok: true });
});

app.delete('/api/tables/:id', (req, res) => {
  const id = Number(req.params.id);
  queries.unassignGuestsFromTable.run(id);
  queries.deleteTable.run(id);
  res.json({ ok: true });
});

app.post('/api/guests', (req, res) => {
  const {
    name,
    phone = null,
    email = null,
    extra_info = null,
    table_id = null,
    parent_id = null,
    is_plus_one = 0,
    confirmed = 0
  } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const info = queries.createGuest.run(
    name.trim(),
    phone,
    email,
    extra_info,
    table_id,
    parent_id,
    is_plus_one ? 1 : 0,
    confirmed ? 1 : 0
  );
  res.json(enrichGuest(queries.getGuest.get(info.lastInsertRowid)));
});

app.post('/api/guests/bulk', (req, res) => {
  const rows = Array.isArray(req.body?.guests) ? req.body.guests : [];
  if (!rows.length) return res.status(400).json({ error: 'Lista vacia' });
  const insert = transaction((items) => {
    const ids = [];
    for (const g of items) {
      if (!g?.name || !String(g.name).trim()) continue;
      const info = queries.createGuest.run(
        String(g.name).trim(),
        g.phone || null,
        g.email || null,
        g.extra_info || null,
        null,
        null,
        0
      );
      ids.push(info.lastInsertRowid);
    }
    return ids;
  });
  const ids = insert(rows);
  res.json({ inserted: ids.length });
});

app.put('/api/guests/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = queries.getGuest.get(id);
  if (!existing) return res.status(404).json({ error: 'Invitado no encontrado' });
  const {
    name = existing.name,
    phone = existing.phone,
    email = existing.email,
    extra_info = existing.extra_info
  } = req.body || {};
  queries.updateGuest.run(name, phone, email, extra_info, id);
  res.json(enrichGuest(queries.getGuest.get(id)));
});

app.patch('/api/guests/:id/assign', (req, res) => {
  const id = Number(req.params.id);
  const { table_id } = req.body || {};
  const existing = queries.getGuest.get(id);
  if (!existing) return res.status(404).json({ error: 'Invitado no encontrado' });
  queries.assignGuest.run(table_id ?? null, id);
  res.json(enrichGuest(queries.getGuest.get(id)));
});

app.patch('/api/guests/:id/confirm', (req, res) => {
  const id = Number(req.params.id);
  const { confirmed } = req.body || {};
  const existing = queries.getGuest.get(id);
  if (!existing) return res.status(404).json({ error: 'Invitado no encontrado' });
  queries.setConfirmed.run(confirmed ? 1 : 0, id);
  res.json(enrichGuest(queries.getGuest.get(id)));
});

app.delete('/api/guests/:id', (req, res) => {
  const id = Number(req.params.id);
  queries.deleteGuest.run(id);
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  queries.clearAll();
  res.json({ ok: true });
});

app.get('/api/export', (req, res) => {
  const payload = queries.exportAll();
  const filename = `mesas-${new Date().toISOString().slice(0,10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(payload, null, 2));
});

app.post('/api/import', (req, res) => {
  try {
    queries.replaceAll(req.body);
    res.json({ ok: true, tables: req.body.tables?.length || 0, guests: req.body.guests?.length || 0 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Gestion de Mesas corriendo en:`);
  console.log(`    Puerto:  ${PORT}`);
  console.log(`    Local:   http://localhost:${PORT}\n`);
});
