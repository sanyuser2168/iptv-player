/**
 * IPTV Player — UI controller.
 * Author: DeepSeek 4.1 Flash & user2168
 */

import {
  parsePlaylist,
  buildXtreamUrl,
  channelSnapshot,
  channelKey,
  safeHost,
  DEMO_CHANNELS,
} from './m3u.js';
import {
  fetchTextSmart,
  detectServer,
  isViaServer,
  streamUrl,
  formatHint,
  probeStream,
  canTranscode,
  transcodeUrl,
  getAppVersion,
} from './net.js';
import { parseXmltv, getSchedule } from './epg.js';
import { Player } from './player.js';
import { loadPersisted, savePersisted, idbGet, idbSet, idbDelete } from './store.js';

const ROW_HEIGHT = 62;
const NO_GROUP = 'Без группы';

const $ = (sel) => document.querySelector(sel);

const EL = {
  search: $('#searchInput'),
  searchClear: $('#searchClear'),
  sourceSelect: $('#sourceSelect'),
  groupSelect: $('#groupSelect'),
  groupRow: $('.group-row'),
  btnReload: $('#btnReload'),
  btnRemove: $('#btnRemove'),
  filters: Array.from(document.querySelectorAll('.pill')),
  chanScroll: $('#chanScroll'),
  chanSpacer: $('#chanSpacer'),
  chanWindow: $('#chanWindow'),
  emptyList: $('#emptyList'),
  chanCount: $('#chanCount'),
  favCount: $('#favCount'),

  playerCard: $('#playerCard'),
  video: $('#video'),
  placeholder: $('#playerPlaceholder'),
  loader: $('#playerLoader'),
  loaderText: $('#loaderText'),
  errorBox: $('#playerError'),
  errTitle: $('#errTitle'),
  errText: $('#errText'),
  btnRetry: $('#btnRetry'),
  btnTranscode: $('#btnTranscode'),

  controls: $('#controls'),
  seekWrap: $('#seekWrap'),
  seek: $('#seek'),
  btnPlay: $('#btnPlay'),
  btnPrev: $('#btnPrev'),
  btnNext: $('#btnNext'),
  btnMute: $('#btnMute'),
  volume: $('#volume'),
  ctlTitle: $('#ctlTitle'),
  liveBadge: $('#liveBadge'),
  btnQuality: $('#btnQuality'),
  btnPip: $('#btnPip'),
  btnFull: $('#btnFull'),

  nowLogo: $('#nowLogo'),
  nowName: $('#nowName'),
  nowGroup: $('#nowGroup'),
  nowQuality: $('#nowQuality'),
  nowUrl: $('#nowUrl'),
  btnFavorite: $('#btnFavorite'),

  epgDate: $('#epgDate'),
  epgEmpty: $('#epgEmpty'),
  epgProg: $('#epgProg'),
  epgTitle: $('#epgTitle'),
  epgTime: $('#epgTime'),
  epgProgress: $('#epgProgress'),
  epgNext: $('#epgNext'),
  epgNextTime: $('#epgNextTime'),

  toasts: $('#toasts'),
  proxyState: $('#proxyState'),

  addDialog: $('#addDialog'),
  addForm: $('#addForm'),
  addMsg: $('#addMsg'),
  btnSubmit: $('#btnSubmit'),
  inpUrl: $('#inpUrl'),
  inpName: $('#inpName'),
  inpFile: $('#inpFile'),
  dropzone: $('#dropzone'),
  fileName: $('#fileName'),
  inpHost: $('#inpHost'),
  inpUser: $('#inpUser'),
  inpPass: $('#inpPass'),
  inpEpg: $('#inpEpg'),

  aboutDialog: $('#aboutDialog'),
};

const state = {
  sources: [],
  activeId: null,
  filter: 'all',
  group: 'all',
  query: '',
  favorites: new Map(),
  recent: [],
  current: null,
  volume: 1,
  muted: false,
  levels: [],
  activeTab: 'url',
  pendingFile: null,
  viewList: [],
  scrollRaf: 0,
  bufferingTimer: 0,
  blockedTimer: 0,
  transcodeKey: '',
  epgTimer: 0,
  saveTimer: 0,
};

const player = new Player(EL.video, {
  onLoading: (text) => {
    if (text) {
      EL.loaderText.textContent = text;
      EL.loader.hidden = false;
      EL.errorBox.hidden = true;
    } else {
      EL.loader.hidden = true;
    }
  },
  onPlaying: (playing) => {
    const isPlaying = playing === undefined ? !EL.video.paused : playing;
    setPlayIcon(isPlaying);
    EL.playerCard.classList.toggle('idle', false);
  },
  onBuffering: (buffering) => {
    clearTimeout(state.bufferingTimer);
    if (buffering) {
      state.bufferingTimer = setTimeout(() => {
        if (!EL.video.paused && EL.video.readyState < 3) {
          EL.loaderText.textContent = 'Буферизация…';
          EL.loader.hidden = false;
        }
      }, 900);
    } else {
      EL.loader.hidden = true;
    }
  },
  onError: ({ title, text }) => {
    const current = state.current;
    const codecProblem = /Кодек|Формат/i.test(title);
    if (current && codecProblem && canTranscode() && state.transcodeKey !== current.key) {
      startTranscode(false);
      return;
    }
    showPlaybackError(title, text);
    refinePlaybackError();
  },
  onLevels: (levels) => {
    state.levels = levels;
    EL.btnQuality.hidden = levels.length < 2;
    EL.btnQuality.textContent = 'Auto';
    updateQualityLabel();
  },
  onLevel: (index) => {
    const label = player.levelLabel(index);
    EL.btnQuality.textContent = label;
    EL.nowQuality.textContent = label === 'Auto' ? '' : `· ${label}`;
  },
  onLive: (live, duration) => {
    EL.liveBadge.hidden = !live;
    EL.seekWrap.hidden = live || !Number.isFinite(duration) || duration <= 0;
  },
  onTime: () => updateSeek(),
  onBlocked: () => {
    clearTimeout(state.blockedTimer);
    state.blockedTimer = setTimeout(() => {
      if (EL.video.paused) toast('Автозапуск заблокирован — нажмите ▶', 'info');
    }, 1200);
  },
});

