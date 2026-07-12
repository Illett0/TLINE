'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const recentFiles = require('./lib/recentFiles');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- 計画データの保存・読み込み（独自 .tline.json 形式） ----------
//
// PathBrowserのtimeline:*ハンドラと同じ「メインプロセスがダイアログ/fs、
// レンダラーはIPC経由のみ」という分担。.oud/.oud2の直接保存(export)は
// 現状スコープ外（NOTES.md参照）— ここは自前JSON形式のみを扱う。

ipcMain.handle('diagram:choose-open', async () => {
  // Test-only escape hatch (mirrors PathBrowser's PATHBROWSER_TEST_FILE):
  // native dialogs can't be driven by UI automation (Playwright's Electron
  // driver included — see scripts/screenshot.js), so E2E scripts set this
  // env var to skip the dialog entirely.
  if (process.env.TLINE_TEST_OPEN_FILE) return process.env.TLINE_TEST_OPEN_FILE;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'ダイヤファイルを開く',
    filters: [{ name: 'TLINE Diagram', extensions: ['tline.json', 'json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('diagram:open-file', async (event, filePath) => {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const diagram = JSON.parse(raw);
  recentFiles.touchRecentFile(app.getPath('userData'), filePath);
  return { diagram, filePath };
});

ipcMain.handle('diagram:choose-save-path', async (event, defaultName) => {
  if (process.env.TLINE_TEST_SAVE_PATH) return process.env.TLINE_TEST_SAVE_PATH;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: '名前を付けて保存',
    defaultPath: defaultName || 'diagram.tline.json',
    filters: [{ name: 'TLINE Diagram', extensions: ['tline.json', 'json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('diagram:save-file', async (event, { filePath, diagram }) => {
  fs.writeFileSync(filePath, JSON.stringify(diagram, null, 2), 'utf-8');
  recentFiles.touchRecentFile(app.getPath('userData'), filePath);
  return { filePath };
});

ipcMain.handle('diagram:get-recent-files', async () => {
  return recentFiles.getRecentFiles(app.getPath('userData'));
});

ipcMain.handle('diagram:remove-recent-file', async (event, filePath) => {
  return recentFiles.removeRecentFile(app.getPath('userData'), filePath);
});
