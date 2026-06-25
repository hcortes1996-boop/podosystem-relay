#!/usr/bin/env node
/**
 * Pieza 5.0 — Datafix licencias existentes: extraer plan del campo notas.
 *
 * Las licencias creadas via webhook LemonSqueezy guardaban el plan en notas
 * con formato "<plan> | Colegiado: NNNN" (o solo "<plan>" si sin colegiado).
 * Tras Pieza 5.0, plan tiene columna propia. Default tras ALTER = 'clinica'.
 *
 * EJECUCION AUTOMATICA: src/db.js applyMigrations() invoca migrateLicenciasPlan
 * en cada arranque del servidor (silencioso, idempotente). Este script CLI
 * es para ejecucion ON-DEMAND manual (verbose).
 *
 * USO (LOCAL):  node scripts/migrate-licencias-plan.js
 * USO (RAILWAY): railway shell → node scripts/migrate-licencias-plan.js
 *
 * IDEMPOTENTE: se puede re-ejecutar sin riesgo. Solo actualiza filas donde
 * el plan extraido de notas difiere de la columna plan actual.
 */
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const { migrateLicenciasPlan } = require('../src/db');

const DB_PATH = process.env.DB_PATH || './relay.db';

console.log(`[migrate-licencias-plan] BD: ${path.resolve(DB_PATH)}`);

const db = new Database(path.resolve(DB_PATH), { timeout: 8000 });

// Verificar columna plan existe (si no, db.js ALTER aun no se ejecuto)
const cols = db.prepare("PRAGMA table_info(licencias)").all();
if (!cols.some(c => c.name === 'plan')) {
  console.error('[migrate-licencias-plan] ❌ Columna plan no existe. Arranca el servidor 1 vez para ejecutar ALTER, despues reintenta.');
  process.exit(1);
}

const total = db.prepare('SELECT COUNT(*) as n FROM licencias').get().n;
console.log(`[migrate-licencias-plan] Licencias en BD: ${total}`);

const result = migrateLicenciasPlan(db, { silencioso: false });

console.log(`[migrate-licencias-plan] Hecho. Actualizadas: ${result.actualizadas} | Ya correctas: ${result.yaCorrectas} | Saltadas (notas sin plan): ${result.saltadas}`);
db.close();
