/**
 * Tasa oficial del dólar BCV — misma lógica que "Omega API dólar"
 * (carpeta `omega api $`: tasas_bcv.py + servidor_tasas.py), llevada a Node
 * para no tener un servicio aparte en el VPS.
 *
 * - Lee la página oficial del BCV (www.bcv.org.ve): tasa del dólar y su "Fecha Valor".
 * - Usa la tasa vigente entre semana y la última publicada el fin de semana.
 * - Consulta al BCV cada hora y guarda un historial en `tasa-bcv.json`. Si el BCV
 *   no responde o reinicia el servidor, sigue usando la última tasa buena.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

const URL_BCV = 'https://www.bcv.org.ve/';

// ---------------------------------------------------------------------------
// Certificado del BCV: su servidor envía un certificado intermedio equivocado,
// así que en Linux (el VPS) la conexión se rechaza ("unable to verify the first
// certificate").
// Windows lo resuelve solo; aquí se completa la cadena con el intermedio oficial
// (lib/certs/*.pem). La verificación se hace completa: nada se desactiva.
// Si el BCV cambiara de certificado, el intermedio nuevo se descarga solo de la
// dirección que indica su propio certificado, y solo se acepta si lo firmó una
// autoridad raíz de confianza.
// ---------------------------------------------------------------------------
const DIR_CERTS = path.join(__dirname, 'certs');
const intermedios = [];
try {
  for (const f of fs.readdirSync(DIR_CERTS)) {
    if (f.endsWith('.pem')) intermedios.push(fs.readFileSync(path.join(DIR_CERTS, f), 'utf8'));
  }
} catch { /* sin carpeta de certificados */ }
const raices = tls.rootCertificates.map(p => new crypto.X509Certificate(p));
const ERRORES_CADENA = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);

function autoridades() {
  return [...tls.rootCertificates, ...intermedios];
}

/** Descarga una página HTTPS verificando el certificado con las autoridades de arriba. */
function descargar(url, { timeout = 30000, max = 3 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca: autoridades(), headers: { 'User-Agent': 'Mozilla/5.0' }, timeout }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`el BCV respondió ${res.statusCode}`)); }
      const partes = [];
      let total = 0;
      res.on('data', d => {
        total += d.length;
        if (total > max) { req.destroy(new Error('respuesta demasiado grande')); return; }
        partes.push(d);
      });
      res.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('tiempo de espera agotado')));
    req.on('error', reject);
  });
}

/** Lee el certificado del sitio (solo para saber de dónde bajar su intermedio). */
function certificadoDelSitio(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 15000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c && c.raw ? { x509: new crypto.X509Certificate(c.raw), aia: (c.infoAccess || {})['CA Issuers - URI'] || [] } : null);
    });
    s.on('timeout', () => s.destroy(new Error('tiempo de espera agotado')));
    s.on('error', reject);
  });
}

function bajarHttp(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 15000 }, res => {
      const partes = [];
      let total = 0;
      res.on('data', d => { total += d.length; if (total > 64 * 1024) req.destroy(new Error('archivo demasiado grande')); else partes.push(d); });
      res.on('end', () => resolve(Buffer.concat(partes)));
    });
    req.on('timeout', () => req.destroy(new Error('tiempo de espera agotado')));
    req.on('error', reject);
  });
}

/** Descarga el intermedio que falta y lo agrega si es legítimo. true si agregó alguno. */
async function completarCadena(host) {
  const sitio = await certificadoDelSitio(host);
  if (!sitio) return false;
  for (const url of sitio.aia) {
    if (!/^http:\/\/[a-z0-9.-]+\/[\w./-]+\.(crt|cer|der)$/i.test(url)) continue;
    try {
      const inter = new crypto.X509Certificate(await bajarHttp(url));
      const firmaElSitio = sitio.x509.checkIssued(inter) && sitio.x509.verify(inter.publicKey);
      const raizConfiable = raices.some(r => inter.checkIssued(r) && inter.verify(r.publicKey));
      if (inter.ca && firmaElSitio && raizConfiable) {
        const pem = inter.toString();
        if (!intermedios.includes(pem)) intermedios.push(pem);
        console.log(`[bcv] Se agregó el certificado intermedio: ${inter.subject.split('\n').pop()}`);
        return true;
      }
    } catch { /* se prueba la siguiente dirección */ }
  }
  return false;
}

