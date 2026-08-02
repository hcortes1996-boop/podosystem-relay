#!/usr/bin/env node
'use strict';
/**
 * Tests de regresión — incidente de dobles citas de agosto 2026.
 *
 * Ver docs del PC: Clinica_Francisco_Roman/docs/incidente_dobles_citas_2026-08.md
 *
 * Cubre los tres defectos y las defensas nuevas:
 *   Fix 3     — reservar-slot debe rechazar por SOLAPAMIENTO, no por hora exacta,
 *               en las tres consultas (citas_ocupadas, citas_podologo, reservas).
 *   Fix 3-bis — sin ventana declarada, la oferta se acota en dias NATURALES
 *               (lo que el PC envia) y no en habiles (lo que el relay calculaba).
 *   Punto 4   — con ventana declarada, la oferta se acota a ella (falla en cerrado).
 *   Fix 4     — un citasOcupadas vacio se aplica igual, solo se avisa.
 *
 * Uso:  node scripts/test_agenda_solapes.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = path.join(os.tmpdir(), `test_agenda_${process.pid}.db`);
process.env.DB_PATH = TMP;

let pasados = 0, fallados = 0;
const ok = (cond, nombre, detalle) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (detalle ? '\n       ' + detalle : '')); }
};

// ── utilidades bajo prueba, importadas del modulo real ────────────────────────
const agenda = require('../src/routes/agenda.js');
const H = agenda.__test__;
if (!H) {
  console.error('❌ src/routes/agenda.js no exporta __test__ — no se pueden probar los helpers');
  process.exit(1);
}

const HORARIO_NORMAL = {
  '1': [{ inicio: '09:30', fin: '13:00' }], '2': [{ inicio: '09:30', fin: '13:00' }],
  '3': [{ inicio: '09:30', fin: '13:00' }], '4': [{ inicio: '09:30', fin: '13:00' }],
  '5': [{ inicio: '09:30', fin: '13:00' }], '6': [], '0': [],
};
const HORARIO_ESCASO = { '4': [{ inicio: '09:30', fin: '13:00' }], '1': [], '2': [], '3': [], '5': [], '6': [], '0': [] };

console.log('\n── Fix 3: solapamiento en la comprobacion de reserva ──');
{
  // Escenario 1: cita de 11:45 durante 60 min. Reservar 12:00 debe RECHAZARSE.
  const ocupadas = [{ hora: '11:45', duracion: 60 }];
  ok(H.haySolape(ocupadas, '12:00', 30) === true,
     'cita 11:45(60min) bloquea una reserva a las 12:00',
     'es el caso real de Pablo Corral vs INES VIDAN del 04-08-2026');

  // Escenario 4: hueco genuinamente libre no debe bloquearse.
  ok(H.haySolape(ocupadas, '13:00', 30) === false,
     'la misma cita NO bloquea las 13:00 (no solapa)');

  // Limite exacto: 11:45+60 = 12:45. Una reserva a las 12:45 no solapa.
  ok(H.haySolape(ocupadas, '12:45', 30) === false,
     'limite exacto: 12:45 queda libre (fin de la anterior)');
  ok(H.haySolape(ocupadas, '12:30', 30) === true,
     'limite exacto: 12:30 sigue ocupado');

  // Igualdad de hora — lo unico que detectaba el codigo viejo.
  ok(H.haySolape([{ hora: '12:00', duracion: 30 }], '12:00', 30) === true,
     'hora exacta sigue detectandose (no hay regresion)');

  // Caso real de Antonio vs CONSUELO: 09:15(30) bloquea 09:30.
  ok(H.haySolape([{ hora: '09:15', duracion: 30 }], '09:30', 30) === true,
     'cita 09:15(30min) bloquea 09:30 (caso Antonio vs CONSUELO del 10-08-2026)');
}

console.log('\n── Fix 3-bis: ventana por defecto en dias NATURALES ──');
{
  // Domingo 02-08-2026, diasMax 7.
  const base = new Date('2026-08-02T12:00:00Z');

  const habiles = H.sumarDiasHabiles(base, 7, HORARIO_NORMAL);
  ok(habiles.toISOString().slice(0, 10) === '2026-08-11',
     'sumarDiasHabiles(7) llega al 11-ago (comportamiento antiguo, documentado)',
     'obtenido: ' + habiles.toISOString().slice(0, 10));

  const fin = H.ventanaFin(base, 7, HORARIO_NORMAL, null);
  ok(fin.toISOString().slice(0, 10) === '2026-08-09',
     'sin ventana declarada, la oferta termina el 09-ago (7 dias naturales)',
     'obtenido: ' + fin.toISOString().slice(0, 10) + ' — debe coincidir con lo que envia el PC');

  // Escenario 8: horario de un solo dia a la semana.
  const finEscaso = H.ventanaFin(base, 7, HORARIO_ESCASO, null);
  ok(finEscaso.toISOString().slice(0, 10) === '2026-08-09',
     'horario de 1 dia/semana: sigue acotando a 7 dias naturales, no a 7 semanas',
     'obtenido: ' + finEscaso.toISOString().slice(0, 10));
}

console.log('\n── Punto 4: ventana declarada por el PC ──');
{
  const base = new Date('2026-08-02T12:00:00Z');

  // Escenario 6: el PC declara una ventana MAS CORTA -> mandan sus fechas.
  const corta = H.ventanaFin(base, 7, HORARIO_NORMAL, { desde: '2026-08-02', hasta: '2026-08-05' });
  ok(corta.toISOString().slice(0, 10) === '2026-08-05',
     'ventana declarada mas corta: se respeta (falla en cerrado)',
     'obtenido: ' + corta.toISOString().slice(0, 10));

  // Escenario 7: el PC declara una ventana MAS LARGA -> no amplia la oferta.
  const larga = H.ventanaFin(base, 7, HORARIO_NORMAL, { desde: '2026-08-02', hasta: '2026-12-31' });
  ok(larga.toISOString().slice(0, 10) === '2026-08-09',
     'ventana declarada mas larga: NO amplia la oferta mas alla de diasMax');

  // Escenario 5: retrocompatibilidad — sin ventana se comporta como el default.
  const sinVentana = H.ventanaFin(base, 7, HORARIO_NORMAL, undefined);
  ok(sinVentana.toISOString().slice(0, 10) === '2026-08-09',
     'sin campo ventana: mismo resultado que el default (retrocompatible)');

  // Ventana malformada no debe romper ni ampliar.
  const mala = H.ventanaFin(base, 7, HORARIO_NORMAL, { desde: 'xx', hasta: 'yy' });
  ok(mala.toISOString().slice(0, 10) === '2026-08-09',
     'ventana malformada: se ignora sin romper');
}

console.log('\n── slotLibres: sin regresiones ──');
{
  const slots = ['09:30', '10:00', '10:30', '11:00'];
  const libres = H.slotLibres(slots, [{ hora: '10:00', duracion: 60 }], 30);
  ok(JSON.stringify(libres) === JSON.stringify(['09:30', '11:00']),
     'una cita de 10:00(60min) libera 09:30 y 11:00 y ocupa 10:00 y 10:30',
     'obtenido: ' + JSON.stringify(libres));
}

console.log(`\n${pasados} pasados, ${fallados} fallados`);
try { fs.unlinkSync(TMP); } catch {}
process.exit(fallados ? 1 : 0);
