/**
 * test_whatsapp_prefijo.js — el botón de WhatsApp del panel solo pone el +34 a quien es de España.
 * El 25-11-2026 una podóloga de Chile (Región del Biobío, +56 9…) salía con su número convertido
 * en un fijo de Castellón.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin-panel', 'index.html'), 'utf8');
const ini = html.indexOf('const PROVINCIAS_ES = ');
const fin = html.indexOf('function botonWhatsApp(');
if (ini < 0 || fin < ini) { console.error('❌ No encuentro telefonoWhatsApp en el panel'); process.exit(1); }
const { telefonoWhatsApp } = new Function(html.slice(ini, fin) + '\nreturn { telefonoWhatsApp };')();

let ok = 0, mal = 0;
const caso = (tel, prov, esperado, n) => {
  const r = telefonoWhatsApp(tel, prov);
  if (r === esperado) { ok++; console.log('  ✅ ' + n); } else { mal++; console.error(`  ❌ ${n} → ${JSON.stringify(r)} (esperaba ${JSON.stringify(esperado)})`); }
};
console.log('\n🧪 Prefijo del WhatsApp del panel\n');
caso('685591572', 'Sevilla', '34685591572', 'móvil de Sevilla → +34');
caso('685 59 15 72', '', '34685591572', 'sin provincia → España');
caso('964332175', 'REGION VIII DEL BIO-BIO', '', 'Chile sin prefijo → no se adivina');
caso('+56 9 6433 2175', 'REGION VIII DEL BIO-BIO', '56964332175', 'Chile con +56 → tal cual');
caso('0056964332175', 'Chile', '56964332175', 'Chile con 0056 → tal cual');
caso('926123456', 'Ciudad Real', '34926123456', 'Ciudad Real (dos palabras) → +34');
caso('922123456', 'Santa Cruz de Tenerife', '34922123456', 'Santa Cruz de Tenerife → +34');
caso('600111222', 'A Coruña', '34600111222', 'A Coruña con tilde → +34');
caso('600111222', 'Málaga', '34600111222', 'Málaga con tilde → +34');
caso('600111222', 'Vizcaya / Bizkaia', '34600111222', 'Bizkaia → +34');
caso('34600111222', 'Madrid', '34600111222', 'ya con 34 → igual');
caso('987654321', 'Lima', '', 'Perú (9 cifras con 9) → no se adivina');
caso('12345', 'Madrid', '', 'número corto → nada');
console.log(`\n${ok} bien, ${mal} mal\n`);
process.exit(mal ? 1 : 0);
