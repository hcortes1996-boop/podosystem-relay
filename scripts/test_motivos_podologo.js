/**
 * test_motivos_podologo.js — cada podologo ofrece lo suyo.
 *
 * ── El caso ──────────────────────────────────────────────────────────────────
 *
 *   German  hace quiropodia (20) y biomecanica (40)
 *   Ana     hace quiropodia (20) y NO hace biomecanica
 *
 * Lo que tiene que pasar:
 *
 *   · El paciente ve LOS DOS servicios: la biomecanica la ofrece la clinica, aunque solo la
 *     haga uno. Quien puede atenderle se decide despues.
 *   · Al elegir biomecanica, los huecos son SOLO los de German.
 *   · Y la web sabe que solo puede atenderle uno, para saltarse el paso de «con quien» y
 *     enseñar su nombre.
 *   · Al reservar con German, se bloquea SU hueco — no el de Ana, que no hace ese servicio.
 *
 * ── Por que esto es delicado ─────────────────────────────────────────────────
 *
 * «Libre» ya dependia del servicio; ahora depende tambien del profesional. Es la aritmetica
 * que produjo 5 dobles citas reales en agosto de 2026, con una dimension mas. Por eso se
 * ejercita con dos catalogos distintos y duraciones distintas el mismo dia.
 *
 * Uso:  node scripts/test_motivos_podologo.js
 */
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TMP  = path.join(os.tmpdir(), `relay_motpod_${process.pid}.db`);
const PORT = 3096;
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

const get  = (r) => fetch(BASE + r).then(x => x.json());
const post = (r, b) => fetch(BASE + r, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));

const horas  = (d) => (d.slots || []).map(s => s.hora);
const libres = (d) => (d.slots || []).filter(s => s.libre).map(s => s.hora);

