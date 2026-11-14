/**
 * M3U / M3U8 / plain-text IPTV playlist parser.
 * Pure JS (no DOM), works both in browser and Node.
 *
 * Supports:
 *  - #EXTM3U with url-tvg / x-tvg-url
 *  - #EXTINF attributes: tvg-id, tvg-name, tvg-logo, group-title, tvg-chno, radio
 *  - #EXTGRP
 *  - #EXTVLCOPT (user-agent, referer)
 *  - plain text lists (one stream URL per line)
 */

const ATTR_RE = /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g;
const NO_GROUP = 'Без группы';

export const DEMO_CHANNELS = [
  { name: 'Red Bull TV', group: 'Спорт', url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8' },
  { name: 'Tagesschau', group: 'Новости', url: 'https://tagesschau.akamaized.net/hls/live/2020115/tagesschau/tagesschau_1/master.m3u8' },
  { name: 'Big Buck Bunny', group: 'Тест', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'Apple BipBop', group: 'Тест', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
  { name: 'Tears of Steel', group: 'Тест', url: 'https://test-streams.mux.dev/tos_ismc/main.m3u8' },
  { name: 'PTS Demo', group: 'Тест', url: 'https://test-streams.mux.dev/pts_shift/master.m3u8' },
];

function parseAttrs(str) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(str))) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** Find first comma that is not inside double quotes. */
function findNameComma(str) {
  let quoted = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) return i;
  }
  return -1;
}

function cleanName(str) {
  if (!str) return '';
  let value = String(str).replace(/\s+/g, ' ').trim();
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function splitEpgUrls(value) {
  if (!value) return [];
  return value
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(seg).replace(/\.(m3u8?|ts|mp4|mkv|aac|mp3)$/i, '') || u.hostname;
  } catch {
    return 'Канал';
  }
}

/**
 * @param {string} text playlist body
 * @param {{ baseUrl?: string }} [options]
 * @returns {{ channels: Array, epgUrls: string[], isHlsManifest: boolean }}
 */
export function parsePlaylist(text, options = {}) {
  const baseUrl = options.baseUrl || undefined;
  const channels = [];
  const epgUrls = [];
  const seen = new Set();
  let pending = null;
  let vlc = null;
  let groupHint = null;
  let isHlsManifest = false;

  const source = String(text || '').replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/);
  let index = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^#EXTM3U/i.test(line)) {
      const attrs = parseAttrs(line);
      epgUrls.push(...splitEpgUrls(attrs['x-tvg-url']), ...splitEpgUrls(attrs['url-tvg']), ...splitEpgUrls(attrs['tvg-url']));
      continue;
    }

    if (/^#EXT-X-/i.test(line)) {
      isHlsManifest = true;
      continue;
    }

    if (/^#EXTINF:/i.test(line)) {
      const body = line.slice(line.indexOf(':') + 1);
      const comma = findNameComma(body);
      const meta = comma === -1 ? body : body.slice(0, comma);
      const attrs = parseAttrs(meta);
      const rawName = comma === -1 ? '' : body.slice(comma + 1);
      const duration = parseFloat(meta.trim().split(/\s+/)[0]);

      pending = {
        name: cleanName(rawName) || cleanName(attrs['tvg-name']) || '',
        logo: (attrs['tvg-logo'] || attrs['logo'] || '').trim(),
        group: cleanName(attrs['group-title']),
        tvgId: (attrs['tvg-id'] || '').trim(),
        tvgName: cleanName(attrs['tvg-name']),
        number: Number.parseInt(attrs['tvg-chno'] || attrs['channel-number'] || '', 10) || 0,
        duration: Number.isFinite(duration) ? duration : -1,
        radio: String(attrs.radio || '').trim().toLowerCase() === 'true',
      };
      vlc = null;
      continue;
    }

    if (/^#EXTGRP:/i.test(line)) {
      groupHint = cleanName(line.slice(line.indexOf(':') + 1));
      continue;
    }

    if (/^#EXTVLCOPT:/i.test(line)) {
      const opt = line.slice(line.indexOf(':') + 1);
      const eq = opt.indexOf('=');
      if (eq > 0 && pending) {
        const key = opt.slice(0, eq).trim().toLowerCase();
        const value = opt.slice(eq + 1).trim();
        vlc = vlc || {};
        if (key === 'http-user-agent') vlc.userAgent = value;
        if (key === 'http-referrer' || key === 'http-referer') vlc.referer = value;
      }
      continue;
    }

    if (line.startsWith('#')) continue;

    // A stream URL line (absolute, or relative when a playlist base URL is known).
    let url = line;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
      if (!baseUrl || /\s/.test(line)) continue;
      try {
        url = new URL(line, baseUrl).href;
      } catch {
        continue;
      }
    }
    const name = pending?.name || nameFromUrl(url);
    const group = pending?.group || groupHint || NO_GROUP;
    const key = `${name}::${url}`;
    if (seen.has(key)) {
      pending = null;
      continue;
    }
    seen.add(key);

    channels.push({
      id: `ch${++index}`,
      index: index - 1,
      name,
      url,
      logo: pending?.logo || '',
      group,
      tvgId: pending?.tvgId || '',
      tvgName: pending?.tvgName || '',
      number: pending?.number || 0,
      radio: pending?.radio || false,
      opts: vlc ? { ...vlc } : null,
    });

    pending = null;
    groupHint = null;
    vlc = null;
  }

  return {
    channels,
    epgUrls: [...new Set(epgUrls)],
    isHlsManifest: isHlsManifest && channels.length === 0,
  };
}

export function buildXtreamUrl(host, username, password, output = 'm3u8') {
  let base = String(host || '').trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) base = `http://${base}`;
  const q = new URLSearchParams({
    username,
    password,
    type: 'm3u_plus',
    output,
  });
  return `${base}/get.php?${q.toString()}`;
}

export function channelKey(sourceId, channel) {
  return `${sourceId}::${channel.url}`;
}

export function channelSnapshot(sourceId, channel) {
  return {
    key: channelKey(sourceId, channel),
    sourceId,
    name: channel.name,
    url: channel.url,
    logo: channel.logo,
    group: channel.group,
    tvgId: channel.tvgId,
    tvgName: channel.tvgName,
    radio: channel.radio === true,
    opts: channel.opts || null,
  };
}

export function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}