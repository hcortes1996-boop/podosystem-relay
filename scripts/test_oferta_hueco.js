#!/usr/bin/env node
'use strict';
/**
 * La lógica del enlace «La quiero» (lista de espera, Fase 2), sin servidor.
 * Uso: node scripts/test_oferta_hueco.js
 */
const L = require('../src/lib/oferta_hueco');

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

const AHORA = new Date('2026-10-26T09:00:00Z');   // lunes 26-10, 10:00 en Madrid (invierno)
const base = {
  huecoCitaId: 101, candidatoCitaId: 202, fecha: '2026-10-27', hora: '10:00', duracion: 30,
  nombre: 'Ana Ruiz Pérez', citaActualFecha: '2026-11-05', citaActualHora: '17:00',
  venceEn: '2026-10-26T11:00:00Z',
};

console.log('\n── Franjas ──');
ok(L.normalizarFranja('manana') === 'manana', 'manana vale');
ok(L.normalizarFranja('Mañana') === 'manana', 'Mañana con tilde y mayúscula vale');
ok(L.normalizarFranja('tarde') === 'tarde' && L.normalizarFranja('dia') === 'dia', 'tarde y dia valen');
ok(L.normalizarFranja('noche') === null && L.normalizarFranja('') === null && L.normalizarFranja(null) === null, 'lo demás no vale');

console.log('\n── Crear la oferta ──');
const v = L.validarNuevaOferta(base, AHORA);
ok(v.ok, 'una oferta correcta se acepta', v.error);
ok(v.datos.nombrePila === 'Ana', 'solo viaja el nombre de pila');
ok(v.datos.huecoCitaId === '101' && v.datos.candidatoCitaId === '202', 'los ids del PC se guardan como texto');
ok(!L.validarNuevaOferta({ ...base, venceEn: '2026-10-26T08:00:00Z' }, AHORA).ok, 'plazo ya vencido → no');
ok(!L.validarNuevaOferta({ ...base, venceEn: '2026-11-20T08:00:00Z' }, AHORA).ok, 'plazo de más de una semana → no');
ok(!L.validarNuevaOferta({ ...base, candidatoCitaId: 101 }, AHORA).ok, 'hueco y candidato iguales → no');
ok(!L.validarNuevaOferta({ ...base, hora: '10h' }, AHORA).ok, 'hora mal formada → no');
ok(!L.validarNuevaOferta({ ...base, nombre: '  ' }, AHORA).ok, 'sin nombre → no');
ok(L.validarNuevaOferta({ ...base, duracion: -5 }, AHORA).datos.duracion === 30, 'duración absurda → 30');

console.log('\n── Responder ──');
const abierta = { ...v.datos, estado: 'abierta' };
ok(L.puedeResponder(abierta, 'Europe/Madrid', AHORA).permitido, 'abierta y en plazo → se puede');
ok(L.puedeResponder(abierta, 'Europe/Madrid', new Date('2026-10-26T11:00:01Z')).motivo === 'caducada',
   'pasado venceEn → caducada aunque en la base siga «abierta»');
ok(L.estadoEfectivo(abierta, new Date('2026-10-26T11:00:01Z')) === 'caducada', 'estadoEfectivo lo ve igual');
for (const e of ['aceptada', 'rechazada', 'retirada', 'caducada']) {
  ok(L.puedeResponder({ ...abierta, estado: e }, 'Europe/Madrid', AHORA).motivo === e, `${e} → no se puede, y dice por qué`);
}
const yaEmpezado = { ...abierta, fecha: '2026-10-26', hora: '09:30', venceEn: '2026-10-26T12:00:00Z' };
ok(L.puedeResponder(yaEmpezado, 'Europe/Madrid', AHORA).motivo === 'pasada',
   'el hueco de las 9:30 (Madrid) ya pasó a las 10:00 → pasada');

console.log('\n── Lo que ve el paciente ──');
const vista = L.vistaPublica(abierta, { nombre: 'Clínica X', telefono: '911000000' },
                             L.puedeResponder(abierta, 'Europe/Madrid', AHORA));
ok(vista.nombre === 'Ana' && vista.hueco.hora === '10:00' && vista.citaActual.fecha === '2026-11-05', 'nombre, hueco y cita actual');
ok(!JSON.stringify(vista).includes('Ruiz') && !('candidatoCitaId' in vista) && !('tokenHash' in vista),
   'ni apellidos ni ids internos ni hash');
ok(vista.puedeResponder === true && vista.estado === 'abierta', 'estado abierta y se puede responder');

console.log(`\n${fallados ? '❌' : '✅'} ${pasados} en verde, ${fallados} en rojo\n`);
process.exit(fallados ? 1 : 0);
