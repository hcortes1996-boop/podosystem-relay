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

    -- v2.2+ — Multi-podólogo (Plan Red web)
    -- Lista pública de podólogos por clínica. id viene de PodoSystem (UUID),
    -- único dentro de cada clínica → PK compuesta (clinicaId, id).
    CREATE TABLE IF NOT EXISTS podologos_publicos (
      clinicaId          TEXT NOT NULL REFERENCES clinicas(id),
      id                 TEXT NOT NULL,
      nombre             TEXT NOT NULL,
      apellido           TEXT,
      color              TEXT NOT NULL DEFAULT '#1E3A5F',
      orden              INTEGER NOT NULL DEFAULT 0,
      descripcionPublica TEXT,
      horarioPublico     TEXT,         -- JSON o NULL (fallback a agenda_config.horario)
      visibleEnWeb       INTEGER NOT NULL DEFAULT 1,
      activo             INTEGER NOT NULL DEFAULT 1,
      updatedAt          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (clinicaId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_podologos_publicos_visibles
      ON podologos_publicos(clinicaId, visibleEnWeb, activo, orden);

    -- v2.2+ — Citas ocupadas POR podólogo (permite varios podólogos en el mismo slot)
    -- Convive con citas_ocupadas (agregada, sin podologoId) para backwards-compat.
    -- INTEGER PK + UNIQUE compuesto → permite múltiples filas por (fecha, hora) con
    -- podologoId distinto, lo que es la semántica multi-podólogo.
    CREATE TABLE IF NOT EXISTS citas_podologo (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clinicaId   TEXT NOT NULL REFERENCES clinicas(id),
      fecha       TEXT NOT NULL,
      hora        TEXT NOT NULL,
      duracion    INTEGER NOT NULL DEFAULT 30,
      podologoId  TEXT NOT NULL,
      UNIQUE (clinicaId, fecha, hora, podologoId)
    );
    CREATE INDEX IF NOT EXISTS idx_citas_podologo_clinica_fecha
      ON citas_podologo(clinicaId, podologoId, fecha);
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
  // Pieza 5.0 — Plan determina las features del cliente (basico|clinica|red).
  // Default 'clinica' por ser la mayoría de licencias actuales en BD.
  try { db.exec("ALTER TABLE licencias ADD COLUMN plan TEXT NOT NULL DEFAULT 'clinica'"); } catch (_) {}
  // v1.9.1+ — Código de activación de un solo uso para citas web
  try { db.exec('ALTER TABLE clinicas ADD COLUMN activation_code TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE clinicas ADD COLUMN activation_code_used INTEGER DEFAULT 0'); } catch (_) {}
  // v2.0+ — Referencia a la clínica creada al aprobar solicitud de alta
  try { db.exec('ALTER TABLE solicitudes_alta ADD COLUMN clinicaId TEXT'); } catch (_) {}
  // v2.1+ — Datos de contacto de la clínica (necesarios para deploy Netlify diferido)
  try { db.exec('ALTER TABLE clinicas ADD COLUMN telefono TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE clinicas ADD COLUMN ciudad TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE clinicas ADD COLUMN provincia TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE clinicas ADD COLUMN direccion TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE clinicas ADD COLUMN email TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE clinicas ADD COLUMN profesional TEXT'); } catch (_) {}

  // v2.2+ — Multi-podólogo (Plan Red web)
  try { db.exec('ALTER TABLE reservas ADD COLUMN podologoId TEXT'); } catch (_) {}

  // Pieza 6.0 — Recordatorios cloud (push notifications a APK fuera de red local PC).
  // Tres tablas: tokens registrados por la APK, configuracion sincronizada del PC,
  // log de envios para idempotencia diaria.
  db.exec(`
    CREATE TABLE IF NOT EXISTS expo_push_tokens (
      id             TEXT PRIMARY KEY,
      clinicaId      TEXT NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
      expoPushToken  TEXT NOT NULL,
      platform       TEXT,
      deviceInfo     TEXT,
      registeredAt   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      lastUsedAt     TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expo_push_tokens_unique
      ON expo_push_tokens(clinicaId, expoPushToken);

    CREATE TABLE IF NOT EXISTS recordatorios_config (
      clinicaId        TEXT PRIMARY KEY REFERENCES clinicas(id) ON DELETE CASCADE,
      diasAntelacion   INTEGER NOT NULL DEFAULT 1,
      recordarMismoDia INTEGER NOT NULL DEFAULT 1,
      reglaViernes     INTEGER NOT NULL DEFAULT 1,
      horaEnvio        INTEGER NOT NULL DEFAULT 20,
      zonaHoraria      TEXT NOT NULL DEFAULT 'Europe/Madrid',
      updatedAt        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS recordatorios_sent_log (
      id              TEXT PRIMARY KEY,
      clinicaId       TEXT NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
      fechaObjetivo   TEXT NOT NULL,
      count           INTEGER NOT NULL,
      citasIds        TEXT,
      sentAt          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_recordatorios_sent_log_idem
      ON recordatorios_sent_log(clinicaId, fechaObjetivo);

    CREATE TABLE IF NOT EXISTS recordatorios_sent_marks (
      clinicaId TEXT NOT NULL,
      citaId    TEXT NOT NULL,
      markedAt  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (clinicaId, citaId)
    );
  `);

  // Pieza 5.0 (datafix automatico) — extraer plan del campo notas para
  // licencias legacy (LemonSqueezy) que tenian "<plan> | Colegiado: NNNN".
  // Idempotente: solo actualiza filas donde plan != primer token de notas.
  // Licencias con notas vacias o irregulares quedan en default 'clinica'.
  migrateLicenciasPlan(db, { silencioso: true });

  return db;
}

/**
 * Pieza 5.0 — Datafix licencias existentes: extraer plan del campo notas.
 *
 * Idempotente: re-ejecucion no toca filas ya correctas. Seguro de invocar
 * en cada arranque del servidor (lo hace applyMigrations).
 *
 * Tambien expuesto en scripts/migrate-licencias-plan.js para ejecucion CLI.
 *
 * @param {Database} db        — instancia better-sqlite3 abierta
 * @param {object}   opts
 * @param {boolean}  opts.silencioso — true en arranque server (sin logs)
 * @returns {{actualizadas:number, saltadas:number, yaCorrectas:number}}
 */
function migrateLicenciasPlan(db, opts = {}) {
  const PLANES_VALIDOS = ['basico', 'clinica', 'red'];
  const log = opts.silencioso ? () => {} : (msg) => console.log(msg);

  // Verificar columna plan existe (defensivo, deberia tras ALTER previo)
  const cols = db.prepare("PRAGMA table_info(licencias)").all();
  if (!cols.some(c => c.name === 'plan')) return { actualizadas: 0, saltadas: 0, yaCorrectas: 0 };

  const updateStmt = db.prepare('UPDATE licencias SET plan = ? WHERE id = ?');
  const licencias  = db.prepare('SELECT id, licenseKey, clienteNombre, notas, plan FROM licencias').all();

  let actualizadas = 0, saltadas = 0, yaCorrectas = 0;
  const tx = db.transaction(() => {
    for (const lic of licencias) {
      const primeraToken = String(lic.notas || '').split('|')[0].trim().toLowerCase();
      if (!PLANES_VALIDOS.includes(primeraToken)) { saltadas++; continue; }
      if (lic.plan === primeraToken)               { yaCorrectas++; continue; }
      updateStmt.run(primeraToken, lic.id);
      actualizadas++;
      log(`[migrate-licencias-plan]  ✓ ${lic.licenseKey} (${lic.clienteNombre}): plan="${lic.plan}" → "${primeraToken}"`);
    }
  });
  tx();

  if (!opts.silencioso) {
    log(`[migrate-licencias-plan] Hecho. Actualizadas: ${actualizadas} | Ya correctas: ${yaCorrectas} | Saltadas: ${saltadas}`);
  } else if (actualizadas > 0) {
    // En modo silencioso, solo logear si hubo cambios (no spamear arranque normal)
    console.log(`[migrate-licencias-plan] Datafix automatico: ${actualizadas} licencias actualizadas desde notas.`);
  }

  return { actualizadas, saltadas, yaCorrectas };
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

module.exports = { initDB, genId, genApiKey, genActivationCode, migrateLicenciasPlan };