/* ======================================================================== */
/* utils                                                                    */
/* ======================================================================== */

function toast(text, kind = 'info', timeout = 3600) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = text;
  EL.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });

function fmtTime(ts) {
  return Number.isFinite(ts) ? timeFmt.format(new Date(ts)) : '—';
}

function hostOf(url) {
  const host = safeHost(url);
  return host || '—';
}

function isVodUrl(url) {
  return /\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i.test(url);
}

function svgIcon(id, cls = 'ico') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', id);
  svg.appendChild(use);
  return svg;
}

function letterLogo(name) {
  const span = document.createElement('span');
  span.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return span;
}

function makeLogo(channel) {
  const box = document.createElement('div');
  box.className = 'chan-logo';
  if (channel.logo) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = channel.logo;
    img.addEventListener('error', () => {
      img.remove();
      box.appendChild(letterLogo(channel.name));
    });
    box.appendChild(img);
  } else {
    box.appendChild(letterLogo(channel.name));
  }
  return box;
}

function setNowLogo(channel) {
  EL.nowLogo.replaceChildren();
  if (!channel) {
    EL.nowLogo.appendChild(svgIcon('#i-tv'));
    return;
  }
  if (channel.logo) {
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = channel.logo;
    img.addEventListener('error', () => {
      img.remove();
      EL.nowLogo.appendChild(svgIcon('#i-tv'));
    });
    EL.nowLogo.appendChild(img);
  } else {
    EL.nowLogo.appendChild(svgIcon('#i-tv'));
  }
}

/* ======================================================================== */
/* state helpers                                                            */
/* ======================================================================== */

function activeSource() {
  return state.sources.find((s) => s.id === state.activeId) || null;
}

function sourceById(id) {
  return state.sources.find((s) => s.id === id) || null;
}

function currentSource() {
  if (!state.current) return null;
  return sourceById(state.current.sourceId) || activeSource();
}

function channelKeyOf(channel) {
  if (channel.key) return channel.key;
  const src = state.current && channel === state.current.channel ? sourceById(state.current.sourceId) : activeSource();
  return channelKey(src?.id || '', channel);
}

let saveTimer = 0;
function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 250);
}

function persistNow() {
  const data = {
    version: 1,
    activeId: state.activeId,
    volume: state.volume,
    muted: state.muted,
    favorites: Array.from(state.favorites.values()),
    recent: state.recent.slice(0, 40),
    sources: state.sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      url: s.url || '',
      epgUrl: s.epgUrl || '',
    })),
  };
  savePersisted(data);
}

function demoChannels() {
  return DEMO_CHANNELS.map((c, i) => ({
    id: `demo${i + 1}`,
    index: i,
    name: c.name,
    url: c.url,
    logo: '',
    group: c.group,
    tvgId: '',
    tvgName: '',
    number: i + 1,
    opts: null,
  }));
}

/* ======================================================================== */
/* sources                                                                  */
/* ======================================================================== */

function renderSources() {
  const sel = EL.sourceSelect;
  sel.replaceChildren();
  if (!state.sources.length) {
    const opt = document.createElement('option');
    opt.textContent = 'Нет плейлистов';
    opt.value = '';
    opt.disabled = true;
    opt.selected = true;
    sel.appendChild(opt);
  } else {
    for (const src of state.sources) {
      const opt = document.createElement('option');
      opt.value = src.id;
      const count = src.channels.length;
      const suffix = src.status === 'loading' ? ' …' : src.status === 'error' ? ' (!)' : count ? ` · ${count}` : '';
      opt.textContent = `${src.name}${suffix}`;
      sel.appendChild(opt);
    }
    sel.value = state.activeId || '';
  }
  EL.btnReload.disabled = !state.sources.length;
  EL.btnRemove.disabled = !state.sources.length;
}

async function loadSource(source) {
  source.status = 'loading';
  renderSources();
  try {
    let parsed;
    if (source.kind === 'demo') {
      parsed = { channels: demoChannels(), epgUrls: [], isHlsManifest: false };
    } else if (source.kind === 'file') {
      const text = await idbGet(source.id);
      if (!text) throw new Error('Файл плейлиста не найден в локальном хранилище');
      parsed = parsePlaylist(text);
    } else {
      const { text, finalUrl } = await fetchTextSmart(source.url);
      parsed = parsePlaylist(text, { baseUrl: finalUrl });
      if (parsed.epgUrls.length && !source.epgUrl) {
        source.epgUrl = parsed.epgUrls[0];
        persistSoon();
      }
    }

    if (!parsed.channels.length) {
      throw new Error(
        parsed.isHlsManifest
          ? 'По ссылке находится поток (HLS), а не список каналов'
          : 'В плейлисте не найдено ни одного канала'
      );
    }

    source.channels = parsed.channels;
    for (const channel of source.channels) channel.sourceId = source.id;
    source.status = 'ready';
    source.error = '';
    source.epg = source.epg || null;
    source.epgState = source.epg ? 'ready' : 'idle';
    if (source === activeSource()) {
      rebuildGroups();
      renderChannels();
      ensureEpg(source);
    }
    return source;
  } catch (err) {
    source.status = 'error';
    source.error = err.message || String(err);
    source.channels = [];
    throw err;
  } finally {
    renderSources();
  }
}

async function addSource(meta, { select = true } = {}) {
  const source = {
    id: uid(),
    name: meta.name || 'Плейлист',
    kind: meta.kind,
    url: meta.url || '',
    epgUrl: meta.epgUrl || '',
    channels: [],
    status: 'idle',
    epg: null,
    epgState: 'idle',
  };

  if (meta.kind === 'file' && meta.text) {
    try {
      await idbSet(source.id, meta.text);
    } catch {
      throw new Error('Не удалось сохранить файл плейлиста (хранилище браузера недоступно)');
    }
  }

  state.sources.push(source);
  const previousActive = state.activeId;
  if (select) state.activeId = source.id;
  renderSources();

  try {
    await loadSource(source);
  } catch (err) {
    if (!select) {
      throw err;
    }
    // Roll back failed playlist addition.
    state.sources = state.sources.filter((s) => s.id !== source.id);
    state.activeId = previousActive || state.sources[0]?.id || null;
    await idbDelete(source.id);
    renderSources();
    rebuildGroups();
    renderChannels();
    throw err;
  }

  if (select) {
    state.filter = 'all';
    state.group = 'all';
    state.query = '';
    EL.search.value = '';
    updateFilterPills();
    rebuildGroups();
    renderChannels();
    ensureEpg(source);
    persistSoon();
  }
  return source;
}

