#!/usr/bin/env node
'use strict';
/**
 * Tests de la anulación por el paciente (sub-pieza 8.20) — token, plazo y endpoints
 * públicos, contra el servidor real por HTTP.
 *
 * Lo que hay que defender aquí, por orden de gravedad:
 *   1. Que no se pueda anular la cita de otro. El token es lo único que separa a un
 *      paciente de la agenda entera.
 *   2. Que fuera de plazo NO se anule, pero SÍ quede registrado el intento. Ese
 *      registro es lo que convierte una ausencia silenciosa en un aviso.
 *   3. Que anular NO libere el hueco por su cuenta. La ocupación la reconstruye el
 *      PC; liberarla aquí es lo que provocó las dobles citas de agosto de 2026.
 *
 * Uso:  node scripts/test_anulacion.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_anul_${process.pid}.db`);
const PORT = 3098;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';   // desactiva el límite de peticiones

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

require('../src/index.js');

const CLINICA = 'testAnul01';
const KEY = 'k_anul';
const HORARIO = { '0': [], '6': [],
  '1': [{ inicio: '09:00', fin: '14:00' }], '2': [{ inicio: '09:00', fin: '14:00' }],
  '3': [{ inicio: '09:00', fin: '14:00' }], '4': [{ inicio: '09:00', fin: '14:00' }],
  '5': [{ inicio: '09:00', fin: '14:00' }] };
const CONFIG = { duracionSlot: 30, diasMin: 1, diasMax: 20, horario: HORARIO };

const diaHabil = (desdeDias) => {
  const d = new Date(); d.setDate(d.getDate() + desdeDias);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};
const LEJOS = diaHabil(10);   // dentro de plazo
const api = (ruta, opts = {}) => fetch(`http://127.0.0.1:${PORT}/api${ruta}`, {
  ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const conKey = (ruta, opts = {}) => api(ruta, { ...opts, headers: { 'X-Api-Key': KEY, ...(opts.headers || {}) } });

setTimeout(async () => {
  const db = require('better-sqlite3')(TMP);
  db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa, telefono) VALUES (?,?,?,1,?)')
    .run(CLINICA, 'Clinica Anulacion', KEY, '954000111');

  const sync = (extra = {}) => conKey('/sync-agenda', { method: 'PUT', body: JSON.stringify({
    config: CONFIG, citasOcupadas: [], permitirVacio: true,
    ventana: { desde: new Date().toISOString().slice(0, 10), hasta: diaHabil(20) }, ...extra,
  }) });
  await sync();

  const reservar = async (fecha, hora, nombre = 'Paciente Prueba') => {
    const r = await api('/reservar-slot', { method: 'POST', body: JSON.stringify({
      clinicaId: CLINICA, fecha, hora, duracion: 30, nombre, telefono: '600111222',
    }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const tokenDe = id => db.prepare('SELECT tokenPlano FROM reservas WHERE id = ?').get(id)?.tokenPlano;
  const filaDe  = id => db.prepare('SELECT * FROM reservas WHERE id = ?').get(id);
  const ocupadas = () => db.prepare('SELECT fecha, hora FROM citas_ocupadas WHERE clinicaId = ?')
    .all(CLINICA).map(r => `${r.fecha} ${r.hora}`);

  console.log(`\nfecha dentro de plazo: ${LEJOS}\n`);

  console.log('── El token se emite al reservar ──');
  const r1 = await reservar(LEJOS, '10:00');
  const id1 = r1.body.reservaId;
  ok(!!id1, 'la reserva se crea', JSON.stringify(r1.body).slice(0, 120));
  const tok1 = tokenDe(id1);
  ok(!!tok1 && tok1.length === 32, 'se guarda un token de 32 caracteres', String(tok1));
  ok(!!filaDe(id1).tokenHash, 'y su hash');
  ok(filaDe(id1).tokenHash !== tok1, 'el hash NO es el token en claro');
  ok(tok1 !== id1, 'el token NO es el id de la reserva (que no es secreto)');
  ok(!JSON.stringify(r1.body).includes(tok1), 'el token no se le devuelve al navegador');

  console.log('\n── El paciente abre su enlace ──');
  let r = await api(`/cita/${tok1}`);
  let b = await r.json();
  ok(r.status === 200 && b.ok, 'GET /cita/:token responde', JSON.stringify(b).slice(0, 120));
  ok(b.cita.fecha === LEJOS && b.cita.hora === '10:00', 'con su fecha y hora');
  ok(b.cita.clinica.nombre === 'Clinica Anulacion', 'y el nombre de la clínica');
  ok(b.cita.clinica.telefono === '954000111', 'y su teléfono, para poder llamar');
  ok(b.cita.plazo.permitido === true, 'dentro de plazo, permitido');
  ok(!JSON.stringify(b).includes('600111222'), 'NUNCA devuelve el teléfono del paciente');

  console.log('\n── Lo que NO puede pasar ──');
  r = await api('/cita/token_inventado_de_32_caracteres');
  ok(r.status === 404, 'un token inventado da 404', String(r.status));
  const cuerpoInventado = JSON.stringify(await r.json());
  r = await api('/cita/xx');
  ok(r.status === 404 && JSON.stringify(await r.json()) === cuerpoInventado,
     'un token corto responde EXACTAMENTE igual — no se filtra cuáles existen');
  r = await api(`/cita/${'a'.repeat(32)}/anular`, { method: 'POST', body: '{}' });
  ok(r.status === 404, 'anular con token inventado da 404');

  // Una clínica no puede tocar la reserva de otra ni con su apiKey.
  db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)')
    .run('otraClinica', 'Otra', 'k_otra');
  r = await fetch(`http://127.0.0.1:${PORT}/api/reservas/${id1}/cancelar`,
    { method: 'PUT', headers: { 'X-Api-Key': 'k_otra' } });
  ok(r.status === 404, 'otra clínica con su propia apiKey no puede cancelarla', String(r.status));
  ok(filaDe(id1).estado !== 'cancelada', 'y la reserva sigue intacta');

  console.log('\n── Anular dentro de plazo ──');
  const antes = ocupadas().length;
  r = await api(`/cita/${tok1}/anular`, { method: 'POST', body: JSON.stringify({ motivo: 'Me ha surgido un imprevisto' }) });
  b = await r.json();
  ok(r.status === 200 && b.ok, 'responde ok', JSON.stringify(b).slice(0, 120));
  const f1 = filaDe(id1);
  ok(f1.estado === 'cancelada', 'la reserva queda cancelada', f1.estado);
  ok(f1.canceladaPor === 'paciente', 'y consta que la anuló el paciente', String(f1.canceladaPor));
  ok(f1.motivoCancelacion === 'Me ha surgido un imprevisto', 'con su motivo');
  ok(!!f1.canceladaEn && !!f1.tokenUsadoEn, 'con fecha de anulación y de uso del token');
  ok(ocupadas().length === antes,
     'CRÍTICO: NO se libera el hueco — la ocupación la manda el PC',
     `antes ${antes}, ahora ${ocupadas().length}`);

  console.log('\n── El enlace ya usado ──');
  r = await api(`/cita/${tok1}/anular`, { method: 'POST', body: '{}' });
  b = await r.json();
  ok(r.status === 200 && b.yaEstaba === true,
     'volver a anular no da error: enseña el estado', JSON.stringify(b).slice(0, 100));
  r = await api(`/cita/${tok1}`);
  b = await r.json();
  ok(b.cita.anulada === true, 'y el enlace sigue mostrando que está anulada');

  console.log('\n── Fuera de plazo: NO anula, pero AVISA ──');
  // Una reserva para dentro de 2 h, metida directamente para controlar la hora.
  const en2h = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const { generarToken, hashToken } = require('../src/lib/anulacion');
  const tokCerca = generarToken();
  db.prepare(`INSERT INTO reservas (id, clinicaId, fecha, hora, duracion, nombre, telefono, tokenHash, tokenPlano)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('res_cerca', CLINICA, en2h.toISOString().slice(0, 10),
         `${String(en2h.getHours()).padStart(2, '0')}:${String(en2h.getMinutes()).padStart(2, '0')}`,
         30, 'Paciente Cerca', '600999888', hashToken(tokCerca), tokCerca);

  r = await api(`/cita/${tokCerca}`);
  b = await r.json();
  ok(b.cita.plazo.permitido === false && b.cita.plazo.motivo === 'fuera_plazo',
     'el enlace avisa de que ya no se puede anular', JSON.stringify(b.cita.plazo));

  r = await api(`/cita/${tokCerca}/anular`, { method: 'POST', body: JSON.stringify({ motivo: 'No puedo ir' }) });
  b = await r.json();
  ok(r.status === 409 && b.ok === false, 'anular fuera de plazo se rechaza', String(r.status));
  ok(b.telefonoClinica === '954000111', 'y se le da el teléfono al que llamar');
  const fc = filaDe('res_cerca');
  ok(fc.estado !== 'cancelada', 'la reserva NO se anula');
  ok(!!fc.intentoAnularEn, 'PERO el intento queda registrado — la clínica se entera',
     JSON.stringify({ en: fc.intentoAnularEn, nota: fc.intentoAnularNota }));
  ok(fc.intentoAnularNota === 'No puedo ir', 'con el motivo que llegó a escribir');
  ok(b.avisoRegistrado === true, 'y al paciente se le dice que se ha avisado a la clínica');

  console.log('\n── Una cita ya pasada ──');
  const tokPasada = generarToken();
  db.prepare(`INSERT INTO reservas (id, clinicaId, fecha, hora, duracion, nombre, telefono, tokenHash)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run('res_pasada', CLINICA, '2020-01-15', '10:00', 30, 'Antiguo', '600000000', hashToken(tokPasada));
  r = await api(`/cita/${tokPasada}/anular`, { method: 'POST', body: '{}' });
  b = await r.json();
  ok(r.status === 409 && b.motivo === 'pasada', 'se distingue de "fuera de plazo"', JSON.stringify(b).slice(0, 100));

  console.log('\n── El PC recoge el token y deja de estar en claro ──');
  const r2 = await reservar(LEJOS, '11:00');
  const id2 = r2.body.reservaId;
  const tokViejo = tokenDe(id2);            // el PC lo lee ANTES de sincronizar
  ok(!!tokViejo, 'antes de sincronizar, el token está disponible para el PC');
  ok((await api(`/cita/${tokViejo}`)).status === 200, 'y funciona');
  await conKey(`/reservas/${id2}/sincronizar`, { method: 'PUT' });
  ok(!tokenDe(id2), 'tras sincronizar se borra: en la base solo queda el hash');
  ok((await api(`/cita/${tokViejo}`)).status === 200,
     'el enlace ya enviado SIGUE funcionando — solo desaparece la copia en claro');

  console.log('\n── Regenerar el token ──');
  const hashViejo = filaDe(id2).tokenHash;
  r = await conKey(`/reservas/${id2}/regenerar-token`, { method: 'PUT' });
  b = await r.json();
  ok(r.status === 200 && b.token?.length === 32, 'el PC puede pedir uno nuevo', JSON.stringify(b).slice(0, 80));
  ok(filaDe(id2).tokenHash !== hashViejo, 'el hash cambia');
  ok(b.token !== tokViejo, 'y el token es distinto del anterior');
  // Con el token VIEJO de verdad, no con uno inventado: es lo único que prueba
  // que regenerar invalida el enlace anterior.
  ok((await api(`/cita/${tokViejo}`)).status === 404,
     'el enlace ANTERIOR deja de valer (probado con el token real, no con uno falso)');
  r = await api(`/cita/${b.token}`);
  ok(r.status === 200, 'el nuevo sí funciona');
  r = await fetch(`http://127.0.0.1:${PORT}/api/reservas/${id2}/regenerar-token`, { method: 'PUT' });
  ok(r.status === 401, 'regenerar sin apiKey se rechaza', String(r.status));

  console.log(`\n${pasados} pasados, ${fallados} fallados`);
  try { fs.unlinkSync(TMP); } catch {}
  process.exit(fallados ? 1 : 0);
}, 2500);
