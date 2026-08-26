/**
 * Test sandbox Pieza 6.1 — Sincronizacion bidireccional de marcas
 *
 * Verifica los 2 endpoints nuevos:
 *   POST /api/recordatorios-marks-batch
 *   GET  /api/recordatorios-marks
 *
 * Uso: node scripts/test_pieza_6_1.js
 * SQLite en memoria, sin tocar relay.db.
 */
'use strict';

const express  = require('express');
const Database = require('better-sqlite3');

const API_KEY_VALIDA = 'key_test_valida_xyz';
const API_KEY_FALSA  = 'key_test_falsa_zzz';
const CLINICA_ID     = 'clinicaTestX';

// ── Setup BD en memoria ────────────────────────────────────────────────────────
function setupDB() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE clinicas (
      id TEXT PRIMARY KEY,
      nombre TEXT,
      apiKey TEXT UNIQUE,
      activa INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE recordatorios_sent_marks (
      clinicaId TEXT NOT NULL,
      citaId    TEXT NOT NULL,
      markedAt  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (clinicaId, citaId)
    );
  `);
  db.prepare('INSERT INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)')
    .run(CLINICA_ID, 'Test Clinic', API_KEY_VALIDA);
  return db;
}

// ── Setup app Express ──────────────────────────────────────────────────────────
function setupApp(db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use('/api', require('../src/routes/recordatorios'));
  return app;
}

// ── Helper request ─────────────────────────────────────────────────────────────
async function call(server, method, path, { apiKey, body } = {}) {
  const port = server.address().port;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

// ── Assertions ─────────────────────────────────────────────────────────────────
const results = [];
function check(name, cond, info) {
  results.push({ name, pass: !!cond, info });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  '+info : ''}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  const db  = setupDB();
  const app = setupApp(db);
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));

  try {
    // T1 — POST batch con 3 marcas inserta 3 nuevas
    {
      const r = await call(server, 'POST', '/api/recordatorios-marks-batch', {
        apiKey: API_KEY_VALIDA,
        body: { marks: [
          { citaId: 'cita-A' },
          { citaId: 'cita-B', markedAt: '2026-06-26T10:00:00.000Z' },
          { citaId: 'cita-C' },
        ]},
      });
      check('T1 status 200',          r.status === 200, `got ${r.status}`);
      check('T1 ok true',             r.json && r.json.ok === true);
      check('T1 inserted=3',          r.json && r.json.inserted === 3, `got ${r.json && r.json.inserted}`);
      check('T1 skipped=0',           r.json && r.json.skipped === 0,  `got ${r.json && r.json.skipped}`);
      const row = db.prepare('SELECT markedAt FROM recordatorios_sent_marks WHERE citaId=?').get('cita-B');
      check('T1 markedAt explicito preservado en cita-B', row && row.markedAt === '2026-06-26T10:00:00.000Z',
            `got ${row && row.markedAt}`);
    }

    // T2 — POST batch con duplicados → INSERT OR IGNORE, skipped contado
    {
      const r = await call(server, 'POST', '/api/recordatorios-marks-batch', {
        apiKey: API_KEY_VALIDA,
        body: { marks: [
          { citaId: 'cita-A' },                                        // duplicado
          { citaId: 'cita-D' },                                        // nuevo
          { citaId: 'cita-B', markedAt: '2099-01-01T00:00:00.000Z' },  // duplicado, NO debe sobreescribir
          { citaId: '   '   },                                         // invalido
          {                  },                                        // invalido
        ]},
      });
      check('T2 status 200', r.status === 200, `got ${r.status}`);
      check('T2 inserted=1', r.json && r.json.inserted === 1, `got ${r.json && r.json.inserted}`);
      check('T2 skipped=4',  r.json && r.json.skipped  === 4, `got ${r.json && r.json.skipped}`);
      const rowB = db.prepare('SELECT markedAt FROM recordatorios_sent_marks WHERE citaId=?').get('cita-B');
      check('T2 markedAt original preservado (no sobreescritura)',
            rowB && rowB.markedAt === '2026-06-26T10:00:00.000Z', `got ${rowB && rowB.markedAt}`);
    }

    // T3 — GET sin desde devuelve todas (4: A, B, C, D)
    {
      const r = await call(server, 'GET', '/api/recordatorios-marks', { apiKey: API_KEY_VALIDA });
      check('T3 status 200',   r.status === 200);
      check('T3 ok true',      r.json && r.json.ok === true);
      check('T3 count=4',      r.json && Array.isArray(r.json.marks) && r.json.marks.length === 4,
            `got ${r.json && r.json.marks && r.json.marks.length}`);
      const ids = r.json && r.json.marks ? r.json.marks.map(m => m.citaId).sort() : [];
      check('T3 ids = [A,B,C,D]', JSON.stringify(ids) === JSON.stringify(['cita-A','cita-B','cita-C','cita-D']),
            `got ${JSON.stringify(ids)}`);
    }

    // T4 — GET con desde filtra correctamente
    // cita-B tiene markedAt '2026-06-26T10:00:00.000Z'. Filtramos desde 2026-06-27 → no debe aparecer cita-B
    // pero A, C, D tienen markedAt = now (2026-06-27+) → deben aparecer.
    {
      const r = await call(server, 'GET',
        '/api/recordatorios-marks?desde=2026-06-27T00:00:00.000Z', { apiKey: API_KEY_VALIDA });
      check('T4 status 200', r.status === 200);
      const ids = r.json && r.json.marks ? r.json.marks.map(m => m.citaId).sort() : [];
      check('T4 cita-B excluida (anterior a desde)', !ids.includes('cita-B'), `ids=${JSON.stringify(ids)}`);
      check('T4 cita-A,C,D presentes', ids.length === 3 && ids.includes('cita-A') && ids.includes('cita-C') && ids.includes('cita-D'),
            `ids=${JSON.stringify(ids)}`);
    }

    // T5 — Sin X-Api-Key → 401
    {
      const r = await call(server, 'POST', '/api/recordatorios-marks-batch', { body: { marks: [] } });
      check('T5 status 401 sin apiKey', r.status === 401, `got ${r.status}`);
      const r2 = await call(server, 'GET', '/api/recordatorios-marks');
      check('T5 status 401 sin apiKey (GET)', r2.status === 401, `got ${r2.status}`);
    }

    // T6 — X-Api-Key incorrecta → 403 (segun auth middleware)
    {
      const r = await call(server, 'POST', '/api/recordatorios-marks-batch', {
        apiKey: API_KEY_FALSA, body: { marks: [] },
      });
      check('T6 status 403 apiKey invalida (POST)', r.status === 403, `got ${r.status}`);
      const r2 = await call(server, 'GET', '/api/recordatorios-marks', { apiKey: API_KEY_FALSA });
      check('T6 status 403 apiKey invalida (GET)', r2.status === 403, `got ${r2.status}`);
    }

    // Extra — body no-array en POST → 400
    {
      const r = await call(server, 'POST', '/api/recordatorios-marks-batch', {
        apiKey: API_KEY_VALIDA, body: { marks: 'no-array' },
      });
      check('Extra status 400 marks no-array', r.status === 400, `got ${r.status}`);
    }

  } finally {
    // NOTA: no llamamos server.close() ni db.close() — libuv en Windows lanza
    // assertion al cerrar handles pendientes tras fetch + better-sqlite3.
    // process.exit() es suficiente para limpiar este sandbox.
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n=== ${passed} PASS / ${failed} FAIL / ${results.length} total ===`);
  // Respiro antes de salir: sin el, process.exit() pillaba a las conexiones de fetch a
  // medio cerrar y libuv abortaba en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file srcwinasync.c
  // El proceso salia con 127 DESPUES de pasar todas las comprobaciones: un test en verde
  // que quien lo lanza ve en rojo. (Detectado el 27-08-2026.)
  setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
