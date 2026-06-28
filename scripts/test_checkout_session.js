/**
 * Test sandbox Pieza 8.3 — POST /api/checkout/create-session
 *
 * Verifica:
 *   T1  Plan valido + sin colegiado -> 200 con url
 *   T2  Plan valido + colegiado valido -> 200 + discounts en sessionParams
 *   T3  Colegiado mal formato (5 digitos) -> 400
 *   T4  Plan invalido -> 400
 *   T5  successUrl dominio NO whitelist -> 400
 *   T6  successUrl sin {CHECKOUT_SESSION_ID} -> 400
 *   T7  Email mal formato -> 400
 *   T8  Sin STRIPE_SECRET_KEY -> 503
 *   T9  Sin STRIPE_PRICE_RED -> 503 al pedir plan=red
 *   T10 Stripe API rechaza -> 502
 *   T11 metadata incluye plan + numeroColegiado correctamente
 *   T12 email pre-rellenado pasa customer_email
 *   T13 sin email NO pasa customer_email
 *   T14 rateLimit middleware aplicado al endpoint (source check)
 *
 * Uso: node scripts/test_checkout_session.js
 * Mock de Stripe SDK + bypass rateLimit (excepto verificacion source).
 */
'use strict';

process.env.STRIPE_SECRET_KEY      = 'sk_test_dummy';
process.env.STRIPE_PRICE_BASICO    = 'price_test_basico';
process.env.STRIPE_PRICE_CLINICA   = 'price_test_clinica';
process.env.STRIPE_PRICE_RED       = 'price_test_red';
process.env.STRIPE_COUPON_ANDALUCIA = 'ANDALUCIA20';

// ── Mock 'stripe' module + bypass rateLimit ANTES de require checkout.js ─────
const Module = require('module');
const originalLoad = Module._load;

let lastCreateParams = null;
let nextStripeError  = null;
const fakeCreate = async (params) => {
  lastCreateParams = params;
  if (nextStripeError) {
    const e = nextStripeError;
    nextStripeError = null;
    throw e;
  }
  return { id: 'cs_test_xxx', url: 'https://checkout.stripe.com/c/pay/cs_test_xxx' };
};

Module._load = function(request, parent) {
  if (request === 'stripe') {
    return function FakeStripe() {
      return { checkout: { sessions: { create: fakeCreate } } };
    };
  }
  if (request === '../middleware/rateLimit') {
    return (_req, _res, next) => next(); // bypass — testeado por separado en T14
  }
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());
app.use('/api/checkout', require('../src/routes/checkout'));
const server = app.listen(0);

