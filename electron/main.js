import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, ipcMain, shell, nativeTheme } from 'electron';
import { startAppServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PREFS_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
const SMOKE = process.argv.includes('--smoke');
const FIXED_PORT = 8787;

if (SMOKE) {
  app.setPath('userData', path.join(app.getPath('temp'), 'iptv-player-smoke'));
}

let mainWindow = null;
let appServer = null;

if (!SMOKE) {
  app.setAppUserModelId('com.user2168.iptvplayer');
}
Menu.setApplicationMenu(null);

function readWindowState() {
  try {
    const raw = fs.readFileSync(PREFS_FILE(), 'utf8');
    const data = JSON.parse(raw);
    if (data && Number.isFinite(data.width) && Number.isFinite(data.height)) return data;
  } catch {
    /* ignore */
  }
  return { width: 1420, height: 900 };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    fs.mkdirSync(path.dirname(PREFS_FILE()), { recursive: true });
    fs.writeFileSync(
      PREFS_FILE(),
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }, null, 2)
    );
  } catch {
    /* ignore */
  }
}

async function ensureServer() {
  // Reuse an already running instance of the local server (keeps localStorage origin stable).
  try {
    const res = await fetch(`http://127.0.0.1:${FIXED_PORT}/api/ping`, { signal: AbortSignal.timeout(1200) });
    if (res.ok) {
      const data = await res.json();
      if (data && data.app === 'iptv-player') {
        return { url: `http://127.0.0.1:${FIXED_PORT}`, external: true };
      }
    }
  } catch {
    /* not running */
  }
  const started = await startAppServer({ port: FIXED_PORT });
  appServer = started.server;
  return { url: started.url, external: false };
}

function createWindow(url) {
  const saved = readWindowState();
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 940,
    minHeight: 620,
    show: false,
    frame: false,
    thickFrame: true,
    backgroundColor: '#07080d',
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'build', 'icon.png'),
    title: 'IPTV Player',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  if (saved.maximized) win.maximize();

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE) setTimeout(() => runSmoke(win), 4200);
  });

  win.on('close', () => saveWindowState(win));
  win.on('closed', () => {
    mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target).catch(() => {});
    }
  });

  if (SMOKE) {
    win.webContents.on('console-message', (...args) => {
      const details = typeof args[0] === 'object' && args[0] && 'message' in args[0] ? args[0] : null;
      const level = details ? details.level : args[1];
      const message = details ? details.message : args[2];
      if (level === 'error' || level === 3 || level === 2) console.log('[renderer]', message);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log('SMOKE_FAIL_LOAD', code, desc);
      app.exit(1);
    });
  }

  win.loadURL(url);
  mainWindow = win;
  return win;
}

