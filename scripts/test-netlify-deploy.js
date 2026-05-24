/**
 * test-netlify-deploy.js — Prueba el deploy Netlify localmente.
 *
 * Uso:
 *   $env:NETLIFY_TOKEN="nfp_xxxx..."; node scripts/test-netlify-deploy.js
 *
 * Con token inline (PowerShell):
 *   $env:NETLIFY_TOKEN="nfp_xxxx"; node scripts/test-netlify-deploy.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// Fix SSL en Windows (solo para tests locales)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { deployClientSite } = require('../src/netlify-deploy');

if (!process.env.NETLIFY_TOKEN) {
  console.error('ERROR: NETLIFY_TOKEN no está en variables de entorno.');
  console.error('Ejecuta: $env:NETLIFY_TOKEN="nfp_tu_token"; node scripts/test-netlify-deploy.js');
  process.exit(1);
}

console.log('=== TEST DEPLOY NETLIFY ===');
console.log('Token:', process.env.NETLIFY_TOKEN.slice(0, 8) + '...');
console.log('');

deployClientSite({
  clinicaId:  'TEST-ID-001',
  nombre:     'Clínica Podológica Test',
  ciudad:     'Sevilla',
  direccion:  'Calle Ejemplo 1, 41001',
  telefono:   '955 000 000',
}).then(result => {
  console.log('');
  console.log('=== RESULTADO OK ===');
  console.log('webUrl:    ', result.webUrl);
  console.log('netlifyId: ', result.netlifyId);
  console.log('siteName:  ', result.siteName);
}).catch(err => {
  console.error('');
  console.error('=== ERROR ===');
  console.error(err.message);
  process.exit(1);
});
