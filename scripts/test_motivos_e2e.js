/**
 * test_motivos_e2e.js — motivos de consulta, sobre el relay de verdad.
 *
 * `test_motivos.js` prueba el catalogo y la aritmetica en aislado. Esto levanta el servidor
 * entero y comprueba lo que de verdad importa:
 *
 *   · que la rejilla que ve el paciente CAMBIA segun a que venga;
 *   · que la reserva guarda la duracion del motivo, no la de la clinica;
 *   · y que **mandar minutos desde el navegador no sirve de nada**.
 *
 * Se usan los dos casos reales que motivan la pieza:
 *
 *   German    rejilla 20 → quiropodia 20 · estudio 40
 *   Francisco rejilla 15 → quiropodia 30 · curas y revisiones 15
 *
 * Uso:  node scripts/test_motivos_e2e.js
 */
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TMP  = path.join(os.tmpdir(), `relay_motivos_${process.pid}.db`);
const PORT = 3098;
process.env.DB_PATH     = TMP;
process.env.PORT        = String(PORT);
process.env.NODE_ENV    = 'test';
process.env.ADMIN_TOKEN = 'token-de-prueba';
process.env.REGISTRO_SECRET = 'secreto-de-prueba';

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

require('../src/index.js');
const db = require('better-sqlite3')(TMP);
const BASE = `http://127.0.0.1:${PORT}`;

const j = (r) => r.json();
// Los slots vienen como { hora, libre }, no como cadenas.
const horas  = (dia) => (dia.slots || []).map(s => s.hora);
const libres = (dia) => (dia.slots || []).filter(s => s.libre).map(s => s.hora);
const get = (ruta) => fetch(BASE + ruta).then(j);
const post = (ruta, body, cab = {}) => fetch(BASE + ruta, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...cab }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// Manana de un dia concreto, para que las cuentas no dependan de cuando se ejecute.
function proximoLunes() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

function crearClinica(nombre, cfg) {
  const { genId, genApiKey } = require('../src/db');
  const id = genId(10), apiKey = genApiKey();
  db.prepare('INSERT INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)').run(id, nombre, apiKey);
  db.prepare('INSERT INTO agenda_config (clinicaId, config) VALUES (?,?)').run(id, JSON.stringify(cfg));
  return { id, apiKey };
}

