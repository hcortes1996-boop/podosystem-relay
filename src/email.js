'use strict';
const { Resend } = require('resend');

// Railway bloquea SMTP saliente en planes no-Pro (timeout). Usamos la API HTTP
// de Resend. Se mantiene la firma sendMail({to,subject,html}) intacta para no
// tocar a los que la llaman (webhook 8.6, alta.js, admin.js).
function getClient() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

/**
 * Envía un email vía Resend (API HTTP). Si DEV_EMAIL_OVERRIDE está definida,
 * todos los envíos van a esa dirección (y el asunto se prefija con [TEST]).
 * Si RESEND_API_KEY no está configurada, solo loguea un warning (no lanza).
 */
async function sendMail({ to, subject, html }) {
  const resend = getClient();
  if (!resend) {
    console.warn('[email] RESEND_API_KEY no configurado — email no enviado. To:', to, '| Subject:', subject);
    return;
  }

  const override      = process.env.DEV_EMAIL_OVERRIDE?.trim();
  const actualTo      = override || to;
  const actualSubject = override ? `[TEST] ${subject}` : subject;

  const { data, error } = await resend.emails.send({
    from:    process.env.SMTP_FROM || 'PodoSystem <info@podosystem.es>',
    to:      actualTo,
    subject: actualSubject,
    html,
    text:    html.replace(/<[^>]+>/g, '').replace(/\s{2,}/g, ' ').trim(),
  });
  if (error) throw new Error(`Resend: ${error.message || JSON.stringify(error)}`);
  return data;
}

module.exports = { sendMail };
