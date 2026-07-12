import { sampleDiagram } from '../data/sampleDiagram.mjs';
import { renderDiagram } from './diagramView.mjs';
import { applyDelay } from './dispatch.mjs';
import { parseTime } from './timeUtils.mjs';

const state = {
  diagram: sampleDiagram, // 計画。ファイルを開くとその内容に差し替わる（state.currentFilePath参照）
  currentFilePath: null, // null = サンプルデータのまま未保存・未オープン
  dispatchTrainId: sampleDiagram.trains[0]?.id ?? null,
  dispatchStationId: sampleDiagram.trains[0]?.stops[0]?.stationId ?? null,
  dispatchDelta: 90,
  adjustedTrain: null, // set once 適用 is pressed; cleared by リセット
  actualByTrainStation: new Map(), // `${trainId}:${stationId}` -> { arrival, departure }
};

const el = {
  tabButtons: document.querySelectorAll('.tab-button'),
  tabPanels: document.querySelectorAll('.tab-panel'),
  planDiagram: document.getElementById('plan-diagram'),
  planTable: document.getElementById('plan-table'),
  planNote: document.getElementById('plan-note'),
  dispatchForm: document.getElementById('dispatch-form'),
  dispatchTrain: document.getElementById('dispatch-train'),
  dispatchStation: document.getElementById('dispatch-station'),
  dispatchDelta: document.getElementById('dispatch-delta'),
  dispatchReset: document.getElementById('dispatch-reset'),
  dispatchDiagram: document.getElementById('dispatch-diagram'),
  dispatchTable: document.getElementById('dispatch-table'),
  actualTable: document.getElementById('actual-table'),
  currentFileLabel: document.getElementById('current-file-label'),
  btnFileOpen: document.getElementById('btn-file-open'),
  btnFileSave: document.getElementById('btn-file-save'),
  btnFileSaveAs: document.getElementById('btn-file-save-as'),
  recentFilesSelect: document.getElementById('recent-files-select'),
};

// ---------- Tabs ----------

for (const button of el.tabButtons) {
  button.addEventListener('click', () => {
    for (const b of el.tabButtons) b.classList.toggle('active', b === button);
    for (const panel of el.tabPanels) panel.classList.toggle('active', panel.id === `tab-${button.dataset.tab}`);
  });
}

// ---------- 計画 ----------

function stopTableHtml(diagram, { trainOverride } = {}) {
  const trains = trainOverride ? diagram.trains.map((t) => (t.id === trainOverride.id ? trainOverride : t)) : diagram.trains;
  const header = `<tr><th>駅</th>${trains.map((t) => `<th>${t.number}</th>`).join('')}</tr>`;
  const rows = diagram.line.stations
    .map((station) => {
      const cells = trains
        .map((t) => {
          const stop = t.stops.find((s) => s.stationId === station.id);
          if (!stop) return '<td>—</td>';
          const arr = stop.arrival ?? '';
          const dep = stop.departure ?? '';
          return `<td>${[arr, dep].filter(Boolean).join(' / ')}</td>`;
        })
        .join('');
      return `<tr><th>${station.name}</th>${cells}</tr>`;
    })
    .join('');
  return header + rows;
}

function renderPlanTab() {
  renderDiagram(el.planDiagram, { stations: state.diagram.line.stations, trains: state.diagram.trains });
  el.planTable.innerHTML = stopTableHtml(state.diagram);
}

// ---------- 運転整理 ----------

function populateDispatchSelectors() {
  el.dispatchTrain.innerHTML = state.diagram.trains.map((t) => `<option value="${t.id}">${t.number}</option>`).join('');
  el.dispatchTrain.value = state.dispatchTrainId;
  updateDispatchStationOptions();
}

