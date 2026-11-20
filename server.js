/**
 * Servidor HTTP para El Maná Market con soporte nativo de la API Tasa BCV.
 * No requiere librerías externas (usa módulos nativos de Node.js).
 * 
 * Inicia la sincronización automática horaria de la tasa BCV (misma lógica que e-commerce).
 * Expone:
 *   - GET /api/bcv          -> Tasa oficial BCV (última publicada)
 *   - GET /api/bcv-estado   -> Diagnóstico de lectura del BCV
 *   - Archivos estáticos    -> index.html, consultasojancwioawmncmaw.html, imagen/, tasas/, etc.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const tasaBCV = require('./lib/tasa-bcv');

const PORT = parseInt(process.env.PORT, 10) || 8085;
const HOST = process.env.HOST || '0.0.0.0';
const RAIZ = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// Iniciar consulta periódica de la tasa BCV
tasaBCV.iniciar();

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let ruta = decodeURIComponent(urlObj.pathname);

  // Headers de CORS estándar
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // API Tasa BCV (misma respuesta que e-commerce)
  if (ruta === '/api/bcv') {
    let tasa = tasaBCV.tasaActiva();
    if (!tasa) {
      await tasaBCV.actualizar();
      tasa = tasaBCV.tasaActiva();
    }
    if (!tasa) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: false, message: 'Tasa no disponible' }));
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    });
    return res.end(JSON.stringify({
      success: true,
      rate: tasa.usd,
      promedio: tasa.usd,
      fecha: `${tasa.fechaValor}T00:00:00-04:00`,
      fechaActualizacion: `${tasa.fechaValor}T00:00:00-04:00`,
      fechaValor: tasa.fechaValor,
      fechaValorTexto: tasa.texto || '',
      fuente: tasa.fuente === 'bcv' ? 'BCV' : 'respaldo'
    }));
  }

  // API Diagnóstico
  if (ruta === '/api/bcv-estado') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ success: true, ...tasaBCV.salud() }));
  }

  // Servir archivos estáticos
  if (ruta === '/' || ruta === '') {
    ruta = '/index.html';
  }

  const archivoSeguro = path.normalize(path.join(RAIZ, ruta));
  if (!archivoSeguro.startsWith(RAIZ)) {
    res.writeHead(403);
    return res.end('Acceso denegado');
  }

  fs.stat(archivoSeguro, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 No Encontrado');
    }

    const ext = path.extname(archivoSeguro).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // No cachear HTML ni JSON de tasas agresivamente
    if (ext === '.html' || ruta.includes('tasas/')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(archivoSeguro).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mana-market] Servidor activo en http://${HOST}:${PORT}`);
});