async function descargarBCV() {
  try {
    return await descargar(URL_BCV);
  } catch (err) {
    if (!ERRORES_CADENA.has(err.code)) throw err;
    if (!(await completarCadena(new URL(URL_BCV).hostname))) throw err;
    return descargar(URL_BCV);
  }
}
const ARCHIVO = path.join(__dirname, '..', 'tasa-bcv.json');
const ARCHIVO_DOLAR = path.join(__dirname, '..', 'tasas', 'dolar.json');
const INTERVALO_MS = Math.max(15, parseInt(process.env.BCV_INTERVALO_MIN, 10) || 60) * 60 * 1000;
const MAX_HISTORIAL = 90; // días guardados

const estado = {
  historial: {},          // "AAAA-MM-DD" (fecha valor) -> { usd, fuente }
  ultimaConsulta: null,   // último intento
  ultimoExito: null,      // última lectura buena del BCV
  ultimoError: null
};

// ---------------------------------------------------------------------------
// Lectura de la página del BCV (equivale a tasas_bcv.py)
// ---------------------------------------------------------------------------
/** '1.010,56078251' (formato venezolano) -> 1010.56078251 */
function aNumero(texto) {
  return parseFloat(String(texto).trim().replace(/\./g, '').replace(',', '.'));
}

async function leerBCV() {
  const html = await descargarBCV();

  const m = html.match(/<div id="dolar"[\s\S]*?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/);
  const usd = m ? aNumero(m[1]) : NaN;
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error('no se encontró la tasa del dólar (¿cambió la página del BCV?)');
  }
  const f = html.match(/Fecha Valor:\s*<span[^>]*content="([^"]+)"[^>]*>([^<]+)<\/span>/);
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f[1].slice(0, 10))) throw new Error('la página del BCV no mostró la fecha valor');
  return {
    fechaValor: f[1].slice(0, 10),
    fechaTexto: f[2].replace(/\s+/g, ' ').trim(),
    usd
  };
}

// ---------------------------------------------------------------------------
// Historial en disco y sincronización con tasas/dolar.json
// ---------------------------------------------------------------------------
let historialCargado = false;

function cargar() {
  if (historialCargado) return;
  historialCargado = true;
  try {
    const guardado = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
    if (guardado?.historial) {
      Object.assign(estado, guardado);
      estado.historial = Object.fromEntries(Object.entries(guardado.historial)
        .filter(([fecha, tasa]) => /^\d{4}-\d{2}-\d{2}$/.test(fecha) &&
          tasa?.fuente === 'bcv' && Number.isFinite(tasa.usd) && tasa.usd > 0));
    }
  } catch { /* primera vez: sin historial */ }
}

function sincronizarDolarJson() {
  try {
    const ult = tasaActiva();
    if (!ult) return;
    const dir = path.dirname(ARCHIVO_DOLAR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const salida = {
      moneda: "USD",
      fuente: 'oficial',
      nombre: "Dólar",
      compra: null,
      venta: null,
      promedio: ult.usd,
      rate: ult.usd,
      fechaActualizacion: `${ult.fechaValor}T00:00:00-04:00`,
      fechaValor: ult.fechaValor,
      fechaValorTexto: ult.texto || '',
      consultado: ahoraVenezuela(),
      tasas: {
        USD: ult.usd
      }
    };
    const tmp = `${ARCHIVO_DOLAR}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(salida, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, ARCHIVO_DOLAR);
  } catch (err) {
    console.warn('[bcv] No se pudo sincronizar tasas/dolar.json:', err.message);
  }
}

function guardar() {
  try {
    const tmp = `${ARCHIVO}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(estado, null, 2));
    fs.renameSync(tmp, ARCHIVO);
  } catch (err) {
    console.warn('[bcv] No se pudo guardar tasa-bcv.json:', err.message);
  }
  sincronizarDolarJson();
}

