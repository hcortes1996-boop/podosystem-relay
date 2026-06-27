/**
 * webhooks-stripe.js — Handler de eventos Stripe (Pieza 8.2)
 *
 * Sucesor de webhooks.js (LemonSqueezy denegado). Stripe NO es Merchant of
 * Record: Francisco Roman Garcia es vendedor legal directo, Stripe procesa
 * pagos. Implicaciones:
 *   - Francisco emite facturas (no Stripe).
 *   - IVA 21% Espana liquidado por Francisco (modelo 303 trimestral).
 *   - Refund 14 dias sin preguntas (politica directa, no LS refund policy).
 *
 * Montado en /api/webhooks/stripe desde index.js con express.raw() para
 * preservar el cuerpo crudo necesario para verificar la firma Stripe.
 *
 * Eventos manejados:
 *   checkout.session.completed     -> alta completa: licencia + clinica + Netlify
 *   invoice.payment_succeeded      -> renovar ultimaValidacion
 *   customer.subscription.deleted  -> marcar expirada
 *   invoice.payment_failed         -> marcar expirada (tras 4 reintentos Stripe)
 *
 * Verificacion firma: stripe.webhooks.constructEvent valida HMAC-SHA256 + ts.
 * Idempotencia: tabla webhooks_stripe_log indexada por event.id (Stripe garantiza
 * unicidad por evento). Stripe reintenta hasta 3 dias si no recibe 2xx.
 */
'use strict';
const router = require('express').Router();
const Stripe = require('stripe');
const { genId, genApiKey } = require('../db');
const { deployClientSite } = require('../netlify-deploy');

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2024-12-18.acacia',
});

