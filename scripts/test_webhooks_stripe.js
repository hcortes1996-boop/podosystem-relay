/**
 * Test sandbox Pieza 8.2 — webhooks-stripe.js
 *
 * Verifica:
 *   - Firma valida -> procesa evento
 *   - Firma invalida -> 400
 *   - Sin signature header -> 400
 *   - 4 handlers (checkout.session.completed, invoice.payment_succeeded,
 *                 customer.subscription.deleted, invoice.payment_failed)
 *   - Idempotencia (mismo event.id solo crea licencia 1 vez)
 *
 * Uso: node scripts/test_webhooks_stripe.js
 * SQLite en memoria + secret mock.
 */
'use strict';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy_secret_for_sandbox';
process.env.STRIPE_SECRET_KEY     = 'sk_test_dummy';
process.env.NETLIFY_TOKEN         = ''; // sin Netlify en sandbox

const express  = require('express');
const Database = require('better-sqlite3');
const Stripe   = require('stripe');

const stripeClient = new Stripe('sk_test_dummy', { apiVersion: '2024-12-18.acacia' });

// Mock del stripeClient del modulo: conserva webhooks.constructEvent real
// (verificacion de firma) y sustituye subscriptions.retrieve por un stub.
let mockSubStatus = 'active';
const mockStripe = {
  webhooks: stripeClient.webhooks,
  subscriptions: { retrieve: async (id) => ({ id, status: mockSubStatus }) },
};