async function removeActiveSource(confirmed) {
  const source = activeSource();
  if (!source) return;

  if (!confirmed) {
    toast(`Нажмите «Удалить» ещё раз, чтобы убрать «${source.name}»`, 'info', 3200);
    EL.btnRemove.classList.add('is-armed');
    clearTimeout(removeActiveSource.timer);
    removeActiveSource.timer = setTimeout(() => EL.btnRemove.classList.remove('is-armed'), 3200);
    return;
  }

  EL.btnRemove.classList.remove('is-armed');
  state.sources = state.sources.filter((s) => s.id !== source.id);
  await idbDelete(source.id);
  if (state.current?.sourceId === source.id) stopPlayback();
  state.activeId = state.sources[0]?.id || null;
  state.group = 'all';
  renderSources();
  rebuildGroups();
  renderChannels();
  persistSoon();
  toast(`Плейлист «${source.name}» удалён`, 'ok');
}

function stopPlayback() {
  player.destroy();
  state.current = null;
  state.levels = [];
  EL.playerCard.classList.add('idle');
  EL.placeholder.hidden = false;
  EL.errorBox.hidden = true;
  EL.loader.hidden = true;
  EL.liveBadge.hidden = true;
  EL.btnQuality.hidden = true;
  EL.seekWrap.hidden = true;
  setPlayIcon(false);
  renderNowCard();
  renderEpg();
}

/* ======================================================================== */
/* channel list (virtualized)                                               */
/* ======================================================================== */

function groupsOf(source) {
  const map = new Map();
  for (const ch of source?.channels || []) {
    const g = ch.group || NO_GROUP;
    map.set(g, (map.get(g) || 0) + 1);
  }
  return map;
}

function rebuildGroups() {
  const source = activeSource();
  const counts = groupsOf(source);
  const current = state.group;

  EL.groupSelect.replaceChildren();
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = `Все категории · ${source?.channels.length || 0}`;
  EL.groupSelect.appendChild(all);

  Array.from(counts.keys())
    .sort((a, b) => a.localeCompare(b, 'ru'))
    .forEach((group) => {
      const opt = document.createElement('option');
      opt.value = group;
      opt.textContent = `${group} · ${counts.get(group)}`;
      EL.groupSelect.appendChild(opt);
    });

  if (counts.has(current)) {
    EL.groupSelect.value = current;
  } else {
    state.group = 'all';
    EL.groupSelect.value = 'all';
  }
  EL.groupRow.classList.toggle('is-hidden', state.filter !== 'all');
}

