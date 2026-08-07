'use strict';

// Simple MRU list of recently opened/saved .tline project file paths,
// persisted under userData. Unlike PathBrowser's recentFiles.js (which backs
// up read-only imports so they survive the original being deleted), a TLINE
// project file is something the user owns and actively saves themselves —
// so this just remembers paths, no content copies.

const fs = require('fs');
const path = require('path');

const LIST_FILE = 'recent-files.json';
const MAX_ENTRIES = 10;

function listPath(userDataPath) {
  return path.join(userDataPath, LIST_FILE);
}

function readList(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(listPath(userDataPath), 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(userDataPath, list) {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(listPath(userDataPath), JSON.stringify(list));
}

// Moves `filePath` to the front (or adds it), deduped by path. `kind`
// ('tline' | 'oud') records which open flow to use when the entry is
// reselected from the 最近使ったファイル dropdown — .oud/.oud2 files need the
// Dia-picker flow, not a plain JSON.parse (see renderer/app.mjs). Defaults to
// 'tline' so entries written before this field existed still open correctly.
function touchRecentFile(userDataPath, filePath, kind = 'tline') {
  const list = readList(userDataPath);
  const rest = list.filter((e) => e.path !== filePath);
  const entry = { path: filePath, name: path.basename(filePath), lastOpenedAt: Date.now(), kind };
  writeList(userDataPath, [entry, ...rest].slice(0, MAX_ENTRIES));
  return entry;
}

// Drops entries whose file no longer exists, so the list stays honest
// without needing the user to manually clear stale ones.
function getRecentFiles(userDataPath) {
  const list = readList(userDataPath);
  const alive = list.filter((e) => {
    try {
      return fs.existsSync(e.path);
    } catch {
      return false;
    }
  });
  if (alive.length !== list.length) writeList(userDataPath, alive);
  return alive;
}

function removeRecentFile(userDataPath, filePath) {
  writeList(userDataPath, readList(userDataPath).filter((e) => e.path !== filePath));
  return getRecentFiles(userDataPath);
}

module.exports = { touchRecentFile, getRecentFiles, removeRecentFile };
