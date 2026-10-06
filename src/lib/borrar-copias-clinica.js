'use strict';
/**
 * borrar-copias-clinica.js — Las copias en la nube de una clínica dada de baja, fuera a los 90 días.
 *
 * ── Por qué existe (06-10-2026) ──────────────────────────────────────────────
 *
 * El Anexo C (contrato de encargado) promete suprimir las copias de seguridad de la clínica en un
 * plazo máximo de 90 días desde la terminación. Hasta hoy, la limpieza solo REVOCABA su clave el
 * día 30: los ficheros se quedaban en Backblaze para siempre.
 *
 * ── Cómo, y por qué así ──────────────────────────────────────────────────────
 *
 *   · El día 30 la limpieza borra la clínica del relay. Para que el día 90 se sepa de quién eran las
 *     copias, antes apunta su carpeta en `copias_por_borrar` (columna `idClinica`, NO `clinicaId`:
 *     la limpieza borra de todas las tablas con `clinicaId`, y se llevaría el apunte en el acto).
 *   · El día 90, la clave GESTORA (que solo crea y borra claves; no puede tocar ficheros) crea una
 *     clave TEMPORAL limitada por Backblaze a `<clinicaId>/` y de una hora de vida, borra con ella
 *     todas las versiones de esa carpeta y la elimina.
 *   · Tres seguros: la carpeta tiene que tener forma de carpeta de clínica (y nunca `relay/`, la de
 *     las copias del propio relay); Backblaze no deja a la clave temporal salir de esa carpeta; y
 *     cada fichero se comprueba otra vez antes de borrarlo.
 */

const { configuracion, gestor } = require('./claves-copia');

const PREFIJO_VALIDO = /^[A-Za-z0-9_-]{4,40}\/$/;

function prefijoSeguro(prefijo) {
  return PREFIJO_VALIDO.test(String(prefijo || '')) && prefijo !== 'relay/';
}

/** Borra todas las versiones de `prefijo`. Devuelve `{ ficheros }`; lanza si algo falla. */
async function borrarCopiasDeClinica(prefijo, { env = process.env, fetchImpl = fetch } = {}) {
  if (!prefijoSeguro(prefijo)) throw new Error('carpeta no válida: ' + prefijo);
  const cfg = configuracion(env);
  if (cfg.faltan.length) throw new Error('Sin configurar en el servidor: ' + cfg.faltan.join(', '));

  const g = await gestor(cfg, fetchImpl);
  const k = await g.api('b2_create_key', {
    accountId: g.accountId,
    capabilities: ['listBuckets', 'listFiles', 'deleteFiles'],
    keyName: ('borrar-' + prefijo.slice(0, -1)).replace(/[^A-Za-z0-9-]/g, '-').slice(0, 100),
    bucketId: cfg.bucketId,
    namePrefix: prefijo,
    validDurationInSeconds: 3600,
  });
  if (!k || !k.applicationKeyId || !k.applicationKey) throw new Error('Backblaze no devolvió la clave temporal');

  let ficheros = 0;
  try {
    const t = await gestor({ keyId: k.applicationKeyId, appKey: k.applicationKey }, fetchImpl);
    let startFileName = null, startFileId = null;
    for (let vuelta = 0; vuelta < 10000; vuelta++) {
      const lista = await t.api('b2_list_file_versions', {
        bucketId: cfg.bucketId, prefix: prefijo, maxFileCount: 1000,
        ...(startFileName ? { startFileName, startFileId } : {}),
      });
      for (const f of (lista.files || [])) {
        if (!String(f.fileName || '').startsWith(prefijo)) {
          throw new Error('Backblaze devolvió un fichero fuera de la carpeta: ' + f.fileName);
        }
        await t.api('b2_delete_file_version', { fileName: f.fileName, fileId: f.fileId });
        ficheros++;
      }
      if (!lista.nextFileName) break;
      startFileName = lista.nextFileName; startFileId = lista.nextFileId;
    }
  } finally {
    await g.api('b2_delete_key', { applicationKeyId: k.applicationKeyId }).catch(() => {});
  }
  return { ficheros };
}

function asegurarTabla(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS copias_por_borrar (
    idClinica    TEXT PRIMARY KEY,
    prefijo      TEXT NOT NULL,
    finServicio  TEXT NOT NULL,
    borrarDesde  TEXT NOT NULL,
    apuntadaEn   TEXT NOT NULL,
    borradaEn    TEXT,
    ficheros     INTEGER,
    ultimoError  TEXT
  )`);
}

/**
 * Las que ya han cumplido su plazo. En ensayo solo las cuenta. No lanza: devuelve el informe.
 * `borrar` se inyecta en las pruebas.
 */
async function procesarPendientes(db, { ahora = new Date(), modo = process.env.LIMPIEZA_MODO,
                                        borrar = borrarCopiasDeClinica } = {}) {
  asegurarTabla(db);
  const informe = { modo: modo === 'aplicar' ? 'aplicar' : 'ensayo', vencidas: [], borradas: [], errores: [] };
  const filas = db.prepare('SELECT * FROM copias_por_borrar WHERE borradaEn IS NULL AND borrarDesde <= ?')
    .all(ahora.toISOString());
  for (const f of filas) {
    // Si esa clínica vuelve a existir, o algo vivo apunta a ella, no se toca.
    const viva = db.prepare('SELECT 1 FROM clinicas WHERE id = ?').get(f.idClinica) ||
      db.prepare("SELECT 1 FROM licencias WHERE clinicaId = ? AND LOWER(COALESCE(estado,'')) NOT IN ('expired','revoked','revocada','cancelada','cancelled')").get(f.idClinica);
    if (viva) { informe.errores.push({ idClinica: f.idClinica, error: 'la clínica vuelve a estar viva: no se borra' }); continue; }
    informe.vencidas.push(f.idClinica);
    if (informe.modo !== 'aplicar') continue;
    try {
      const r = await borrar(f.prefijo);
      db.prepare('UPDATE copias_por_borrar SET borradaEn = ?, ficheros = ?, ultimoError = NULL WHERE idClinica = ?')
        .run(ahora.toISOString(), r.ficheros, f.idClinica);
      informe.borradas.push({ idClinica: f.idClinica, ficheros: r.ficheros });
    } catch (e) {
      db.prepare('UPDATE copias_por_borrar SET ultimoError = ? WHERE idClinica = ?').run(e.message, f.idClinica);
      informe.errores.push({ idClinica: f.idClinica, error: e.message });
    }
  }
  return informe;
}

module.exports = { borrarCopiasDeClinica, procesarPendientes, asegurarTabla, prefijoSeguro };