(async () => {
  await new Promise(r => setTimeout(r, 500));

  const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  const LUNES = d.toISOString().slice(0, 10);
  const dow = String(new Date(LUNES + 'T12:00:00Z').getUTCDay());

  const { genId, genApiKey } = require('../src/db');
  const cid = genId(10);
  db.prepare('INSERT INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)').run(cid, 'Dos podologos', genApiKey());
  db.prepare('INSERT INTO agenda_config (clinicaId, config) VALUES (?,?)').run(cid, JSON.stringify({
    duracionSlot: 20, diasMin: 0, diasMax: 30,
    horario: { [dow]: [{ inicio: '09:00', fin: '13:00' }] },
    motivos: [
      { id: 'quiropodia',  nombre: 'Quiropodia',  minutos: 20, activo: true },
      { id: 'biomecanica', nombre: 'Biomecánica', minutos: 40, activo: true },
    ],
  }));

  const insPod = db.prepare(`INSERT INTO podologos_publicos
    (clinicaId, id, nombre, motivosPublicos, visibleEnWeb, activo) VALUES (?,?,?,?,1,1)`);
  // German hereda el catalogo de la clinica: hace las dos cosas.
  insPod.run(cid, 'german', 'Germán', null);
  // Ana tiene el suyo: solo quiropodia.
  insPod.run(cid, 'ana', 'Ana', JSON.stringify([
    { id: 'quiropodia', nombre: 'Quiropodia', minutos: 20, activo: true },
  ]));

  console.log('\n🧪 Motivos por podólogo\n');

  console.log('── El paciente ve TODOS los servicios de la clinica ──');
  {
    const r = await get(`/api/semana/${cid}?desde=${LUNES}`);
    const ids = (r.motivos || []).map(m => m.id).sort();
    ok(ids.join(',') === 'biomecanica,quiropodia',
      'la biomecánica sale aunque solo la haga uno', ids.join(','));
    ok(r.podologosQuePueden === null,
      'sin motivo elegido no se filtra a nadie todavía', JSON.stringify(r.podologosQuePueden));
  }

  console.log('\n── Al elegir el servicio, se sabe QUIEN puede atenderle ──');
  {
    const q = await get(`/api/semana/${cid}?desde=${LUNES}&motivo=quiropodia`);
    const b = await get(`/api/semana/${cid}?desde=${LUNES}&motivo=biomecanica`);
    ok((q.podologosQuePueden || []).sort().join(',') === 'ana,german',
      'la quiropodia la hacen los dos', JSON.stringify(q.podologosQuePueden));
    ok((b.podologosQuePueden || []).join(',') === 'german',
      'la biomecánica solo Germán — la web se salta el paso y enseña su nombre',
      JSON.stringify(b.podologosQuePueden));
  }

  console.log('\n── Y los huecos son los de quien puede atender ──');
  {
    // Se ocupa a German toda la mañana. La quiropodia sigue disponible (queda Ana);
    // la biomecanica NO, porque el unico que la hace esta lleno.
    const ins = db.prepare('INSERT INTO citas_podologo (clinicaId, fecha, hora, duracion, podologoId) VALUES (?,?,?,?,?)');
    for (const h of ['09:00','09:20','09:40','10:00','10:20','10:40','11:00','11:20','11:40','12:00','12:20','12:40'])
      ins.run(cid, LUNES, h, 20, 'german');

    const q = await get(`/api/semana/${cid}?desde=${LUNES}&motivo=quiropodia`);
    const b = await get(`/api/semana/${cid}?desde=${LUNES}&motivo=biomecanica`);
    const dq = q.dias.find(x => x.fecha === LUNES);
    const db_ = b.dias.find(x => x.fecha === LUNES);
    ok(libres(dq).length > 0, 'con Germán lleno, la quiropodia sigue teniendo huecos: los de Ana',
      String(libres(dq).length));
    ok(libres(db_).length === 0,
      'pero la biomecánica NO: el único que la hace está lleno, y Ana no la ofrece',
      libres(db_).join(' '));
  }

  console.log('\n── Cada uno con SU duracion ──');
  {
    // A German se le da una biomecanica mas larga que la de la clinica.
    db.prepare('UPDATE podologos_publicos SET motivosPublicos = ? WHERE clinicaId = ? AND id = ?')
      .run(JSON.stringify([
        { id: 'quiropodia',  nombre: 'Quiropodia',  minutos: 20, activo: true },
        { id: 'biomecanica', nombre: 'Biomecánica', minutos: 60, activo: true },
      ]), cid, 'german');
    db.prepare('DELETE FROM citas_podologo WHERE clinicaId = ?').run(cid);

    const r = await get(`/api/semana/${cid}/german?desde=${LUNES}&motivo=biomecanica`);
    const dia = r.dias.find(x => x.fecha === LUNES);
    // 09:00–13:00 con paso 20 y citas de 60: caben hasta las 12:00.
    ok(horas(dia).slice(-1)[0] === '12:00',
      'la biomecánica de 60 de Germán se oferta hasta las 12:00, no hasta las 12:40',
      horas(dia).slice(-1)[0]);
  }

  console.log('\n── La reserva bloquea al que la atiende, no a los dos ──');
  {
    const r = await post('/api/reservar-slot', {
      clinicaId: cid, fecha: LUNES, hora: '09:00',
      nombre: 'Paciente', telefono: '600001111',
      motivoId: 'biomecanica', podologoId: 'german',
    });
    ok(r.body.ok === true, 'se reserva con Germán', JSON.stringify(r.body).slice(0, 90));

    const fila = db.prepare('SELECT duracion, motivo FROM reservas WHERE clinicaId = ?').get(cid);
    ok(fila.duracion === 60, 'con LOS 60 de Germán, no con los 40 de la clínica', String(fila.duracion));

    const bloq = db.prepare('SELECT podologoId, duracion FROM citas_podologo WHERE clinicaId = ? AND hora = ?')
      .all(cid, '09:00');
    ok(bloq.length === 1 && bloq[0].podologoId === 'german',
      'se bloquea SOLO a Germán', JSON.stringify(bloq));
    const agregada = db.prepare('SELECT COUNT(*) c FROM citas_ocupadas WHERE clinicaId = ?').get(cid).c;
    ok(agregada === 0, 'y NO se bloquea a toda la clínica, que dejaría a Ana sin ese hueco',
      String(agregada));

    const q = await get(`/api/semana/${cid}?desde=${LUNES}&motivo=quiropodia`);
    ok(libres(q.dias.find(x => x.fecha === LUNES)).includes('09:00'),
      'Ana sigue libre a las 09:00 para una quiropodia');
  }

  console.log('\n── Quien no personaliza, hereda ──');
  {
    db.prepare('UPDATE podologos_publicos SET motivosPublicos = NULL WHERE clinicaId = ?').run(cid);
    const b = await get(`/api/semana/${cid}?desde=${LUNES}&motivo=biomecanica`);
    ok((b.podologosQuePueden || []).sort().join(',') === 'ana,german',
      'con los dos heredando, los dos ofrecen todo — comportamiento de siempre',
      JSON.stringify(b.podologosQuePueden));
  }

  console.log('\n── El catalogo de cada uno llega por el sync, y se limpia ──');
  {
    const apiKey = db.prepare('SELECT apiKey FROM clinicas WHERE id = ?').get(cid).apiKey;
    await fetch(`${BASE}/api/sync-agenda`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({
        config: { duracionSlot: 20, horario: { [dow]: [{ inicio: '09:00', fin: '13:00' }] } },
        citasOcupadas: [{ fecha: LUNES, hora: '09:00', duracion: 20 }],
        podologos: [
          { id: 'german', nombre: 'Germán' },
          { id: 'ana', nombre: 'Ana', motivosPublicos: [
            { id: 'quiropodia', nombre: 'Quiropodia', minutos: 20 },
            { nombre: '' },                                   // se descarta
            { id: 'malo', nombre: 'Malo', minutos: 9999 },    // se descarta
          ] },
        ],
      }),
    });
    const g = db.prepare('SELECT motivosPublicos FROM podologos_publicos WHERE clinicaId = ? AND id = ?').get(cid, 'german');
    const a = db.prepare('SELECT motivosPublicos FROM podologos_publicos WHERE clinicaId = ? AND id = ?').get(cid, 'ana');
    ok(g.motivosPublicos === null, 'el que no manda nada, hereda');
    ok(a.motivosPublicos && JSON.parse(a.motivosPublicos).length === 1,
      'y del que manda basura solo se guarda lo utilizable', a.motivosPublicos);
  }

  console.log(`\n${fallados === 0 ? `✅ ${pasados} COMPROBACIONES EN VERDE` : `❌ ${fallados} FALLIDAS de ${pasados + fallados}`}\n`);
  try { fs.unlinkSync(TMP); } catch {}
  await new Promise(r => setTimeout(r, 300));
  process.exit(fallados === 0 ? 0 : 1);
})();