// ── Helpers ───────────────────────────────────────────────────────────────────
async function call(body) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/checkout/create-session`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

const validBody = (overrides = {}) => ({
  plan: 'clinica',
  successUrl: 'https://podosystem.es/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl:  'https://podosystem.es/#precios',
  ...overrides,
});

const results = [];
function check(name, cond, info) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
}

(async () => {
  await new Promise(r => server.on('listening', r));

  // T1 — Plan valido + sin colegiado -> 200 con url
  {
    lastCreateParams = null;
    const r = await call(validBody({ plan: 'basico' }));
    check('T1 status 200', r.status === 200, `got ${r.status} body=${r.text.slice(0,120)}`);
    check('T1 url presente', r.json?.url?.startsWith('https://checkout.stripe.com/'));
    check('T1 sessionId presente', r.json?.sessionId === 'cs_test_xxx');
    check('T1 mode subscription', lastCreateParams?.mode === 'subscription');
    check('T1 line_items[0].price = price_test_basico', lastCreateParams?.line_items?.[0]?.price === 'price_test_basico');
    check('T1 metadata.plan=basico', lastCreateParams?.metadata?.plan === 'basico');
    check('T1 metadata.numeroColegiado vacio', lastCreateParams?.metadata?.numeroColegiado === '');
    check('T1 NO discounts (sin colegiado)', !lastCreateParams?.discounts);
    check('T1 locale=es', lastCreateParams?.locale === 'es');
    check('T1 payment_method_types=[card]', JSON.stringify(lastCreateParams?.payment_method_types) === '["card"]');
  }

  // T2 — Plan valido + colegiado valido -> 200 + discounts cupon
  {
    lastCreateParams = null;
    const r = await call(validBody({ plan: 'clinica', numeroColegiado: '838123456' }));
    check('T2 status 200', r.status === 200, `got ${r.status}`);
    check('T2 discounts incluye cupon ANDALUCIA20',
      JSON.stringify(lastCreateParams?.discounts) === '[{"coupon":"ANDALUCIA20"}]',
      `got ${JSON.stringify(lastCreateParams?.discounts)}`);
    check('T2 metadata.numeroColegiado=838123456', lastCreateParams?.metadata?.numeroColegiado === '838123456');
    check('T2 line_items[0].price = price_test_clinica', lastCreateParams?.line_items?.[0]?.price === 'price_test_clinica');
  }

  // T3 — Colegiado mal formato (5 digitos en lugar de 6) -> 400
  {
    lastCreateParams = null;
    const r = await call(validBody({ numeroColegiado: '83812345' }));
    check('T3 status 400 colegiado mal formato', r.status === 400, `got ${r.status}`);
    check('T3 mensaje claro', r.json?.error?.includes('colegiado'), `got ${r.json?.error}`);
    check('T3 NO crea session Stripe', lastCreateParams === null);
  }

  // T4 — Plan invalido -> 400
  {
    lastCreateParams = null;
    const r = await call(validBody({ plan: 'enterprise_pro_xxx' }));
    check('T4 status 400 plan invalido', r.status === 400);
    check('T4 NO crea session Stripe', lastCreateParams === null);
  }

  // T5 — successUrl dominio NO whitelist -> 400
  {
    lastCreateParams = null;
    const r = await call(validBody({ successUrl: 'https://evil.com/?session_id={CHECKOUT_SESSION_ID}' }));
    check('T5 status 400 successUrl no permitida', r.status === 400);
    check('T5 mensaje whitelist', r.json?.error?.includes('whitelist'), `got ${r.json?.error}`);
    check('T5 NO crea session', lastCreateParams === null);
  }

  // T6 — successUrl sin {CHECKOUT_SESSION_ID} -> 400
  {
    lastCreateParams = null;
    const r = await call(validBody({ successUrl: 'https://podosystem.es/success' }));
    check('T6 status 400 sin placeholder session_id', r.status === 400);
    check('T6 mensaje claro', r.json?.error?.includes('CHECKOUT_SESSION_ID'));
  }

  // T7 — Email mal formato -> 400
  {
    lastCreateParams = null;
    const r = await call(validBody({ email: 'no-es-email' }));
    check('T7 status 400 email invalido', r.status === 400);
    check('T7 NO crea session', lastCreateParams === null);
  }

  // T8 — Sin STRIPE_SECRET_KEY -> 503
  {
    const savedKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    lastCreateParams = null;
    const r = await call(validBody({ plan: 'basico' }));
    check('T8 status 503 sin STRIPE_SECRET_KEY', r.status === 503, `got ${r.status}`);
    check('T8 NO crea session', lastCreateParams === null);
    process.env.STRIPE_SECRET_KEY = savedKey;
  }

  // T9 — Sin STRIPE_PRICE_RED -> 503 al pedir plan=red
  {
    const savedPrice = process.env.STRIPE_PRICE_RED;
    delete process.env.STRIPE_PRICE_RED;
    lastCreateParams = null;
    const r = await call(validBody({ plan: 'red' }));
    check('T9 status 503 sin STRIPE_PRICE_RED', r.status === 503, `got ${r.status}`);
    check('T9 mensaje menciona plan red', r.json?.error?.includes('red'), `got ${r.json?.error}`);
    check('T9 NO crea session', lastCreateParams === null);
    process.env.STRIPE_PRICE_RED = savedPrice;
  }

  // T10 — Stripe API rechaza -> 502
  {
    nextStripeError = new Error('Invalid price ID: price_xxx');
    lastCreateParams = null;
    const r = await call(validBody({ plan: 'basico' }));
    check('T10 status 502 Stripe error', r.status === 502, `got ${r.status}`);
    check('T10 mensaje legible', r.json?.error?.includes('Stripe error:'));
    check('T10 fakeCreate fue invocado', lastCreateParams !== null);
  }

  // T11 — metadata.plan + metadata.numeroColegiado correctos (mismo caso T2 reverificado)
  {
    lastCreateParams = null;
    await call(validBody({ plan: 'red', numeroColegiado: '838999000' }));
    check('T11 metadata.plan=red', lastCreateParams?.metadata?.plan === 'red');
    check('T11 metadata.numeroColegiado=838999000', lastCreateParams?.metadata?.numeroColegiado === '838999000');
  }

  // T12 — email pre-rellenado pasa customer_email
  {
    lastCreateParams = null;
    await call(validBody({ email: 'podologo@test.es' }));
    check('T12 customer_email = podologo@test.es', lastCreateParams?.customer_email === 'podologo@test.es');
  }

  // T13 — sin email NO pasa customer_email (undefined, no string vacio)
  {
    lastCreateParams = null;
    await call(validBody());
    check('T13 customer_email NO definido', lastCreateParams?.customer_email === undefined,
      `got ${JSON.stringify(lastCreateParams?.customer_email)}`);
  }

  // T14 — rateLimit middleware aplicado al endpoint (verificacion source)
  {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/checkout.js'), 'utf-8');
    check('T14 rateLimit importado',
      /require\(['"]\.\.\/middleware\/rateLimit['"]\)/.test(src));
    check('T14 rateLimit aplicado al POST /create-session',
      /router\.post\(\s*['"]\/create-session['"]\s*,\s*rateLimit\s*,/.test(src),
      'patron no encontrado');
  }

  // NOTA: cleanup minimo — process.exit basta
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n=== ${passed} PASS / ${failed} FAIL / ${results.length} total ===`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
