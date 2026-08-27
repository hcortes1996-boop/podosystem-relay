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
 * DEV_EMAIL_OVERRIDE redirige TODOS los correos a una sola dirección. Es útil probando y
 * catastrófico en producción: el cliente que pide recuperar su contraseña recibe un
 * «enviado» y no le llega nada, porque su código se ha ido a otro buzón.
 *
 * El 27-08-2026 estuvo activa sin que nadie lo supiera. Se descubrió por casualidad, al
 * mirar el asunto de un correo de prueba y ver el prefijo [TEST]. Buscándola no aparecía en
 * la lista de variables del servicio en Railway.
 *
 * Eso es lo que se arregla aquí: no la variable —que es legítima— sino que fuera INVISIBLE.
 * Ahora el relay lo grita al arrancar, así que sale en el log de cada despliegue.
 */
function avisarOverride() {
  const override = process.env.DEV_EMAIL_OVERRIDE?.trim();
  if (!override) return;
  const linea = '─'.repeat(72);
  console.warn('\n' + linea);
  console.warn('⚠️  DEV_EMAIL_OVERRIDE ACTIVO — TODOS los correos van a: ' + override);
  console.warn('    Ningún cliente recibirá los suyos: ni códigos de recuperación, ni');
  console.warn('    licencias. Quítala en Railway antes de vender (Variables → Raw Editor).');
  console.warn(linea + '\n');
}
avisarOverride();

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

  // Y en cada envío, no solo al arrancar: si alguien mira el log buscando por qué un
  // cliente no recibe su correo, esta línea se lo dice sin tener que deducirlo.
  if (override && override !== to) {
    console.warn(`⚠️  [email] DESVIADO por DEV_EMAIL_OVERRIDE: iba a "${to}" y se manda a "${override}"`);
  }

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