(async () => {
  await new Promise(r => setTimeout(r, 400));
  const LUNES = proximoLunes();
  const diaSemana = String(new Date(LUNES + 'T12:00:00Z').getUTCDay());

  // ── Los dos casos reales ───────────────────────────────────────────────────
  const german = crearClinica('German', {
    duracionSlot: 20, diasMin: 0, diasMax: 30,
    horario: { [diaSemana]: [{ inicio: '09:30', fin: '13:00' }] },
    motivos: [
      { id: 'quiropodia', nombre: 'Quiropodia', minutos: 20, activo: true },
      { id: 'estudio',    nombre: 'Estudio',    minutos: 40, activo: true },
    ],
  });
  const francisco = crearClinica('Francisco', {
    duracionSlot: 15, diasMin: 0, diasMax: 30,
    horario: { [diaSemana]: [{ inicio: '09:30', fin: '13:00' }] },
    motivos: [
      { id: 'quiropodia', nombre: 'Quiropodia', minutos: 30, activo: true },
      { id: 'cura',       nombre: 'Cura',       minutos: 15, activo: true },
    ],
  });

  console.log('\n🧪 Motivos de consulta — sobre el relay real\n');

  console.log('── El paciente ve el catalogo junto a la rejilla ──');
  {
    const r = await get(`/api/semana/${german.id}?desde=${LUNES}`);
    ok(Array.isArray(r.motivos) && r.motivos.length === 2, 'la web recibe los motivos', JSON.stringify(r.motivos));
    ok(r.motivos.every(m => m.minutos === undefined),
      'sin los minutos: no le dicen nada al paciente e invitan a probar numeros');
  }

  console.log('\n── La rejilla CAMBIA segun a que vengas (German) ──');
  {
    const quiro = await get(`/api/semana/${german.id}?desde=${LUNES}&motivo=quiropodia`);
    const estud = await get(`/api/semana/${german.id}?desde=${LUNES}&motivo=estudio`);
    const dQ = quiro.dias.find(d => d.fecha === LUNES);
    const dE = estud.dias.find(d => d.fecha === LUNES);
    ok(horas(dQ).length === 10, 'una quiropodia de 20 cabe 10 veces entre 09:30 y 13:00', String(horas(dQ).length));
    ok(horas(dE).length === 9,  'un estudio de 40 se oferta 9 veces, en la misma rejilla de 20', String(horas(dE).length));
    ok(horas(dQ).includes('12:30') && !horas(dE).includes('12:30'),
      'las 12:30 valen para quiropodia y NO para estudio: 12:30+40 se pasaria de las 13:00');
    ok(horas(dE).includes('09:50'),
      'y el estudio se oferta cada 20, no cada 40 — las 09:50 no se pierden');
  }

  console.log('\n── Y en el caso de Francisco, con curas de 15 ──');
  {
    const quiro = await get(`/api/semana/${francisco.id}?desde=${LUNES}&motivo=quiropodia`);
    const cura  = await get(`/api/semana/${francisco.id}?desde=${LUNES}&motivo=cura`);
    const dQ = quiro.dias.find(d => d.fecha === LUNES);
    const dC = cura.dias.find(d => d.fecha === LUNES);
    ok(horas(dC).length > horas(dQ).length,
      'una cura de 15 tiene mas huecos que una quiropodia de 30', `${horas(dC).length} vs ${horas(dQ).length}`);
    ok(horas(dQ).includes('09:45'),
      'y la quiropodia se oferta tambien a y cuarto: la rejilla fina da mas horas');
  }

  console.log('\n── Sin motivo, todo sigue como siempre ──');
  {
    const sin = await get(`/api/semana/${german.id}?desde=${LUNES}`);
    const quiro = await get(`/api/semana/${german.id}?desde=${LUNES}&motivo=quiropodia`);
    const a = horas(sin.dias.find(d => d.fecha === LUNES));
    const b = horas(quiro.dias.find(d => d.fecha === LUNES));
    ok(JSON.stringify(a) === JSON.stringify(b),
      'sin motivo se usa la duracion de la clinica — retrocompatible');
  }

  console.log('\n── La reserva guarda la duracion del MOTIVO ──');
  {
    const r = await post('/api/reservar-slot', {
      clinicaId: german.id, fecha: LUNES, hora: '09:30',
      nombre: 'Paciente Prueba', telefono: '600001111', motivoId: 'estudio',
    });
    ok(r.body.ok === true, 'la reserva se acepta', JSON.stringify(r.body).slice(0, 120));
    const fila = db.prepare('SELECT duracion, motivo FROM reservas WHERE clinicaId = ?').get(german.id);
    ok(fila.duracion === 40, 'con 40 minutos, no con los 20 de la clinica', String(fila.duracion));
    ok(fila.motivo === 'Estudio', 'y el nombre resuelto del catalogo, para que la clinica lo lea', fila.motivo);
    const oc = db.prepare('SELECT duracion FROM citas_ocupadas WHERE clinicaId = ? AND hora = ?').get(german.id, '09:30');
    ok(oc.duracion === 40, 'el hueco bloqueado tambien ocupa 40', String(oc.duracion));
  }

  console.log('\n── Y ese estudio bloquea lo que tiene que bloquear ──');
  {
    const quiro = await get(`/api/semana/${german.id}?desde=${LUNES}&motivo=quiropodia`);
    const d = quiro.dias.find(x => x.fecha === LUNES);
    ok(!libres(d).includes('09:30') && !libres(d).includes('09:50'),
      'un estudio de 09:30 a 10:10 tapa DOS huecos de quiropodia');
    ok(libres(d).includes('10:10'), 'y deja libre el de las 10:10');
  }

  console.log('\n── LO QUE NO PUEDE PASAR: que el cliente decida los minutos ──');
  {
    // Se intenta colar una cita de 5 minutos donde solo caben 20, mandando la duracion.
    const r = await post('/api/reservar-slot', {
      clinicaId: german.id, fecha: LUNES, hora: '09:50',
      nombre: 'Colado', telefono: '600002222',
      duracion: 5, minutos: 5, motivoId: 'quiropodia',
    });
    ok(r.body.ok !== true,
      'no se puede reservar las 09:50: las tapa el estudio', JSON.stringify(r.body).slice(0, 100));

    // Y con un motivo inventado, cae a la duracion de la clinica, no a lo que diga el cliente.
    const r2 = await post('/api/reservar-slot', {
      clinicaId: german.id, fecha: LUNES, hora: '10:10',
      nombre: 'Otro', telefono: '600003333', motivoId: 'inventado', duracion: 5,
    });
    ok(r2.body.ok === true, 'un motivo desconocido no impide reservar');
    const f = db.prepare("SELECT duracion FROM reservas WHERE telefono = '600003333'").get();
    ok(f.duracion === 20, 'pero se guarda con la duracion de la clinica, no con los 5 pedidos', String(f.duracion));
  }

  console.log('\n── El catalogo que llega del PC se limpia al entrar ──');
  {
    const r = await fetch(`${BASE}/api/sync-agenda`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': german.apiKey },
      body: JSON.stringify({
        config: {
          duracionSlot: 20, horario: { [diaSemana]: [{ inicio: '09:30', fin: '13:00' }] },
          motivos: [
            { id: 'bueno', nombre: 'Bueno', minutos: 20 },
            { id: 'malo',  nombre: 'Malo',  minutos: 9999 },
            { nombre: '' },
          ],
        },
        citasOcupadas: [{ fecha: LUNES, hora: '09:30', duracion: 40 }],
      }),
    }).then(j);
    ok(r.ok === true, 'el sync se acepta');
    const cfg = JSON.parse(db.prepare('SELECT config FROM agenda_config WHERE clinicaId = ?').get(german.id).config);
    ok(cfg.motivos.length === 1 && cfg.motivos[0].id === 'bueno',
      'y solo se guarda el motivo utilizable', JSON.stringify(cfg.motivos));
  }

  console.log(`\n${fallados === 0 ? `✅ ${pasados} COMPROBACIONES EN VERDE` : `❌ ${fallados} FALLIDAS de ${pasados + fallados}`}\n`);
  try { fs.unlinkSync(TMP); } catch {}
  await new Promise(r => setTimeout(r, 300));
  process.exit(fallados === 0 ? 0 : 1);
})();
