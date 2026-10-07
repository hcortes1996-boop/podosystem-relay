#!/usr/bin/env node
'use strict';
/**
 * test_legal.js — Las condiciones se aceptan ANTES de pagar o descargar, y queda constancia.
 *
 * 07-10-2026 (LCGC + LSSI). Se fija aquí:
 *   · la web puede pedir qué documentos hay que aceptar, con su versión y su huella;
 *   · el servidor rechaza el pago y la descarga sin aceptar, o con una versión vieja;
 *   · cada aceptación guarda correo, fecha, IP, navegador, versiones y huellas;
 *   · tras el pago se enlaza con la licencia, y el correo confirma qué se aceptó con su PDF.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_legal_${process.pid}.db`);
const PORT = 3103;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_falsa';
process.env.STRIPE_PRICE_CLINICA = 'price_falso';

let ok = 0, fallos = 0;
const prueba = (c, n, x) => { if (c) { ok++; console.log('  ✅ ' + n); } else { fallos++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };

require('../src/index.js');
const legal = require('../src/lib/legal');
const BASE = `http://127.0.0.1:${PORT}`;
const post = (ruta, body) => fetch(BASE + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'prueba/1.0' },
  body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const todas = para => legal.vigentes(para).map(d => ({ id: d.id, version: d.version }));

setTimeout(async () => {
  const db = require('better-sqlite3')(TMP);
  try {
    console.log('\n🧪 Las condiciones, antes de pagar o descargar\n');

    console.log('── Qué hay que aceptar ──');
    const v = await fetch(BASE + '/api/legal/vigentes?para=compra').then(r => r.json());
    prueba(v.ok && v.documentos.length >= 2, 'la web puede pedir los documentos vigentes');
    prueba(v.documentos.every(d => d.version && /^[0-9a-f]{64}$/.test(d.sha256) && /^https:\/\/podosystem\.es\/legal\/.+\.pdf$/.test(d.pdf)),
      'cada uno con su versión, su huella SHA-256 y su copia fija en PDF');
    prueba(v.documentos.some(d => d.id === 'condiciones' && d.accion === 'acepto') &&
           v.documentos.some(d => d.id === 'privacidad' && d.accion === 'leido'),
      'las condiciones se ACEPTAN; la privacidad se declara LEÍDA');

    console.log('\n── El pago ──');
    const comun = { plan: 'clinica', email: 'cliente@ejemplo.test',
      successUrl: 'https://podosystem.es/success?session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://podosystem.es/#precios' };
    let r = await post('/api/checkout/create-session', comun);
    prueba(r.status === 400 && r.body.legal, 'sin aceptar nada, no hay pago', JSON.stringify(r.body));
    r = await post('/api/checkout/create-session', { ...comun, aceptaciones: todas('compra').slice(0, 1) });
    prueba(r.status === 400 && /Falta aceptar/.test(r.body.error), 'aceptando solo una parte, tampoco', r.body.error);
    r = await post('/api/checkout/create-session', { ...comun,
      aceptaciones: todas('compra').map(a => a.id === 'condiciones' ? { ...a, version: '2020-01-01' } : a) });
    prueba(r.status === 400 && /han cambiado/.test(r.body.error), 'con una versión vieja, pide recargar', r.body.error);

    console.log('\n── La prueba gratuita ──');
    const trial = { nombre: 'Ana', email: 'ana@ejemplo.test', telefono: '600123456', aceptaPrivacidad: true };
    r = await post('/api/trial/registrar', trial);
    prueba(r.status === 400 && r.body.legal, 'sin aceptar las condiciones, no hay descarga', JSON.stringify(r.body));

    console.log('\n── El registro ──');
    const val = legal.validar('compra', todas('compra'));
    prueba(val.ok && val.documentos.every(d => d.sha256), 'aceptándolo todo, se valida y lleva las huellas');
    const reqFalsa = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'Navegador/1' }, ip: '10.0.0.1' };
    const id = legal.registrar(db, { para: 'compra', email: 'Cliente@Ejemplo.test', req: reqFalsa,
      documentos: val.documentos, stripeSessionId: 'cs_test_123' });
    const fila = db.prepare('SELECT * FROM aceptaciones_legales WHERE id = ?').get(id);
    prueba(fila && fila.email === 'cliente@ejemplo.test' && fila.ip === '203.0.113.7' && fila.userAgent === 'Navegador/1' &&
           /^\d{4}-\d{2}-\d{2}T/.test(fila.fecha), 'guarda correo, IP real (no la del proxy), navegador y fecha');
    prueba(JSON.parse(fila.documentos).length === val.documentos.length, 'y qué versión de cada documento, con su huella');
    prueba(JSON.parse(fila.documentos).some(d => d.id === 'condiciones' && /actividad empresarial o profesional/.test(d.casilla)),
      'y el texto exacto de cada casilla, con la declaración de contratar como profesional');

    console.log('\n── Tras el pago ──');
    prueba(legal.enlazarLicencia(db, { stripeSessionId: 'cs_test_123', licenciaId: 'LIC1', email: 'cliente@ejemplo.test' }),
      'se enlaza con la licencia por la sesión de Stripe');
    prueba(db.prepare('SELECT licenciaId FROM aceptaciones_legales WHERE id = ?').get(id).licenciaId === 'LIC1', 'y queda apuntada');
    const html = legal.htmlConfirmacion(legal.documentosDe(db, { stripeSessionId: 'cs_test_123' }));
    prueba(/Confirmación de la contratación/.test(html) && /descargar PDF/.test(html) && /podosystem\.es\/legal\//.test(html),
      'el correo confirma la contratación con el PDF de cada documento');
    const { buildEmailLicencia } = require('../src/routes/webhooks-stripe');
    prueba(buildEmailLicencia({ nombre: 'X', plan: 'clinica', licenseKey: 'K', confirmacion: html }).includes('Confirmación de la contratación'),
      'y va dentro del correo de la licencia');

    const adj = legal.adjuntosDe(legal.documentosDe(db, { stripeSessionId: 'cs_test_123' }));
    prueba(adj.length === 2 && adj.every(a => /\.pdf$/.test(a.filename) && /^https:\/\/podosystem\.es\/legal\//.test(a.path)),
      'y adjunta en PDF la copia de las versiones que aceptó');
    prueba(/copia de las condiciones vigentes en el momento de la contratación/.test(html), 'diciéndolo así en el correo');

    console.log('\n── El código de la ruta ──');
    const ck = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'checkout.js'), 'utf8');
    prueba(ck.indexOf("legal.validar('compra'") < ck.indexOf('stripeClient.checkout.sessions.create'),
      'el pago comprueba las condiciones ANTES de crear la sesión de Stripe');
    const wh = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhooks-stripe.js'), 'utf8');
    prueba(/legal\.enlazarLicencia\(db, \{ stripeSessionId: session\.id/.test(wh), 'el webhook enlaza la aceptación con la licencia');
    prueba(/attachments: legal\.adjuntosDe\(docsAceptados\)/.test(wh), 'y el correo de la licencia lleva los PDF adjuntos');
    prueba(/attachments \}/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'email.js'), 'utf8')), 'el envío de correo pasa los adjuntos a Resend');

    console.log('\n── El JSON de versiones ──');
    const J = require('../src/legal-vigentes.json');
    prueba(J.documentos.every(d => d.id && d.titulo && d.version && ['acepto', 'leido'].includes(d.accion) && Array.isArray(d.para)),
      'cada documento tiene id, título, versión, acción y para qué se pide');
  } catch (e) {
    fallos++; console.error('💥', e);
  }
  console.log(`\n${ok} pasados, ${fallos} fallados`);
  try { db.close(); fs.unlinkSync(TMP); } catch {}
  setTimeout(() => process.exit(fallos ? 1 : 0), 300);
}, 2500);
