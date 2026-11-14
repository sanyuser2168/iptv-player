/**
 * Video player wrapper with automatic engine selection:
 *   hls.js   → HLS (m3u8) adaptive streams
 *   mpegts.js→ raw MPEG-TS / FLV live streams (Xtream output=ts)
 *   native   → progressive mp4/webm and browsers with built-in HLS
 *
 * If an engine cannot start the stream, the next one is tried automatically
 * and only the most useful error is shown at the end.
 */

const LIVE_ENGINE_TIMEOUT = 12000;

export class Player {
  constructor(video, handlers = {}) {
    this.video = video;
    this.handlers = handlers;
    this.hls = null;
    this.mpegtsPlayer = null;
    this.engine = 'idle';
    this.chain = [];
    this.chainIndex = 0;
    this.errors = [];
    this.levels = [];
    this.currentLevel = -1;
    this.live = true;
    this.url = '';
    this.destroyed = true;
    this.attemptToken = 0;
    this.watchdog = 0;
    this.healthTimer = 0;
    this.expectVideo = true;
    this.playingNow = false;

    video.addEventListener('playing', () => {
      this.playingNow = true;
      this.playStartedAt = Date.now();
      clearTimeout(this.watchdog);
      clearTimeout(this.healthTimer);
      if (this.expectVideo) {
        this.healthTimer = setTimeout(() => this.checkVideoHealth(), 4000);
      }
      this.handlers.onLoading?.(null);
      this.handlers.onPlaying?.(true);
    });
    video.addEventListener('waiting', () => this.handlers.onBuffering?.(true));
    video.addEventListener('canplay', () => this.handlers.onBuffering?.(false));
    video.addEventListener('pause', () => {
      this.playingNow = false;
      this.handlers.onPlaying?.(false);
    });
    video.addEventListener('timeupdate', () => this.handlers.onTime?.(video.currentTime, video.duration));
    video.addEventListener('durationchange', () => {
      if (this.engine === 'hls') return; // live/VOD flag comes from the manifest
      if (this.engine === 'mpegts') {
        this.handlers.onLive?.(this.live, this.live ? Infinity : video.duration);
        return;
      }
      const duration = video.duration;
      this.live = !Number.isFinite(duration) || duration <= 0;
      this.handlers.onLive?.(this.live, duration);
    });
    video.addEventListener('ended', () => {
      if (this.expectVideo) {
        const quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        const frames = quality ? quality.totalVideoFrames : -1;
        if (video.videoWidth === 0 || frames === 0) {
          this.noteError({ kind: this.engine, code: 'no-video' });
          if (/\/api\/transcode\?/.test(this.url)) {
            this.fail('Перекодирование не удалось', 'FFmpeg не смог отдать видеопоток.');
            return;
          }
          this.teardown();
          this.attempt();
          return;
        }
      }
      this.handlers.onEnded?.();
    });
    video.addEventListener('error', () => {
      if (this.destroyed || this.engine !== 'native' || !this.url) return;
      this.noteError({ kind: 'native', code: video.error?.code || 0 });
      this.teardown();
      this.attempt();
    });
  }

  load(url, { live = true, format = '', video = true } = {}) {
    this.destroy();
    this.destroyed = false;
    this.url = url;
    this.live = live;
    this.expectVideo = video !== false;
    this.playingNow = false;
    this.playStartedAt = 0;
    this.errors = [];
    this.levels = [];
    this.currentLevel = -1;
    this.chain = buildChain(url, format);
    this.chainIndex = 0;
    this.handlers.onLevels?.([], -1);
    this.handlers.onLive?.(live, live ? Infinity : 0);
    this.attempt();
  }

  attempt() {
    if (this.destroyed) return;
    if (this.chainIndex >= this.chain.length) {
      const [title, text] = this.describeFailure();
      this.fail(title, text);
      return;
    }

    const engine = this.chain[this.chainIndex++];
    this.engine = engine;
    this.playingNow = false;
    this.handlers.onLoading?.(this.chainIndex > 1 ? 'Пробуем другой формат…' : 'Подключение…');
    const isTranscode = /\/api\/transcode\?/.test(this.url);
    const timeout = isTranscode ? 20000 : engine === 'hls' ? 18000 : engine === 'mpegts' ? 7000 : 8000;
    this.startWatchdog(timeout);

    try {
      if (engine === 'hls') this.startHls();
      else if (engine === 'mpegts') this.startMpegts();
      else this.startNative();
    } catch (err) {
      this.noteError({ kind: engine, message: err?.message || String(err) });
      this.teardown();
      this.attempt();
    }
  }

  startWatchdog(timeout = LIVE_ENGINE_TIMEOUT) {
    clearTimeout(this.watchdog);
    const token = ++this.attemptToken;
    this.watchdog = setTimeout(() => {
      if (this.destroyed || token !== this.attemptToken || this.playingNow) return;
      this.noteError({ kind: this.engine, code: 'timeout' });
      this.teardown();
      this.attempt();
    }, timeout);
  }

  startNative() {
    this.engine = 'native';
    const video = this.video;
    video.src = this.url;
    video.load();
    this.tryPlay();
  }

