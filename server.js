/**
 * Local web server for IPTV Player.
 *
 * - serves the static UI
 * - /api/ping            → health probe
 * - /api/fetch?url=...   → downloads a playlist/EPG (no CORS, gzip aware)
 * - /api/proxy?url=...   → media proxy with HLS manifest URL rewriting
 *
 * Used both by `node server.js` (browser mode) and by the Electron shell.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m3u': 'audio/x-mpegurl',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,HEAD,OPTIONS',
};

const FFMPEG_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const activeChildren = new Set();
let ffmpegPathCache;

function findFfmpeg() {
  if (ffmpegPathCache !== undefined) return ffmpegPathCache;

  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(ROOT, 'bin', FFMPEG_NAME),
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', FFMPEG_NAME) : '',
  ].filter(Boolean);

  ffmpegPathCache = '';
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        ffmpegPathCache = candidate;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  return ffmpegPathCache;
}

function transcodeArgs(target, { ua, ref }) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning'];

  if (target.startsWith('http')) {
    args.push(
      '-user_agent', ua || DEFAULT_UA,
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    );
    if (ref) args.push('-headers', `Referer: ${ref}\r\n`);
  }

  args.push(
    '-probesize', '1000000',
    '-analyzeduration', '3000000',
    '-re',
    '-i', target,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-vf', "scale=-2:'min(720,ih)'",
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-b:v', '2500k',
    '-maxrate', '3000k',
    '-bufsize', '6000k',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '44100',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-f', 'mpegts',
    'pipe:1'
  );

  return args;
}

async function handleTranscode(req, res, search) {
  const rawTarget = search.get('url');
  if (!rawTarget || !isHttpUrl(rawTarget)) return sendJson(res, 400, { error: 'bad url' });

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    return sendJson(res, 503, {
      error: 'ffmpeg не найден',
      hint: 'Положите ffmpeg.exe в папку bin рядом с программой',
    });
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, { ...CORS, 'content-type': 'video/mp2t', 'cache-control': 'no-store' });
    res.end();
    return;
  }

  const target = prepareTarget(rawTarget);
  const args = transcodeArgs(target.url, {
    ua: search.get('ua') || '',
    ref: search.get('ref') || '',
  });

  let child;
  try {
    child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  } catch (err) {
    return sendJson(res, 502, { error: err.message });
  }

  activeChildren.add(child);

  let started = false;
  let stderr = '';
  const cleanup = () => {
    activeChildren.delete(child);
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };

  const startupTimer = setTimeout(() => {
    if (started) return;
    cleanup();
    if (!res.headersSent) {
      sendJson(res, 504, { error: 'ffmpeg не успел начать перекодирование', details: stderr.slice(-800) });
    }
  }, 25000);

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  child.stdout.once('data', (chunk) => {
    started = true;
    clearTimeout(startupTimer);
    res.writeHead(200, {
      ...CORS,
      'content-type': 'video/mp2t',
      'cache-control': 'no-store',
      'x-transcoded': '1',
    });
    res.write(chunk);
    child.stdout.pipe(res);
  });

  child.on('error', (err) => {
    clearTimeout(startupTimer);
    activeChildren.delete(child);
    if (!started && !res.headersSent) {
      sendJson(res, 502, { error: `ffmpeg: ${err.message}` });
    } else {
      res.destroy();
    }
  });

  child.on('close', (code) => {
    clearTimeout(startupTimer);
    activeChildren.delete(child);
    if (!started && !res.headersSent) {
      sendJson(res, 502, {
        error: `ffmpeg завершился с кодом ${code}`,
        details: stderr.slice(-800),
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  const abort = () => {
    cleanup();
  };
  req.on('close', abort);
  res.on('close', abort);
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function upstreamHeaders(search, extra = {}) {
  const ua = search.get('ua') || DEFAULT_UA;
  const ref = search.get('ref');
  const headers = {
    'user-agent': ua,
    accept: '*/*',
    'accept-language': 'ru,en;q=0.8',
    ...extra,
  };
  if (ref) headers.referer = ref;
  return headers;
}

