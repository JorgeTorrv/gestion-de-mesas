import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

function nowISO() { return new Date().toISOString(); }

// ---- Seat layout helpers (rectangular tables) ----
// layout = { head, side, corners, drop }
//   head    seats per cabecera (short end), applied to BOTH ends
//   side    seats per lateral (long side), target for BOTH sides
//   corners 4 corner seats on/off
//   drop    seats removed from the trailing slots of ONE lateral (keeps others aligned)
export function cleanLayout(l) {
  if (!l || typeof l !== 'object') return null;
  const head = Math.max(0, Math.min(12, Math.round(Number(l.head) || 0)));
  const side = Math.max(0, Math.min(60, Math.round(Number(l.side) || 0)));
  const corners = !!l.corners;
  const maxDrop = Math.max(0, side);
  const drop = Math.max(0, Math.min(maxDrop, Math.round(Number(l.drop) || 0)));
  return { head, side, corners, drop };
}

export function layoutCapacity(l) {
  const c = cleanLayout(l);
  if (!c) return null;
  return Math.max(1, c.head * 2 + c.side * 2 + (c.corners ? 4 : 0) - c.drop);
}

function cleanColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

function cleanRotation(r) {
  let n = Number(r);
  if (!Number.isFinite(n)) return 0;
  n = ((n % 360) + 360) % 360;
  return Math.round(n * 10) / 10;
}

function normalizeTable(row) {
  const shape = row.shape === 'square' ? 'square' : 'circle';
  let seat_layout = row.seat_layout ?? null;
  if (typeof seat_layout === 'string') {
    try { seat_layout = JSON.parse(seat_layout); } catch { seat_layout = null; }
  }
  if (shape === 'square') seat_layout = cleanLayout(seat_layout);
  else seat_layout = null;
  return {
    id: Number(row.id),
    name: row.name,
    position_x: Number(row.position_x) || 0,
    position_y: Number(row.position_y) || 0,
    capacity: Number(row.capacity) || 10,
    shape,
    rotation: cleanRotation(row.rotation),
    color: cleanColor(row.color),
    seat_layout,
    created_at: row.created_at || ''
  };
}

function normalizeGuest(row) {
  return {
    id: Number(row.id),
    name: row.name,
    phone: row.phone || null,
    email: row.email || null,
    extra_info: row.extra_info || null,
    table_id: row.table_id != null ? Number(row.table_id) : null,
    seat: row.seat != null && Number.isFinite(Number(row.seat)) ? Number(row.seat) : null,
    parent_id: row.parent_id != null ? Number(row.parent_id) : null,
    is_plus_one: row.is_plus_one ? 1 : 0,
    confirmed: row.confirmed ? 1 : 0,
    created_at: row.created_at || ''
  };
}

