'use strict';

// Dev-only watch+restart loop for `npm start`'s plain `electron .`. No new
// dependency (nodemon等は追加していない) — this project is otherwise
// deliberately light on devDependencies and gates install scripts (see
// package.json's `allow-scripts`/lavamoat setup), so a ~60行のfs.watchで
// 十分な用途にパッケージを足すのは避けた。
//
// 変更箇所によって2通りに分ける（2026-09-26改訂）:
//   - renderer/・data/（画面側）の変更 → 既存ウィンドウの中身だけを再読み込み
//     （IPCチャネル経由でmain.jsに'reload'を送る）。ウィンドウを作り直さない
//     ので、最前面に出てきたりフォーカスを奪ったりしない。
//   - main.js・preload.js・lib/（メインプロセス側）の変更 → Electronはこれらを
//     ホットリロードできないのでフル再起動。新しいウィンドウは前回の位置・
//     サイズで、フォーカスを奪わない形（showInactive）で表示する
//     （main.jsのTLINE_DEV_*参照）。
// 当初は常にフル再起動していたが、保存のたびにウィンドウが最前面に出てきて
// エディタ作業の邪魔になるとのフィードバックで分けた。
//
// fs.watchの`recursive`オプションはWindows/macOSのみ対応（Linux非対応）——
// このプロジェクトはWindows向け配布（package.jsonのbuild.win）なので許容。
//
// Usage: npm run dev

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const electronPath = require('electron');

const ROOT = path.join(__dirname, '..');
const WATCH_TARGETS = ['main.js', 'preload.js', 'lib', 'data', 'renderer'];
const RELOAD_ONLY_TARGETS = new Set(['data', 'renderer']);
// main.jsが開発時のウィンドウ位置・サイズを書き出す先（再起動をまたいで引き継ぐ）。
const BOUNDS_FILE = path.join(require('os').tmpdir(), 'tline-dev-window-bounds.json');
const DEBOUNCE_MS = 200;

let child = null;
let restartTimer = null;
let pendingFullRestart = false; // debounce中に1つでもメインプロセス側の変更があればフル再起動
let hasStartedOnce = false;
let restarting = false; // true only while WE are killing the child to respawn it — lets the exit handler tell that apart from the user closing the window

function startElectron() {
  console.log('[dev] starting electron…');
  // 'ipc'チャネルでmain.jsに再読み込み指示を送る。初回以外はTLINE_DEV_RESTART
  // を立て、フォーカスを奪わずに前回の位置で表示させる。
  child = spawn(electronPath, ['.'], {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, TLINE_DEV: '1', TLINE_DEV_BOUNDS_FILE: BOUNDS_FILE, ...(hasStartedOnce ? { TLINE_DEV_RESTART: '1' } : {}) },
  });
  hasStartedOnce = true;
  child.on('exit', (code, signal) => {
    child = null;
    if (!restarting) {
      console.log(`[dev] electron exited (code ${code}, signal ${signal}) — stopping watcher.`);
      process.exit(code || 0);
    }
  });
}

function scheduleRestart(reason, reloadOnly) {
  if (!reloadOnly) pendingFullRestart = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    const full = pendingFullRestart || !child || !child.connected;
    pendingFullRestart = false;
    if (!full) {
      console.log(`[dev] ${reason} changed — reloading window.`);
      child.send('reload');
      return;
    }
    console.log(`[dev] ${reason} changed — restarting.`);
    restarting = true;
    if (child) {
      child.once('exit', () => {
        restarting = false;
        startElectron();
      });
      child.kill();
    } else {
      restarting = false;
      startElectron();
    }
  }, DEBOUNCE_MS);
}

for (const target of WATCH_TARGETS) {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) continue;
  const isDir = fs.statSync(full).isDirectory();
  fs.watch(full, { recursive: isDir }, (_eventType, filename) => {
    scheduleRestart(filename ? path.join(target, filename) : target, RELOAD_ONLY_TARGETS.has(target));
  });
}

process.on('SIGINT', () => {
  if (child) child.kill();
  process.exit(0);
});

startElectron();