function updateDispatchStationOptions() {
  const train = state.diagram.trains.find((t) => t.id === state.dispatchTrainId);
  if (!train) return;
  el.dispatchStation.innerHTML = train.stops
    .map((s) => {
      const station = state.diagram.line.stations.find((st) => st.id === s.stationId);
      return `<option value="${s.stationId}">${station ? station.name : s.stationId}</option>`;
    })
    .join('');
  if (!train.stops.some((s) => s.stationId === state.dispatchStationId)) {
    state.dispatchStationId = train.stops[0].stationId;
  }
  el.dispatchStation.value = state.dispatchStationId;
}

function renderDispatchTab() {
  const train = state.diagram.trains.find((t) => t.id === state.dispatchTrainId);
  renderDiagram(
    el.dispatchDiagram,
    { stations: state.diagram.line.stations, trains: state.diagram.trains },
    { highlightTrainId: train?.id, adjustedTrain: state.adjustedTrain }
  );
  el.dispatchTable.innerHTML = state.adjustedTrain ? stopTableHtml(state.diagram, { trainOverride: state.adjustedTrain }) : stopTableHtml(state.diagram);
}

el.dispatchTrain.addEventListener('change', () => {
  state.dispatchTrainId = el.dispatchTrain.value;
  state.adjustedTrain = null;
  updateDispatchStationOptions();
  renderDispatchTab();
});

el.dispatchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const train = state.diagram.trains.find((t) => t.id === state.dispatchTrainId);
  if (!train) return;
  state.dispatchStationId = el.dispatchStation.value;
  state.dispatchDelta = Number(el.dispatchDelta.value) || 0;
  state.adjustedTrain = applyDelay(train, state.dispatchStationId, state.dispatchDelta);
  renderDispatchTab();
});

el.dispatchReset.addEventListener('click', () => {
  state.adjustedTrain = null;
  renderDispatchTab();
});

// ---------- 実績 ----------

function deltaSeconds(planned, actual) {
  const p = parseTime(planned);
  const a = parseTime(actual);
  if (p == null || a == null) return null;
  return a - p;
}

function actualTableHtml() {
  const header = '<tr><th>列車</th><th>駅</th><th>計画着</th><th>実績着</th><th>差</th><th>計画発</th><th>実績発</th><th>差</th></tr>';
  const rows = [];
  for (const train of state.diagram.trains) {
    for (const stop of train.stops) {
      const station = state.diagram.line.stations.find((s) => s.id === stop.stationId);
      const key = `${train.id}:${stop.stationId}`;
      const actual = state.actualByTrainStation.get(key) || {};
      const arrDelta = deltaSeconds(stop.arrival, actual.arrival);
      const depDelta = deltaSeconds(stop.departure, actual.departure);
      rows.push(`
        <tr>
          <th>${train.number}</th>
          <th>${station ? station.name : stop.stationId}</th>
          <td>${stop.arrival ?? '—'}</td>
          <td>${stop.arrival != null ? `<input data-key="${key}" data-field="arrival" value="${actual.arrival ?? ''}" placeholder="HH:MM:SS" />` : '—'}</td>
          <td class="${deltaClass(arrDelta)}">${formatDelta(arrDelta)}</td>
          <td>${stop.departure ?? '—'}</td>
          <td>${stop.departure != null ? `<input data-key="${key}" data-field="departure" value="${actual.departure ?? ''}" placeholder="HH:MM:SS" />` : '—'}</td>
          <td class="${deltaClass(depDelta)}">${formatDelta(depDelta)}</td>
        </tr>`);
    }
  }
  return header + rows.join('');
}

function formatDelta(seconds) {
  if (seconds == null) return '';
  if (seconds === 0) return '±0';
  return seconds > 0 ? `+${seconds}秒` : `${seconds}秒`;
}

function deltaClass(seconds) {
  if (seconds == null) return '';
  return seconds > 0 ? 'delta-positive' : seconds < 0 ? 'delta-negative' : '';
}

function renderActualTab() {
  el.actualTable.innerHTML = actualTableHtml();
  el.actualTable.querySelectorAll('input').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.key;
      const field = input.dataset.field;
      const entry = state.actualByTrainStation.get(key) || {};
      entry[field] = input.value.trim() || null;
      state.actualByTrainStation.set(key, entry);
      renderActualTab(); // re-render to recompute the delta column; loses focus, acceptable for this skeleton
    });
  });
}

