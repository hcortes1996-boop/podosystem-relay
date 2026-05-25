/**
 * webhooks.js — Handler de eventos LemonSqueezy
 *
 * Montado en /api/webhooks desde index.js con express.raw() para
 * poder verificar la firma HMAC-SHA256 sobre el cuerpo sin parsear.
 *
 * Eventos manejados:
 *   order_created              → alta completa: licencia + relay + Netlify
 *   subscription_payment_success → renovar ultimaValidacion
 *   subscription_cancelled     → marcar expirada
 *   subscription_payment_failed  → marcar expirada
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const { genId, genApiKey } = require('../db');
const { deployClientSite } = require('../netlify-deploy');

// ── Verificación de firma ────────────────────────────────────────────────────

function verifySignature(rawBody, signature) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[webhook] ⚠️  LEMONSQUEEZY_WEBHOOK_SECRET no definido — verificación omitida');
    return true;
  }
  if (!signature) return false;
  const hash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function genLicenseKey() {
  const bytes = crypto.randomBytes(10).toString('hex').toUpperCase();
  return [0, 4, 8, 12, 16].map((s, i, a) => bytes.slice(s, a[i + 1] || bytes.length)).join('-');
}

function findLicencia(db, subscriptionId, email) {
  if (subscriptionId) {
    const l = db.prepare('SELECT id, estado FROM licencias WHERE suscripcionId = ?').get(String(subscriptionId));
    if (l) return l;
  }
  if (email) {
    return db.prepare("SELECT id, estado FROM licencias WHERE clienteEmail = ? AND fuente = 'lemonsqueezy' ORDER BY createdAt DESC LIMIT 1").get(email);
  }
  return null;
}

// ── Ruta principal ───────────────────────────────────────────────────────────

router.post('/lemonsqueezy', async (req, res) => {
  // req.body es Buffer (express.raw() montado en index.js)
  const rawBody  = req.body;
  const signature = req.headers['x-signature'] || '';

  if (!verifySignature(rawBody, signature)) {
    console.warn('[webhook] Firma HMAC inválida — request rechazado');
    return res.status(401).json({ ok: false, error: 'Firma inválida' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return res.status(400).json({ ok: false, error: 'Payload JSON inválido' });
  }

  const eventName = payload?.meta?.event_name || '';
  const customData = payload?.meta?.custom_data || {};
  const attrs = payload?.data?.attributes || {};
  // Para order_created: subscription_id puede estar en attrs.subscription_ids[0]
  // Para subscription_*: payload.data.id ES el subscription ID
  const subscriptionId = String(
    (Array.isArray(attrs.subscription_ids) && attrs.subscription_ids[0]) ||
    attrs.subscription_id ||
    payload?.data?.id ||
    ''
  );

  console.log(`[webhook] ${eventName} | subscriptionId=${subscriptionId}`);

  const db = req.db;
  try {
    switch (eventName) {
      case 'order_created':
        await handleOrderCreated(db, { attrs, customData, subscriptionId });
        break;
      case 'subscription_payment_success':
        handlePaymentSuccess(db, { attrs, subscriptionId });
        break;
      case 'subscription_cancelled':
        handleCancelled(db, { attrs, subscriptionId });
        break;
      case 'subscription_payment_failed':
        handlePaymentFailed(db, { attrs, subscriptionId });
        break;
      default:
        console.log(`[webhook] Evento no manejado: ${eventName}`);
    }
  } catch (err) {
    console.error(`[webhook] Error en ${eventName}:`, err.message);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }

  // Siempre responder 200 para que LemonSqueezy no reintente
  res.json({ ok: true, event: eventName });
});

// ── Manejadores de eventos ───────────────────────────────────────────────────

async function handleOrderCreated(db, { attrs, customData, subscriptionId }) {
  const clienteNombre = attrs.user_name || 'Cliente';
  const clienteEmail  = attrs.user_email;
  const plan          = customData.plan || 'basico';
  const colegiado     = customData.numeroColegiado || null;

  if (!clienteEmail) {
    console.error('[webhook/order_created] Email ausente en el payload');
    return;
  }

  // Idempotencia: evitar duplicar si LemonSqueezy reintenta
  if (subscriptionId) {
    const existing = db.prepare('SELECT id FROM licencias WHERE suscripcionId = ?').get(subscriptionId);
    if (existing) {
      console.log(`[webhook/order_created] Ya existe licencia para subscriptionId=${subscriptionId} — ignorado`);
      return;
    }
  }

  // 1. Licencia
  const licId      = genId(12);
  const licenseKey = genLicenseKey();
  const notas      = [plan, colegiado ? `Colegiado: ${colegiado}` : ''].filter(Boolean).join(' | ');
  db.prepare(`
    INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, estado, fuente, suscripcionId, notas)
    VALUES (?, ?, ?, ?, 'active', 'lemonsqueezy', ?, ?)
  `).run(licId, licenseKey, clienteNombre, clienteEmail, subscriptionId || null, notas);

  // 2. Clínica relay
  const clinicaId = genId(10);
  const apiKey    = genApiKey();
  db.prepare('INSERT INTO clinicas (id, nombre, apiKey) VALUES (?, ?, ?)').run(clinicaId, clienteNombre, apiKey);
  db.prepare('UPDATE licencias SET clinicaId = ? WHERE id = ?').run(clinicaId, licId);

  const relayUrl = process.env.RELAY_URL || 'https://podosystem-relay-production.up.railway.app';
  console.log(`[webhook/order_created] ✅ Licencia creada: ${licenseKey} | plan=${plan} | email=${clienteEmail}`);
  console.log(`[webhook/order_created]    clinicaId=${clinicaId} | apiKey=${apiKey} | relay=${relayUrl}`);

  // 3. Netlify (asíncrono, no bloquea la respuesta)
  if (process.env.NETLIFY_TOKEN) {
    deployClientSite({ clinicaId, nombre: clienteNombre, ciudad: '', direccion: '', telefono: '', logoUrl: '' })
      .then(result => {
        db.prepare('UPDATE clinicas SET webUrl=?, netlifyId=? WHERE id=?').run(result.webUrl, result.netlifyId, clinicaId);
        console.log(`[webhook/order_created] Netlify OK: ${result.webUrl}`);
      })
      .catch(err => console.error('[webhook/order_created] Netlify fallido:', err.message));
  }

  // 4. TODO: enviar email de bienvenida vía nodemailer cuando se configure SMTP
  // Los datos necesarios están en: licenseKey, clinicaId, apiKey, clienteEmail, relayUrl
}

function handlePaymentSuccess(db, { attrs, subscriptionId }) {
  const lic = findLicencia(db, subscriptionId, attrs.user_email);
  if (!lic) {
    console.warn(`[webhook/payment_success] Licencia no encontrada — subscriptionId=${subscriptionId}`);
    return;
  }
  db.prepare('UPDATE licencias SET ultimaValidacion=?, estado=? WHERE id=?')
    .run(new Date().toISOString(), 'active', lic.id);
  console.log(`[webhook/payment_success] Licencia ${lic.id} renovada`);
}

function handleCancelled(db, { attrs, subscriptionId }) {
  const lic = findLicencia(db, subscriptionId, attrs.user_email);
  if (!lic) {
    console.warn(`[webhook/cancelled] Licencia no encontrada — subscriptionId=${subscriptionId}`);
    return;
  }
  db.prepare('UPDATE licencias SET estado=? WHERE id=?').run('expired', lic.id);
  console.log(`[webhook/cancelled] Licencia ${lic.id} → expired`);
}

function handlePaymentFailed(db, { attrs, subscriptionId }) {
  const lic = findLicencia(db, subscriptionId, attrs.user_email);
  if (!lic) {
    console.warn(`[webhook/payment_failed] Licencia no encontrada — subscriptionId=${subscriptionId}`);
    return;
  }
  db.prepare('UPDATE licencias SET estado=? WHERE id=?').run('expired', lic.id);
  console.log(`[webhook/payment_failed] Licencia ${lic.id} → expired (pago fallido)`);
}

module.exports = router;
