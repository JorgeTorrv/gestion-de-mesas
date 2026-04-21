import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

function nowISO() { return new Date().toISOString(); }

function normalizeTable(row) {
  return {
    id: Number(row.id),
    name: row.name,
    position_x: Number(row.position_x) || 0,
    position_y: Number(row.position_y) || 0,
    capacity: Number(row.capacity) || 10,
    shape: row.shape === 'square' ? 'square' : 'circle',
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
    parent_id: row.parent_id != null ? Number(row.parent_id) : null,
    is_plus_one: row.is_plus_one ? 1 : 0,
    confirmed: row.confirmed ? 1 : 0,
    created_at: row.created_at || ''
  };
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
    run: async (name, position_x, position_y, capacity, shape = 'circle') => {
      const { rows } = await pool.query(
        `INSERT INTO mesas_tables(name, position_x, position_y, capacity, shape, created_at)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [name, Number(position_x) || 0, Number(position_y) || 0,
         Number(capacity) || 10, shape === 'square' ? 'square' : 'circle', nowISO()]
      );
      return { lastInsertRowid: rows[0].id };
    }
  },

  updateTable: {
    run: async (name, position_x, position_y, capacity, id, shape) => {
      await pool.query(
        `UPDATE mesas_tables SET name=$1, position_x=$2, position_y=$3, capacity=$4, shape=$5 WHERE id=$6`,
        [name, Number(position_x) || 0, Number(position_y) || 0,
         Number(capacity) || 10, shape === 'square' ? 'square' : 'circle', Number(id)]
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

  deleteTable: {
    run: async (id) => {
      await pool.query('DELETE FROM mesas_tables WHERE id=$1', [Number(id)]);
    }
  },

  unassignGuestsFromTable: {
    run: async (id) => {
      await pool.query('UPDATE mesas_guests SET table_id=NULL WHERE table_id=$1', [Number(id)]);
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
    run: async (name, phone, email, extra_info, table_id, parent_id, is_plus_one, confirmed = 0) => {
      const { rows } = await pool.query(
        `INSERT INTO mesas_guests(name,phone,email,extra_info,table_id,parent_id,is_plus_one,confirmed,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [name, phone || null, email || null, extra_info || null,
         table_id ?? null, parent_id ?? null,
         is_plus_one ? 1 : 0, confirmed ? 1 : 0, nowISO()]
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
    run: async (table_id, id) => {
      await pool.query(
        `UPDATE mesas_guests SET table_id=$1 WHERE id=$2`,
        [table_id ?? null, Number(id)]
      );
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
      version: 1,
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

      for (const t of payload.tables) {
        await client.query(
          `INSERT INTO mesas_tables(id,name,position_x,position_y,capacity,shape,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [Number(t.id), String(t.name || 'Mesa'),
           Number(t.position_x) || 0, Number(t.position_y) || 0,
           Number(t.capacity) || 10,
           t.shape === 'square' ? 'square' : 'circle',
           t.created_at || nowISO()]
        );
      }

      for (const g of payload.guests) {
        await client.query(
          `INSERT INTO mesas_guests(id,name,phone,email,extra_info,table_id,parent_id,is_plus_one,confirmed,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [Number(g.id), String(g.name || ''),
           g.phone || null, g.email || null, g.extra_info || null,
           g.table_id ? Number(g.table_id) : null,
           g.parent_id ? Number(g.parent_id) : null,
           g.is_plus_one ? 1 : 0, g.confirmed ? 1 : 0,
           g.created_at || nowISO()]
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
