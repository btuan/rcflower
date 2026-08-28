import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  -- One row per observed state transition (e.g. person entering/leaving frame).
  CREATE TABLE IF NOT EXISTS state_changes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT    NOT NULL,          -- what changed, e.g. 'person_in_frame'
    value      TEXT    NOT NULL,          -- new value, stored as text
    changed_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000) -- ms epoch
  );
  CREATE INDEX IF NOT EXISTS idx_state_changes_key_time
    ON state_changes (key, changed_at);

  -- One row per watering action.
  CREATE TABLE IF NOT EXISTS watering_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger     TEXT    NOT NULL,         -- what caused it, e.g. 'manual', 'schedule', 'person'
    duration_ms INTEGER,                  -- how long the valve/pump ran
    volume_ml   REAL,                     -- dispensed volume, if measured
    notes       TEXT,
    watered_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000) -- ms epoch
  );
  CREATE INDEX IF NOT EXISTS idx_watering_events_time
    ON watering_events (watered_at);
`);

// --- migrations: columns added after the original schema above ---
const hasColumn = (table: string, column: string): boolean =>
  (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (c) => c.name === column,
  );

if (!hasColumn("watering_events", "src_ip")) {
  db.exec("ALTER TABLE watering_events ADD COLUMN src_ip TEXT");
}