function visibleChannels() {
  const source = activeSource();
  const q = state.query.trim().toLowerCase();

  // Search runs across every playlist (or inside favourites/recents).
  if (q) {
    let pool;
    if (state.filter === 'fav') pool = Array.from(state.favorites.values());
    else if (state.filter === 'recent') pool = state.recent.slice(0, 40);
    else pool = state.sources.flatMap((src) => src.channels);

    return pool.filter((ch) => {
      const hay = `${ch.name || ''} ${ch.group || ''} ${ch.tvgName || ''} ${ch.tvgId || ''} ${ch.number || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  let list;
  if (state.filter === 'fav') list = Array.from(state.favorites.values());
  else if (state.filter === 'recent') list = state.recent.slice(0, 40);
  else list = source?.channels || [];

  if (state.filter === 'all' && state.group !== 'all') {
    list = list.filter((ch) => (ch.group || NO_GROUP) === state.group);
  }

  return list;
}

function highlightMatches(text, query) {
  const value = String(text || '');
  const needle = String(query || '').trim();
  if (!needle) return [document.createTextNode(value)];

  const nodes = [];
  const lower = value.toLowerCase();
  const target = needle.toLowerCase();
  let index = 0;
  let found = lower.indexOf(target);

  if (found === -1) return [document.createTextNode(value)];

  while (found !== -1) {
    if (found > index) nodes.push(document.createTextNode(value.slice(index, found)));
    const mark = document.createElement('mark');
    mark.textContent = value.slice(found, found + target.length);
    nodes.push(mark);
    index = found + target.length;
    found = lower.indexOf(target, index);
  }
  if (index < value.length) nodes.push(document.createTextNode(value.slice(index)));
  return nodes;
}

function nowTitleFor(channel) {
  const src = sourceById(channel.sourceId) || activeSource();
  if (!src?.epg) return '';
  const { current } = getSchedule(src.epg, channel);
  return current?.title || '';
}

function renderRow(channel, index) {
  const key = channel.key || channelKey(channel.sourceId || state.activeId || '', channel);
  const isActive = state.current?.key === key;
  const isFav = state.favorites.has(key);
  const source = sourceById(channel.sourceId);
  const crossSource = Boolean(source && source.id !== state.activeId);

  const row = document.createElement('div');
  row.className = `chan${isActive ? ' is-active' : ''}`;
  row.dataset.key = key;
  row.title = channel.name;

  const num = document.createElement('div');
  num.className = 'chan-num';
  num.textContent = channel.number || index + 1;

  const body = document.createElement('div');
  body.className = 'chan-body';
  const name = document.createElement('div');
  name.className = 'chan-name';
  name.append(...highlightMatches(channel.name, state.query.trim()));
  const sub = document.createElement('div');
  sub.className = 'chan-sub';
  const now = nowTitleFor(channel);
  sub.textContent = now
    ? `Сейчас: ${now}`
    : [crossSource ? source.name : '', channel.group || NO_GROUP].filter(Boolean).join(' · ');
  body.append(name, sub);

  const star = document.createElement('button');
  star.className = `chan-star${isFav ? ' is-fav' : ''}`;
  star.title = isFav ? 'Убрать из избранного' : 'В избранное';
  star.setAttribute('aria-label', star.title);
  star.appendChild(svgIcon('#i-star'));
  star.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFavorite(channel);
    const active = state.favorites.has(key);
    star.classList.toggle('is-fav', active);
    star.title = active ? 'Убрать из избранного' : 'В избранное';
  });

  row.append(num, makeLogo(channel), body, star);
  row.addEventListener('click', () => {
    playChannel(channel, channel.sourceId || state.activeId);
  });

  return row;
}

function renderWindow() {
  const list = state.viewList;
  const viewport = EL.chanScroll.clientHeight || 400;
  const maxScroll = Math.max(0, list.length * ROW_HEIGHT - viewport);
  if (EL.chanScroll.scrollTop > maxScroll) EL.chanScroll.scrollTop = maxScroll;
  const scrollTop = Math.min(EL.chanScroll.scrollTop, maxScroll);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 3);
  const end = Math.min(list.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + 4);

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.appendChild(renderRow(list[i], i));
  EL.chanWindow.replaceChildren(frag);
  EL.chanWindow.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
  EL.chanSpacer.style.height = `${list.length * ROW_HEIGHT}px`;
}

function renderChannels() {
  state.viewList = visibleChannels();
  const searching = Boolean(state.query.trim());

  if (searching) {
    const found = state.viewList.length;
    EL.chanCount.textContent = `${found} ${plural(found, ['совпадение', 'совпадения', 'совпадений'])}`;
  } else if (state.filter === 'all') {
    const src = activeSource();
    const count = src?.channels.length || 0;
    EL.chanCount.textContent = `${count} ${plural(count, ['канал', 'канала', 'каналов'])}`;
  } else if (state.filter === 'fav') {
    EL.chanCount.textContent = `${state.favorites.size} в избранном`;
  } else {
    EL.chanCount.textContent = `${Math.min(state.recent.length, 40)} недавних`;
  }

  EL.groupRow.classList.toggle('is-hidden', state.filter !== 'all' || searching);

  EL.favCount.textContent = state.favorites.size ? `★ ${state.favorites.size}` : '';

  const empty = state.viewList.length === 0;
  EL.emptyList.hidden = !empty;
  if (empty) {
    const title = EL.emptyList.querySelector('p');
    const hint = EL.emptyList.querySelector('span');
    if (state.query) {
      title.textContent = 'Ничего не найдено';
      hint.textContent = 'Попробуйте другой запрос';
    } else if (state.filter === 'fav') {
      title.textContent = 'В избранном пусто';
      hint.textContent = 'Нажмите ★ у канала, чтобы добавить его сюда';
    } else if (state.filter === 'recent') {
      title.textContent = 'История пуста';
      hint.textContent = 'Включённые каналы появятся здесь';
    } else if (!state.sources.length) {
      title.textContent = 'Нет плейлистов';
      hint.textContent = 'Нажмите «Добавить плейлист»';
    } else {
      title.textContent = 'Каналов нет';
      hint.textContent = 'В этой категории нет каналов';
    }
  }

  renderWindow();
}

function scheduleRenderWindow() {
  if (state.scrollRaf) return;
  state.scrollRaf = requestAnimationFrame(() => {
    state.scrollRaf = 0;
    renderWindow();
  });
}

/* ======================================================================== */
/* playback                                                                 */
/* ======================================================================== */

let controlsTimer = 0;

function showControls() {
  EL.playerCard.classList.add('controls-visible');
  clearTimeout(controlsTimer);
  if (!EL.video.paused) {
    controlsTimer = setTimeout(() => EL.playerCard.classList.remove('controls-visible'), 2600);
  }
}

function setPlayIcon(playing) {
  const use = EL.btnPlay.querySelector('use');
  if (use) use.setAttribute('href', playing ? '#i-pause' : '#i-play');
  EL.btnPlay.title = playing ? 'Пауза (Space)' : 'Воспроизведение (Space)';
}

function showPlaybackError(title, text) {
  clearTimeout(state.bufferingTimer);
  player.destroy();
  EL.loader.hidden = true;
  EL.errTitle.textContent = title;
  EL.errText.textContent = text;
  EL.errorBox.hidden = false;
  EL.btnTranscode.hidden = !canTranscode() || state.transcodeKey === state.current?.key;
  setPlayIcon(false);
}

/** Fallback for codecs Chromium cannot decode: live ffmpeg → H.264/AAC → MSE. */
async function startTranscode(manual = false) {
  const current = state.current;
  if (!current) return;

  if (!canTranscode()) {
    if (manual) toast('Перекодирование недоступно: ffmpeg не найден', 'err');
    return;
  }
  if (state.transcodeKey === current.key) {
    if (manual) toast('Этот канал уже перекодируется', 'info', 2000);
    return;
  }

  state.transcodeKey = current.key;
  EL.errorBox.hidden = true;
  EL.loaderText.textContent = 'Перекодирование потока…';
  EL.loader.hidden = false;
  EL.nowQuality.textContent = '· транскод';
  toast('Кодек не поддерживается — перекодирую на лету', 'info', 3200);
  showControls();

  await player.load(transcodeUrl(current.channel.url, current.channel.opts || {}), {
    live: !isVodUrl(current.channel.url),
    format: 'ts',
    video: current.channel.radio !== true,
  });

  if (state.current?.key === current.key) {
    EL.nowQuality.textContent = '· транскод';
    showControls();
  }
}

/** After a failure, check HTTP status to explain 401/403/404 instead of "format". */
async function refinePlaybackError() {
  const current = state.current;
  if (!current) return;
  const probe = await probeStream(current.channel.url, current.channel.opts || {});
  if (!probe || state.current?.key !== current.key || EL.errorBox.hidden) return;

  if (probe.status === 401 || probe.status === 403) {
    EL.errTitle.textContent = `Сервер отклонил доступ (HTTP ${probe.status})`;
    EL.errText.textContent =
      'Проверьте логин, пароль или срок действия ссылки. Некоторые провайдеры привязывают поток к IP-адресу.';
  } else if (probe.status === 404) {
    EL.errTitle.textContent = 'Поток не найден (HTTP 404)';
    EL.errText.textContent = 'Ссылка устарела или канал временно снят с вещания.';
  } else if (probe.status >= 500) {
    EL.errTitle.textContent = `Ошибка сервера (HTTP ${probe.status})`;
    EL.errText.textContent = 'Источник ответил ошибкой. Попробуйте позже или проверьте ссылку в VLC.';
  }
}

async function playChannel(channel, sourceId) {
  if (!channel?.url) return;
  const src = sourceById(sourceId) || activeSource();
  if (!src) return;

  const key = channel.key || channelKey(src.id, channel);
  const snapshot = { ...channelSnapshot(src.id, channel), key };

  state.transcodeKey = '';
  state.current = { key, channel: snapshot, sourceId: src.id };
  EL.playerCard.classList.remove('idle');
  EL.placeholder.hidden = true;
  EL.errorBox.hidden = true;
  EL.ctlTitle.textContent = channel.name;
  setNowLogo(snapshot);
  EL.nowName.textContent = snapshot.name;
  EL.nowGroup.textContent = snapshot.group || 'IPTV';
  EL.nowUrl.textContent = hostOf(snapshot.url);
  EL.nowQuality.textContent = '';
  updateFavoriteButton();

  pushRecent(snapshot);
  persistSoon();
  renderChannels();
  renderEpg();
  showControls();

  let format = formatHint(channel.url);

  if (!format) {
    // Unknown extension: ask the local proxy what is actually inside.
    player.destroy();
    EL.loaderText.textContent = 'Проверка потока…';
    EL.loader.hidden = false;
    const probe = await probeStream(channel.url, channel.opts || {});
    if (state.current?.key !== key) return;

    if (probe) {
      if (probe.status === 401 || probe.status === 403) {
        showPlaybackError(
          `Сервер отклонил доступ (HTTP ${probe.status})`,
          'Проверьте логин, пароль или срок действия ссылки. Некоторые провайдеры привязывают поток к IP-адресу.'
        );
        return;
      }
      if (probe.status === 404) {
        showPlaybackError('Поток не найден (HTTP 404)', 'Ссылка устарела или канал временно снят с вещания.');
        return;
      }
      if (probe.status >= 500) {
        showPlaybackError(
          `Ошибка сервера (HTTP ${probe.status})`,
          'Источник ответил ошибкой. Попробуйте позже или проверьте ссылку в VLC.'
        );
        return;
      }
      if (probe.kind && probe.kind !== 'unknown') format = probe.kind;
    }
  }

  const url = streamUrl(channel.url, channel.opts || {});
  await player.load(url, { live: !isVodUrl(channel.url), format, video: snapshot.radio !== true });
  showControls();
}

function pushRecent(snapshot) {
  state.recent = [snapshot, ...state.recent.filter((item) => item.key !== snapshot.key)].slice(0, 40);
}

function toggleFavorite(channel) {
  const key = channel.key || channelKey(state.activeId || channel.sourceId || '', channel);
  if (state.favorites.has(key)) {
    state.favorites.delete(key);
    toast('Удалено из избранного', 'info', 1800);
  } else {
    const src = chapterSource(channel);
    if (!src) {
      toast('Источник канала не найден', 'err');
      return;
    }
    state.favorites.set(key, { ...channelSnapshot(src.id, channel), key });
    toast('Добавлено в избранное', 'ok', 1800);
  }
  persistSoon();
  updateFavoriteButton();
  renderChannels();
}

function chapterSource(channel) {
  return sourceById(channel.sourceId) || activeSource();
}

function updateFavoriteButton() {
  const key = state.current?.key;
  const isFav = key ? state.favorites.has(key) : false;
  EL.btnFavorite.classList.toggle('is-fav', isFav);
  EL.btnFavorite.title = isFav ? 'Убрать из избранного' : 'В избранное';
  EL.btnFavorite.setAttribute('aria-label', EL.btnFavorite.title);
}

function renderNowCard() {
  const channel = state.current?.channel;
  if (!channel) {
    setNowLogo(null);
    EL.nowName.textContent = 'Канал не выбран';
    EL.nowGroup.textContent = 'IPTV';
    EL.nowQuality.textContent = '';
    EL.nowUrl.textContent = 'Выберите канал из списка слева, чтобы начать просмотр';
    updateFavoriteButton();
    EL.ctlTitle.textContent = '';
    return;
  }
  setNowLogo(channel);
  EL.nowName.textContent = channel.name;
  EL.nowGroup.textContent = channel.group || 'IPTV';
  EL.nowUrl.textContent = hostOf(channel.url);
  updateFavoriteButton();
}

function playStep(delta) {
  const list = state.viewList.length ? state.viewList : activeSource()?.channels || [];
  if (!list.length) return;
  const index = list.findIndex((ch) => (ch.key || channelKey(state.activeId || '', ch)) === state.current?.key);
  const next = list[(index + delta + list.length) % list.length];
  if (next) playChannel(next, next.sourceId || state.activeId);
}

function updateSeek() {
  const duration = EL.video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const p = Math.min(1, Math.max(0, EL.video.currentTime / duration));
  EL.seek.value = String(Math.round(p * 1000));
  EL.seek.style.setProperty('--p', `${p * 100}%`);
}

function updateQualityLabel() {
  const index = player.hls ? (player.hls.autoLevelEnabled ? -1 : player.hls.currentLevel) : -1;
  const label = player.levelLabel(index);
  EL.btnQuality.textContent = label;
  EL.nowQuality.textContent = label === 'Auto' ? '' : `· ${label}`;
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    EL.playerCard.requestFullscreen?.();
  }
}

async function togglePip() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await EL.video.requestPictureInPicture();
  } catch {
    toast('Картинка в картинке недоступна для этого потока', 'err');
  }
}

/* ======================================================================== */
/* EPG                                                                      */
/* ======================================================================== */

async function ensureEpg(source) {
  if (!source?.epgUrl) {
    renderEpg();
    return;
  }
  if (source.epgState === 'loading' || source.epgState === 'ready') {
    renderEpg();
    return;
  }
  source.epgState = 'loading';
  renderEpg();
  try {
    const { text } = await fetchTextSmart(source.epgUrl);
    source.epg = parseXmltv(text);
    source.epgState = 'ready';
    if (source === activeSource()) renderChannels();
  } catch (err) {
    source.epgState = 'error';
    toast(`EPG не загружен: ${err.message}`, 'err', 5000);
  }
  renderEpg();
}

function renderEpg() {
  EL.epgDate.textContent = dateFmt.format(new Date());
  const channel = state.current?.channel;
  const source = currentSource();

  if (!channel) {
    EL.epgProg.hidden = true;
    EL.epgEmpty.hidden = false;
    EL.epgEmpty.textContent = 'Выберите канал — здесь появится текущая и следующая передача.';
    return;
  }

  if (!source?.epgUrl) {
    EL.epgProg.hidden = true;
    EL.epgEmpty.hidden = false;
    EL.epgEmpty.textContent = 'Нет данных EPG. Добавьте ссылку XMLTV при создании плейлиста — и здесь появится программа передач.';
    return;
  }

  if (source.epgState === 'loading') {
    EL.epgProg.hidden = true;
    EL.epgEmpty.hidden = false;
    EL.epgEmpty.textContent = 'Загрузка программы передач…';
    return;
  }

  if (source.epgState === 'error') {
    EL.epgProg.hidden = true;
    EL.epgEmpty.hidden = false;
    EL.epgEmpty.textContent = 'Не удалось загрузить EPG. Проверьте ссылку XMLTV и повторите позже.';
    return;
  }

  const { current, next } = getSchedule(source.epg, channel);
  if (!current && !next) {
    EL.epgProg.hidden = true;
    EL.epgEmpty.hidden = false;
    EL.epgEmpty.textContent = 'Для этого канала в EPG нет программы передач.';
    return;
  }

  EL.epgEmpty.hidden = true;
  EL.epgProg.hidden = false;

  const item = current || next;
  EL.epgTitle.textContent = item.title || '—';
  EL.epgTime.textContent = current ? `${fmtTime(current.start)} — ${fmtTime(current.stop)}` : fmtTime(item.start);
  const progress = current
    ? Math.min(100, Math.max(0, ((Date.now() - current.start) / (current.stop - current.start)) * 100))
    : 0;
  EL.epgProgress.style.width = `${progress}%`;

  if (next) {
    EL.epgNext.textContent = next.title || '—';
    EL.epgNextTime.textContent = fmtTime(next.start);
  } else {
    EL.epgNext.textContent = 'нет данных';
    EL.epgNextTime.textContent = '';
  }
}

/* ======================================================================== */
/* dialogs                                                                  */
/* ======================================================================== */

function openAdd(tab = 'url') {
  setTab(tab);
  EL.addMsg.hidden = true;
  EL.addMsg.className = 'modal-msg';
  state.pendingFile = null;
  EL.fileName.textContent = '';
  EL.inpFile.value = '';
  if (!EL.addDialog.open) EL.addDialog.showModal();
  setTimeout(() => {
    if (tab === 'url') EL.inpUrl.focus();
    else if (tab === 'xtream') EL.inpHost.focus();
  }, 60);
}

function closeAdd() {
  EL.addDialog.close();
}

function setTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
}

function showAddMessage(text, kind = 'err') {
  EL.addMsg.textContent = text;
  EL.addMsg.className = `modal-msg${kind === 'err' ? '' : ` ${kind}`}`;
  EL.addMsg.hidden = false;
}

function normalizeUrlInput(value) {
  const url = value.trim();
  if (!url) throw new Error('Введите ссылку на плейлист');
  if (!/^https?:\/\//i.test(url)) return `http://${url}`;
  return url;
}

function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last && !/^get\.php$/i.test(last) ? decodeURIComponent(last).replace(/\.(m3u8?|txt)$/i, '') : u.host;
  } catch {
    return 'Плейлист';
  }
}

async function submitAdd(event) {
  event.preventDefault();
  EL.addMsg.hidden = true;
  const tab = state.activeTab;
  const epgUrl = EL.inpEpg.value.trim();

  try {
    let meta;
    if (tab === 'url') {
      const url = normalizeUrlInput(EL.inpUrl.value);
      try {
        new URL(url);
      } catch {
        throw new Error('Некорректная ссылка');
      }
      meta = { kind: 'url', url, name: EL.inpName.value.trim() || nameFromUrl(url), epgUrl };
    } else if (tab === 'file') {
      if (!state.pendingFile) throw new Error('Выберите файл плейлиста или перетащите его в область загрузки');
      const text = await state.pendingFile.text();
      meta = {
        kind: 'file',
        name: state.pendingFile.name.replace(/\.(m3u8?|txt)$/i, '') || 'Локальный плейлист',
        text,
        epgUrl,
      };
    } else {
      const host = EL.inpHost.value.trim();
      const user = EL.inpUser.value.trim();
      const pass = EL.inpPass.value;
      if (!host) throw new Error('Укажите адрес сервера Xtream');
      if (!user) throw new Error('Укажите логин');
      const url = buildXtreamUrl(host, user, pass, 'm3u8');
      let label = 'Xtream';
      try {
        label = `Xtream · ${new URL(url).host}`;
      } catch {
        /* ignore */
      }
      meta = { kind: 'xtream', url, name: label, epgUrl };
    }

    EL.btnSubmit.disabled = true;
    EL.btnSubmit.textContent = 'Загрузка…';
    await addSource(meta);
    closeAdd();
    EL.inpUrl.value = '';
    EL.inpName.value = '';
    EL.inpEpg.value = '';
    EL.inpHost.value = '';
    EL.inpUser.value = '';
    EL.inpPass.value = '';
    state.pendingFile = null;
    EL.fileName.textContent = '';
    toast('Плейлист добавлен', 'ok');
  } catch (err) {
    showAddMessage(err.message || 'Не удалось добавить плейлист');
  } finally {
    EL.btnSubmit.disabled = false;
    EL.btnSubmit.textContent = 'Добавить';
  }
}

async function addDemo() {
  const existing = state.sources.find((s) => s.kind === 'demo');
  if (existing) {
    state.activeId = existing.id;
    renderSources();
    rebuildGroups();
    renderChannels();
    if (!existing.channels.length) {
      try {
        await loadSource(existing);
      } catch {
        /* ignore */
      }
    }
    toast('Демо-плейлист уже добавлен', 'info');
    return;
  }
  try {
    if (EL.addDialog.open) closeAdd();
    await addSource({ kind: 'demo', name: 'Демо-каналы' });
    toast('Публичные демо-потоки добавлены', 'ok');
  } catch (err) {
    toast(`Демо: ${err.message}`, 'err');
  }
}

/* ======================================================================== */
/* restore & boot                                                           */
/* ======================================================================== */

async function restore() {
  const data = loadPersisted();
  if (!data) {
    EL.placeholder.hidden = false;
    renderSources();
    rebuildGroups();
    renderChannels();
    return;
  }

  state.volume = typeof data.volume === 'number' ? data.volume : 1;
  state.muted = Boolean(data.muted);
  EL.video.volume = state.volume;
  EL.video.muted = state.muted;
  EL.volume.value = String(state.volume);
  updateVolumeIcon();

  state.favorites = new Map((data.favorites || []).map((item) => [item.key, item]));
  state.recent = (data.recent || []).filter(Boolean).slice(0, 40);

  state.sources = (data.sources || []).map((src) => ({
    ...src,
    channels: [],
    status: 'idle',
    epg: null,
    epgState: 'idle',
  }));

  state.activeId = state.sources.some((s) => s.id === data.activeId)
    ? data.activeId
    : state.sources[0]?.id || null;

  renderSources();
  rebuildGroups();
  renderChannels();
  renderNowCard();
  renderEpg();

  // Load playlists one by one to keep the UI responsive.
  for (const source of state.sources) {
    try {
      await loadSource(source);
    } catch (err) {
      toast(`«${source.name}»: ${err.message}`, 'err', 5500);
    }
  }

  if (state.activeId) {
    rebuildGroups();
    renderChannels();
    ensureEpg(activeSource());
  }
}

function updateVolumeIcon() {
  const use = EL.btnMute.querySelector('use');
  const muted = EL.video.muted || EL.video.volume === 0;
  if (use) use.setAttribute('href', muted ? '#i-mute' : '#i-volume');
}

function bindEvents() {
  // search
  let searchTimer = 0;
  EL.search.addEventListener('input', () => {
    EL.searchClear.hidden = !EL.search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = EL.search.value;
      EL.chanScroll.scrollTop = 0;
      renderChannels();
    }, 110);
  });

  EL.searchClear.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    EL.search.value = '';
    state.query = '';
    EL.searchClear.hidden = true;
    EL.chanScroll.scrollTop = 0;
    renderChannels();
    EL.search.focus();
  });

  EL.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      EL.search.value = '';
      state.query = '';
      EL.searchClear.hidden = true;
      EL.chanScroll.scrollTop = 0;
      renderChannels();
      EL.search.blur();
    }
    if (event.key === 'Enter') {
      const first = state.viewList[0];
      if (first) playChannel(first, first.sourceId || state.activeId);
    }
  });

  // filters
  EL.filters.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      updateFilterPills();
      rebuildGroups();
      EL.chanScroll.scrollTop = 0;
      renderChannels();
    });
  });

  EL.sourceSelect.addEventListener('change', () => {
    state.activeId = EL.sourceSelect.value || null;
    state.group = 'all';
    renderSources();
    rebuildGroups();
    renderChannels();
    ensureEpg(activeSource());
    persistSoon();
  });

  EL.groupSelect.addEventListener('change', () => {
    state.group = EL.groupSelect.value;
    EL.chanScroll.scrollTop = 0;
    renderChannels();
  });

  EL.btnReload.addEventListener('click', async () => {
    const source = activeSource();
    if (!source) return;
    try {
      source.epg = null;
      source.epgState = 'idle';
      await loadSource(source);
      ensureEpg(source);
      toast(`«${source.name}» обновлён`, 'ok');
    } catch (err) {
      toast(`Не удалось обновить: ${err.message}`, 'err', 5000);
    }
  });

  EL.btnRemove.addEventListener('click', () => {
    const armed = EL.btnRemove.classList.contains('is-armed');
    removeActiveSource(armed);
  });

  EL.chanScroll.addEventListener('scroll', scheduleRenderWindow, { passive: true });
  new ResizeObserver(scheduleRenderWindow).observe(EL.chanScroll);

  // add dialog
  $('#btnAdd').addEventListener('click', () => openAdd('url'));
  $('#btnAdd2').addEventListener('click', () => openAdd('url'));
  $('#btnAddClose').addEventListener('click', closeAdd);
  $('#btnCancel').addEventListener('click', closeAdd);
  EL.addForm.addEventListener('submit', submitAdd);
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });
  $('#btnDemo').addEventListener('click', addDemo);
  $('#btnDemo2').addEventListener('click', addDemo);

  EL.inpFile.addEventListener('change', () => {
    const file = EL.inpFile.files?.[0];
    state.pendingFile = file || null;
    EL.fileName.textContent = file ? `Выбран: ${file.name}` : '';
  });

  const dz = EL.dropzone;
  dz.addEventListener('dragover', (event) => {
    event.preventDefault();
    dz.classList.add('is-over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
  dz.addEventListener('drop', (event) => {
    event.preventDefault();
    dz.classList.remove('is-over');
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    state.pendingFile = file;
    EL.fileName.textContent = `Выбран: ${file.name}`;
  });

  EL.addDialog.addEventListener('click', (event) => {
    if (event.target === EL.addDialog) closeAdd();
  });

  // about
  $('#btnAbout').addEventListener('click', () => EL.aboutDialog.showModal());
  $('#btnAboutClose').addEventListener('click', () => EL.aboutDialog.close());
  EL.aboutDialog.addEventListener('click', (event) => {
    if (event.target === EL.aboutDialog) EL.aboutDialog.close();
  });

  // player controls
  EL.btnPlay.addEventListener('click', () => {
    if (EL.video.paused) player.tryPlay();
    else EL.video.pause();
    showControls();
  });

  EL.video.addEventListener('click', () => {
    if (EL.video.paused) player.tryPlay();
    else EL.video.pause();
    showControls();
  });

  EL.video.addEventListener('dblclick', toggleFullscreen);

  EL.playerCard.addEventListener('mousemove', showControls);
  EL.playerCard.addEventListener('mouseleave', () => {
    if (!EL.video.paused) EL.playerCard.classList.remove('controls-visible');
  });

  EL.btnPrev.addEventListener('click', () => playStep(-1));
  EL.btnNext.addEventListener('click', () => playStep(1));

  EL.btnMute.addEventListener('click', () => {
    EL.video.muted = !EL.video.muted;
    if (!EL.video.muted && EL.video.volume === 0) EL.video.volume = 0.6;
    state.muted = EL.video.muted;
    updateVolumeIcon();
    persistSoon();
  });

  EL.volume.addEventListener('input', () => {
    const value = Number(EL.volume.value);
    EL.video.volume = value;
    EL.video.muted = value === 0;
    state.volume = value;
    state.muted = EL.video.muted;
    updateVolumeIcon();
    persistSoon();
  });

  EL.seek.addEventListener('input', () => {
    const duration = EL.video.duration;
    if (Number.isFinite(duration) && duration > 0) {
      EL.video.currentTime = (Number(EL.seek.value) / 1000) * duration;
      updateSeek();
    }
  });

  EL.btnQuality.addEventListener('click', () => {
    player.cycleLevel();
    updateQualityLabel();
  });

  EL.btnPip.addEventListener('click', togglePip);
  EL.btnFull.addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', () => {
    const use = EL.btnFull.querySelector('use');
    if (use) use.setAttribute('href', document.fullscreenElement ? '#i-compress' : '#i-expand');
    EL.btnFull.title = document.fullscreenElement ? 'Выйти из полного экрана (F)' : 'Полный экран (F)';
  });

  EL.btnRetry.addEventListener('click', () => {
    const channel = state.current?.channel;
    if (channel) playChannel(channel, state.current.sourceId);
  });

  EL.btnTranscode.addEventListener('click', () => {
    startTranscode(true);
  });

  EL.btnFavorite.addEventListener('click', () => {
    const channel = state.current?.channel;
    if (channel) toggleFavorite({ ...channel, key: state.current.key });
  });

  // keyboard
  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
    if (EL.addDialog.open || EL.aboutDialog.open) return;

    if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      EL.search.focus();
      EL.search.select();
      return;
    }

    if (event.key === '/' && !typing) {
      event.preventDefault();
      EL.search.focus();
      EL.search.select();
      return;
    }
    if (typing) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        if (EL.video.paused) player.tryPlay();
        else EL.video.pause();
        showControls();
        break;
      case 'f':
      case 'F':
      case 'F11':
        if (event.key === 'F11') return;
        event.preventDefault();
        toggleFullscreen();
        break;
      case 'm':
      case 'M':
        EL.btnMute.click();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        playStep(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        playStep(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        EL.video.volume = Math.min(1, EL.video.volume + 0.05);
        EL.volume.value = String(EL.video.volume);
        updateVolumeIcon();
        break;
      case 'ArrowDown':
        event.preventDefault();
        EL.video.volume = Math.max(0, EL.video.volume - 0.05);
        EL.volume.value = String(EL.video.volume);
        updateVolumeIcon();
        break;
    }
  });

  window.addEventListener('beforeunload', persistNow);

  EL.video.addEventListener('volumechange', () => {
    EL.volume.value = String(EL.video.volume);
    updateVolumeIcon();
  });

  setInterval(() => {
    if (state.current) {
      renderEpg();
      const source = activeSource();
      if (source?.epg) scheduleRenderWindow();
    }
  }, 20000);
}

