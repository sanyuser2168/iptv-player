/**
 * XMLTV (EPG) parsing and programme lookup.
 */

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function parseXmltvTime(value) {
  const str = String(value || '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-]\d{4}))?/.exec(str);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, tz] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s || '00'}`;
  iso += tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z';
  return Date.parse(iso);
}

function textOf(node, tag) {
  const el = node.getElementsByTagName(tag)[0];
  return el ? el.textContent.trim() : '';
}

/**
 * @param {string} xml XMLTV document
 * @returns {{ byId: Map<string, any[]>, byName: Map<string, string>, count: number }}
 */
export function parseXmltv(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const parseError = doc.getElementsByTagName('parsererror')[0];
  if (parseError) throw new Error('Некорректный XMLTV файл');

  const byId = new Map();
  const byName = new Map();

  for (const channel of Array.from(doc.getElementsByTagName('channel'))) {
    const id = channel.getAttribute('id') || '';
    if (!id) continue;
    for (const name of Array.from(channel.getElementsByTagName('display-name'))) {
      const key = norm(name.textContent);
      if (key && !byName.has(key)) byName.set(key, id);
    }
    byName.set(norm(id), id);
  }

  const programmes = Array.from(doc.getElementsByTagName('programme'));
  for (const node of programmes) {
    const channelId = node.getAttribute('channel');
    if (!channelId) continue;
    const start = parseXmltvTime(node.getAttribute('start'));
    if (!Number.isFinite(start)) continue;
    let stop = parseXmltvTime(node.getAttribute('stop'));
    const title = textOf(node, 'title');
    if (!title) continue;
    if (!Number.isFinite(stop) || stop <= start) stop = start + 60 * 60 * 1000;

    const list = byId.get(channelId) || [];
    list.push({
      channel: channelId,
      start,
      stop,
      title,
      desc: textOf(node, 'desc'),
      category: textOf(node, 'category'),
    });
    byId.set(channelId, list);
  }

  for (const list of byId.values()) list.sort((a, b) => a.start - b.start);

  return { byId, byName, count: programmes.length, loadedAt: Date.now() };
}

function lookup(guide, channel) {
  if (!guide || !channel) return null;
  const candidates = [channel.tvgId, channel.tvgName, channel.name].filter(Boolean);
  for (const raw of candidates) {
    const id = guide.byId.has(raw) ? raw : guide.byName.get(norm(raw));
    if (id && guide.byId.has(id)) return guide.byId.get(id);
  }
  return null;
}

/** Find the programme airing at `at` and the following one. */
export function getSchedule(guide, channel, at = Date.now()) {
  const list = lookup(guide, channel);
  if (!list || !list.length) return { current: null, next: null, list: null };

  let lo = 0;
  let hi = list.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= at) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let current = idx >= 0 ? list[idx] : null;
  if (current && current.stop <= at) current = null;
  let next = null;
  if (current) next = list[idx + 1] || null;
  else if (list[0] && list[0].start > at) next = list[0];

  return { current, next, list };
}