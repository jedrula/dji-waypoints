// One fact, handed to the page: it is running inside the desktop app.
//
// js/service.js decides which heights service to talk to from this: the
// desktop build starts its own service on :8130 (electron/main.mjs), so it
// talks to that. This is the only thing the preload exists for; everything
// else the app does, it does as a web page.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('dji', { desktop: true });