/** Move user:pass@ from the URL into a Basic Authorization header. */
function prepareTarget(target) {
  try {
    const u = new URL(target);
    if (u.username || u.password) {
      const user = decodeURIComponent(u.username);
      const pass = decodeURIComponent(u.password);
      const authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      u.username = '';
      u.password = '';
      return { url: u.href, authorization };
    }
  } catch {
    /* ignore */
  }
  return { url: target, authorization: '' };
}

async function handleFetch(req, res, search) {
  const rawTarget = search.get('url');
  if (!rawTarget || !isHttpUrl(rawTarget)) return sendJson(res, 400, { error: 'bad url' });
  const target = prepareTarget(rawTarget);

  const timeout = AbortSignal.timeout(60000);
  const upstream = await fetch(target.url, {
    headers: upstreamHeaders(search, target.authorization ? { authorization: target.authorization } : {}),
    redirect: 'follow',
    signal: timeout,
  });

  const raw = Buffer.from(await upstream.arrayBuffer());
  let body = raw;
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      body = zlib.gunzipSync(raw);
    } catch {
      body = raw;
    }
  }

  res.writeHead(upstream.status, {
    ...CORS,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-final-url': upstream.url || target.url,
  });
  res.end(body);
}

function proxyHref(absUrl, params) {
  const search = new URLSearchParams({ url: absUrl });
  if (params.ua) search.set('ua', params.ua);
  if (params.ref) search.set('ref', params.ref);
  return `/api/proxy?${search.toString()}`;
}

function rewriteManifest(text, baseUrl, params) {
  const wrap = (value) => {
    const v = String(value || '').trim();
    if (!v || /^(data|blob|about|javascript):/i.test(v)) return v;
    try {
      return proxyHref(new URL(v, baseUrl).href, params);
    } catch {
      return v;
    }
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (trimmed.includes('URI="')) return line.replace(/URI="([^"]*)"/g, (_m, uri) => `URI="${wrap(uri)}"`);
        return line;
      }
      return wrap(trimmed);
    })
    .join('\n');
}

