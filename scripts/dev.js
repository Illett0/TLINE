'use strict';

// Dev-only watch+restart loop for `npm start`'s plain `electron .`. No new
// dependency (nodemon等は追加していない) — this project is otherwise
// deliberately light on devDependencies and gates install scripts (see
// package.json's `allow-scripts`/lavamoat setup), so a ~60行のfs.watchで
// 十分な用途にパッケージを足すのは避けた。
//
// Restarts the WHOLE app (kill + respawn the electron child) on ANY change
// under main.js/preload.js/lib/data/renderer, rather than trying to tell
// "needs a full restart" (main process) apart from "just needs the window
// reloaded" (renderer) — Electronはメインプロセスの変更をホットリロードしない
// のでどのみち必要になる区別だが、TLINEの起動は一瞬なので、毎回フル再起動
// でも体感コストが無い。
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
const DEBOUNCE_MS = 200;

let child = null;
let restartTimer = null;
let restarting = false; // true only while WE are killing the child to respawn it — lets the exit handler tell that apart from the user closing the window

function startElectron() {
  console.log('[dev] starting electron…');
  child = spawn(electronPath, ['.'], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    child = null;
    if (!restarting) {
      console.log(`[dev] electron exited (code ${code}, signal ${signal}) — stopping watcher.`);
      process.exit(code || 0);
    }
  });
}

function scheduleRestart(reason) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
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
    scheduleRestart(filename ? path.join(target, filename) : target);
  });
}

process.on('SIGINT', () => {
  if (child) child.kill();
  process.exit(0);
});

startElectron();
