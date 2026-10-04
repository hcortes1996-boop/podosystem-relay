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
