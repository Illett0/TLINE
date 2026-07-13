import { sampleDiagram } from '../data/sampleDiagram.mjs';
import { renderDiagram } from './diagramView.mjs';
import { applyDelay } from './dispatch.mjs';
import { parseTime } from './timeUtils.mjs';

const state = {
  diagram: sampleDiagram, // 計画。ファイルを開くとその内容に差し替わる（state.currentFilePath参照）
  currentFilePath: null, // null = サンプルデータのまま未保存・未オープン、または.oudインポート直後（保存先未確定）
  currentFileDescription: null, // currentFilePathがnullの間だけ使う表示ラベル（.oudインポート時。「サンプルデータ」と区別するため）
  dispatchTrainId: sampleDiagram.trains[0]?.id ?? null,
  dispatchStationId: sampleDiagram.trains[0]?.stops[0]?.stationId ?? null,
  dispatchDelta: 90,
  adjustedTrain: null, // set once 適用 is pressed; cleared by リセット
  actualByTrainStation: new Map(), // `${trainId}:${stationId}` -> { arrival, departure }
  actualCompareTarget: 'plan', // 'plan' | 'dispatch' — 実績タブで何と差分を取るか（issue #7）
  pendingOudImport: null, // { filePath, lineName } while the Dia picker is shown; null otherwise
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
  actualCompareTarget: document.getElementById('actual-compare-target'),
  actualCompareNote: document.getElementById('actual-compare-note'),
  currentFileLabel: document.getElementById('current-file-label'),
  btnFileOpen: document.getElementById('btn-file-open'),
  btnFileSave: document.getElementById('btn-file-save'),
  btnFileSaveAs: document.getElementById('btn-file-save-as'),
  recentFilesSelect: document.getElementById('recent-files-select'),
  btnOudImport: document.getElementById('btn-oud-import'),
  oudImportPanel: document.getElementById('oud-import-panel'),
  oudImportLabel: document.getElementById('oud-import-label'),
  oudDiaSelect: document.getElementById('oud-dia-select'),
  oudDiaConfirm: document.getElementById('oud-dia-confirm'),
  oudDiaCancel: document.getElementById('oud-dia-cancel'),
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
  renderActualTab(); // adjustedTrainがクリアされたので実績タブの比較基準（issue #7）も更新
});

el.dispatchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const train = state.diagram.trains.find((t) => t.id === state.dispatchTrainId);
  if (!train) return;
  state.dispatchStationId = el.dispatchStation.value;
  state.dispatchDelta = Number(el.dispatchDelta.value) || 0;
  state.adjustedTrain = applyDelay(train, state.dispatchStationId, state.dispatchDelta);
  renderDispatchTab();
  renderActualTab();
});

el.dispatchReset.addEventListener('click', () => {
  state.adjustedTrain = null;
  renderDispatchTab();
  renderActualTab();
});

// ---------- 実績 ----------

function deltaSeconds(planned, actual) {
  const p = parseTime(planned);
  const a = parseTime(actual);
  if (p == null || a == null) return null;
  return a - p;
}