// ── Setup BD en memoria ────────────────────────────────────────────────────────
function setupDB() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE clinicas (
      id TEXT PRIMARY KEY,
      nombre TEXT,
      apiKey TEXT UNIQUE,
      webUrl TEXT,
      netlifyId TEXT,
      activa INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE licencias (
      id               TEXT PRIMARY KEY,
      licenseKey       TEXT UNIQUE NOT NULL,
      clienteNombre    TEXT NOT NULL,
      clienteEmail     TEXT NOT NULL,
      clinicaId        TEXT,
      hardwareId       TEXT,
      estado           TEXT NOT NULL DEFAULT 'trial',
      fuente           TEXT NOT NULL DEFAULT 'manual',
      suscripcionId    TEXT,
      notas            TEXT,
      plan             TEXT NOT NULL DEFAULT 'clinica',
      ultimaValidacion TEXT,
      createdAt        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE webhooks_stripe_log (
      eventId     TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      processedAt TEXT NOT NULL,
      payload     TEXT
    );
  `);
  return db;
}

// ── Setup app Express ──────────────────────────────────────────────────────────
function setupApp(db) {
  const app = express();
  app.use('/api/webhooks', express.raw({ type: 'application/json' }));
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use('/api/webhooks', require('../src/routes/webhooks-stripe'));
  return app;
}

// ── Firma Stripe valida (helper oficial) ──────────────────────────────────────
function signEvent(eventObj, secret = process.env.STRIPE_WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify(eventObj);
  return {
    payload,
    signature: stripeClient.webhooks.generateTestHeaderString({ payload, secret, timestamp: ts }),
  };
}

// ── Helpers fake event ────────────────────────────────────────────────────────
function makeCheckoutEvent(eventId, sessionId, sub, email, plan = 'clinica') {
  return {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        customer: 'cus_test_' + sessionId.slice(-6),
        subscription: sub,
        customer_details: { email, name: 'Test User' },
        metadata: { plan, numeroColegiado: '838123456' },
      }
    }
  };
}
function makeInvoiceEvent(eventId, type, sub, email) {
  return {
    id: eventId,
    object: 'event',
    type,
    data: { object: { id: 'in_' + eventId.slice(-6), object: 'invoice', subscription: sub, customer_email: email } }
  };
}
function makeSubDeletedEvent(eventId, sub) {
  return {
    id: eventId,
    object: 'event',
    type: 'customer.subscription.deleted',
    data: { object: { id: sub, object: 'subscription' } }
  };
}

// ── Request helper ────────────────────────────────────────────────────────────
async function call(server, eventObj, opts = {}) {
  const port = server.address().port;
  const { payload, signature } = signEvent(eventObj, opts.secret);
  const headers = { 'Content-Type': 'application/json' };
  if (opts.skipSignature !== true) headers['Stripe-Signature'] = opts.badSignature || signature;
  const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/stripe`, {
    method: 'POST', headers, body: payload,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

const results = [];
function check(name, cond, info) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
}

(async () => {
  const db = setupDB();
  const app = setupApp(db);
  require('../src/routes/webhooks-stripe')._setStripeClient(mockStripe);
  // Mock del envio de email: registra las llamadas (el handler hace require a call-time).
  const emailMod = require('../src/email');
  const mailCalls = [];
  emailMod.sendMail = async (args) => { mailCalls.push(args); };
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));

  try {
    // T1 — checkout.session.completed crea licencia + clinica
    {
      const r = await call(server, makeCheckoutEvent('evt_001', 'cs_001', 'sub_001', 'cliente1@test.es', 'red'));
      check('T1 status 200', r.status === 200, `got ${r.status}`);
      check('T1 event echo', r.json?.event === 'checkout.session.completed');
      const lic = db.prepare("SELECT * FROM licencias WHERE clienteEmail = 'cliente1@test.es'").get();
      check('T1 licencia creada', !!lic);
      check('T1 plan=red', lic?.plan === 'red', `got ${lic?.plan}`);
      check('T1 estado=active', lic?.estado === 'active');
      check('T1 fuente=stripe', lic?.fuente === 'stripe');
      check('T1 suscripcionId=sub_001', lic?.suscripcionId === 'sub_001');
      check('T1 colegiado en notas', lic?.notas?.includes('838123456'));
      const clinica = db.prepare('SELECT * FROM clinicas WHERE id = ?').get(lic?.clinicaId);
      check('T1 clinica creada con apiKey', !!clinica && !!clinica.apiKey);
      const log = db.prepare("SELECT * FROM webhooks_stripe_log WHERE eventId = 'evt_001'").get();
      check('T1 webhook log registrado', !!log && log.type === 'checkout.session.completed');
    }

    // T2 — invoice.payment_succeeded renueva ultimaValidacion
    {
      const r = await call(server, makeInvoiceEvent('evt_002', 'invoice.payment_succeeded', 'sub_001', 'cliente1@test.es'));
      check('T2 status 200', r.status === 200);
      const lic = db.prepare("SELECT * FROM licencias WHERE suscripcionId = 'sub_001'").get();
      check('T2 ultimaValidacion actualizada', !!lic?.ultimaValidacion);
      check('T2 estado sigue active', lic?.estado === 'active');
    }

    // T3 — customer.subscription.deleted marca expired
    {
      const r = await call(server, makeSubDeletedEvent('evt_003', 'sub_001'));
      check('T3 status 200', r.status === 200);
      const lic = db.prepare("SELECT * FROM licencias WHERE suscripcionId = 'sub_001'").get();
      check('T3 estado=expired', lic?.estado === 'expired', `got ${lic?.estado}`);
    }

    // T4 — invoice.payment_failed con sub CANCELED marca expired
    {
      // crear licencia previa
      await call(server, makeCheckoutEvent('evt_004a', 'cs_004', 'sub_004', 'cliente4@test.es', 'basico'));
      mockSubStatus = 'canceled';   // Stripe confirma sub cancelada -> SI expira
      const r = await call(server, makeInvoiceEvent('evt_004b', 'invoice.payment_failed', 'sub_004', 'cliente4@test.es'));
      check('T4 status 200', r.status === 200);
      const lic = db.prepare("SELECT * FROM licencias WHERE suscripcionId = 'sub_004'").get();
      check('T4 estado=expired (sub canceled)', lic?.estado === 'expired', `got ${lic?.estado}`);
    }

    // T5 — Firma invalida -> 400
    {
      const r = await call(server, makeCheckoutEvent('evt_005', 'cs_005', 'sub_005', 'cliente5@test.es'),
        { badSignature: 't=1234567890,v1=fakesignature_invalid' });
      check('T5 status 400 firma invalida', r.status === 400, `got ${r.status}`);
      const lic = db.prepare("SELECT * FROM licencias WHERE clienteEmail = 'cliente5@test.es'").get();
      check('T5 NO crea licencia con firma mala', !lic);
    }

    // T6 — Sin Stripe-Signature header -> 400
    {
      const r = await call(server, makeCheckoutEvent('evt_006', 'cs_006', 'sub_006', 'cliente6@test.es'),
        { skipSignature: true });
      check('T6 status 400 sin signature', r.status === 400);
      check('T6 mensaje "Missing stripe-signature"',
        r.json?.error?.includes('Missing stripe-signature'),
        `got ${JSON.stringify(r.json)}`);
    }

    // T7 — Idempotencia: mismo event.id procesado 2 veces
    {
      const ev = makeCheckoutEvent('evt_007', 'cs_007', 'sub_007', 'cliente7@test.es', 'clinica');
      await call(server, ev);  // primera vez
      const countBefore = db.prepare("SELECT COUNT(*) AS n FROM licencias WHERE clienteEmail = 'cliente7@test.es'").get().n;
      const r = await call(server, ev);  // segunda vez (mismo event.id)
      check('T7 status 200 idempotent', r.status === 200);
      check('T7 idempotent flag true', r.json?.idempotent === true);
      const countAfter = db.prepare("SELECT COUNT(*) AS n FROM licencias WHERE clienteEmail = 'cliente7@test.es'").get().n;
      check('T7 licencia NO duplicada', countBefore === 1 && countAfter === 1, `before=${countBefore} after=${countAfter}`);
    }

    // T8 — Plan invalido en metadata fallback 'clinica'
    {
      const ev = makeCheckoutEvent('evt_008', 'cs_008', 'sub_008', 'cliente8@test.es', 'enterprise_pro_xxx');
      await call(server, ev);
      const lic = db.prepare("SELECT * FROM licencias WHERE clienteEmail = 'cliente8@test.es'").get();
      check('T8 plan invalido cae a clinica', lic?.plan === 'clinica', `got ${lic?.plan}`);
    }

    // T9 — Sin email en customer_details -> rechazo silencioso (200 pero NO crea)
    {
      const ev = makeCheckoutEvent('evt_009', 'cs_009', 'sub_009', '', 'clinica');
      const r = await call(server, ev);
      check('T9 status 200 (no fatal)', r.status === 200);
      const lic = db.prepare("SELECT * FROM licencias WHERE suscripcionId = 'sub_009'").get();
      check('T9 NO crea licencia sin email', !lic);
    }

    // T10 — REGRESION del incidente: payment_failed con sub ACTIVE NO expira
    {
      await call(server, makeCheckoutEvent('evt_010a', 'cs_010', 'sub_010', 'cliente10@test.es', 'basico'));
      mockSubStatus = 'active';   // Stripe dice que la sub sigue activa (stale/SCA/transitorio)
      const r = await call(server, makeInvoiceEvent('evt_010b', 'invoice.payment_failed', 'sub_010', 'cliente10@test.es'));
      check('T10 status 200', r.status === 200);
      const lic = db.prepare("SELECT * FROM licencias WHERE suscripcionId = 'sub_010'").get();
      check('T10 sigue active (sub no cancelada)', lic?.estado === 'active', `got ${lic?.estado}`);
    }

    // T11 — B2: invoice con sub en parent.subscription_details (API dahlia)
    {
      await call(server, makeCheckoutEvent('evt_011a', 'cs_011', 'sub_011', 'cliente11@test.es', 'basico'));
      const ev = {
        id: 'evt_011b', object: 'event', type: 'invoice.payment_succeeded',
        data: { object: { id: 'in_011', object: 'invoice',
          parent: { subscription_details: { subscription: 'sub_011' } },
          customer_email: 'cliente11@test.es' } }
      };
      const r = await call(server, ev);
      check('T11 status 200', r.status === 200);
      const lic = db.prepare("SELECT * FROM licencias WHERE suscripcionId = 'sub_011'").get();
      check('T11 sub id leido de parent.subscription_details', !!lic?.ultimaValidacion, `got ${lic?.ultimaValidacion}`);
    }

    // T12 — email de bienvenida enviado con datos correctos (Pieza 8.6)
    {
      mailCalls.length = 0;
      await call(server, makeCheckoutEvent('evt_012', 'cs_012', 'sub_012', 'cliente12@test.es', 'basico'));
      const mail = mailCalls.find(m => m.to === 'cliente12@test.es');
      check('T12 sendMail llamado 1 vez', mailCalls.length === 1, `got ${mailCalls.length}`);
      check('T12 to correcto', mail?.to === 'cliente12@test.es');
      check('T12 subject correcto', mail?.subject === 'Bienvenido a PodoSystem — Tu clave de licencia', `got ${mail?.subject}`);
      const lic = db.prepare("SELECT * FROM licencias WHERE suscripcionId = 'sub_012'").get();
      check('T12 html contiene la licenseKey', !!lic && mail?.html?.includes(lic.licenseKey));
      check('T12 html menciona el plan (Básico)', mail?.html?.includes('Básico'));
    }

    // T13 — la licencia se crea aunque el email falle (no rollback, no throw)
    {
      emailMod.sendMail = async () => { throw new Error('SMTP down simulado'); };
      const r = await call(server, makeCheckoutEvent('evt_013', 'cs_013', 'sub_013', 'cliente13@test.es', 'clinica'));
      check('T13 status 200 pese a email fallido', r.status === 200, `got ${r.status}`);
      const lic = db.prepare("SELECT * FROM licencias WHERE suscripcionId = 'sub_013'").get();
      check('T13 licencia creada aunque email falle', !!lic, `lic=${!!lic}`);
      emailMod.sendMail = async (args) => { mailCalls.push(args); }; // restaurar mock
    }

  } finally {
    // NOTA: no llamamos server.close() ni db.close() — libuv Windows lanza
    // assertion en cleanup. process.exit es suficiente.
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n=== ${passed} PASS / ${failed} FAIL / ${results.length} total ===`);
  // Respiro antes de salir: sin el, process.exit() pillaba a las conexiones de fetch a
  // medio cerrar y libuv abortaba en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file srcwinasync.c
  // El proceso salia con 127 DESPUES de pasar todas las comprobaciones: un test en verde
  // que quien lo lanza ve en rojo. (Detectado el 27-08-2026.)
  setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
