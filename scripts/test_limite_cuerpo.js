#!/usr/bin/env node
'use strict';
/**
 * Test — una clínica grande cabe en una sincronización.
 *
 * Hasta el 06-10-2026 el relay usaba el límite de serie de Express, 100 KB. El PC manda en cada
 * sincronización los huecos ocupados de toda la ventana (`/api/sync-agenda`) y todas las citas
 * futuras para la APK (`/api/agenda-snapshot`). Una clínica de 4-5 podólogos con la agenda llena a
 * un mes vista pasaba de 100 KB: Express respondía 413, el relay se quedaba con la ocupación vieja
 * y la web ofrecía horas ya ocupadas, sin ningún aviso.
 *
 * Aquí: 5 podólogos × 15 citas al día × 42 días, en los dos envíos.
 *
 * Uso:  node scripts/test_limite_cuerpo.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_lim_${process.pid}.db`);
const PORT = 3102;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

require('../src/index.js');

const CLINICA = 'testLim01';
const KEY = 'k_lim';
const HORARIO = { '0': [], '6': [],
  '1': [{ inicio: '08:00', fin: '20:00' }], '2': [{ inicio: '08:00', fin: '20:00' }],
  '3': [{ inicio: '08:00', fin: '20:00' }], '4': [{ inicio: '08:00', fin: '20:00' }],
  '5': [{ inicio: '08:00', fin: '20:00' }] };
const CONFIG = { duracionSlot: 30, diasMin: 1, diasMax: 30, horario: HORARIO };

// 5 podólogos × 15 citas × 42 días naturales, como las manda el PC (cada una con hora distinta
// dentro del día y del podólogo; el relay no exige que no se solapen entre podólogos).
const huecos = [];
const citas = [];
const d0 = new Date(); d0.setDate(d0.getDate() + 1);
for (let dia = 0; dia < 42; dia++) {
  const d = new Date(d0); d.setDate(d0.getDate() + dia);
  const fecha = d.toISOString().slice(0, 10);
  for (let p = 0; p < 5; p++) {
    for (let i = 0; i < 15; i++) {
      const min = 8 * 60 + i * 30;
      const hora = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
      huecos.push({ fecha, hora, duracion: 30 });
      citas.push({ id: `c${dia}_${p}_${i}_1727000000000`, fecha, hora,
        nombre: 'Nombre Apellido Apellido', telefono: '600000000', confirmada: false, duracion: 30 });
    }
  }
}

const put = async (ruta, cuerpo) => {
  const body = JSON.stringify(cuerpo);
  const r = await fetch(`http://127.0.0.1:${PORT}${ruta}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body,
  });
  return { status: r.status, kb: Math.round(Buffer.byteLength(body) / 1024), body: await r.json().catch(() => ({})) };
};

setTimeout(async () => {
  const db = require('better-sqlite3')(TMP);
  db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)')
    .run(CLINICA, 'Clinica Grande', KEY);

  const s = await put('/api/sync-agenda', { config: CONFIG, citasOcupadas: huecos });
  ok(s.kb > 100, `el envío de huecos pasa de 100 KB (${s.kb} KB), que era el límite viejo`);
  ok(s.status === 200, `sync-agenda de ${huecos.length} huecos se acepta`, 'status ' + s.status);
  const n = db.prepare('SELECT COUNT(*) AS n FROM citas_ocupadas WHERE clinicaId = ?').get(CLINICA).n;
  ok(n > 0, 'y el relay guarda la ocupación', 'quedan ' + n);

  const a = await put('/api/agenda-snapshot', { citas });
  ok(a.kb > 100, `el envío para la APK pasa de 100 KB (${a.kb} KB)`);
  ok(a.status === 200 && a.body.count === citas.length,
     `agenda-snapshot de ${citas.length} citas se acepta entero`, 'status ' + a.status + ' ' + JSON.stringify(a.body).slice(0, 120));

  console.log(`\n${pasados} pasados, ${fallados} fallados`);
  try { db.close(); fs.unlinkSync(TMP); } catch {}
  setTimeout(() => process.exit(fallados ? 1 : 0), 300);
}, 2500);