function actualTableHtml() {
  const compareToDispatch = state.actualCompareTarget === 'dispatch';
  const baseLabel = compareToDispatch ? '整理後' : '計画';
  const header = `<tr><th>列車</th><th>駅</th><th>${baseLabel}着</th><th>実績着</th><th>差</th><th>${baseLabel}発</th><th>実績発</th><th>差</th></tr>`;
  const rows = [];
  for (const train of state.diagram.trains) {
    // 「運転整理後」比較時、state.adjustedTrainは常に1列車分しか保持していない
    // （運転整理タブのv1仕様）ため、選択中の列車だけ整理後時刻、他は計画時刻のまま。
    const baseline = compareToDispatch && state.adjustedTrain && state.adjustedTrain.id === train.id ? state.adjustedTrain : train;
    for (const stop of baseline.stops) {
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

function actualCompareNoteText() {
  if (state.actualCompareTarget !== 'dispatch') return '';
  if (!state.adjustedTrain) return '運転整理タブでダイヤを適用すると、その列車のみ整理後ダイヤと比較します（未適用の列車は計画のままです）。';
  return `「${state.adjustedTrain.number}」のみ運転整理後のダイヤと比較しています（他の列車は計画のままです）。`;
}

function renderActualTab() {
  el.actualCompareTarget.value = state.actualCompareTarget;
  el.actualCompareNote.textContent = actualCompareNoteText();
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

el.actualCompareTarget.addEventListener('change', () => {
  state.actualCompareTarget = el.actualCompareTarget.value;
  renderActualTab();
});

// ---------- ファイル操作（開く・保存・最近使ったファイル） ----------
//
// 独自の .tline 形式（計画データの line/trains をそのまま
// JSON化したもの）の開く・保存に加え、.oud/.oud2（OuDia/OuDiaSecond）
// からのインポートに対応（lib/oudParser.js、下記「.oud/.oud2インポート」
// 参照）。インポートしたダイヤは.tlineファイルとして開いたものでは
// ないため、取り込み後はcurrentFilePathをnull（サンプルデータと同様の
// 「未保存」扱い）にする——保存するには「名前を付けて保存」が必要。

function isValidDiagram(d) {
  return !!d && !!d.line && Array.isArray(d.line.stations) && Array.isArray(d.trains);
}

function basename(filePath) {
  return filePath.split(/[\\/]/).pop();
}

function updateFileLabel() {
  const label = state.currentFilePath ? basename(state.currentFilePath) : state.currentFileDescription || '（サンプルデータ）';
  el.currentFileLabel.textContent = label;
  el.currentFileLabel.title = state.currentFilePath || '';
  el.btnFileSave.disabled = !state.currentFilePath;
  if (state.currentFilePath) {
    el.planNote.textContent = `${state.currentFilePath} を表示しています。`;
  } else if (state.currentFileDescription) {
    el.planNote.textContent = `${state.currentFileDescription} を表示しています（保存するには「名前を付けて保存」）。`;
  } else {
    el.planNote.textContent = 'サンプルダイヤ（data/sampleDiagram.mjs）を表示しています。';
  }
}

// 開いたファイル・新規保存後・.oudインポート後、いずれもここを通って画面
// 全体を更新する。運転整理・実績のその場限りの作業状態
// （adjustedTrain/actualByTrainStation）は新しいダイヤに対しては意味を
// 持たないためリセットする。
// `description` は.oudインポートなどcurrentFilePathを持たない取り込みで、
// 「サンプルデータ」表示と区別するためのラベル（例:「碧洛電車.oud2 / 通常」）。
function loadDiagram(diagram, filePath, description) {
  if (!isValidDiagram(diagram)) {
    window.alert('ダイヤファイルの形式が正しくありません（line.stations / trains が必要です）。');
    return;
  }
  state.diagram = { line: diagram.line, trains: diagram.trains }; // dispatch/actualはrestoreOpsExtrasが別途扱う（state.diagramには含めない）
  state.currentFilePath = filePath || null;
  state.currentFileDescription = filePath ? null : description || null;
  state.dispatchTrainId = diagram.trains[0]?.id ?? null;
  state.dispatchStationId = diagram.trains[0]?.stops?.[0]?.stationId ?? null;
  state.adjustedTrain = null;
  state.actualByTrainStation = new Map();
  state.actualCompareTarget = 'plan';

  updateFileLabel();
  renderPlanTab();
  populateDispatchSelectors();
  renderDispatchTab();
  renderActualTab();
}

// 運転整理・実績の保存形式（issue #3、確定）: 計画(line/trains)と同じ.tline
// ファイル内に、任意の`dispatch`/`actual`セクションを追加する（別拡張子・別
// ファイルにはしない）。どちらのキーもない旧来のplanのみ.tlineファイルも
// そのまま開ける後方互換を維持する。
// - dispatch: 運転整理タブの最後の適用状態（v1同様、保持できるのは1列車分のみ）
//   { trainId, fromStationId, deltaSeconds }
// - actual: 実績タブの入力値。MapはJSON化できないのでObjectにして保存し、
//   読み込み時にMapへ戻す。 { "trainId:stationId": { arrival, departure } }
function buildSavePayload() {
  const payload = { line: state.diagram.line, trains: state.diagram.trains };
  if (state.adjustedTrain) {
    payload.dispatch = { trainId: state.dispatchTrainId, fromStationId: state.dispatchStationId, deltaSeconds: state.dispatchDelta };
  }
  if (state.actualByTrainStation.size > 0) {
    payload.actual = Object.fromEntries(state.actualByTrainStation);
  }
  return payload;
}

// loadDiagram()がplan(line/trains)を読み込んだ直後に呼ぶ。dispatch/actualは
// state.diagramに含めない別セクションなので、loadDiagramのリセット処理の
// あとに改めて復元する。
function restoreOpsExtras(loaded) {
  if (loaded.dispatch) {
    const train = state.diagram.trains.find((t) => t.id === loaded.dispatch.trainId);
    if (train) {
      state.dispatchTrainId = loaded.dispatch.trainId;
      state.dispatchStationId = loaded.dispatch.fromStationId;
      state.dispatchDelta = loaded.dispatch.deltaSeconds;
      state.adjustedTrain = applyDelay(train, loaded.dispatch.fromStationId, loaded.dispatch.deltaSeconds);
      populateDispatchSelectors();
      renderDispatchTab();
    }
  }
  if (loaded.actual) {
    state.actualByTrainStation = new Map(Object.entries(loaded.actual));
  }
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
    restoreOpsExtras(diagram);
    await refreshRecentFiles();
  } catch (err) {
    window.alert(`ファイルを開けませんでした: ${err && err.message ? err.message : err}`);
  }
});

el.btnFileSave.addEventListener('click', async () => {
  if (!state.currentFilePath) return;
  await window.tline.saveFile(state.currentFilePath, buildSavePayload());
  await refreshRecentFiles();
});

el.btnFileSaveAs.addEventListener('click', async () => {
  const defaultName = state.currentFilePath ? basename(state.currentFilePath) : 'diagram.tline';
  const filePath = await window.tline.chooseSavePath(defaultName);
  if (!filePath) return;
  await window.tline.saveFile(filePath, buildSavePayload());
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
    restoreOpsExtras(diagram);
  } catch (err) {
    window.alert(`ファイルを開けませんでした: ${err && err.message ? err.message : err}`);
    await window.tline.removeRecentFile(filePath);
  }
  await refreshRecentFiles();
  el.recentFilesSelect.value = '';
});

// ---------- .oud/.oud2インポート ----------
//
// 2段階フロー: ファイルを選ぶ→Dia一覧を取得（複数持つファイルが普通、
// NOTES.md参照）→ユーザーがDiaを選んで「取り込む」でTLINEのデータモデルに
// 変換して読み込む。取り込み後、未確定（timesConfident:false）の列車が
// あれば件数を知らせる（見た目上の区別はissue #1の今後の課題）。

function hideOudImportPanel() {
  state.pendingOudImport = null;
  el.oudImportPanel.classList.add('hidden');
  el.oudDiaSelect.innerHTML = '';
}

el.btnOudImport.addEventListener('click', async () => {
  const filePath = await window.tline.chooseOpenOudPath();
  if (!filePath) return;
  try {
    const { lineName, dias } = await window.tline.listOudDias(filePath);
    if (dias.length === 0) {
      window.alert('このファイルにはダイヤ（Dia）が見つかりませんでした。');
      return;
    }
    state.pendingOudImport = { filePath, lineName };
    el.oudImportLabel.textContent = `${basename(filePath)}（${lineName || '路線名なし'}）`;
    el.oudDiaSelect.innerHTML = dias.map((d) => `<option value="${d.index}">${d.name}（${d.trainCount}本）</option>`).join('');
    el.oudImportPanel.classList.remove('hidden');
  } catch (err) {
    window.alert(`OuDiaファイルを読み込めませんでした: ${err && err.message ? err.message : err}`);
  }
});

el.oudDiaConfirm.addEventListener('click', async () => {
  if (!state.pendingOudImport) return;
  const diaIndex = Number(el.oudDiaSelect.value);
  try {
    const { diagram, stats } = await window.tline.importOud(state.pendingOudImport.filePath, diaIndex);
    loadDiagram(diagram, null, `${basename(state.pendingOudImport.filePath)} / ${stats.diaName}`);
    hideOudImportPanel();
    const notes = [];
    if (stats.skippedTrains > 0) notes.push(`時刻データのない${stats.skippedTrains}本は除外`);
    if (stats.unconfidentTrains > 0) notes.push(`${stats.unconfidentTrains}本は時刻の解読精度が低い可能性あり`);
    window.alert(`「${stats.diaName}」から${stats.importedTrains}本の列車を取り込みました。${notes.length ? '（' + notes.join('、') + '）' : ''}`);
  } catch (err) {
    window.alert(`ダイヤを取り込めませんでした: ${err && err.message ? err.message : err}`);
  }
});

el.oudDiaCancel.addEventListener('click', () => {
  hideOudImportPanel();
});

// ---------- Init ----------

updateFileLabel();
renderPlanTab();
populateDispatchSelectors();
renderDispatchTab();
renderActualTab();
refreshRecentFiles();
