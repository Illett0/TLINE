'use strict';

const { contextBridge } = require('electron');

// Placeholder bridge — mirrors PathBrowser's contextIsolation/no-Node-in-renderer
// setup from the start, even though there's nothing to expose yet. Diagram
// load/save (file dialogs, disk I/O) will go through ipcMain handlers in
// main.js + wrappers here, same pattern as PathBrowser's window.pathBrowser.
contextBridge.exposeInMainWorld('sujiOps', {});
