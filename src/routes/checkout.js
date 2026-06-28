/**
 * checkout.js — Endpoint Stripe Checkout Sessions (Pieza 8.3)
 *
 * Crea una sesion de Stripe Checkout (modo subscription) para que el cliente
 * pague una suscripcion mensual. La session llega a /api/webhooks/stripe via
 * 'checkout.session.completed' (Pieza 8.2) que crea licencia + clinica.
 *
 *   POST /api/checkout/create-session  (publico, rate-limit 10/h por IP)
 *
 * Body:
 *   {
 *     plan: 'basico' | 'clinica' | 'red',
 *     numeroColegiado: '838xxxxxx' (opcional, 838+6 digitos),
 *     email: 'cliente@dominio.es' (opcional, prerrellenar Checkout),
 *     successUrl: 'https://podosystem.es/success?session_id={CHECKOUT_SESSION_ID}',
 *     cancelUrl:  'https://podosystem.es/#precios'
 *   }
 *
 * Respuesta exito: { ok: true, url: 'https://checkout.stripe.com/...', sessionId: 'cs_xxx' }
 * Errores:
 *   400 plan/url/colegiado/email invalido
 *   429 rate-limit excedido
 *   502 Stripe API down/timeout
 *   503 sin STRIPE_SECRET_KEY o STRIPE_PRICE_<plan> configurados
 *
 * Defensivo:
 *   - successUrl/cancelUrl con whitelist de dominios (evita open redirect).
 *   - successUrl debe contener literal {CHECKOUT_SESSION_ID} (Stripe lo sustituye).
 *   - Colegiado validado con regex 838+6 digitos antes de aplicar cupon Andalucia.
 *   - Si cupon o colegiado falta -> precio estandar sin descuento.
 */
'use strict';
const router   = require('express').Router();
const Stripe   = require('stripe');
const rateLimit = require('../middleware/rateLimit');

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2024-12-18.acacia',
});

const PLANES_VALIDOS = ['basico', 'clinica', 'red'];
const ALLOWED_HOSTS  = new Set([
  'podosystem.es',
  'www.podosystem.es',
  'franciscoroman.com',
  'localhost',
  '127.0.0.1',
]);
const COLEGIADO_REGEX = /^838\d{6}$/;
const EMAIL_REGEX     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function priceIdForPlan(plan) {
  switch (plan) {
    case 'basico':  return process.env.STRIPE_PRICE_BASICO;
    case 'clinica': return process.env.STRIPE_PRICE_CLINICA;
    case 'red':     return process.env.STRIPE_PRICE_RED;
    default:        return null;
  }
}

function isUrlAllowed(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) return false;
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

router.post('/create-session', rateLimit, async (req, res) => {
  // 1) Guard: STRIPE_SECRET_KEY configurado
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ ok: false, error: 'Stripe no configurado en el servidor' });
  }

  const body = req.body || {};
  const { plan, numeroColegiado, email, successUrl, cancelUrl } = body;

  // 2) Plan whitelist
  if (!PLANES_VALIDOS.includes(plan)) {
    return res.status(400).json({ ok: false, error: 'Plan no valido. Permitidos: basico, clinica, red' });
  }

  // 3) Price ID configurado para el plan
  const priceId = priceIdForPlan(plan);
  if (!priceId) {
    return res.status(503).json({ ok: false, error: `Precio no configurado para plan ${plan}` });
  }

  // 4) successUrl / cancelUrl whitelist dominio
  if (!isUrlAllowed(successUrl)) {
    return res.status(400).json({ ok: false, error: 'successUrl no permitida (dominio fuera de la whitelist)' });
  }
  if (!isUrlAllowed(cancelUrl)) {
    return res.status(400).json({ ok: false, error: 'cancelUrl no permitida (dominio fuera de la whitelist)' });
  }

  // 5) successUrl debe contener placeholder {CHECKOUT_SESSION_ID} (Stripe lo sustituye)
  if (!successUrl.includes('{CHECKOUT_SESSION_ID}')) {
    return res.status(400).json({ ok: false, error: 'successUrl debe incluir el literal {CHECKOUT_SESSION_ID}' });
  }

  // 6) Colegiado opcional — si presente, validar formato 838 + 6 digitos
  const colegiadoTrim = (typeof numeroColegiado === 'string') ? numeroColegiado.trim() : '';
  if (colegiadoTrim && !COLEGIADO_REGEX.test(colegiadoTrim)) {
    return res.status(400).json({ ok: false, error: 'Formato de numero de colegiado invalido (esperado 838 + 6 digitos)' });
  }

  // 7) Email opcional — si presente, validar formato basico
  const emailTrim = (typeof email === 'string') ? email.trim() : '';
  if (emailTrim && !EMAIL_REGEX.test(emailTrim)) {
    return res.status(400).json({ ok: false, error: 'Email invalido' });
  }

  // 8) Construir parametros de la Checkout Session
  const sessionParams = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: {
      plan,
      numeroColegiado: colegiadoTrim || '',
    },
    success_url: successUrl,
    cancel_url:  cancelUrl,
    locale: 'es',
    payment_method_types: ['card'],
    billing_address_collection: 'required',
  };

  if (emailTrim) {
    sessionParams.customer_email = emailTrim;
  }

  if (colegiadoTrim && process.env.STRIPE_COUPON_ANDALUCIA) {
    sessionParams.discounts = [{ coupon: process.env.STRIPE_COUPON_ANDALUCIA }];
  }

  // 9) Crear session via Stripe API
  try {
    const session = await stripeClient.checkout.sessions.create(sessionParams);
    return res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[checkout/create-session] Stripe error:', err.message);
    return res.status(502).json({ ok: false, error: `Stripe error: ${err.message}` });
  }
});

module.exports = router;
