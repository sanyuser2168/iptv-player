/**
 * Networking helpers.
 * When the app is served by server.js, all remote requests go through the
 * local proxy (/api/fetch, /api/proxy) which removes CORS limitations.
 */

const HAS_DOM = typeof window !== 'undefined';

let viaServer = false;
let transcodeAvailable = false;

export function setViaServer(value) {
  viaServer = Boolean(value);
}

export function isViaServer() {
  return viaServer;
}

export function canTranscode() {
  return viaServer && transcodeAvailable;
}

export function apiUrl(path, params = {}) {
  const url = new URL(`./api/${path}`, HAS_DOM ? window.location.href : 'http://localhost/');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  return url.href;
}

export function streamUrl(url, opts = {}) {
  if (!viaServer) return url;
  return apiUrl('proxy', { url, ua: opts.userAgent, ref: opts.referer });
}

/** On-the-fly ffmpeg transcode endpoint (used when the codec is unsupported). */
export function transcodeUrl(url, opts = {}) {
  return apiUrl('transcode', { url, ua: opts.userAgent, ref: opts.referer });
}

export async function detectServer() {
  if (!HAS_DOM || window.location.protocol === 'file:') {
    setViaServer(false);
    return false;
  }
  try {
    const res = await fetch(apiUrl('ping'), { cache: 'no-store' });
    if (!res.ok) throw new Error('no server');
    const data = await res.json();
    setViaServer(data && data.ok === true);
    transcodeAvailable = Boolean(data && data.transcode);
  } catch {
    setViaServer(false);
    transcodeAvailable = false;
  }
  return viaServer;
}

function decode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1251').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

async function gunzipIfNeeded(bytes) {
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'function') {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        /* fall through */
      }
    }
  }
  return bytes;
}

/**
 * Fetch a text resource (playlist / EPG) and decode it.
 * @returns {Promise<{ text: string, finalUrl: string }>}
 */
export async function fetchTextSmart(url) {
  const target = viaServer ? apiUrl('fetch', { url }) : url;
  const res = await fetch(target, { cache: 'no-store', redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  }
  const raw = new Uint8Array(await res.arrayBuffer());
  const bytes = await gunzipIfNeeded(raw);
  const text = decode(bytes);
  let finalUrl = url;
  if (viaServer) {
    finalUrl = res.headers.get('x-final-url') || url;
  } else {
    finalUrl = res.url || url;
  }
  return { text, finalUrl };
}

const probeCache = new Map();

/** Guess the stream format from the URL only. */
export function formatHint(url) {
  if (/\.m3u8($|[?#])/i.test(url) || /[?&](output|format)=m3u8/i.test(url)) return 'hls';
  if (/\.(mp4|webm|ogg|ogv|mov|m4v)($|[?#])/i.test(url)) return 'mp4';
  if (/\.(ts|m2ts|flv)($|[?#])/i.test(url)) return 'ts';
  return '';
}

/**
 * Ask the local server to inspect the first bytes of a stream.
 * @returns {Promise<{status:number, contentType:string, kind:string}|null>}
 */
export async function probeStream(url, opts = {}) {
  if (!viaServer) return null;

  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.at < 120000) return cached.value;

  try {
    const res = await fetch(
      apiUrl('probe', { url, ua: opts.userAgent, ref: opts.referer }),
      { cache: 'no-store', signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.status !== 'number') return null;
    if (probeCache.size > 300) probeCache.clear();
    probeCache.set(url, { at: Date.now(), value: data });
    return data;
  } catch {
    return null;
  }
}