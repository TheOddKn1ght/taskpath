const { app, BrowserWindow, clipboard, dialog, Menu, shell } = require('electron');
const { serverURL, sameOrigin, externalURL } = require('./policy.cjs');

app.setName('Taskpath');
let origin;
let window;

async function openExternal(url) {
  if (!externalURL(url)) return;
  const { response } = await dialog.showMessageBox(window, {
    type: 'question', message: 'Open this link in your browser?',
    detail: url, buttons: ['Cancel', 'Open link'], defaultId: 0, cancelId: 0,
  });
  if (response === 1) await shell.openExternal(url).catch(() => {});
}

function createWindow() {
  window = new BrowserWindow({
    title: 'Taskpath', width: 1280, height: 860, minWidth: 480, minHeight: 600,
    backgroundColor: '#18181b',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
  });
  const contents = window.webContents;
  contents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'notifications' && sameOrigin(contents.getURL(), origin));
  });
  contents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    permission === 'notifications' && sameOrigin(requestingOrigin, origin));
  contents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url, origin)) { event.preventDefault(); void openExternal(url); }
  });
  contents.on('will-redirect', (event, url) => {
    if (!sameOrigin(url, origin)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url, origin)) void contents.loadURL(url).catch(() => {});
    else void openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => { window = null; });
  void contents.loadURL(origin).catch(() => {
    if (!window) return;
    dialog.showMessageBox(window, {
      type: 'error', message: 'Could not connect to Taskpath',
      detail: `Check that ${origin} is running, then choose View → Reload.`,
    });
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(() => {
    try {
      origin = serverURL(process.env.TASKPATH_DESKTOP_URL ??
        (app.isPackaged ? undefined : 'http://localhost:3000'));
    }
    catch (error) { dialog.showErrorBox('Invalid Taskpath server', error.message); app.quit(); return; }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: 'File', submenu: [
        { label: 'Open Copied Invitation Link', click: () => {
          const url = clipboard.readText().trim();
          if (window && sameOrigin(url, origin)) void window.loadURL(url).catch(() => {});
          else dialog.showErrorBox('Cannot open invitation', 'Copy an invitation link for the configured Taskpath server first.');
        } },
        { type: 'separator' }, { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ] }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