  startHls() {
    const Hls = window.Hls;
    if (!Hls || !Hls.isSupported()) throw new Error('hls.js недоступен');
    this.engine = 'hls';
    this.hlsFatal = 0;

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 60,
      maxBufferLength: 30,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 2,
      fragLoadingTimeOut: 30000,
      fragLoadingMaxRetry: 4,
    });
    this.hls = hls;

    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(this.url));
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.levels = hls.levels.slice().sort((a, b) => (b.height || 0) - (a.height || 0));
      this.handlers.onLevels?.(this.levels, -1);
      this.tryPlay();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
      if (!hls.autoLevelEnabled) this.currentLevel = data.level;
      this.handlers.onLevel?.(hls.autoLevelEnabled ? -1 : data.level);
    });
    hls.on(Hls.Events.LEVEL_LOADED, (_evt, data) => {
      const details = data.details || {};
      this.live = details.live !== false && !details.ended;
      this.handlers.onLive?.(this.live, this.live ? Infinity : details.totalduration || this.video.duration);
    });
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal || this.destroyed || this.engine !== 'hls') return;
      this.hlsFatal += 1;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.hlsFatal <= 2 && !this.playingNow) {
        setTimeout(() => {
          if (!this.destroyed && this.hls && this.engine === 'hls') this.hls.startLoad();
        }, 700);
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.hlsFatal <= 2) {
        try {
          hls.recoverMediaError();
          return;
        } catch {
          /* fall through */
        }
      }

      this.noteError({ kind: 'hls', code: data.response?.code || 0, details: data.details || '' });
      if (this.playingNow && Date.now() - this.playStartedAt > 3000) {
        this.fail('Поток прервался', 'Вещание остановилось или канал временно недоступен. Попробуйте повторить.');
        return;
      }
      this.teardown();
      this.attempt();
    });

    hls.attachMedia(this.video);
  }

  startMpegts() {
    const mpegts = window.mpegts;
    if (!mpegts || (mpegts.isSupported && !mpegts.isSupported())) throw new Error('mpegts.js недоступен');

    this.engine = 'mpegts';
    const isFlv = /\.flv($|[?#])/i.test(this.url);
    const player = mpegts.createPlayer(
      {
        type: isFlv ? 'flv' : 'mse',
        isLive: this.live,
        url: this.url,
      },
      {
        enableWorker: true,
        enableStashBuffer: false,
        stashInitialSize: 128,
        liveBufferLatencyChasing: true,
        autoCleanupSourceBuffer: true,
        lazyLoad: false,
      }
    );
    this.mpegtsPlayer = player;

    player.on(mpegts.Events.ERROR, (type, detail, info) => {
      if (this.destroyed || this.engine !== 'mpegts') return;
      this.noteError({
        kind: 'mpegts',
        code: type,
        details: detail,
        message: info?.msg || info?.code || '',
      });
      if (this.playingNow && Date.now() - this.playStartedAt > 3000) {
        this.fail('Поток прервался', 'Вещание остановилось или канал временно недоступен. Попробуйте повторить.');
        return;
      }
      this.teardown();
      this.attempt();
    });

    player.on(mpegts.Events.MEDIA_INFO, (info) => {
      if (this.destroyed || this.engine !== 'mpegts') return;
      const mime = info?.mimeType || '';
      if (mime && window.MediaSource && !MediaSource.isTypeSupported(mime)) {
        this.noteError({ kind: 'mpegts', code: 'MediaError', message: `unsupported codec: ${mime}` });
        this.teardown();
        this.attempt();
      }
    });

    player.attachMediaElement(this.video);
    player.load();
    try {
      const promise = player.play();
      if (promise && typeof promise.catch === 'function') promise.catch(() => this.handlers.onBlocked?.());
    } catch {
      /* ignore */
    }
  }

  noteError(error) {
    this.errors.push(error);
  }

  /** Some containers "play" without a decodable video track (e.g. MPEG-2 in TS). */
  checkVideoHealth() {
    if (this.destroyed || !this.playingNow || this.engine === 'idle') return;
    if (!this.expectVideo) return;

    const quality = this.video.getVideoPlaybackQuality
      ? this.video.getVideoPlaybackQuality()
      : null;
    const frames = quality ? quality.totalVideoFrames : -1;
    const hasPicture = this.video.videoWidth > 0 && (frames === -1 || frames > 0);
    if (hasPicture) return;

    this.noteError({ kind: this.engine, code: 'no-video' });

    if (/\/api\/transcode\?/.test(this.url)) {
      this.fail(
        'Перекодирование не удалось',
        'FFmpeg не смог отдать видеопоток. Возможно, источник защищён или использует необычный формат.'
      );
      return;
    }

    this.teardown();
    this.attempt();
  }

  describeFailure() {
    const errs = this.errors;
    const str = (e) => `${e.code || ''} ${e.details || ''} ${e.message || ''}`;

    const httpCode = errs
      .map((e) => e.code)
      .find((code) => typeof code === 'number' && code >= 400 && code < 600);
    if (httpCode === 401 || httpCode === 403) {
      return [
        `Сервер отклонил доступ (HTTP ${httpCode})`,
        'Проверьте логин, пароль или срок действия ссылки. Некоторые провайдеры привязывают поток к IP.',
      ];
    }
    if (httpCode === 404) {
      return ['Поток не найден (HTTP 404)', 'Ссылка устарела или канал временно снят с вещания.'];
    }
    if (httpCode) {
      return [`Ошибка сервера (HTTP ${httpCode})`, 'Источник ответил ошибкой. Попробуйте позже или проверьте ссылку.'];
    }

    const codecFail = errs.some(
      (e) =>
        e.code === 3 ||
        e.code === 'MediaError' ||
        e.code === 'no-video' ||
        e.details === 'bufferAppendError' ||
        e.details === 'bufferAddCodecError' ||
        /codec|append/i.test(str(e))
    );
    if (codecFail) {
      return [
        'Кодек потока не поддерживается',
        'Скорее всего, канал вещает в HEVC/H.265 или со звуком AC-3 — встроенный декодер Windows такое не воспроизводит. Попробуйте H.264/AAC-вариант канала.',
      ];
    }

    if (errs.some((e) => /NetworkError|timeout/i.test(str(e)))) {
      return ['Поток не загружается', 'Сервер не отвечает или блокирует подключение. Проверьте интернет и ссылку.'];
    }

    const formatFail = errs.some((e) => e.code === 4 || e.kind === 'mpegts');
    if (formatFail) {
      return [
        'Формат потока не поддерживается',
        'Не удалось воспроизвести ни как HLS, ни как MPEG-TS. Попробуйте «Перекодировать» или проверьте ссылку в другом плеере.',
      ];
    }

    return ['Не удалось воспроизвести', 'Поток недоступен, защищён DRM или использует неподдерживаемый формат.'];
  }

  tryPlay() {
    const promise = this.video.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch((err) => {
        if (err && err.name === 'AbortError') return;
        this.handlers.onBlocked?.();
      });
    }
  }

  fail(title, text) {
    clearTimeout(this.watchdog);
    this.handlers.onLoading?.(null);
    this.handlers.onError?.({ title, text });
  }

  setLevel(index) {
    if (!this.hls) return;
    this.hls.currentLevel = index;
    this.currentLevel = index;
    this.handlers.onLevel?.(index);
  }

  /** Cycle Auto → level 0 (best) → level 1 → … → Auto */
  cycleLevel() {
    if (!this.hls || !this.hls.levels.length) return -1;
    const levels = this.hls.levels;
    const current = this.hls.autoLevelEnabled ? -1 : this.hls.currentLevel;
    const next = current + 1 >= levels.length ? -1 : current + 1;
    this.hls.currentLevel = next;
    this.handlers.onLevel?.(next);
    return next;
  }

  levelLabel(index) {
    if (index < 0) return 'Auto';
    const level = this.levels[index];
    if (!level) return 'Auto';
    if (level.height) return `${level.height}p`;
    if (level.bitrate) return `${Math.round(level.bitrate / 1000)}k`;
    return 'Auto';
  }

  teardown() {
    clearTimeout(this.watchdog);
    clearTimeout(this.healthTimer);

    const hls = this.hls;
    this.hls = null;
    if (hls) {
      try {
        hls.destroy();
      } catch {
        /* ignore */
      }
    }

    const mpegtsPlayer = this.mpegtsPlayer;
    this.mpegtsPlayer = null;
    if (mpegtsPlayer) {
      try {
        mpegtsPlayer.pause();
        mpegtsPlayer.unload();
        mpegtsPlayer.detachMediaElement();
        mpegtsPlayer.destroy();
      } catch {
        /* ignore */
      }
    }

    const video = this.video;
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* ignore */
    }
    this.engine = 'idle';
    this.playingNow = false;
  }

  destroy() {
    this.destroyed = true;
    this.attemptToken += 1;
    this.url = '';
    this.teardown();
    this.engine = 'idle';
  }
}

function buildChain(url, format = '') {
  const Hls = window.Hls;
  const hlsOk = Boolean(Hls && Hls.isSupported && Hls.isSupported());
  const mpegtsOk = Boolean(
    window.mpegts && window.mpegts.isSupported && window.mpegts.isSupported()
  );

  if (format === 'hls') return hlsOk ? ['hls'] : ['native'];
  if (format === 'ts') return mpegtsOk ? ['mpegts', 'native'] : ['native'];
  if (format === 'mp4') return ['native'];

  if (/\.m3u8($|[?#])/i.test(url) || /[?&](output|format)=m3u8/i.test(url)) {
    return hlsOk ? ['hls'] : ['native'];
  }
  if (/\.(mp4|webm|ogg|ogv|mov|m4v)($|[?#])/i.test(url)) {
    return ['native'];
  }
  if (/\.(ts|flv|m2ts)($|[?#])/i.test(url)) {
    return mpegtsOk ? ['mpegts', 'native'] : ['native'];
  }
  return mpegtsOk ? ['native', 'mpegts'] : ['native'];
}