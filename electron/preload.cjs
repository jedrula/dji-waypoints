// One fact, handed to the page: it is running inside the desktop app.
//
// js/service.js decides which heights service to talk to from the address the
// page was loaded from -- localhost means the dev server, which means there is
// a service on :8130 next to it. The desktop build is also on localhost and has
// no service of its own, so it has to say so. This is the only thing the
// preload exists for; everything else the app does, it does as a web page.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('dji', { desktop: true });