function updateFilterPills() {
  EL.filters.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.filter === state.filter));
}

function setupDesktopChrome() {
  const desktop = window.desktop;
  if (!desktop || !desktop.isDesktop) return;
  document.body.classList.add('is-desktop');

  const actions = document.querySelector('.topbar-actions');
  if (!actions) return;

  const controls = document.createElement('div');
  controls.className = 'win-controls';

  const addButton = (label, kind, markup, handler) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `win-btn ${kind}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = markup;
    btn.addEventListener('click', handler);
    controls.appendChild(btn);
  };

  addButton(
    'Свернуть',
    'min',
    '<svg viewBox="0 0 24 24"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    () => desktop.minimize()
  );
  addButton(
    'Развернуть',
    'max',
    '<svg viewBox="0 0 24 24"><rect x="5.5" y="5.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    () => desktop.toggleMaximize()
  );
  addButton(
    'Закрыть',
    'close',
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    () => desktop.close()
  );

  actions.appendChild(controls);
  document.querySelector('.brand')?.addEventListener('dblclick', () => desktop.toggleMaximize());
}

function updateProxyState() {
  if (isViaServer()) {
    EL.proxyState.textContent = 'Локальный прокси активен';
    EL.proxyState.className = 'proxy-state ok';
  } else {
    EL.proxyState.textContent = 'Прямой режим · CORS может блокировать потоки';
    EL.proxyState.className = 'proxy-state warn';
  }
}

async function boot() {
  setupDesktopChrome();
  bindEvents();
  updateFilterPills();
  await detectServer();
  updateProxyState();

  const version = getAppVersion();
  const versionNode = document.getElementById('appVersion');
  if (versionNode) versionNode.textContent = `v${version}`;
  const aboutVersionNode = document.getElementById('aboutVersion');
  if (aboutVersionNode) aboutVersionNode.textContent = version;

  document.body.dataset.transcode = canTranscode() ? '1' : '0';
  window.__iptv = {
    state,
    player,
    canTranscode,
    startTranscode: (manual) => startTranscode(manual),
  };
  await restore();

  const source = activeSource();
  if (source) {
    EL.sourceSelect.value = source.id;
    EL.btnReload.disabled = false;
    EL.btnRemove.disabled = false;
  }

  renderNowCard();
  if (!state.current) {
    EL.playerCard.classList.add('idle');
    EL.placeholder.hidden = false;
  }
}

boot();