async function handleProxy(req, res, search) {
  const rawTarget = search.get('url');
  if (!rawTarget || !isHttpUrl(rawTarget)) return sendJson(res, 400, { error: 'bad url' });
  const target = prepareTarget(rawTarget);

  const params = { ua: search.get('ua') || '', ref: search.get('ref') || '' };
  const headers = upstreamHeaders(
    search,
    target.authorization ? { authorization: target.authorization } : {}
  );
  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers['if-none-match']) headers['if-none-match'] = req.headers['if-none-match'];

  const upstream = await fetch(target.url, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(45000),
  });

  const contentType = upstream.headers.get('content-type') || '';
  const looksPlaylist = /mpegurl/i.test(contentType) || /\.m3u8?($|[?#])/i.test(target.url);

  if (looksPlaylist && upstream.status !== 206) {
    const text = await upstream.text();
    const finalUrl = upstream.url || target.url;
    const body = rewriteManifest(text, finalUrl, params);
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(upstream.status, {
      ...CORS,
      'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return;
  }

  const out = {
    ...CORS,
    'content-type': contentType || 'application/octet-stream',
    'cache-control': 'no-store',
    'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
  };
  for (const name of ['content-range', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }

  res.writeHead(upstream.status, out);
  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function handleProbe(req, res, search) {
  const rawTarget = search.get('url');
  if (!rawTarget || !isHttpUrl(rawTarget)) return sendJson(res, 400, { error: 'bad url' });
  const target = prepareTarget(rawTarget);

  try {
    const auth = target.authorization ? { authorization: target.authorization } : {};
    const upstream = await fetch(target.url, {
      headers: upstreamHeaders(search, { range: 'bytes=0-65535', ...auth }),
      redirect: 'follow',
      signal: AbortSignal.timeout(9000),
    });

    const contentType = upstream.headers.get('content-type') || '';
    let head = Buffer.alloc(0);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (total < 65536) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
          total += value.length;
          if (total >= 65536) break;
        }
      } catch {
        /* ignore body errors */
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      head = Buffer.concat(chunks).subarray(0, 8192);
    }

    sendJson(res, 200, {
      status: upstream.status,
      contentType,
      finalUrl: upstream.url || target.url,
      kind: detectKind(contentType, head, upstream.url || target.url),
    });
  } catch (err) {
    sendJson(res, 200, { status: 0, contentType: '', kind: 'unknown', error: err.message });
  }
}

function detectKind(contentType, head, url) {
  const ct = String(contentType || '').toLowerCase();
  const urlStr = String(url || '');
  const text = Buffer.isBuffer(head) ? head.toString('latin1') : '';

  if (/mpegurl/.test(ct)) return 'hls';
  if (text.startsWith('#EXTM3U') || text.startsWith('\uFEFF#EXTM3U') || text.includes('#EXT-X-')) return 'hls';
  if (/mp2t|mpeg-ts/.test(ct)) return 'ts';
  if (Buffer.isBuffer(head) && head.length > 0 && head[0] === 0x47 && (head.length < 189 || head[188] === 0x47)) return 'ts';
  if (/mp4|webm|ogg|quicktime/.test(ct)) return 'mp4';
  if (text.slice(4, 8) === 'ftyp') return 'mp4';
  if (/\.m3u8($|[?#])/i.test(urlStr) || /[?&](output|format)=m3u8/i.test(urlStr)) return 'hls';
  if (/\.(ts|m2ts|flv)($|[?#])/i.test(urlStr)) return 'ts';
  if (/\.(mp4|webm|ogg|mov|m4v)($|[?#])/i.test(urlStr)) return 'mp4';
  return 'unknown';
}

async function handleStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (!rel || rel === '/') rel = '/index.html';
  const target = path.resolve(ROOT, `.${path.posix.normalize(rel)}`);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }

  let file = target;
  if (stat.isDirectory()) {
    file = path.join(target, 'index.html');
    try {
      stat = await fsp.stat(file);
    } catch {
      res.writeHead(404).end('Not found');
      return;
    }
  }

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  const route = async () => {
    if (url.pathname === '/api/ping') {
      sendJson(res, 200, { ok: true, app: 'iptv-player', transcode: Boolean(findFfmpeg()) });
      return;
    }
    if (url.pathname === '/api/fetch') {
      await handleFetch(req, res, url.searchParams);
      return;
    }
    if (url.pathname === '/api/proxy') {
      await handleProxy(req, res, url.searchParams);
      return;
    }
    if (url.pathname === '/api/probe') {
      await handleProbe(req, res, url.searchParams);
      return;
    }
    if (url.pathname === '/api/transcode') {
      await handleTranscode(req, res, url.searchParams);
      return;
    }
    await handleStatic(req, res, url.pathname);
  };

  route().catch((err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const message = err?.name === 'TimeoutError' ? 'Upstream timeout' : err?.message || 'Proxy error';
    sendJson(res, 502, { error: message });
  });
}

export function createAppServer() {
  const server = http.createServer(handler);
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.on('close', () => {
    for (const child of activeChildren) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    activeChildren.clear();
  });
  return server;
}

export function startAppServer({ port = 8787, host = '127.0.0.1', tries = 12 } = {}) {
  return new Promise((resolve, reject) => {
    const server = createAppServer();
    let attempt = 0;

    const listen = (tryPort) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < tries) {
          attempt += 1;
          listen(tryPort + 1);
          return;
        }
        reject(err);
      });
      server.listen(tryPort, host, () => {
        const address = server.address();
        resolve({
          server,
          port: address.port,
          url: `http://${host}:${address.port}`,
        });
      });
    };

    listen(port);
  });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const port = Number(process.env.PORT) || 8787;
  startAppServer({ port })
    .then(({ url }) => {
      console.log(`\n  IPTV Player запущен: ${url}\n  Автор: DeepSeek 4.1 Flash & user2168\n  Остановить: Ctrl+C\n`);
    })
    .catch((err) => {
      console.error('Не удалось запустить сервер:', err.message);
      process.exit(1);
    });
}