async function runSmoke(win) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const first = await win.webContents.executeJavaScript(`(() => ({
      title: document.title,
      desktopApi: Boolean(window.desktop && window.desktop.isDesktop),
      proxy: (document.getElementById('proxyState') || {}).textContent || '',
      playlistOptions: document.querySelectorAll('#sourceSelect option').length,
      playerIdle: document.getElementById('playerCard').classList.contains('idle'),
      errors: (window.desktop && window.desktop.getErrors ? window.desktop.getErrors() : (window.__smokeErrors || []))
    }))()`);

    const epgTest = await win.webContents.executeJavaScript(`(async () => {
      const epg = await import('./js/epg.js');
      const guide = epg.parseXmltv('<tv><channel id="ch1"><display-name>Первый</display-name></channel><programme start="20260101100000 +0000" stop="20260101110000 +0000" channel="ch1"><title>Новости</title></programme><programme start="20260101110000 +0000" stop="20260101120000 +0000" channel="ch1"><title>Фильм</title></programme></tv>');
      const at = Date.parse('2026-01-01T10:30:00Z');
      const byId = epg.getSchedule(guide, { tvgId: 'ch1' }, at);
      const byName = epg.getSchedule(guide, { name: 'Первый' }, at);
      return { count: guide.count, current: byId.current && byId.current.title, next: byId.next && byId.next.title, byName: byName.current && byName.current.title };
    })()`);

    await win.webContents.executeJavaScript(`document.getElementById('btnDemo').click()`);
    await wait(1800);

    const demo = await win.webContents.executeJavaScript(`(() => ({
      sources: document.querySelectorAll('#sourceSelect option').length,
      rows: document.querySelectorAll('.chan').length,
      firstChannel: (document.querySelector('.chan-name') || {}).textContent || '',
      groups: document.querySelectorAll('#groupSelect option').length
    }))()`);

    await win.webContents.executeJavaScript(`(document.querySelector('.chan') || {click(){}}).click()`);
    await wait(8000);

    const playing = await win.webContents.executeJavaScript(`(() => {
      const video = document.getElementById('video');
      const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
      return {
        active: Boolean(document.querySelector('.chan.is-active')),
        name: document.getElementById('nowName').textContent,
        errorVisible: !document.getElementById('playerError').hidden,
        errorText: document.getElementById('errText').textContent,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        decodedFrames: q.totalVideoFrames || 0,
        liveBadge: !document.getElementById('liveBadge').hidden,
        controls: document.getElementById('playerCard').classList.contains('controls-visible')
      };
    })()`);

    const image = await win.webContents.capturePage();
    const shotDir = app.isPackaged ? app.getPath('temp') : path.join(ROOT, 'dist');
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(shotDir, 'smoke-screenshot.png'), image.toPNG());

    // ---- raw MPEG-TS engine (Xtream output=ts style) ----
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('btnAdd').click();
      document.getElementById('inpUrl').value = 'http://127.0.0.1:8787/build/sample.m3u';
      document.getElementById('addForm').requestSubmit();
    })()`);
    await wait(3500);

    const tsList = await win.webContents.executeJavaScript(`(() => ({
      sourceName: document.getElementById('sourceSelect').selectedOptions[0]?.textContent || '',
      rows: document.querySelectorAll('.chan').length
    }))()`);

    if (tsList.rows > 0) {
      await win.webContents.executeJavaScript(`document.querySelector('.chan').click()`);
      await wait(9000);
    }

    const tsPlaying = await win.webContents.executeJavaScript(`(() => {
      const video = document.getElementById('video');
      const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
      return {
        name: document.getElementById('nowName').textContent,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        decodedFrames: q.totalVideoFrames || 0,
        errorVisible: !document.getElementById('playerError').hidden,
        errorTitle: document.getElementById('errTitle').textContent,
        errorText: document.getElementById('errText').textContent
      };
    })()`);

    const tsImage = await win.webContents.capturePage();
    fs.writeFileSync(path.join(shotDir, 'smoke-ts.png'), tsImage.toPNG());

    // MPEG-2 → ffmpeg live transcode fallback
    let transcoded = null;
    if (tsList.rows > 1) {
      await win.webContents.executeJavaScript(`document.querySelectorAll('.chan')[1].click()`);
      await wait(25000);
      transcoded = await win.webContents.executeJavaScript(`(() => {
        const video = document.getElementById('video');
        const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
        const app = window.__iptv || {};
        return {
          name: document.getElementById('nowName').textContent,
          readyState: video.readyState,
          errorVisible: !document.getElementById('playerError').hidden,
          errorTitle: document.getElementById('errTitle').textContent,
          quality: document.getElementById('nowQuality').textContent,
          loaderVisible: !document.getElementById('playerLoader').hidden,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          currentTime: Math.round(video.currentTime * 10) / 10,
          paused: video.paused,
          decodedFrames: q.totalVideoFrames || 0,
          bufferedEnd: video.buffered.length ? Math.round(video.buffered.end(0)) : 0,
          transcodeRequests: performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/transcode')).length,
          canTranscode: app.canTranscode ? app.canTranscode() : null,
          transcodeKey: app.state ? app.state.transcodeKey : null,
          currentKey: app.state && app.state.current ? app.state.current.key : null,
          playerErrors: app.player ? app.player.errors : null,
          playerEngine: app.player ? app.player.engine : null
        };
      })()`);
      const transImage = await win.webContents.capturePage();
      fs.writeFileSync(path.join(shotDir, 'smoke-transcode.png'), transImage.toPNG());
    }

    console.log(
      'SMOKE_OK',
      JSON.stringify({ first, epgTest, demo, playing, tsList, tsPlaying, transcoded }, null, 2)
    );
    const failed =
      first.errors.length > 0 ||
      !first.title.includes('IPTV') ||
      demo.rows === 0 ||
      !playing.active ||
      playing.videoWidth < 1 ||
      epgTest.count !== 2 ||
      epgTest.current !== 'Новости' ||
      epgTest.next !== 'Фильм' ||
      tsList.rows < 2 ||
      tsPlaying.readyState < 2 ||
      tsPlaying.videoWidth < 1 ||
      tsPlaying.errorVisible ||
      !transcoded ||
      transcoded.readyState < 2 ||
      transcoded.videoWidth < 1 ||
      transcoded.decodedFrames < 1 ||
      transcoded.errorVisible;
    setTimeout(() => app.exit(failed ? 1 : 0), 300);
  } catch (err) {
    console.log('SMOKE_ERROR', err.message);
    app.exit(1);
  }
}

ipcMain.on('win:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.on('win:maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());

const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    try {
      const { url } = await ensureServer();
      createWindow(url);
    } catch (err) {
      console.error('Не удалось запустить локальный сервер:', err);
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    if (appServer) {
      try {
        appServer.close();
      } catch {
        /* ignore */
      }
    }
  });
}