#!/usr/bin/env node
'use strict';
/**
 * descifrar-copia-relay.js — abrir una copia de la base del relay (30-09-2026)
 *
 *   RELAY_COPIA_CLAVE=<la clave> node scripts/descifrar-copia-relay.js relay-2026-09-30.db.gz.enc salida.db
 *
 * La clave se pasa por VARIABLE DE ENTORNO, nunca como argumento: un proceso que falla vuelca su
 * línea de órdenes, y con ella la clave (regla del proyecto). El resultado es una base SQLite
 * normal, que se puede abrir para mirar o poner en el volumen de Railway para restaurar.
 */
const fs = require('fs');
const { descifrar, claveDeCifrado } = require('../src/lib/copia-relay');

const [entrada, salida] = process.argv.slice(2);
if (!entrada || !salida) {
  console.error('Uso: RELAY_COPIA_CLAVE=... node scripts/descifrar-copia-relay.js <copia.db.gz.enc> <salida.db>');
  process.exit(2);
}
const clave = claveDeCifrado(process.env.RELAY_COPIA_CLAVE);
if (!clave) {
  console.error('Falta RELAY_COPIA_CLAVE (32 bytes, en hex o base64)');
  process.exit(2);
}
try {
  const db = descifrar(fs.readFileSync(entrada), clave);
  fs.writeFileSync(salida, db);
  console.log(`✅ ${salida}: ${db.length} bytes`);
} catch (e) {
  console.error('❌ No se pudo descifrar:', e.message, '— ¿es la clave correcta?');
  process.exit(1);
}
