/**
 * db.js — Capa de base de datos SQLite para el relay de citas online
 * Patrón idéntico al db.js de PodoSystem: better-sqlite3, WAL mode.
 */

const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');

const DB_PATH = process.env.DB_PATH || './relay.db';

function initDB() {
  const db = new Database(path.resolve(DB_PATH), { timeout: 8000 });

  // Limpiar WAL residual de reinicios anteriores antes de activar WAL mode
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clinicas (
      id          TEXT PRIMARY KEY,
      nombre      TEXT NOT NULL,
      apiKey      TEXT UNIQUE NOT NULL,
      webUrl      TEXT,
      netlifyId   TEXT,
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

    -- Licencias PodoSystem (gestionadas desde el admin panel)
    CREATE TABLE IF NOT EXISTS licencias (
      id               TEXT PRIMARY KEY,
      licenseKey       TEXT UNIQUE NOT NULL,
      clienteNombre    TEXT NOT NULL,
      clienteEmail     TEXT NOT NULL,
      clinicaId        TEXT,
      hardwareId       TEXT,
      instanceId       TEXT,
      estado           TEXT NOT NULL DEFAULT 'trial',
      activadaEn       TEXT,
      ultimaValidacion TEXT,
      proximaRenovacion TEXT,
      notas            TEXT,
      createdAt        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_licencias_estado
      ON licencias(estado, createdAt DESC);

    -- Snapshot de agenda completa para la APK en modo remoto
    CREATE TABLE IF NOT EXISTS agenda_snapshot (
      clinicaId      TEXT PRIMARY KEY REFERENCES clinicas(id),
      citas          TEXT NOT NULL DEFAULT '[]',
      horarioClinica TEXT,   -- { inicio, fin, duracion } del horario real del PC
      updatedAt      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Operaciones de agenda creadas desde el móvil en modo remoto
    CREATE TABLE IF NOT EXISTS citas_remote_ops (
      id        TEXT PRIMARY KEY,
      clinicaId TEXT NOT NULL REFERENCES clinicas(id),
      op        TEXT NOT NULL,   -- 'add' | 'edit' | 'delete'
      citaId    TEXT NOT NULL,
      citaData  TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      syncedAt  TEXT            -- NULL = pendiente de sincronizar con el PC
    );
    CREATE INDEX IF NOT EXISTS idx_citas_remote_ops_pendientes
      ON citas_remote_ops(clinicaId, syncedAt, createdAt);

    -- Solicitudes de alta desde alta-relay.html
    CREATE TABLE IF NOT EXISTS solicitudes_alta (
      id                TEXT PRIMARY KEY,
      nombre_clinica    TEXT NOT NULL,
      profesional       TEXT NOT NULL,
      nif               TEXT,
      ciudad            TEXT,
      provincia         TEXT,
      telefono          TEXT NOT NULL,
      email             TEXT NOT NULL,
      web_citas         TEXT,
      mensaje           TEXT,
      podosystem_version TEXT,
      estado            TEXT NOT NULL DEFAULT 'pendiente',
      creadaEn          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      gestionadaEn      TEXT,
      notas_admin       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_solicitudes_alta_estado
      ON solicitudes_alta(estado, creadaEn DESC);
  `);

  // Migraciones incrementales (idempotentes: el catch ignora "column already exists")
  try { db.exec('ALTER TABLE agenda_snapshot ADD COLUMN horarioClinica TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE clinicas ADD COLUMN webUrl TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE clinicas ADD COLUMN netlifyId TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE clinicas ADD COLUMN logo BLOB'); } catch (_) {}
  // v1.5+ — LemonSqueezy y Plan Red
  try { db.exec("ALTER TABLE licencias ADD COLUMN fuente TEXT NOT NULL DEFAULT 'manual'"); } catch (_) {}
  try { db.exec('ALTER TABLE licencias ADD COLUMN suscripcionId TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE licencias ADD COLUMN max_podologos INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
  try { db.exec('ALTER TABLE licencias ADD COLUMN plan_extra INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  // v1.9.1+ — Código de activación de un solo uso para citas web
  try { db.exec('ALTER TABLE clinicas ADD COLUMN activation_code TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE clinicas ADD COLUMN activation_code_used INTEGER DEFAULT 0'); } catch (_) {}

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

/** Genera código de activación: 4 letras del nombre + guion + 4 dígitos. Ej: MERI-4829 */
function genActivationCode(nombre) {
  const prefix = (nombre || 'PODE').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4).padEnd(4, 'X');
  const num = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}-${num}`;
}

module.exports = { initDB, genId, genApiKey, genActivationCode };