// Resolve the fields to persist for a table given a patch + existing row.
function resolveTableFields(patch = {}, existing = null) {
  const base = existing || {};
  const name = patch.name != null ? String(patch.name).trim() || 'Mesa' : (base.name ?? 'Mesa');
  const position_x = patch.position_x != null ? Number(patch.position_x) || 0 : (Number(base.position_x) || 0);
  const position_y = patch.position_y != null ? Number(patch.position_y) || 0 : (Number(base.position_y) || 0);
  const shape = (patch.shape != null ? patch.shape : base.shape) === 'square' ? 'square' : 'circle';
  const rotation = patch.rotation != null ? cleanRotation(patch.rotation) : cleanRotation(base.rotation);
  const color = 'color' in patch ? cleanColor(patch.color) : cleanColor(base.color);

  let seat_layout = null;
  if (shape === 'square') {
    if ('seat_layout' in patch) seat_layout = cleanLayout(patch.seat_layout);
    else seat_layout = cleanLayout(base.seat_layout);
  }

  let capacity;
  if (shape === 'square' && seat_layout) {
    capacity = layoutCapacity(seat_layout);
  } else if (patch.capacity != null) {
    capacity = Math.max(1, Math.round(Number(patch.capacity) || 10));
  } else {
    capacity = Math.max(1, Math.round(Number(base.capacity) || 10));
  }

  return { name, position_x, position_y, capacity, shape, rotation, color, seat_layout };
}

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mesas_tables (
      id        SERIAL PRIMARY KEY,
      name      TEXT    NOT NULL,
      position_x REAL   NOT NULL DEFAULT 0,
      position_y REAL   NOT NULL DEFAULT 0,
      capacity  INTEGER NOT NULL DEFAULT 10,
      shape     TEXT    NOT NULL DEFAULT 'circle',
      created_at TEXT   NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS mesas_guests (
      id          SERIAL  PRIMARY KEY,
      name        TEXT    NOT NULL,
      phone       TEXT,
      email       TEXT,
      extra_info  TEXT,
      table_id    INTEGER,
      parent_id   INTEGER,
      is_plus_one INTEGER NOT NULL DEFAULT 0,
      confirmed   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS mesas_settings (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      event_name TEXT    NOT NULL DEFAULT ''
    );
    INSERT INTO mesas_settings(id, event_name) VALUES(1, '') ON CONFLICT DO NOTHING;

    ALTER TABLE mesas_tables ADD COLUMN IF NOT EXISTS rotation    REAL  NOT NULL DEFAULT 0;
    ALTER TABLE mesas_tables ADD COLUMN IF NOT EXISTS color       TEXT;
    ALTER TABLE mesas_tables ADD COLUMN IF NOT EXISTS seat_layout JSONB;
    ALTER TABLE mesas_guests ADD COLUMN IF NOT EXISTS seat        INTEGER;
  `);
}

export const queries = {

  listTables: {
    all: async () => {
      const { rows } = await pool.query('SELECT * FROM mesas_tables ORDER BY id ASC');
      return rows.map(normalizeTable);
    }
  },

  getTable: {
    get: async (id) => {
      const { rows } = await pool.query('SELECT * FROM mesas_tables WHERE id=$1', [Number(id)]);
      return rows[0] ? normalizeTable(rows[0]) : null;
    }
  },

  createTable: {
    // Accepts either an object patch or the legacy positional signature
    // (name, position_x, position_y, capacity, shape).
    run: async (patch, position_x, position_y, capacity, shape) => {
      const input = (patch && typeof patch === 'object')
        ? patch
        : { name: patch, position_x, position_y, capacity, shape };
      const f = resolveTableFields(input, null);
      const { rows } = await pool.query(
        `INSERT INTO mesas_tables
           (name, position_x, position_y, capacity, shape, rotation, color, seat_layout, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [f.name, f.position_x, f.position_y, f.capacity, f.shape,
         f.rotation, f.color, f.seat_layout ? JSON.stringify(f.seat_layout) : null, nowISO()]
      );
      return { lastInsertRowid: rows[0].id };
    }
  },

  updateTable: {
    // updateTable.run(patchObject, id, existingRow)
    run: async (patch, id, existing = null) => {
      const f = resolveTableFields(patch || {}, existing);
      await pool.query(
        `UPDATE mesas_tables
            SET name=$1, position_x=$2, position_y=$3, capacity=$4, shape=$5,
                rotation=$6, color=$7, seat_layout=$8
          WHERE id=$9`,
        [f.name, f.position_x, f.position_y, f.capacity, f.shape,
         f.rotation, f.color, f.seat_layout ? JSON.stringify(f.seat_layout) : null, Number(id)]
      );
    }
  },

  updateTablePosition: {
    run: async (position_x, position_y, id) => {
      await pool.query(
        `UPDATE mesas_tables SET position_x=$1, position_y=$2 WHERE id=$3`,
        [Number(position_x) || 0, Number(position_y) || 0, Number(id)]
      );
    }
  },

  updateTableRotation: {
    run: async (rotation, id) => {
      await pool.query(
        `UPDATE mesas_tables SET rotation=$1 WHERE id=$2`,
        [cleanRotation(rotation), Number(id)]
      );
    }
  },

  deleteTable: {
    run: async (id) => {
      await pool.query('DELETE FROM mesas_tables WHERE id=$1', [Number(id)]);
    }
  },

  unassignGuestsFromTable: {
    run: async (id) => {
      await pool.query('UPDATE mesas_guests SET table_id=NULL, seat=NULL WHERE table_id=$1', [Number(id)]);
    }
  },

  listGuests: {
    all: async () => {
      const { rows } = await pool.query(
        `SELECT * FROM mesas_guests ORDER BY is_plus_one ASC, name ASC`
      );
      return rows.map(normalizeGuest);
    }
  },

  getGuest: {
    get: async (id) => {
      const { rows } = await pool.query('SELECT * FROM mesas_guests WHERE id=$1', [Number(id)]);
      return rows[0] ? normalizeGuest(rows[0]) : null;
    }
  },

  getGuestsByTable: {
    all: async (id) => {
      const { rows } = await pool.query(
        `SELECT * FROM mesas_guests WHERE table_id=$1 ORDER BY is_plus_one ASC, name ASC`,
        [Number(id)]
      );
      return rows.map(normalizeGuest);
    }
  },

  getChildren: {
    all: async (id) => {
      const { rows } = await pool.query(
        `SELECT * FROM mesas_guests WHERE parent_id=$1 ORDER BY name ASC`,
        [Number(id)]
      );
      return rows.map(normalizeGuest);
    }
  },

  createGuest: {
    run: async (name, phone, email, extra_info, table_id, parent_id, is_plus_one, confirmed = 0, seat = null) => {
      const seatVal = Number.isFinite(Number(seat)) && Number(seat) > 0 ? Math.round(Number(seat)) : null;
      const { rows } = await pool.query(
        `INSERT INTO mesas_guests(name,phone,email,extra_info,table_id,parent_id,is_plus_one,confirmed,seat,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [name, phone || null, email || null, extra_info || null,
         table_id ?? null, parent_id ?? null,
         is_plus_one ? 1 : 0, confirmed ? 1 : 0, table_id ? seatVal : null, nowISO()]
      );
      return { lastInsertRowid: rows[0].id };
    }
  },

  updateGuest: {
    run: async (name, phone, email, extra_info, id) => {
      await pool.query(
        `UPDATE mesas_guests SET name=$1, phone=$2, email=$3, extra_info=$4 WHERE id=$5`,
        [name, phone || null, email || null, extra_info || null, Number(id)]
      );
    }
  },

  assignGuest: {
    // seat: number pins the guest to that seat; null clears the pin; undefined keeps it.
    run: async (table_id, id, seat) => {
      const tid = table_id ?? null;
      if (seat === undefined) {
        // legacy call — moving tables clears any stale pin
        await pool.query(
          `UPDATE mesas_guests SET table_id=$1, seat = CASE WHEN $1 IS DISTINCT FROM table_id THEN NULL ELSE seat END WHERE id=$2`,
          [tid, Number(id)]
        );
        return;
      }
      const seatVal = tid && Number.isFinite(Number(seat)) && Number(seat) > 0 ? Math.round(Number(seat)) : null;
      await pool.query(
        `UPDATE mesas_guests SET table_id=$1, seat=$2 WHERE id=$3`,
        [tid, seatVal, Number(id)]
      );
    }
  },

  setGuestSeat: {
    run: async (seat, id) => {
      const seatVal = Number.isFinite(Number(seat)) && Number(seat) > 0 ? Math.round(Number(seat)) : null;
      await pool.query(`UPDATE mesas_guests SET seat=$1 WHERE id=$2`, [seatVal, Number(id)]);
    }
  },

  setConfirmed: {
    run: async (confirmed, id) => {
      await pool.query(
        `UPDATE mesas_guests SET confirmed=$1 WHERE id=$2`,
        [confirmed ? 1 : 0, Number(id)]
      );
    }
  },

  deleteGuest: {
    run: async (id) => {
      await pool.query(
        'DELETE FROM mesas_guests WHERE id=$1 OR parent_id=$1',
        [Number(id)]
      );
    }
  },

  countTableGuests: {
    get: async (id) => {
      const { rows } = await pool.query(
        'SELECT COUNT(*) AS c FROM mesas_guests WHERE table_id=$1',
        [Number(id)]
      );
      return { c: Number(rows[0].c) };
    }
  },

  clearAll: async () => {
    await pool.query('DELETE FROM mesas_guests');
    await pool.query('DELETE FROM mesas_tables');
    await pool.query(`SELECT setval('mesas_tables_id_seq', 1, false)`);
    await pool.query(`SELECT setval('mesas_guests_id_seq', 1, false)`);
    await pool.query(`UPDATE mesas_settings SET event_name='' WHERE id=1`);
  },

  getSettings: {
    get: async () => {
      const { rows } = await pool.query('SELECT * FROM mesas_settings WHERE id=1');
      return rows[0] ? { event_name: rows[0].event_name || '' } : { event_name: '' };
    }
  },

  updateSettings: {
    run: async (patch) => {
      if (patch && typeof patch === 'object' && 'event_name' in patch) {
        await pool.query(
          'UPDATE mesas_settings SET event_name=$1 WHERE id=1',
          [String(patch.event_name || '')]
        );
      }
      const { rows } = await pool.query('SELECT * FROM mesas_settings WHERE id=1');
      return { event_name: rows[0]?.event_name || '' };
    }
  },

  exportAll: async () => {
    const { rows: tables }   = await pool.query('SELECT * FROM mesas_tables ORDER BY id');
    const { rows: guests }   = await pool.query('SELECT * FROM mesas_guests ORDER BY id');
    const { rows: settings } = await pool.query('SELECT * FROM mesas_settings WHERE id=1');
    const maxTableId = tables.length ? Math.max(...tables.map(t => Number(t.id))) : 0;
    const maxGuestId = guests.length ? Math.max(...guests.map(g => Number(g.id))) : 0;
    return {
      version: 2,
      exported_at: nowISO(),
      tables: tables.map(normalizeTable),
      guests: guests.map(normalizeGuest),
      seq: { table: maxTableId, guest: maxGuestId },
      settings: settings[0] ? { event_name: settings[0].event_name || '' } : { event_name: '' }
    };
  },

  replaceAll: async (payload) => {
    if (!payload || !Array.isArray(payload.tables) || !Array.isArray(payload.guests)) {
      throw new Error('Formato invalido');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM mesas_guests');
      await client.query('DELETE FROM mesas_tables');

      for (const raw of payload.tables) {
        const f = resolveTableFields(raw, null);
        await client.query(
          `INSERT INTO mesas_tables
             (id,name,position_x,position_y,capacity,shape,rotation,color,seat_layout,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [Number(raw.id), f.name, f.position_x, f.position_y, f.capacity, f.shape,
           f.rotation, f.color, f.seat_layout ? JSON.stringify(f.seat_layout) : null,
           raw.created_at || nowISO()]
        );
      }

      for (const g of payload.guests) {
        const seatVal = g.table_id && Number.isFinite(Number(g.seat)) && Number(g.seat) > 0
          ? Math.round(Number(g.seat)) : null;
        await client.query(
          `INSERT INTO mesas_guests(id,name,phone,email,extra_info,table_id,parent_id,is_plus_one,confirmed,seat,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [Number(g.id), String(g.name || ''),
           g.phone || null, g.email || null, g.extra_info || null,
           g.table_id ? Number(g.table_id) : null,
           g.parent_id ? Number(g.parent_id) : null,
           g.is_plus_one ? 1 : 0, g.confirmed ? 1 : 0,
           seatVal, g.created_at || nowISO()]
        );
      }

      const maxTableId = payload.tables.length ? Math.max(...payload.tables.map(t => Number(t.id))) : 0;
      const maxGuestId = payload.guests.length ? Math.max(...payload.guests.map(g => Number(g.id))) : 0;
      await client.query(`SELECT setval('mesas_tables_id_seq', $1)`, [Math.max(1, maxTableId)]);
      await client.query(`SELECT setval('mesas_guests_id_seq', $1)`, [Math.max(1, maxGuestId)]);

      if (payload.settings) {
        await client.query(
          'UPDATE mesas_settings SET event_name=$1 WHERE id=1',
          [String(payload.settings.event_name || '')]
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
};

export function transaction(fn) {
  return async (...args) => fn(...args);
}

export default { queries };
