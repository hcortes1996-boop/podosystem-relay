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

let stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2024-12-18.acacia',
});

const PLANES_VALIDOS = ['basico', 'clinica', 'red'];

// Estados de suscripcion Stripe que justifican expirar la licencia.
// active/trialing/incomplete NO expiran; past_due tampoco (grace, Stripe reintenta).
const EXPIRE_STATUSES = new Set(['unpaid', 'canceled', 'incomplete_expired']);

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

// El id de suscripcion en un invoice cambio de sitio en la API 2026-06-24.dahlia:
// antes invoice.subscription; ahora invoice.parent.subscription_details.subscription.
// Fallback para compatibilidad con ambas versiones.
function subIdFromInvoice(invoice) {
  const s = invoice.parent?.subscription_details?.subscription || invoice.subscription || null;
  return s ? String(s) : null;
}

// Nombres legibles de plan para el email de bienvenida.
const PLAN_NOMBRES = { basico: 'Básico', clinica: 'Clínica', red: 'Red' };

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Email HTML de bienvenida con la clave de licencia (Pieza 8.6).
function buildEmailLicencia({ nombre, plan, licenseKey }) {
  const planNombre = PLAN_NOMBRES[plan] || 'Clínica';
  return `
<div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#0f2137;padding:28px 40px">
    <p style="margin:0;font-size:20px;font-weight:800;color:#fff">Podo<span style="color:#2ecc9a">System</span></p>
    <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,.5)">Tu licencia está activa</p>
  </div>
  <div style="padding:32px 40px">
    <p style="margin:0 0 16px;color:#1a2a3a">Hola <strong>${esc(nombre)}</strong>,</p>
    <p style="margin:0 0 20px;color:#1a2a3a;line-height:1.6">¡Gracias por confiar en PodoSystem! Tu suscripción al <strong>Plan ${esc(planNombre)}</strong> está activa. Aquí tienes tu clave de licencia:</p>
    <div style="background:#f0f6ff;border:2px solid #2ecc9a;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#1E3A5F;text-transform:uppercase;letter-spacing:.1em">Clave de licencia</p>
      <p style="margin:0;font-family:monospace;font-size:24px;font-weight:800;letter-spacing:.12em;color:#0f2137">${esc(licenseKey)}</p>
    </div>
    <p style="margin:0 0 20px;font-size:.9rem;color:#5a7080"><strong>Guarda este email</strong> — necesitarás la clave para activar el software.</p>
    <div style="margin:0 0 24px;padding:18px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px">
      <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#1e40af">Próximos pasos</p>
      <ol style="margin:0;padding-left:20px;font-size:.9rem;color:#1e3a8a;line-height:1.8">
        <li>Descarga PodoSystem en <a href="https://podosystem.es/demo" style="color:#2ecc9a">podosystem.es/demo</a></li>
        <li>Instálalo en tu PC Windows</li>
        <li>Al abrirlo verás la pantalla <strong>«Activar PodoSystem»</strong></li>
        <li>Pega tu clave y pulsa <strong>«Activar licencia»</strong></li>
        <li>¡Listo! Ya puedes empezar</li>
      </ol>
    </div>
    <p style="margin:24px 0 0;font-size:.85rem;color:#aaa">¿Dudas? Escríbenos a <a href="mailto:soporte@podosystem.es" style="color:#2ecc9a">soporte@podosystem.es</a></p>
    <p style="margin:16px 0 0;font-size:.85rem;color:#5a7080">Un saludo,<br>Francisco Román García · PodoSystem</p>
  </div>
</div>`;
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
        await handleInvoiceFailed(db, event.data.object);
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

  // 4. Email de bienvenida con la clave (fire-and-forget; la licencia ya esta creada,
  //    si el email falla se loguea y el admin puede reenviar — no bloquea el webhook).
  const { sendMail } = require('../email');
  sendMail({
    to:      clienteEmail,
    subject: 'Bienvenido a PodoSystem — Tu clave de licencia',
    html:    buildEmailLicencia({ nombre: clienteNombre, plan: planFinal, licenseKey }),
  }).then(() => console.log(`[webhook-stripe/checkout] Email bienvenida enviado a ${clienteEmail}`))
    .catch(err => console.error(`[webhook-stripe/checkout] Email bienvenida FALLO (licencia ya creada): ${err.message}`));
}

function handleInvoicePaid(db, invoice) {
  const suscripcionId = subIdFromInvoice(invoice);
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

async function handleInvoiceFailed(db, invoice) {
  const suscripcionId = subIdFromInvoice(invoice);
  const email         = invoice.customer_email || '';
  const lic = findLicenciaByStripe(db, suscripcionId, email);
  if (!lic) {
    console.warn(`[webhook-stripe/invoice_failed] Licencia no encontrada — sub=${suscripcionId} email=${email}`);
    return;
  }
  // NO expirar a ciegas: un payment_failed puede ser un evento stale (backlog),
  // un fallo SCA del alta o un fallo transitorio que Stripe recupera. Consultamos
  // el estado REAL de la suscripcion como autoridad.
  if (!suscripcionId) {
    console.warn('[webhook-stripe/invoice_failed] Sin suscripcionId — no se expira por seguridad');
    return;
  }
  let sub;
  try {
    sub = await stripeClient.subscriptions.retrieve(suscripcionId);
  } catch (err) {
    console.error(`[webhook-stripe/invoice_failed] No se pudo verificar sub ${suscripcionId}: ${err.message}`);
    throw err; // -> 500 -> Stripe reintenta el webhook y re-evalua el estado
  }
  if (!EXPIRE_STATUSES.has(sub.status)) {
    console.log(`[webhook-stripe/invoice_failed] Sub ${suscripcionId} status=${sub.status} — NO se expira (lic ${lic.id})`);
    return;
  }
  db.prepare('UPDATE licencias SET estado=? WHERE id=?').run('expired', lic.id);
  console.log(`[webhook-stripe/invoice_failed] Licencia ${lic.id} -> expired (sub status=${sub.status})`);
}

module.exports = router;

// Hook solo para tests: inyectar un stripeClient mock (subscriptions.retrieve).
// En produccion nunca se invoca -> el cliente real queda intacto.
module.exports._setStripeClient = (client) => { stripeClient = client; };
