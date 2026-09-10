// The desktop build: the same app, in a window, with a USB cable.
//
// Nothing here is a second version of anything. The renderer loads the files in
// `js/` -- the same ones GitHub Pages serves -- and the install API is
// `tools/bridge.mjs` through `tools/serve.mjs`, exactly as `npm start` gives
// you. What Electron adds is the two things a browser cannot have: a window
// that ships, and a Node process next to it that can hold a USB device.
//
// Why an HTTP server rather than file:// or a custom scheme: the page fetches
// `/api/slots` and imports ES modules by path, and both want an origin. A
// loopback server is the origin the app already has in development, so the
// desktop build and `npm start` are the same code path -- which is the whole
// point of doing it this way.
import { app, BrowserWindow, shell, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '../tools/serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Port 0: the OS picks a free one, so the desktop app never fights `npm start`
// on 8123 -- you can have both open, which is what developing on it looks like.
let port = null;

async function start() {
  try {
    ({ port } = await serve({ root: ROOT, port: 0 }));
  } catch (e) {
    dialog.showErrorBox('The planner could not start', String(e.message ?? e));
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0e11',      // the app's own panel colour, so no white flash
    title: '3DGS Mission Planner',
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Anything that is not this app opens in the real browser: the heights
  // service's own viewer, and whatever a plan link points at.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);

  // One line to the console saying what actually loaded. Worth keeping: the
  // three things that can silently be wrong here are the preload not running
  // (so the app talks to a heights service that is not there), the app being
  // served from the wrong root, and the install API not reaching bridge.mjs.
  // All three show up in this line or its absence.
  try {
    const state = await win.webContents.executeJavaScript(
      '({ desktop: Boolean(window.dji?.desktop), title: document.title,'
      + ' service: (window.__service ?? null) })',
    );
    console.log(`window up on :${port} · desktop=${state.desktop} · ${state.title}`);
  } catch (e) {
    console.log(`window up on :${port}, but it did not answer: ${e.message}`);
  }
}

app.whenReady().then(start);

// macOS convention, and it matters here: closing the window while a controller
// is plugged in should not leave a server running with nothing to show it.
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (!BrowserWindow.getAllWindows().length && port) start();
});
