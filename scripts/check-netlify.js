#!/usr/bin/env node
'use strict';
/**
 * check-netlify.js — ¿Sirve el NETLIFY_TOKEN?
 *
 * Existe porque el panel solo comprueba que la variable EXISTA:
 *
 *   if (!process.env.NETLIFY_TOKEN) return res.status(503)...
 *
 * Un token caducado la pasa —está definida— y el fallo aparece después, como un 500
 * al pulsar «Redeploy web», con el error de Netlify enterrado en los logs de Railway.
 * Esto lo dice antes y en una línea.
 *
 * Solo hace LECTURAS: lista los sitios. No crea ni despliega nada.
 *
 * El token se lee del ENTORNO, nunca de la línea de órdenes: un proceso que falla
 * vuelca su argv completo en el mensaje de error, y ahí se ha ido más de un secreto.
 *
 * Uso:
 *   export NETLIFY_TOKEN=nfp_xxxxx   # o $env:NETLIFY_TOKEN="nfp_xxx" en PowerShell
 *   node scripts/check-netlify.js
 */
const NETLIFY_API = 'https://api.netlify.com/api/v1';

const token = process.env.NETLIFY_TOKEN;

if (!token) {
  console.error('❌ NETLIFY_TOKEN no está en el entorno.\n');
  console.error('   bash:       export NETLIFY_TOKEN=nfp_...');
  console.error('   PowerShell: $env:NETLIFY_TOKEN="nfp_..."');
  process.exit(1);
}

// Se enseña solo el principio, lo justo para distinguir dos tokens sin revelarlo.
console.log(`Token presente: ${token.slice(0, 7)}… (${token.length} caracteres)\n`);

(async () => {
  let res;
  try {
    res = await fetch(`${NETLIFY_API}/sites`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.error(`❌ No se pudo hablar con Netlify: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (res.status === 401) {
    console.error('❌ Netlify lo rechaza (401). El token está caducado o revocado.');
    console.error('   Crea uno nuevo en: https://app.netlify.com/user/applications#personal-access-tokens');
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    console.error(`❌ Netlify respondió ${res.status}.`);
    console.error((await res.text().catch(() => '')).slice(0, 300));
    process.exitCode = 1;
    return;
  }

  const sitios = await res.json();
  console.log(`✅ El token FUNCIONA. Netlify devuelve ${sitios.length} sitio(s):\n`);

  // Los tres que le importan a PodoSystem, para ver de un vistazo si están todos.
  const nuestros = ['clinica-del-pie-merino', 'clinipie-alboran', 'podologofranciscoroman'];
  for (const s of sitios) {
    const marca = nuestros.some(n => (s.name || '').includes(n)) ? '👉' : '  ';
    console.log(`  ${marca} ${(s.name || '?').padEnd(34)} ${s.id}`);
  }

  const faltan = nuestros.filter(n => !sitios.some(s => (s.name || '').includes(n)));
  if (faltan.length) {
    console.log(`\n⚠️  No aparecen por aquí: ${faltan.join(', ')}`);
    console.log('   Puede ser normal: podologofranciscoroman se desplegó fuera del panel y');
    console.log('   quizá viva en otra cuenta de Netlify.');
  }

  console.log('\nSiguiente paso: pon este mismo token en Railway → Variables → NETLIFY_TOKEN.');
  console.log('Railway reinicia el servicio solo al guardar la variable.');
})();
