'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const recentFiles = require('./lib/recentFiles');
const oudParser = require('./lib/oudParser');

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

// ---------- 計画データの保存・読み込み（独自 .tline 形式 + .oud/.oud2） ----------
//
// PathBrowserのtimeline:*ハンドラと同じ「メインプロセスがダイアログ/fs、
// レンダラーはIPC経由のみ」という分担。「開く」ボタンは.tline/.json（自前
// JSON形式）と.oud/.oud2（OuDia/OuDiaSecond、下記「.oud/.oud2インポート」参照）
// の両方を1つのダイアログ・1つのボタンから選べる（拡張子でレンダラー側が
// 分岐——診断: 元は「OuDia読み込み…」という別ボタン・別ダイアログだったが、
// ユーザーからのフィードバックで「開く」に統合）。.oud/.oud2の直接保存
// (export)は現状スコープ外（NOTES.md参照）— 保存は自前JSON形式のみ。

ipcMain.handle('diagram:choose-open', async () => {
  // Test-only escape hatch (mirrors PathBrowser's PATHBROWSER_TEST_FILE):
  // native dialogs can't be driven by UI automation (Playwright's Electron
  // driver included — see scripts/screenshot.js), so E2E scripts set this
  // env var to skip the dialog entirely. Works for either file kind — the
  // renderer picks the open flow from the returned path's extension.
  if (process.env.TLINE_TEST_OPEN_FILE) return process.env.TLINE_TEST_OPEN_FILE;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'ダイヤファイルを開く',
    filters: [
      { name: 'すべての対応ファイル', extensions: ['tline', 'json', 'oud', 'oud2'] },
      { name: 'TLINE Diagram', extensions: ['tline', 'json'] },
      { name: 'OuDia Diagram', extensions: ['oud', 'oud2'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('diagram:open-file', async (event, filePath) => {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const diagram = JSON.parse(raw);
  recentFiles.touchRecentFile(app.getPath('userData'), filePath, 'tline');
  return { diagram, filePath };
});

ipcMain.handle('diagram:choose-save-path', async (event, defaultName) => {
  if (process.env.TLINE_TEST_SAVE_PATH) return process.env.TLINE_TEST_SAVE_PATH;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: '名前を付けて保存',
    defaultPath: defaultName || 'diagram.tline',
    filters: [{ name: 'TLINE Diagram', extensions: ['tline', 'json'] }],
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

// ---------- .oud/.oud2 (OuDia/OuDiaSecond) インポート ----------
//
// lib/oudParser.jsのクリーンルームパーサを使い、選ばれたファイルを読んで
// Dia一覧を返す→ユーザーが選んだDiaをTLINEのデータモデルに変換して返す、
// の2段階IPC（ファイル選択自体は上のdiagram:choose-openを共用——「開く」に
// 統合済み）。ファイルが小さいテキストなので、状態を持たず2回とも読み直す
// 設計（diagram:open-fileと同じ「メインプロセスがfs、レンダラーはIPC経由
// のみ」という分担）。取り込み（oud:import）が成功したタイミングでrecent
// Filesに'oud'種別として登録する——「最近使ったファイル」再選択時はDia
// 選択パネルを再度開く（renderer/app.mjs参照、1ファイルに複数Diaを持てる
// ため前回の選択を暗黙に決め打ちしない）。

ipcMain.handle('oud:list-dias', async (event, filePath) => {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = oudParser.parseDiagram(raw);
  if (!parsed) throw new Error('OuDia形式のファイルとして認識できませんでした（Rosen.ブロックが見つかりません）。');
  return {
    lineName: parsed.lineName,
    stationCount: parsed.stations.length,
    dias: parsed.dias.map((d, index) => ({ index, name: d.name, trainCount: d.trains.length })),
  };
});

ipcMain.handle('oud:import', async (event, { filePath, diaIndex }) => {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = oudParser.parseDiagram(raw);
  if (!parsed) throw new Error('OuDia形式のファイルとして認識できませんでした（Rosen.ブロックが見つかりません）。');
  const result = oudParser.toTlineDiagram(parsed, diaIndex);
  if (!result) throw new Error('指定されたダイヤが見つかりませんでした。');
  recentFiles.touchRecentFile(app.getPath('userData'), filePath, 'oud');
  return result;
});
