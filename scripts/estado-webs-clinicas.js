#!/usr/bin/env node
'use strict';
/**
 * Qué versión de la web sirve cada clínica, y si tiene la página de anulación.
 *
 * Existe por lo que costó averiguarlo a mano el 13-08-2026: hubo que descargar seis
 * ficheros y compararlos para descubrir que las tres webs vivas llevaban tres meses
 * por detrás de la plantilla y que ninguna tenía el multi-podólogo que ya estaba
 * programado. Con esto se responde en dos segundos.
 *
 * Solo LEE. No despliega ni modifica nada.
 *
 *   node scripts/estado-webs-clinicas.js
 *   node scripts/estado-webs-clinicas.js https://mi-clinica.com/cita.html   (una suelta)
 */
const fs = require('fs');
const path = require('path');

const PLANTILLA = path.join(__dirname, '..', 'web-template');
const TIEMPO = 20000;

/** El sello <meta name="podosystem-web" content="AAAA-MM-DD"> que lleva cada página. */
function selloDe(html) {
  const m = html.match(/<meta\s+name=["']podosystem-web["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

async function bajar(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIEMPO);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    const txt = res.ok ? await res.text() : '';
    return { estado: res.status, bytes: txt.length, html: txt };
  } catch (e) {
    return { estado: 0, bytes: 0, html: '', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

function pista(html) {
  // Marcadores que distinguen versiones sin tener que diferenciar 1.900 líneas.
  return {
    planRed: /podologoId|PodologoCard/.test(html),
    hero:    /hero-cita/.test(html),
    sinRellenar: (html.match(/\{\{[A-Z0-9_]+\}\}/g) || []).length,
  };
}

(async () => {
  const sueltas = process.argv.slice(2).filter(a => a.startsWith('http'));

  // La plantilla, como referencia
  const refCita = fs.existsSync(path.join(PLANTILLA, 'cita.html'))
    ? fs.readFileSync(path.join(PLANTILLA, 'cita.html'), 'utf-8') : '';
  const refGest = fs.existsSync(path.join(PLANTILLA, 'gestionar.html'))
    ? fs.readFileSync(path.join(PLANTILLA, 'gestionar.html'), 'utf-8') : '';

  console.log('\n══ PLANTILLA (web-template/) ══');
  console.log(`  cita.html       ${String(refCita.length).padStart(7)} B · sello ${selloDe(refCita) || '—'} · Plan Red: ${pista(refCita).planRed ? 'sí' : 'no'}`);
  console.log(`  gestionar.html  ${String(refGest.length).padStart(7)} B · sello ${selloDe(refGest) || '—'}`);

  let urls = sueltas;
  if (!urls.length) {
    // Sin argumentos, se piden las clínicas al panel si hay token; si no, la lista
    // conocida. Se prefiere no exigir credenciales para algo que solo lee webs.
    urls = [
      'https://podologofranciscoroman.com/cita.html',
      'https://clinica-del-pie-merino.netlify.app/cita.html',
      'https://clinipie-alboran.netlify.app/cita.html',
    ];
    console.log('\n(sin argumentos: se comprueban las webs conocidas)');
  }

  console.log('\n══ EN PRODUCCIÓN ══');
  let desfasadas = 0, sinGestionar = 0;

  for (const url of urls) {
    const cita = await bajar(url);
    const urlGest = url.replace(/\/[^/]*$/, '/gestionar.html');
    const gest = await bajar(urlGest);

    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    console.log(`\n  ${host}`);

    if (cita.estado !== 200) {
      console.log(`     cita.html       ❌ http ${cita.estado || '—'} ${cita.error || ''}`);
    } else {
      const p = pista(cita.html);
      const alDia = refCita && cita.bytes === refCita.length;
      if (!alDia) desfasadas++;
      console.log(`     cita.html       ${String(cita.bytes).padStart(7)} B · sello ${selloDe(cita.html) || '—'}` +
                  ` · Plan Red: ${p.planRed ? 'sí' : 'NO'}` +
                  ` ${alDia ? '✅ al día' : '⚠️ distinta de la plantilla'}`);
      if (p.sinRellenar) console.log(`                     🔴 ${p.sinRellenar} marcadores {{…}} SIN RELLENAR`);
    }

    if (gest.estado === 200) {
      const p = pista(gest.html);
      console.log(`     gestionar.html  ${String(gest.bytes).padStart(7)} B · sello ${selloDe(gest.html) || '—'} ✅`);
      if (p.sinRellenar) console.log(`                     🔴 ${p.sinRellenar} marcadores {{…}} SIN RELLENAR`);
    } else {
      sinGestionar++;
      console.log(`     gestionar.html  ❌ no está (http ${gest.estado || '—'}) — el paciente no puede anular`);
    }
  }

  console.log('\n══ RESUMEN ══');
  console.log(`  ${desfasadas} de ${urls.length} sirven algo distinto de la plantilla`);
  console.log(`  ${sinGestionar} de ${urls.length} no tienen la página de anulación`);
  if (desfasadas || sinGestionar) {
    console.log('\n  Para ponerlas al día: «Redeploy web» en el panel del relay.');
    console.log('  ⚠️ Antes, mirar qué se pierde: las webs vivas tienen hero y navegación');
    console.log('     que la plantilla no trae. Ver docs/webs_clinicas_estado_2026-08.md');
    console.log('     en el repo del PC.');
  }
  console.log();
})();
