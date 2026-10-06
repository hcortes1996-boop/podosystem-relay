#!/usr/bin/env node
'use strict';
/**
 * test_borrar_copias.js — Las copias en la nube de una clínica dada de baja, fuera a los 90 días.
 *
 * El Anexo C promete suprimirlas «en un plazo máximo de 90 días desde la terminación». Hasta el
 * 06-10-2026 la limpieza solo revocaba la clave el día 30. Se fija aquí:
 *   · el día 30 se APUNTA la carpeta, y el apunte sobrevive al borrado de la clínica;
 *   · antes del día 90 no se toca nada; en ensayo, tampoco;
 *   · se borra con una clave temporal limitada a esa carpeta, que luego se elimina;
 *   · nunca `relay/` ni algo que no tenga forma de carpeta de clínica, ni ficheros de otra;
 *   · si la clínica vuelve a estar viva, no se borra.
 * Backblaze se simula interceptando `fetch`.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const TMP = path.join(os.tmpdir(), `relay_borrarcopias_${process.pid}.db`);
process.env.DB_PATH = TMP;
delete process.env.LIMPIEZA_MODO;
const ENV = {
  RELAY_B2_GESTOR_KEY_ID: 'gestor-id', RELAY_B2_GESTOR_APP_KEY: 'gestor-secreto',
  COPIAS_BUCKET_ID: 'bucket-123', RELAY_COPIA_CLAVE: crypto.randomBytes(32).toString('hex'),
};

const { initDB } = require('../src/db');
const { revisarClinicas } = require('../src/lib/limpieza-clinicas');
const copias = require('../src/lib/borrar-copias-clinica');

let ok = 0, fallos = 0;
const prueba = (c, n, x) => { if (c) { ok++; console.log('  ✅ ' + n); } else { fallos++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };

// ── Backblaze de mentira, con ficheros de tres carpetas ──
function backblaze({ intruso = false } = {}) {
  const st = { ficheros: [], llamadas: [], claves: new Map(), n: 0 };
  for (const p of ['CLINX0001/', 'OTRA00002/', 'relay/']) {
    for (let i = 0; i < 5; i++) st.ficheros.push({ fileName: `${p}copia-${i}.enc`, fileId: `${p}id${i}` });
  }
  st.fetch = async (url, opts = {}) => {
    const op = String(url).split('/').pop();
    const cuerpo = opts.body ? JSON.parse(opts.body) : null;
    st.llamadas.push({ op, cuerpo, auth: (opts.headers || {}).Authorization });
    const r = (o) => ({ ok: true, status: 200, json: async () => o });
    if (op === 'b2_authorize_account') return r({ accountId: 'cuenta', authorizationToken: 'tok-' + st.llamadas.length, apiInfo: { storageApi: { apiUrl: 'https://api000.backblazeb2.com' } } });
    if (op === 'b2_create_key') { st.n++; st.claves.set('temp-' + st.n, cuerpo); return r({ applicationKeyId: 'temp-' + st.n, applicationKey: 'S' + st.n }); }
    if (op === 'b2_delete_key') { st.claves.delete(cuerpo.applicationKeyId); return r({}); }
    if (op === 'b2_list_file_versions') {
      let lista = st.ficheros.filter(f => f.fileName.startsWith(cuerpo.prefix)).sort((a, b) => a.fileName.localeCompare(b.fileName));
      if (cuerpo.startFileName) lista = lista.filter(f => f.fileName >= cuerpo.startFileName);
      const pagina = lista.slice(0, 2);            // páginas de dos: obliga a paginar
      if (intruso) pagina.push({ fileName: 'OTRA00002/copia-0.enc', fileId: 'OTRA00002/id0' });
      const sig = lista[2];
      return r({ files: pagina, nextFileName: sig ? sig.fileName : null, nextFileId: sig ? sig.fileId : null });
    }
    if (op === 'b2_delete_file_version') { st.ficheros = st.ficheros.filter(f => f.fileId !== cuerpo.fileId); return r({}); }
    return { ok: false, status: 400, json: async () => ({ message: 'op ' + op }) };
  };
  return st;
}

(async () => {
  const db = initDB();
  try {
    console.log('\n🧪 Borrar las copias en la nube de una clínica dada de baja\n');

    console.log('── Qué carpetas se pueden borrar ──');
    prueba(copias.prefijoSeguro('CLINX0001/'), 'una carpeta de clínica sí');
    prueba(!copias.prefijoSeguro('relay/'), 'la de las copias del propio relay, NUNCA');
    prueba(!copias.prefijoSeguro('') && !copias.prefijoSeguro('/') && !copias.prefijoSeguro('CLINX0001') &&
           !copias.prefijoSeguro('../x/') && !copias.prefijoSeguro('a/'), 'ni vacío, ni raíz, ni sin barra, ni rutas raras');

    console.log('\n── El borrado en Backblaze ──');
    let b = backblaze();
    const r = await copias.borrarCopiasDeClinica('CLINX0001/', { env: ENV, fetchImpl: b.fetch });
    prueba(r.ficheros === 5, 'borra las 5 copias de la clínica, paginando', JSON.stringify(r));
    prueba(b.ficheros.every(f => !f.fileName.startsWith('CLINX0001/')), 'no queda ninguna en su carpeta');
    prueba(b.ficheros.filter(f => f.fileName.startsWith('OTRA00002/')).length === 5 &&
           b.ficheros.filter(f => f.fileName.startsWith('relay/')).length === 5, 'las de otra clínica y las del relay, intactas');
    const creada = b.llamadas.find(l => l.op === 'b2_create_key').cuerpo;
    prueba(creada.namePrefix === 'CLINX0001/' && creada.bucketId === 'bucket-123', 'la clave temporal va limitada a su carpeta y al bucket');
    prueba(!creada.capabilities.includes('writeFiles') && !creada.capabilities.includes('readFiles') &&
           !creada.capabilities.some(c => /Keys$/.test(c)), 'y solo puede listar y borrar: ni leer, ni escribir, ni crear claves');
    prueba(creada.validDurationInSeconds <= 3600, 'y caduca sola en una hora');
    prueba(b.claves.size === 0, 'al terminar, la clave temporal se elimina');

    b = backblaze({ intruso: true });
    let lanzo = null;
    try { await copias.borrarCopiasDeClinica('CLINX0001/', { env: ENV, fetchImpl: b.fetch }); } catch (e) { lanzo = e.message; }
    prueba(/fuera de la carpeta/.test(lanzo || ''), 'si Backblaze devolviera un fichero de otra carpeta, se para', lanzo);
    prueba(b.ficheros.filter(f => f.fileName.startsWith('OTRA00002/')).length === 5, 'y no lo borra');
    prueba(b.claves.size === 0, 'y aun así elimina la clave temporal');

    lanzo = null;
    try { await copias.borrarCopiasDeClinica('relay/', { env: ENV, fetchImpl: backblaze().fetch }); } catch (e) { lanzo = e.message; }
    prueba(/no válida/.test(lanzo || ''), 'pedir borrar relay/ falla antes de llamar a Backblaze');

    console.log('\n── El día 30 se apunta; el 90 se borra ──');
    const DIA = 24 * 60 * 60 * 1000;
    const FIN = new Date('2026-07-01T10:00:00Z');
    db.prepare("INSERT INTO clinicas (id, nombre, apiKey, fuente, activa) VALUES ('CLINX0001', 'X', 'kx', 'pago', 1)").run();
    db.prepare("INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, clinicaId, estado) VALUES ('L1','KEY-L1','C','c@x.es','CLINX0001','expired')").run();
    revisarClinicas(db, { ahora: FIN, modo: 'aplicar' });   // la primera pasada pone en marcha su reloj
    const inf = revisarClinicas(db, { ahora: new Date(FIN.getTime() + 31 * DIA), modo: 'aplicar' });
    prueba(inf.borradas.some(d => d.clinicaId === 'CLINX0001'), 'el día 31 la clínica se borra del relay');
    const apunte = db.prepare("SELECT * FROM copias_por_borrar WHERE idClinica = 'CLINX0001'").get();
    prueba(apunte && apunte.prefijo === 'CLINX0001/', 'y su carpeta de copias queda apuntada (sobrevive al borrado)');
    prueba(apunte && apunte.borrarDesde === new Date(FIN.getTime() + 90 * DIA).toISOString(), 'para borrarla 90 días después del fin del servicio');

    const llamadas = [];
    const borrar = async (p) => { llamadas.push(p); return { ficheros: 3 }; };
    let c = await copias.procesarPendientes(db, { ahora: new Date(FIN.getTime() + 89 * DIA), modo: 'aplicar', borrar });
    prueba(c.vencidas.length === 0 && llamadas.length === 0, 'el día 89 no se toca nada');
    c = await copias.procesarPendientes(db, { ahora: new Date(FIN.getTime() + 91 * DIA), modo: 'ensayo', borrar });
    prueba(c.vencidas.includes('CLINX0001') && llamadas.length === 0, 'el día 91, en ENSAYO, solo se cuenta');

    db.prepare("INSERT INTO clinicas (id, nombre, apiKey, fuente, activa) VALUES ('CLINX0001', 'X', 'kx2', 'pago', 1)").run();
    c = await copias.procesarPendientes(db, { ahora: new Date(FIN.getTime() + 91 * DIA), modo: 'aplicar', borrar });
    prueba(llamadas.length === 0 && c.errores.length === 1, 'si la clínica vuelve a existir, NO se borra');
    db.prepare("DELETE FROM clinicas WHERE id = 'CLINX0001'").run();

    c = await copias.procesarPendientes(db, { ahora: new Date(FIN.getTime() + 91 * DIA), modo: 'aplicar', borrar });
    prueba(llamadas.length === 1 && llamadas[0] === 'CLINX0001/', 'el día 91, aplicando, se borra su carpeta');
    const tras = db.prepare("SELECT * FROM copias_por_borrar WHERE idClinica = 'CLINX0001'").get();
    prueba(tras.borradaEn && tras.ficheros === 3, 'y queda constancia de cuándo y cuántos ficheros');
    c = await copias.procesarPendientes(db, { ahora: new Date(FIN.getTime() + 92 * DIA), modo: 'aplicar', borrar });
    prueba(llamadas.length === 1, 'una vez borrada, no se vuelve a intentar');
  } catch (e) {
    fallos++; console.error('💥', e);
  }
  console.log(`\n${ok} pasados, ${fallos} fallados`);
  try { db.close(); fs.unlinkSync(TMP); } catch {}
  setTimeout(() => process.exit(fallos ? 1 : 0), 200);
})();
