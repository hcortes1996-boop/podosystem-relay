'use strict';
/**
 * La dirección pública del relay, LIMPIA.
 *
 * 04-10-2026: la variable `RELAY_URL` de Railway lleva un ESPACIO delante. Medido en la página de
 * citas de la clínica de Francisco: `src=" https://podosystem-relay-production…"`. En un atributo
 * HTML el navegador lo ignora, pero esa misma base va dentro de los QR de las pruebas y en los
 * enlaces de los correos, y ahí un espacio delante puede hacer que el móvil no la reconozca como
 * enlace. Estaba copiada en siete sitios, cada uno con su `process.env.RELAY_URL || '…'`.
 */
const POR_DEFECTO = 'https://podosystem-relay-production.up.railway.app';

function relayUrl(env = process.env) {
  return (String(env.RELAY_URL || '').trim() || POR_DEFECTO).replace(/\/+$/, '');
}

module.exports = { relayUrl, POR_DEFECTO };
