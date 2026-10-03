/**
 * test_menu_web.js — La página de citas de una clínica con web propia enlaza a SU web.
 *
 * 03-10-2026, web de Francisco: «si le doy a Inicio se queda en la página de citas». La plantilla
 * es de una sola página y su menú apunta a #hero, #como-funciona… `conMenuDeWeb` los cambia por la
 * portada, Servicios, El Podólogo y Localización. Si la plantilla cambia esos bloques y la función
 * deja de encontrarlos, esto lo dice antes de que se publique una web con el menú viejo.
 */
'use strict';
const { construirVars, construirFicheros, conMenuDeWeb } = require('../src/netlify-deploy');

let ok = 0, fallos = 0;
const prueba = (c, n, x) => { if (c) { ok++; console.log('  ✅ ' + n); } else { fallos++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };

console.log('\n🧪 Menú de la página de citas → la web de la clínica\n');
const ficheros = construirFicheros(construirVars({ clinicaId: 'X1', nombre: 'Clinica de Prueba', ciudad: 'Sevilla', telefono: '600000000' }));
const { html, cambios } = conMenuDeWeb(String(ficheros['cita.html']));
const nav = (clase) => (html.match(new RegExp(`<nav class="${clase}"[^>]*>([\\s\\S]*?)</nav>`)) || [])[1] || '';

prueba(cambios === 4, 'encuentra los cuatro sitios: menú, pie y los dos logos', `cambios: ${cambios}`);
for (const clase of ['nav-menu', 'footer-nav']) {
  const n = nav(clase);
  prueba(['index.html', 'servicios.html', 'podologo.html', 'localizacion.html'].every(h => n.includes(`href="${h}"`)),
    `${clase}: lleva a la portada, Servicios, El Podólogo y Localización`);
  prueba(!/href="#(hero|como-funciona|sobre-nosotros|contacto)"/.test(n), `${clase}: ya no apunta a secciones de la propia página`);
  prueba(/href="#pedir-cita"/.test(n), `${clase}: «Pedir Cita» sigue llevando al formulario`);
}
prueba(/<a href="index\.html" class="header-logo"/.test(html), 'el logo de la cabecera lleva a la portada');
prueba(String(ficheros['cita.html']) !== html && /href="#hero"/.test(String(ficheros['cita.html'])),
  'y sin --menu-web la plantilla sigue igual (para las clínicas sin web propia)');

console.log(`\n${ok} bien, ${fallos} mal\n`);
process.exit(fallos ? 1 : 0);
