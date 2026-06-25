#!/usr/bin/env node
/**
 * Pieza 5.0 — Datafix licencias existentes: extraer plan del campo notas.
 *
 * Las licencias creadas via webhook LemonSqueezy guardaban el plan en notas
 * con formato "<plan> | Colegiado: NNNN" (o solo "<plan>" si sin colegiado).
 * Tras Pieza 5.0, plan tiene columna propia. Default tras ALTER = 'clinica'.
 *
 * Este script extrae el plan de notas en formato esperado y lo asigna a la
 * columna plan. Licencias con notas vacias o irregulares quedan en 'clinica'
 * (default), que es el comportamiento correcto (la mayoria son Clinica).
 *
 * USO (LOCAL):  node scripts/migrate-licencias-plan.js
 * USO (RAILWAY): railway run node scripts/migrate-licencias-plan.js
 *
 * IDEMPOTENTE: se puede re-ejecutar sin riesgo. Solo actualiza filas donde
 * el plan extraido de notas difiere de la columna plan actual.
 */
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = process.env.DB_PATH || './relay.db';
const PLANES_VALIDOS = ['basico', 'clinica', 'red'];

console.log(`[migrate-licencias-plan] BD: ${path.resolve(DB_PATH)}`);

const db = new Database(path.resolve(DB_PATH), { timeout: 8000 });

// Verificar columna plan existe (si no, db.js ALTER aun no se ejecuto)
const cols = db.prepare("PRAGMA table_info(licencias)").all();
const tienePlan = cols.some(c => c.name === 'plan');
if (!tienePlan) {
  console.error('[migrate-licencias-plan] ❌ Columna plan no existe. Arranca el servidor 1 vez para ejecutar ALTER, despues reintenta.');
  process.exit(1);
}

const licencias = db.prepare('SELECT id, licenseKey, clienteNombre, notas, plan FROM licencias').all();
console.log(`[migrate-licencias-plan] Licencias en BD: ${licencias.length}`);

let actualizadas = 0;
let saltadas     = 0;
let yaCorrectas  = 0;

const updateStmt = db.prepare('UPDATE licencias SET plan = ? WHERE id = ?');

const tx = db.transaction(() => {
  for (const lic of licencias) {
    const primeraToken = String(lic.notas || '').split('|')[0].trim().toLowerCase();
    if (!PLANES_VALIDOS.includes(primeraToken)) {
      saltadas++;
      continue; // notas vacias o formato distinto → queda con default
    }
    if (lic.plan === primeraToken) {
      yaCorrectas++;
      continue;
    }
    updateStmt.run(primeraToken, lic.id);
    actualizadas++;
    console.log(`[migrate-licencias-plan]  ✓ ${lic.licenseKey} (${lic.clienteNombre}): plan="${lic.plan}" → "${primeraToken}"`);
  }
});

tx();

console.log(`[migrate-licencias-plan] Hecho. Actualizadas: ${actualizadas} | Ya correctas: ${yaCorrectas} | Saltadas (notas sin plan): ${saltadas}`);
db.close();
