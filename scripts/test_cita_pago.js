/**
 * test_cita_pago.js — La página de citas que sirve el relay, también para las clínicas de pago.
 *
 * 04-10-2026: en vez de subir a mano la página de citas a cada Netlify (o redesplegar con el token,
 * gastando créditos), el Netlify de cada clínica la pide al relay con un `_redirects`
 * (`/cita  <relay>/cita/<id>  200!`). Así un cambio en la plantilla llega a todas al desplegar.
 * Se fija:
 *   · una prueba lleva el cartel «período de prueba» y noindex; una de pago, NO (el fallo del QR
 *     del 20-09 le habría dicho a sus pacientes que la clínica estaba de prueba);
 *   · con `menuWeb` el menú lleva a las páginas de su web y los estilos son los SUYOS (rutas
 *     relativas); sin `menuWeb`, los del relay;
 *   · el panel puede activar `menuWeb` y rellenar teléfono y ciudad.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_citapago_${process.pid}.db`);
const PORT = 3091;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'token-de-prueba-cita-pago';
delete process.env.RESEND_API_KEY;

let ok = 0, fallos = 0;
const prueba = (c, n, x) => { if (c) { ok++; console.log('  ✅ ' + n); } else { fallos++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };

require('../src/index.js');
const BASE = `http://127.0.0.1:${PORT}`;
const pagina = (id) => fetch(`${BASE}/cita/${id}`).then(r => r.text());

(async () => {
  let db = null;
  try {
    await new Promise(r => setTimeout(r, 900));
    console.log('\n🧪 La página de citas del relay, para pruebas y para clínicas de pago\n');
    db = require('better-sqlite3')(TMP);
    db.prepare("INSERT INTO clinicas (id, nombre, apiKey, fuente) VALUES ('PRUEBA1','Clinica Trial','k1','trial'), ('PAGO1','Clinica Pago','k2','manual'), ('WEB1','Clinica Con Web','k3','manual')").run();
    const lic = (id, clinicaId, estado) => db.prepare("INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, clinicaId, estado) VALUES (?,?,'C','c@x.es',?,?)").run(id, 'K-' + id, clinicaId, estado);
    lic('L1', 'PAGO1', 'active'); lic('L2', 'WEB1', 'active');

    const trial = await pagina('PRUEBA1');
    prueba(/período de prueba/.test(trial) && /noindex/.test(trial), 'una prueba lleva el cartel y noindex');

    const pago = await pagina('PAGO1');
    prueba(!/período de prueba/.test(pago) && !/noindex/.test(pago), 'una clínica de PAGO no lleva el cartel ni noindex');
    prueba(/href="\/cita-assets\/css\/styles\.css"/.test(pago), 'sin web propia, los estilos son los del relay');
    prueba(/href="#como-funciona"/.test(pago), 'y el menú de una sola página');

    console.log('\n── Con web propia (menuWeb), activado desde el panel ──');
    const r = await fetch(`${BASE}/admin/api/clinicas/WEB1/datos`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-de-prueba-cita-pago' },
      body: JSON.stringify({ menuWeb: true, telefono: '955000000', ciudad: 'Dos Hermanas' }),
    });
    prueba(r.status === 200, 'el panel activa menuWeb y guarda teléfono y ciudad');
    const web = await pagina('WEB1');
    prueba(/<nav class="nav-menu"[\s\S]*?href="servicios\.html"[\s\S]*?<\/nav>/.test(web), 'el menú lleva a las páginas de SU web');
    prueba(/href="css\/styles\.css"/.test(web) && !/\/cita-assets\//.test(web), 'y los estilos son los suyos (rutas relativas a su dominio)');
    prueba(/955000000/.test(web) && /Dos Hermanas/.test(web) && !/Sin teléfono/.test(web), 'con su teléfono y su ciudad');
    prueba(!/período de prueba/.test(web), 'sin cartel de prueba');

    const r0 = await fetch(`${BASE}/admin/api/clinicas/WEB1/datos`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-de-prueba-cita-pago' },
      body: JSON.stringify({ menuWeb: false }),
    });
    prueba(r0.status === 200 && /\/cita-assets\//.test(await pagina('WEB1')), 'y se puede desactivar (menuWeb: false guarda 0, no null)');

    console.log('\n── Personalizada con los datos de CADA clínica (04-10-2026) ──');
    // Lo que vio Francisco en la de Merino: un horario inventado igual para todas, WhatsApp al fijo…
    db.prepare("INSERT OR REPLACE INTO agenda_config (clinicaId, config) VALUES ('PAGO1', ?)").run(JSON.stringify({ horario: {
      '1': [{ inicio: '09:30', fin: '12:30' }, { inicio: '17:00', fin: '19:15' }], '2': [{ inicio: '09:30', fin: '12:30' }, { inicio: '17:00', fin: '19:15' }],
      '3': [{ inicio: '09:30', fin: '12:30' }, { inicio: '17:00', fin: '19:15' }], '4': [{ inicio: '09:30', fin: '12:30' }, { inicio: '17:00', fin: '19:15' }],
      '5': [{ inicio: '09:30', fin: '12:30' }] } }));
    db.prepare("UPDATE clinicas SET telefono='955111222', ciudad='Dos Hermanas', direccion='Calle Real 1' WHERE id='PAGO1'").run();
    let p = await pagina('PAGO1');
    const texto = p.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    prueba(/Lunes — Jueves 9:30 — 12:30 17:00 — 19:15/.test(texto) && /Viernes 9:30 — 12:30/.test(texto),
      'el horario es el SUYO, el que configura en PodoSystem', (texto.match(/Lunes[^|]{0,80}/) || [''])[0]);
    prueba(/Sábado, Domingo Cerrado/.test(texto) && !/9:00 — 14:00|16:00 — 19:30/.test(texto), 'y no el 9:00—14:00 / 16:00—19:30 que tenían todas');
    prueba(!/wa\.me/.test(p), 'sin móvil para WhatsApp, no hay botones de WhatsApp (antes apuntaban al fijo)');
    prueba(/Calle Real 1, Dos Hermanas/.test(p), 'la dirección es la dirección, no solo la ciudad');
    prueba(new RegExp(`© ${new Date().getFullYear()} `).test(p) && !/© 2025/.test(p), 'el año del pie es el de ahora');
    prueba(!/resultados probados|última generación|Sin lista de espera/.test(p), 'sin afirmaciones de marketing que la clínica no ha escrito');
    prueba(/Cambiar servicio o podólogo/.test(p) && !/Cambiar motivo/.test(p), '«Cambiar servicio», no «motivo»');
    prueba(!/\{\{[A-Z_]+\}\}|<!--\/?WHATSAPP-->/.test(p), 'ningún marcador sin sustituir');

    // La sincronización trae los datos desde PodoSystem, y entonces sí hay WhatsApp
    const key = db.prepare("SELECT apiKey FROM clinicas WHERE id='PAGO1'").get().apiKey;
    const s = await fetch(`${BASE}/api/sync-agenda`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({ config: { duracionSlot: 30, horario: { '1': [{ inicio: '10:00', fin: '14:00' }] } }, citasOcupadas: [],
        datosClinica: { direccion: 'Avda Nueva 7', ciudad: 'Sevilla', telefono: '954000000', whatsapp: '+34 611 22 33 44' } }) });
    p = await pagina('PAGO1');
    prueba(s.status === 200 && /Avda Nueva 7, Sevilla/.test(p) && /954000000/.test(p), 'la sincronización guarda dirección, ciudad y teléfono de PodoSystem');
    prueba((p.match(/wa\.me\/34611223344/g) || []).length === 2, 'y con móvil, los botones de WhatsApp van a ESE móvil');
    // WhatsApp Business con un FIJO: es lo que tiene la clínica de Francisco (04-10-2026)
    db.prepare("UPDATE clinicas SET whatsapp='955 67 66 63' WHERE id='PAGO1'").run();
    prueba((await pagina('PAGO1')).match(/wa\.me\/34955676663/g)?.length === 2, 'un FIJO también vale (WhatsApp Business con el de la consulta)');
    db.prepare("UPDATE clinicas SET whatsapp='123' WHERE id='PAGO1'").run();
    prueba(!/wa\.me/.test(await pagina('PAGO1')), 'y algo que no es un teléfono, no saca botones');
    db.prepare("UPDATE clinicas SET whatsapp='+34 611 22 33 44' WHERE id='PAGO1'").run();
    prueba(/Lunes 10:00 — 14:00/.test(p.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')), 'y el horario nuevo se ve al momento');
    await fetch(`${BASE}/api/sync-agenda`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({ config: { duracionSlot: 30 }, citasOcupadas: [] }) });
    prueba(/Avda Nueva 7/.test(await pagina('PAGO1')), 'un PC antiguo, que no manda los datos, no los borra');

    console.log('\n── La dirección del relay, limpia ──');
    const { relayUrl } = require('../src/lib/relay-url');
    prueba(relayUrl({ RELAY_URL: ' https://relay.ejemplo/ ' }) === 'https://relay.ejemplo',
      'sin el espacio delante que tiene RELAY_URL en Railway (04-10-2026), ni barra al final');
    prueba(relayUrl({}) === 'https://podosystem-relay-production.up.railway.app', 'y sin variable, la de siempre');
    prueba(!/src=" https?:/.test(web), 'en la página no queda ningún enlace con un espacio delante');

    console.log('\n── Una licencia que caduca devuelve el cartel ──');
    db.prepare("UPDATE licencias SET estado = 'expired' WHERE id = 'L1'").run();
    prueba(/período de prueba/.test(await pagina('PAGO1')), 'sin licencia viva, vuelve el cartel');
  } catch (e) {
    fallos++; console.log('💥', e);
  } finally {
    try { db && db.close(); } catch (_) {}
    for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log(`\n${ok} bien, ${fallos} mal\n`);
  await new Promise(r => setTimeout(r, 300));
  process.exit(fallos ? 1 : 0);
})();
