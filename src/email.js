'use strict';
const nodemailer = require('nodemailer');

function createTransport() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.zoho.eu',
    port:   parseInt(process.env.SMTP_PORT || '465', 10),
    secure: process.env.SMTP_PORT !== '587',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

/**
 * Envía un email. Si DEV_EMAIL_OVERRIDE está definida, todos los envíos van a esa
 * dirección (y el asunto se prefija con [TEST]).
 * Si SMTP no está configurado, solo loguea un warning.
 */
async function sendMail({ to, subject, html }) {
  const transport = createTransport();
  if (!transport) {
    console.warn('[email] SMTP no configurado — email no enviado. To:', to, '| Subject:', subject);
    return;
  }

  const override = process.env.DEV_EMAIL_OVERRIDE?.trim();
  const actualTo      = override || to;
  const actualSubject = override ? `[TEST] ${subject}` : subject;

  await transport.sendMail({
    from:    process.env.SMTP_FROM || 'PodoSystem <info@podosystem.es>',
    to:      actualTo,
    subject: actualSubject,
    html,
    text:    html.replace(/<[^>]+>/g, '').replace(/\s{2,}/g, ' ').trim(),
  });
}

module.exports = { sendMail };