const PLANES_VALIDOS = ['basico', 'clinica', 'red'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function genLicenseKey() {
  const crypto = require('crypto');
  const bytes = crypto.randomBytes(10).toString('hex').toUpperCase();
  return [0, 4, 8, 12, 16].map((s, i, a) => bytes.slice(s, a[i + 1] || bytes.length)).join('-');
}

function findLicenciaByStripe(db, suscripcionId, email) {
  if (suscripcionId) {
    const l = db.prepare('SELECT id, estado FROM licencias WHERE suscripcionId = ?').get(String(suscripcionId));
    if (l) return l;
  }
  if (email) {
    return db.prepare(
      "SELECT id, estado FROM licencias WHERE clienteEmail = ? AND fuente = 'stripe' ORDER BY createdAt DESC LIMIT 1"
    ).get(email);
  }
  return null;
}

// ── Ruta principal ───────────────────────────────────────────────────────────

router.post('/stripe', async (req, res) => {
  const rawBody  = req.body;          // Buffer (gracias a express.raw())
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    console.warn('[webhook-stripe] Falta stripe-signature header');
    return res.status(400).json({ ok: false, error: 'Missing stripe-signature' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[webhook-stripe] STRIPE_WEBHOOK_SECRET no configurado — webhook rechazado');
    return res.status(503).json({ ok: false, error: 'Webhook secret not configured' });
  }

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.warn('[webhook-stripe] Firma invalida:', err.message);
    return res.status(400).json({ ok: false, error: `Webhook signature error: ${err.message}` });
  }

  const db = req.db;

  // Idempotencia: si ya procesamos este event.id, responder 200 sin re-ejecutar
  const seen = db.prepare('SELECT eventId FROM webhooks_stripe_log WHERE eventId = ?').get(event.id);
  if (seen) {
    console.log(`[webhook-stripe] ${event.type} | event.id=${event.id} ya procesado — skip`);
    return res.json({ ok: true, idempotent: true });
  }

  console.log(`[webhook-stripe] ${event.type} | event.id=${event.id}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(db, event.data.object);
        break;
      case 'invoice.payment_succeeded':
        handleInvoicePaid(db, event.data.object);
        break;
      case 'customer.subscription.deleted':
        handleSubscriptionDeleted(db, event.data.object);
        break;
      case 'invoice.payment_failed':
        handleInvoiceFailed(db, event.data.object);
        break;
      default:
        console.log(`[webhook-stripe] Evento no manejado: ${event.type}`);
    }
  } catch (err) {
    console.error(`[webhook-stripe] Error en ${event.type}:`, err.message);
    // No registramos en log si falla — Stripe reintentara
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }

  // Registrar evento procesado (idempotencia futura)
  db.prepare(
    "INSERT OR IGNORE INTO webhooks_stripe_log (eventId, type, processedAt, payload) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)"
  ).run(event.id, event.type, JSON.stringify(event.data.object).slice(0, 8000));

  res.json({ ok: true, event: event.type });
});

// ── Manejadores de eventos ───────────────────────────────────────────────────

async function handleCheckoutCompleted(db, session) {
  const clienteEmail   = session.customer_details?.email || session.customer_email || '';
  const clienteNombre  = session.customer_details?.name || 'Cliente';
  const plan           = session.metadata?.plan || 'clinica';
  const colegiado      = session.metadata?.numeroColegiado || null;
  const suscripcionId  = session.subscription ? String(session.subscription) : null;
  const stripeCustomer = session.customer ? String(session.customer) : null;

  if (!clienteEmail) {
    console.error('[webhook-stripe/checkout] Email ausente en session');
    return;
  }

  // Idempotencia adicional por suscripcionId (por si llega antes de marcar event)
  if (suscripcionId) {
    const existing = db.prepare('SELECT id FROM licencias WHERE suscripcionId = ?').get(suscripcionId);
    if (existing) {
      console.log(`[webhook-stripe/checkout] Licencia ya existe para sub=${suscripcionId} — skip`);
      return;
    }
  }

  // 1. Licencia
  const licId        = genId(12);
  const licenseKey   = genLicenseKey();
  const planFinal    = PLANES_VALIDOS.includes(plan) ? plan : 'clinica';
  const notas        = [planFinal, colegiado ? `Colegiado: ${colegiado}` : '', stripeCustomer ? `Stripe: ${stripeCustomer}` : '']
                         .filter(Boolean).join(' | ');

  db.prepare(`
    INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, estado, fuente, suscripcionId, notas, plan)
    VALUES (?, ?, ?, ?, 'active', 'stripe', ?, ?, ?)
  `).run(licId, licenseKey, clienteNombre, clienteEmail, suscripcionId, notas, planFinal);

  // 2. Clinica relay
  const clinicaId = genId(10);
  const apiKey    = genApiKey();
  db.prepare('INSERT INTO clinicas (id, nombre, apiKey) VALUES (?, ?, ?)').run(clinicaId, clienteNombre, apiKey);
  db.prepare('UPDATE licencias SET clinicaId = ? WHERE id = ?').run(clinicaId, licId);

  console.log(`[webhook-stripe/checkout] OK licencia=${licenseKey} | plan=${planFinal} | email=${clienteEmail}`);
  console.log(`[webhook-stripe/checkout]    clinicaId=${clinicaId} | apiKey=${apiKey} | sub=${suscripcionId}`);

  // 3. Netlify async (no bloquea respuesta)
  if (process.env.NETLIFY_TOKEN) {
    deployClientSite({ clinicaId, nombre: clienteNombre, ciudad: '', direccion: '', telefono: '' })
      .then(result => {
        db.prepare('UPDATE clinicas SET webUrl=?, netlifyId=? WHERE id=?')
          .run(result.webUrl, result.netlifyId, clinicaId);
        console.log(`[webhook-stripe/checkout] Netlify OK: ${result.webUrl}`);
      })
      .catch(err => console.error('[webhook-stripe/checkout] Netlify fallido:', err.message));
  }
}

function handleInvoicePaid(db, invoice) {
  const suscripcionId = invoice.subscription ? String(invoice.subscription) : null;
  const email         = invoice.customer_email || '';
  const lic = findLicenciaByStripe(db, suscripcionId, email);
  if (!lic) {
    console.warn(`[webhook-stripe/invoice_paid] Licencia no encontrada — sub=${suscripcionId} email=${email}`);
    return;
  }
  db.prepare('UPDATE licencias SET ultimaValidacion=?, estado=? WHERE id=?')
    .run(new Date().toISOString(), 'active', lic.id);
  console.log(`[webhook-stripe/invoice_paid] Licencia ${lic.id} renovada`);
}

function handleSubscriptionDeleted(db, subscription) {
  const suscripcionId = subscription.id ? String(subscription.id) : null;
  const lic = findLicenciaByStripe(db, suscripcionId, null);
  if (!lic) {
    console.warn(`[webhook-stripe/sub_deleted] Licencia no encontrada — sub=${suscripcionId}`);
    return;
  }
  db.prepare('UPDATE licencias SET estado=? WHERE id=?').run('expired', lic.id);
  console.log(`[webhook-stripe/sub_deleted] Licencia ${lic.id} -> expired`);
}

function handleInvoiceFailed(db, invoice) {
  const suscripcionId = invoice.subscription ? String(invoice.subscription) : null;
  const email         = invoice.customer_email || '';
  const lic = findLicenciaByStripe(db, suscripcionId, email);
  if (!lic) {
    console.warn(`[webhook-stripe/invoice_failed] Licencia no encontrada — sub=${suscripcionId}`);
    return;
  }
  // Stripe ya intento 4 veces antes de mandar este evento (smart retries).
  // Marcamos expired directamente; cliente puede actualizar tarjeta y reactivar.
  db.prepare('UPDATE licencias SET estado=? WHERE id=?').run('expired', lic.id);
  console.log(`[webhook-stripe/invoice_failed] Licencia ${lic.id} -> expired (pago fallido tras reintentos)`);
}

module.exports = router;
