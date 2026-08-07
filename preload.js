'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// contextIsolation: true / nodeIntegration: false / sandbox: true on the
// BrowserWindow, so this is the only bridge the renderer has to Node/Electron
// — same pattern as PathBrowser's window.pathBrowser.
contextBridge.exposeInMainWorld('tline', {
  chooseOpenPath: () => ipcRenderer.invoke('diagram:choose-open'),
  openFile: (filePath) => ipcRenderer.invoke('diagram:open-file', filePath),
  chooseSavePath: (defaultName) => ipcRenderer.invoke('diagram:choose-save-path', defaultName),
  saveFile: (filePath, diagram) => ipcRenderer.invoke('diagram:save-file', { filePath, diagram }),
  getRecentFiles: () => ipcRenderer.invoke('diagram:get-recent-files'),
  removeRecentFile: (filePath) => ipcRenderer.invoke('diagram:remove-recent-file', filePath),
  listOudDias: (filePath) => ipcRenderer.invoke('oud:list-dias', filePath),
  importOud: (filePath, diaIndex) => ipcRenderer.invoke('oud:import', { filePath, diaIndex }),
});