// ---------- ファイル操作（開く・保存・最近使ったファイル） ----------
//
// 独自の .tline.json 形式のみ対応（計画データの line/trains をそのまま
// JSON化したもの）。.oud/.oud2のインポートは時刻エンコード(EkiJikoku)が
// 未解読のため未対応（NOTES.md参照）。

function isValidDiagram(d) {
  return !!d && !!d.line && Array.isArray(d.line.stations) && Array.isArray(d.trains);
}

function basename(filePath) {
  return filePath.split(/[\\/]/).pop();
}

function updateFileLabel() {
  el.currentFileLabel.textContent = state.currentFilePath ? basename(state.currentFilePath) : '（サンプルデータ）';
  el.currentFileLabel.title = state.currentFilePath || '';
  el.btnFileSave.disabled = !state.currentFilePath;
  el.planNote.textContent = state.currentFilePath
    ? `${state.currentFilePath} を表示しています。`
    : 'サンプルダイヤ（data/sampleDiagram.mjs）を表示しています。';
}

// 開いたファイル・新規保存後、いずれもここを通って画面全体を更新する。
// 運転整理・実績のその場限りの作業状態（adjustedTrain/actualByTrainStation）
// は新しいダイヤに対しては意味を持たないためリセットする。
function loadDiagram(diagram, filePath) {
  if (!isValidDiagram(diagram)) {
    window.alert('ダイヤファイルの形式が正しくありません（line.stations / trains が必要です）。');
    return;
  }
  state.diagram = diagram;
  state.currentFilePath = filePath || null;
  state.dispatchTrainId = diagram.trains[0]?.id ?? null;
  state.dispatchStationId = diagram.trains[0]?.stops?.[0]?.stationId ?? null;
  state.adjustedTrain = null;
  state.actualByTrainStation = new Map();

  updateFileLabel();
  renderPlanTab();
  populateDispatchSelectors();
  renderDispatchTab();
  renderActualTab();
}

async function refreshRecentFiles() {
  const list = await window.tline.getRecentFiles();
  el.recentFilesSelect.innerHTML =
    '<option value="">最近使ったファイル…</option>' + list.map((e) => `<option value="${e.path}">${e.name}</option>`).join('');
}

el.btnFileOpen.addEventListener('click', async () => {
  const filePath = await window.tline.chooseOpenPath();
  if (!filePath) return;
  try {
    const { diagram } = await window.tline.openFile(filePath);
    loadDiagram(diagram, filePath);
    await refreshRecentFiles();
  } catch (err) {
    window.alert(`ファイルを開けませんでした: ${err && err.message ? err.message : err}`);
  }
});

el.btnFileSave.addEventListener('click', async () => {
  if (!state.currentFilePath) return;
  await window.tline.saveFile(state.currentFilePath, state.diagram);
  await refreshRecentFiles();
});

el.btnFileSaveAs.addEventListener('click', async () => {
  const defaultName = state.currentFilePath ? basename(state.currentFilePath) : 'diagram.tline.json';
  const filePath = await window.tline.chooseSavePath(defaultName);
  if (!filePath) return;
  await window.tline.saveFile(filePath, state.diagram);
  state.currentFilePath = filePath;
  updateFileLabel();
  await refreshRecentFiles();
});

el.recentFilesSelect.addEventListener('change', async () => {
  const filePath = el.recentFilesSelect.value;
  if (!filePath) return;
  try {
    const { diagram } = await window.tline.openFile(filePath);
    loadDiagram(diagram, filePath);
  } catch (err) {
    window.alert(`ファイルを開けませんでした: ${err && err.message ? err.message : err}`);
    await window.tline.removeRecentFile(filePath);
  }
  await refreshRecentFiles();
  el.recentFilesSelect.value = '';
});

// ---------- Init ----------

updateFileLabel();
renderPlanTab();
populateDispatchSelectors();
renderDispatchTab();
renderActualTab();
refreshRecentFiles();
