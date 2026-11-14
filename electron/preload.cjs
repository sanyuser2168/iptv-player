const { contextBridge, ipcRenderer } = require('electron');

window.__smokeErrors = [];
window.addEventListener('error', (event) => {
  window.__smokeErrors.push(`${event.message} @ ${event.filename}:${event.lineno}`);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  window.__smokeErrors.push(`Unhandled rejection: ${reason && reason.message ? reason.message : reason}`);
});

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  getErrors: () => window.__smokeErrors,
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
});