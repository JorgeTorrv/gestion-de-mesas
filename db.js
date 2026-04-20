import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const dbFile = join(dataDir, 'mesas.json');

let data = { tables: [], guests: [], seq: { table: 0, guest: 0 } };

function load() {
  if (existsSync(dbFile)) {
    try {
      const raw = readFileSync(dbFile, 'utf8');
      const parsed = JSON.parse(raw);
      data = {
        tables: parsed.tables || [],
        guests: parsed.guests || [],
        seq: parsed.seq || {
          table: Math.max(0, ...(parsed.tables || []).map(t => t.id)),
          guest: Math.max(0, ...(parsed.guests || []).map(g => g.id))
        }
      };
    } catch (err) {
      console.error('Error leyendo DB JSON, arrancando vacio:', err.message);
    }
  }
}

let saveTimer = null;
let saving = false;
function persist() {
  if (saving) { saveTimer = saveTimer || setTimeout(persist, 50); return; }
  saving = true;
  try {
    const tmp = dbFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, dbFile);
  } finally {
    saving = false;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  }
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 30);
}

load();

const nextTableId = () => (++data.seq.table);
const nextGuestId = () => (++data.seq.guest);

function nowISO() { return new Date().toISOString(); }

export const queries = {
  listTables: {
    all: () => [...data.tables].sort((a, b) => a.id - b.id)
  },
  getTable: {
    get: (id) => data.tables.find(t => t.id === id) || null
  },
  createTable: {
    run: (name, position_x, position_y, capacity) => {
      const id = nextTableId();
      data.tables.push({
        id,
        name,
        position_x: Number(position_x) || 0,
        position_y: Number(position_y) || 0,
        capacity: Number(capacity) || 10,
        created_at: nowISO()
      });
      save();
      return { lastInsertRowid: id };
    }
  },
  updateTable: {
    run: (name, position_x, position_y, capacity, id) => {
      const t = data.tables.find(x => x.id === id);
      if (!t) return;
      t.name = name;
      t.position_x = Number(position_x) || 0;
      t.position_y = Number(position_y) || 0;
      t.capacity = Number(capacity) || 10;
      save();
    }
  },
  updateTablePosition: {
    run: (position_x, position_y, id) => {
      const t = data.tables.find(x => x.id === id);
      if (!t) return;
      t.position_x = Number(position_x) || 0;
      t.position_y = Number(position_y) || 0;
      save();
    }
  },
  deleteTable: {
    run: (id) => {
      data.tables = data.tables.filter(t => t.id !== id);
      save();
    }
  },
  unassignGuestsFromTable: {
    run: (id) => {
      for (const g of data.guests) if (g.table_id === id) g.table_id = null;
      save();
    }
  },

  listGuests: {
    all: () => [...data.guests].sort((a, b) => {
      if (a.is_plus_one !== b.is_plus_one) return a.is_plus_one - b.is_plus_one;
      return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
    })
  },
  getGuest: {
    get: (id) => data.guests.find(g => g.id === id) || null
  },
  getGuestsByTable: {
    all: (id) => data.guests.filter(g => g.table_id === id).sort((a, b) => {
      if (a.is_plus_one !== b.is_plus_one) return a.is_plus_one - b.is_plus_one;
      return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
    })
  },
  getChildren: {
    all: (id) => data.guests.filter(g => g.parent_id === id).sort((a, b) =>
      a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
    )
  },
  createGuest: {
    run: (name, phone, email, extra_info, table_id, parent_id, is_plus_one) => {
      const id = nextGuestId();
      data.guests.push({
        id,
        name,
        phone: phone || null,
        email: email || null,
        extra_info: extra_info || null,
        table_id: table_id ?? null,
        parent_id: parent_id ?? null,
        is_plus_one: is_plus_one ? 1 : 0,
        created_at: nowISO()
      });
      save();
      return { lastInsertRowid: id };
    }
  },
  updateGuest: {
    run: (name, phone, email, extra_info, id) => {
      const g = data.guests.find(x => x.id === id);
      if (!g) return;
      g.name = name;
      g.phone = phone || null;
      g.email = email || null;
      g.extra_info = extra_info || null;
      save();
    }
  },
  assignGuest: {
    run: (table_id, id) => {
      const g = data.guests.find(x => x.id === id);
      if (!g) return;
      g.table_id = table_id ?? null;
      save();
    }
  },
  deleteGuest: {
    run: (id) => {
      const removeIds = new Set([id]);
      // cascade plus-ones
      for (const g of data.guests) if (g.parent_id === id) removeIds.add(g.id);
      data.guests = data.guests.filter(g => !removeIds.has(g.id));
      save();
    }
  },
  countTableGuests: {
    get: (id) => ({ c: data.guests.filter(g => g.table_id === id).length })
  },
  clearAll: () => {
    data.tables = [];
    data.guests = [];
    data.seq = { table: 0, guest: 0 };
    save();
  },
  exportAll: () => ({
    version: 1,
    exported_at: nowISO(),
    tables: data.tables,
    guests: data.guests,
    seq: data.seq
  }),
  replaceAll: (payload) => {
    if (!payload || !Array.isArray(payload.tables) || !Array.isArray(payload.guests)) {
      throw new Error('Formato invalido');
    }
    data.tables = payload.tables.map(t => ({
      id: Number(t.id),
      name: String(t.name || 'Mesa'),
      position_x: Number(t.position_x) || 0,
      position_y: Number(t.position_y) || 0,
      capacity: Number(t.capacity) || 10,
      created_at: t.created_at || nowISO()
    }));
    data.guests = payload.guests.map(g => ({
      id: Number(g.id),
      name: String(g.name || ''),
      phone: g.phone || null,
      email: g.email || null,
      extra_info: g.extra_info || null,
      table_id: g.table_id ? Number(g.table_id) : null,
      parent_id: g.parent_id ? Number(g.parent_id) : null,
      is_plus_one: g.is_plus_one ? 1 : 0,
      created_at: g.created_at || nowISO()
    }));
    data.seq = payload.seq && typeof payload.seq === 'object' ? {
      table: Number(payload.seq.table) || Math.max(0, ...data.tables.map(t => t.id)),
      guest: Number(payload.seq.guest) || Math.max(0, ...data.guests.map(g => g.id))
    } : {
      table: Math.max(0, ...data.tables.map(t => t.id)),
      guest: Math.max(0, ...data.guests.map(g => g.id))
    };
    persist();
  }
};

// Keep transaction-like helper (for bulk insert in server.js)
export function transaction(fn) {
  return (...args) => {
    const result = fn(...args);
    // single save at end (inside functions we already save; but force flush)
    persist();
    return result;
  };
}

export default { queries };
