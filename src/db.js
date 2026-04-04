/**
 * db.js — Capa de base de datos SQLite para el relay de citas online
 * Patrón idéntico al db.js de PodoSystem: better-sqlite3, WAL mode.
 */

const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');

const DB_PATH = process.env.DB_PATH || './relay.db';

function initDB() {
  const db = new Database(path.resolve(DB_PATH));

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clinicas (
      id          TEXT PRIMARY KEY,
      nombre      TEXT NOT NULL,
      apiKey      TEXT UNIQUE NOT NULL,
      createdAt   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      activa      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS solicitudes (
      id            TEXT PRIMARY KEY,
      clinicaId     TEXT NOT NULL REFERENCES clinicas(id),
      nombre        TEXT NOT NULL,
      telefono      TEXT NOT NULL,
      email         TEXT,
      motivo        TEXT NOT NULL,
      fechaDeseada  TEXT,
      horaDeseada   TEXT,
      observaciones TEXT,
      estado        TEXT NOT NULL DEFAULT 'pendiente',
      citaId        TEXT,
      gestionadaEn  TEXT,
      creadaEn      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ip            TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sol_clinica_estado
      ON solicitudes(clinicaId, estado, creadaEn DESC);

    -- Fechas bloqueadas para citas web (solo telefónicas esos días)
    CREATE TABLE IF NOT EXISTS bloqueos (
      clinicaId TEXT NOT NULL REFERENCES clinicas(id),
      fecha     TEXT NOT NULL,   -- YYYY-MM-DD
      PRIMARY KEY (clinicaId, fecha)
    );

    -- Configuración de agenda publicada (horario, slots, días)
    CREATE TABLE IF NOT EXISTS agenda_config (
      clinicaId   TEXT PRIMARY KEY REFERENCES clinicas(id),
      config      TEXT NOT NULL DEFAULT '{}',
      updatedAt   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Citas ya ocupadas (sincronizadas desde PodoSystem + reservas web)
    CREATE TABLE IF NOT EXISTS citas_ocupadas (
      clinicaId TEXT NOT NULL REFERENCES clinicas(id),
      fecha     TEXT NOT NULL,   -- YYYY-MM-DD
      hora      TEXT NOT NULL,   -- HH:MM
      duracion  INTEGER NOT NULL DEFAULT 30,
      PRIMARY KEY (clinicaId, fecha, hora)
    );

    -- Reservas directas desde la web (confirmadas al instante)
    CREATE TABLE IF NOT EXISTS reservas (
      id            TEXT PRIMARY KEY,
      clinicaId     TEXT NOT NULL REFERENCES clinicas(id),
      fecha         TEXT NOT NULL,
      hora          TEXT NOT NULL,
      duracion      INTEGER NOT NULL DEFAULT 30,
      nombre        TEXT NOT NULL,
      telefono      TEXT NOT NULL,
      email         TEXT,
      motivo        TEXT,
      observaciones TEXT,
      estado        TEXT NOT NULL DEFAULT 'pendiente_pc',
      creadaEn      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reservas_clinica_estado
      ON reservas(clinicaId, estado, creadaEn DESC);
  `);

  return db;
}

/** Genera un ID corto tipo nanoid sin dependencias ESM */
function genId(len = 12) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

/** Genera un apiKey de 64 hex chars (256 bits) */
function genApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { initDB, genId, genApiKey };