function ahoraVenezuela() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Caracas' }).replace(' ', 'T') + '-04:00';
}

// ---------------------------------------------------------------------------
// Actualización (equivale a actualizar() de servidor_tasas.py)
// ---------------------------------------------------------------------------
let enCurso = null;

async function actualizar() {
  if (enCurso) return enCurso;
  cargar();
  enCurso = (async () => {
    const ahora = ahoraVenezuela();
    let lectura = null;
    let error = null;
    try {
      lectura = await leerBCV();
    } catch (e) {
      error = `BCV: ${e.code ? `${e.message} (${e.code})` : e.message}`;
    }

    estado.ultimaConsulta = ahora;
    estado.ultimoError = error;
    if (lectura) {
      estado.historial[lectura.fechaValor] = { usd: lectura.usd, fuente: 'bcv', texto: lectura.fechaTexto || '' };
      estado.ultimoExito = ahora;
      for (const vieja of Object.keys(estado.historial).sort().slice(0, -MAX_HISTORIAL)) delete estado.historial[vieja];
    }
    guardar();
    if (error) console.warn(`[bcv] ${error}`);
    else console.log(`[bcv] Tasa ${lectura.usd} Bs./$ · fecha valor ${lectura.fechaValor}`);
  })().finally(() => { enCurso = null; });
  return enCurso;
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------
/** La más reciente que publicó el BCV (fin de semana: la del lunes). */
function ultimaPublicada() {
  const fechas = Object.keys(estado.historial).sort();
  if (!fechas.length) return null;
  const fecha = fechas[fechas.length - 1];
  return { fechaValor: fecha, ...estado.historial[fecha] };
}

/** La que tiene fecha valor de hoy o anterior (por si algún día se necesita). */
function vigenteHoy() {
  const hoy = ahoraVenezuela().slice(0, 10);
  const fechas = Object.keys(estado.historial).filter(f => f <= hoy).sort();
  if (!fechas.length) return null;
  const fecha = fechas[fechas.length - 1];
  return { fechaValor: fecha, ...estado.historial[fecha] };
}

/**
 * Tasa activa según la regla comercial:
 * - De lunes a viernes: la tasa del día (vigente hoy).
 * - Sábado y domingo: la tasa del lunes que viene (última publicada por el BCV).
 * - Lunes: se mantiene la tasa del lunes.
 */
function tasaActiva() {
  const hoy = ahoraVenezuela().slice(0, 10);
  const diaSemana = new Date(hoy).getUTCDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado

  // Sábado y Domingo: usar la tasa del lunes que viene (última publicada)
  if (diaSemana === 6 || diaSemana === 0) {
    return ultimaPublicada();
  }

  // De Lunes a Viernes: la tasa con fecha valor de hoy o más reciente hasta hoy
  const vigente = vigenteHoy();
  if (vigente) return vigente;

  return ultimaPublicada();
}

function salud() {
  return {
    ultimaConsulta: estado.ultimaConsulta,
    ultimoExitoBCV: estado.ultimoExito,
    ultimoError: estado.ultimoError,
    ultimaPublicada: ultimaPublicada(),
    vigenteHoy: vigenteHoy(),
    tasaActiva: tasaActiva()
  };
}

let iniciado = false;
/** Carga el historial y consulta al BCV ahora y cada hora. */
function iniciar() {
  if (iniciado) return;
  iniciado = true;
  actualizar();
  setInterval(actualizar, INTERVALO_MS).unref();
}

module.exports = { iniciar, actualizar, ultimaPublicada, vigenteHoy, tasaActiva, salud };
