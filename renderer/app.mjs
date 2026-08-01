import { sampleDiagram } from '../data/sampleDiagram.mjs';
import { renderDiagram, MARGIN } from './diagramView.mjs';
import { applyDelay, findNewTrackConflicts } from './dispatch.mjs';
import { segmentTimeRange, findDutyOverlaps, findDutiesBrokenByAdjustment } from './duty.mjs';
import { parseTime, shiftTime, formatTime } from './timeUtils.mjs';

// ローカルタイムゾーンでの今日の日付（YYYY-MM-DD）。<input type="date">の
// value形式に合わせる。toISOString()はUTC基準で日本の早朝に前日へずれる
// ため使わない。
function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ズーム倍率の範囲（縦=駅間隔、横=時間軸）。stepDiagramZoomY/setupDiagramPanZoom
// の外側（state初期化）でも使うため先出しで定義。
const ZOOM_Y_MIN = 0.3;
const ZOOM_Y_MAX = 4;
const ZOOM_X_MIN = 0.3;
const ZOOM_X_MAX = 6;

// localStorageに保存したズーム倍率を読み戻す（2026-07-15、要望「ズーム倍率
// をキャッシュできますか」）。数値でない・範囲外（保存後にMIN/MAXを変えた
// 場合等）はデフォルト1に戻す。テーマ設定（下記state.theme）と同じ
// localStorage直読みパターン。
function loadStoredZoom(key, min, max) {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : 1;
}

const state = {
  diagram: sampleDiagram, // 計画。ファイルを開くとその内容に差し替わる（state.currentFilePath参照）
  currentFilePath: null, // null = サンプルデータのまま未保存・未オープン、または.oudインポート直後（保存先未確定）
  currentFileDescription: null, // currentFilePathがnullの間だけ使う表示ラベル（.oudインポート時。「サンプルデータ」と区別するため）
  dispatchTrainId: sampleDiagram.trains[0]?.id ?? null,
  dispatchStationId: sampleDiagram.trains[0]?.stops[0]?.stationId ?? null,
  dispatchDelta: 90,
  adjustedTrain: null, // set once 適用 is pressed; cleared by リセット
  // 実績は運転日ごとに独立したマップで持つ（issue #5、2026-07-15）:
  // 日付文字列(YYYY-MM-DD) -> Map(`${trainId}:${stationId}` ->
  // { arrival, departure, manualArrival?, manualDeparture? })。
  // manual*フラグは「ユーザーが手入力した」印——遅延の自動補完
  // （propagateActualDelay）は手入力セルを上書きしない（自動補完で埋めた
  // セルはフラグなし＝後からの再補完で更新される）。
  actualByDate: new Map(),
  actualDate: todayDateString(), // 実績タブで表示・編集中の運転日
  actualAutoComplete: true, // 入力駅以降へ同じ遅延を自動反映するか（issue #5）
  actualCompareTarget: 'plan', // 'plan' | 'dispatch' — 実績タブで何と差分を取るか（issue #7）
  pendingOudImport: null, // { filePath, lineName } while the Dia picker is shown; null otherwise
  diagramZoomY: loadStoredZoom('tline-zoom-y', ZOOM_Y_MIN, ZOOM_Y_MAX), // 縦方向（駅間隔）のズーム。ヘッダー横のボタンで変更（2026-07-14、専用ボタン化）。前回値をlocalStorageから復元
  diagramZoomX: loadStoredZoom('tline-zoom-x', ZOOM_X_MIN, ZOOM_X_MAX), // マウスホイールによる横方向（時間軸）のみのズーム。縦はdiagramZoomYのみに従う（下記setupDiagramPanZoom参照）。前回値をlocalStorageから復元
  // 4タブ（計画/運転整理/実績/仕業）はそれぞれ別のdiagram-container要素を
  // 持つため、スクロール位置はDOM上は独立している。ズーム率と同様
  // state側で共通に持ち、setupDiagramPanZoomのscrollイベントで更新・
  // タブ切り替え/再描画のたびに反映することで「どのタブでも同じ表示範囲」
  // にする（2026-08-01要望）。localStorage永続化はしない（ズームと違い
  // セッションをまたいで復元する価値は薄いため）。
  diagramScrollLeft: 0,
  diagramScrollTop: 0,
  theme: ['light', 'classic'].includes(localStorage.getItem('tline-theme')) ? localStorage.getItem('tline-theme') : 'dark', // ダーク/ライト/クラシック（issue #8）
  // 入出庫・運用関連の5トグル（2026-07-14、issue #10）。元は「入出庫記号」
  // 「運用番号」の2つだったが、①運用のつなぎ線は入出庫記号と独立にON/OFF
  // したい、②運用番号ラベルは「入出庫（チェーンなし端点）」と「折り返し
  // （チェーンあり端点）」で意味が違うので分けたい、③新設の列車番号表示も
  // 独立トグルにしたい、という要望で5つに分割した。
  showDepotMarkers: true, // 入出庫記号（○出区／▽入区）
  showChainLines: true, // 運用のつなぎ線（列車間の折り返し接続、lib/oudParser.jsのinferOperationChains）
  showDepotOperationNumbers: true, // 入出庫運番（チェーンが見つからなかった端点の運用番号ラベル）
  showTurnbackOperationNumbers: true, // 折り返し運番（チェーンが見つかった端点の運用番号ラベル）
  showTrainNumbers: true, // 列車番号ラベル
  // issue #2「仕業」: .oud/.oud2に存在しないTLINE独自データ（duty.mjs doc
  // comment参照）。`duties`は保存済みの仕業一覧、`dutyDraft`は仕業タブの
  // フォームで編集中の1件（新規なら`id: null`）。診断: どちらも現在開いて
  // いるダイヤのtrainId/stationIdを参照するため、loadDiagramで毎回リセット
  // する（運転整理のadjustedTrain・実績のactualByDateと同じ扱い）。
  duties: [],
  dutyDraft: { id: null, name: '', segments: [] },
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
  dispatchConflicts: document.getElementById('dispatch-conflicts'),
  dispatchDiagram: document.getElementById('dispatch-diagram'),
  dispatchTable: document.getElementById('dispatch-table'),
  planZoomIn: document.getElementById('plan-zoom-in'),
  planZoomOut: document.getElementById('plan-zoom-out'),
  planZoomLabel: document.getElementById('plan-zoom-label'),
  dispatchZoomIn: document.getElementById('dispatch-zoom-in'),
  dispatchZoomOut: document.getElementById('dispatch-zoom-out'),
  dispatchZoomLabel: document.getElementById('dispatch-zoom-label'),
  actualZoomIn: document.getElementById('actual-zoom-in'),
  actualZoomOut: document.getElementById('actual-zoom-out'),
  actualZoomLabel: document.getElementById('actual-zoom-label'),
  actualDiagram: document.getElementById('actual-diagram'),
  dutyZoomIn: document.getElementById('duty-zoom-in'),
  dutyZoomOut: document.getElementById('duty-zoom-out'),
  dutyZoomLabel: document.getElementById('duty-zoom-label'),
  themeSelect: document.getElementById('theme-select'),
  planShowDepot: document.getElementById('plan-show-depot'),
  planShowChainLink: document.getElementById('plan-show-chainlink'),
  planShowDepotOpnum: document.getElementById('plan-show-depot-opnum'),
  planShowTurnbackOpnum: document.getElementById('plan-show-turnback-opnum'),
  planShowTrainNum: document.getElementById('plan-show-trainnum'),
  dispatchShowDepot: document.getElementById('dispatch-show-depot'),
  dispatchShowChainLink: document.getElementById('dispatch-show-chainlink'),
  dispatchShowDepotOpnum: document.getElementById('dispatch-show-depot-opnum'),
  dispatchShowTurnbackOpnum: document.getElementById('dispatch-show-turnback-opnum'),
  dispatchShowTrainNum: document.getElementById('dispatch-show-trainnum'),
  actualTable: document.getElementById('actual-table'),
  actualCompareTarget: document.getElementById('actual-compare-target'),
  actualCompareNote: document.getElementById('actual-compare-note'),
  actualDate: document.getElementById('actual-date'),
  actualAutoComplete: document.getElementById('actual-autocomplete'),
  currentFileLabel: document.getElementById('current-file-label'),
  btnFileOpen: document.getElementById('btn-file-open'),
  btnFileSave: document.getElementById('btn-file-save'),
  btnFileSaveAs: document.getElementById('btn-file-save-as'),
  recentFilesSelect: document.getElementById('recent-files-select'),
  oudImportPanel: document.getElementById('oud-import-panel'),
  oudImportLabel: document.getElementById('oud-import-label'),
  oudDiaSelect: document.getElementById('oud-dia-select'),
  oudDiaConfirm: document.getElementById('oud-dia-confirm'),
  oudDiaCancel: document.getElementById('oud-dia-cancel'),
  appToast: document.getElementById('app-toast'),
  appToastMessage: document.getElementById('app-toast-message'),
  appToastClose: document.getElementById('app-toast-close'),
  dutySegmentForm: document.getElementById('duty-segment-form'),
  dutySegmentTrain: document.getElementById('duty-segment-train'),
  dutySegmentFrom: document.getElementById('duty-segment-from'),
  dutySegmentTo: document.getElementById('duty-segment-to'),
  dutySegmentTable: document.getElementById('duty-segment-table'),
  dutySaveForm: document.getElementById('duty-save-form'),
  dutyName: document.getElementById('duty-name'),
  dutyNew: document.getElementById('duty-new'),
  dutyDiagram: document.getElementById('duty-diagram'),
  dutyListTable: document.getElementById('duty-list-table'),
};

// ---------- 通知トースト（window.alert()の非モーダル代替。style.cssの
// .app-toastコメント参照） ----------

let toastHideTimer = null;
function showToast(message, kind = 'info') {
  el.appToastMessage.textContent = message;
  el.appToast.classList.toggle('app-toast--error', kind === 'error');
  el.appToast.classList.remove('hidden');
  clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => el.appToast.classList.add('hidden'), kind === 'error' ? 8000 : 5000);
}
el.appToastClose.addEventListener('click', () => {
  clearTimeout(toastHideTimer);
  el.appToast.classList.add('hidden');
});

// ---------- Tabs ----------
//
// renderTabLazy（2026-07-15、報告「Noout系ファイルでズーム・縦割合変更が
// 重い」への対応）: ズーム・テーマ・表示トグルはすべて計画・運転整理
// 両タブ共通のstate（diagramZoomY/X等）を書き換えるため、以前は変更の
// たびに両タブのrenderPlanTab/renderDispatchTab（ダイヤグラムSVG＋
// タイムテーブルHTMLの丸ごと再構築、駅×列車数に比例して重い）を無条件で
// 呼んでいた——ホイールでのズームは1操作で何十回もfireするうえ、常に
// 「今見えていない方のタブ」の分は完全に無駄な作業だった。表示中のタブ
// だけ即座に再描画し、非表示側は「dirty」フラグだけ立てて、実際にその
// タブに切り替えられた瞬間に描く（結果は同じ、無駄な作業をしないだけ）。
const dirtyTabs = { plan: false, dispatch: false, actual: false, duty: false };
function isTabActive(tabId) {
  return document.getElementById(`tab-${tabId}`).classList.contains('active');
}
function renderTabLazy(tabId, renderFn) {
  if (isTabActive(tabId)) {
    renderFn();
    dirtyTabs[tabId] = false;
  } else {
    dirtyTabs[tabId] = true;
  }
}

for (const button of el.tabButtons) {
  button.addEventListener('click', () => {
    for (const b of el.tabButtons) b.classList.toggle('active', b === button);
    for (const panel of el.tabPanels) panel.classList.toggle('active', panel.id === `tab-${button.dataset.tab}`);
    const tabId = button.dataset.tab;
    if (tabId === 'plan' && dirtyTabs.plan) renderTabLazy('plan', renderPlanTab);
    if (tabId === 'dispatch' && dirtyTabs.dispatch) renderTabLazy('dispatch', renderDispatchTab);
    if (tabId === 'actual' && dirtyTabs.actual) renderTabLazy('actual', renderActualTab);
    if (tabId === 'duty' && dirtyTabs.duty) renderTabLazy('duty', renderDutyTab);
    // dirtyでなければ上のrenderTabLazyは何もしない（renderDiagramSynced経由
    // のスクロール同期も走らない）ので、切り替え先のタブが前回表示された
    // ときから他タブでスクロール/ズームされていた場合に備えてここでも
    // 直接合わせる（tabId+"Diagram"がel内の対応するcontainer参照と一致する
    // 命名規則、例: 'plan'->el.planDiagram）。
    const container = el[`${tabId}Diagram`];
    if (container) {
      container.scrollLeft = state.diagramScrollLeft;
      container.scrollTop = state.diagramScrollTop;
    }
  });
}

// ---------- 計画 ----------

// タイムテーブルの1マス（駅×列車）のHTML。2026-07-14の要望「発車時刻も
// 着時刻も縦で２ますつかうように」「番線表示も」「oud/oud2に主要駅/一般駅
// の設定が参照できるなら、主要駅は発車・着・番線の3マス、一般駅は発車時刻
// の1マスに」を反映。`station.scale`（lib/oudParser.jsのparseEkikibo、
// `.oud`/`.oud2`の`Ekikibo`プロパティ由来。手作成の計画データ等、由来がな
// ければ`undefined`）で3通りに分岐する:
//   'major'   — 主要駅: 着/発/番線の3マス（縦積み）
//   'general' — 一般駅: 発車時刻のみ1マス（発が無い列車の終着駅では着で代用）
//   それ以外  — 区分不明: 着/発の2マス（縦積み、区分ができるようになる前の
//               基本仕様。手作成の計画データはこちらに常に該当する）
// `isOrigin` — true when `stop` is the train's own first stop. A train's
// EkiJikoku never has a real arrival there (it starts existing on the line
// at that point) — decodeEkiJikoku's bare-single-time fallback just sets
// arrival=departure for display convenience, which read as a bogus
// "arrived, then immediately departed" at the origin (2026-07-15 report).
// Blanked here rather than reinterpreted, matching the ordinary empty-cell
// case elsewhere in this table — no extra centering/consolidation for the
// single remaining value (project owner: 中央揃えは不要、ないものは普通に空欄).
function stopCellHtml(stop, station, isOrigin) {
  if (!stop) return '<td class="stop-cell">—</td>';
  const arr = isOrigin ? '' : stop.arrival ?? '';
  const dep = stop.departure ?? '';

  if (station.scale === 'general') {
    // 一般駅は停車時分が短い前提で発車時刻のみ。終着駅（発が無い）は着で代用。
    return `<td class="stop-cell stop-cell--general">${dep || arr}</td>`;
  }
  // 始発駅（isOrigin）は構造上、実際の着時刻を持たない（decodeEkiJikokuの
  // 単一時刻フォールバックが着=発を仮に埋めるだけで、上のarrも常に空欄）。
  // 他の空欄マス（例: 終着駅の発）は従来通り空行のまま残すが、始発駅だけは
  // 空の着行そのものを描画せず、縦の無駄な空白を無くす（2026-07-16要望）。
  const arrRow = isOrigin ? '' : `<div class="stop-cell-row stop-cell-row--arr">${arr}</div>`;
  if (station.scale === 'major') {
    // trackLabel（lib/oudParser.jsのresolveTrackLabel）— その駅自身が宣言
    // した番線名（TrackRyakusyou優先）に解決済みの値。丸数字(①②③)・上本/
    // 下本・X/Y/Eのような非数値ラベルの駅では生の`$N`番号をそのまま出すと
    // 実物と食い違う（2026-07-15、プロジェクトオーナーからの実例で確認:
    // 大道寺の生値5は実際は「③」＝3番線）。解決できなかった場合（宣言なし
    // の駅・手作成の計画データ等）は従来通り生の数字にフォールバック。
    const track = stop.trackLabel ?? (stop.track != null ? `${stop.track}` : '');
    return (
      `<td class="stop-cell stop-cell--major">` +
      arrRow +
      `<div class="stop-cell-row stop-cell-row--dep">${dep}</div>` +
      `<div class="stop-cell-row stop-cell-row--track">${track}</div>` +
      `</td>`
    );
  }
  return `<td class="stop-cell stop-cell--basic">${arrRow}<div class="stop-cell-row stop-cell-row--dep">${dep}</div></td>`;
}

function stopTableHtml(diagram, { trainOverride } = {}) {
  const trains = trainOverride ? diagram.trains.map((t) => (t.id === trainOverride.id ? trainOverride : t)) : diagram.trains;
  const header = `<thead><tr><th>駅</th>${trains.map((t) => `<th>${t.number}</th>`).join('')}</tr></thead>`;
  const rows = diagram.line.stations
    .map((station) => {
      const cells = trains
        .map((t) => {
          const stop = t.stops.find((s) => s.stationId === station.id);
          return stopCellHtml(stop, station, stop === t.stops[0]);
        })
        .join('');
      // branchFromStationId (lib/oudParser.js, issue #6): this row is a
      // branch's re-listing of an earlier station (same name reappears
      // further down diagram.line.stations) — label it so it doesn't read
      // as a stray duplicate row; matches the "（支線）" annotation
      // renderer/diagramView.mjs adds at the same seam in the diagram.
      const name = station.branchFromStationId != null ? `${station.name}（支線）` : station.name;
      return `<tr><th>${name}</th>${cells}</tr>`;
    })
    .join('');
  return header + `<tbody>${rows}</tbody>`;
}

function diagramDisplayOptions() {
  return {
    zoomY: state.diagramZoomY,
    zoomX: state.diagramZoomX,
    theme: state.theme,
    showDepotMarkers: state.showDepotMarkers,
    showChainLines: state.showChainLines,
    showDepotOperationNumbers: state.showDepotOperationNumbers,
    showTurnbackOperationNumbers: state.showTurnbackOperationNumbers,
    showTrainNumbers: state.showTrainNumbers,
  };
}

// renderDiagram()に加えて、4タブ共通のスクロール位置（state.diagramScroll
// Left/Top、上記参照）をこの再描画のたびに適用する薄いラッパー。
// containerのinnerHTMLを丸ごと差し替えてもscrollLeft/Top自体は保持される
// が、タブ切り替え直後（別要素のスクロールをコピーする必要がある場合）や
// 他タブでのズーム変更後の初回再描画では明示的に合わせ直す必要がある。
function renderDiagramSynced(container, data, options) {
  renderDiagram(container, data, options);
  container.scrollLeft = state.diagramScrollLeft;
  container.scrollTop = state.diagramScrollTop;
}

function renderPlanTab() {
  renderDiagramSynced(el.planDiagram, { stations: state.diagram.line.stations, trains: state.diagram.trains }, diagramDisplayOptions());
  el.planTable.innerHTML = stopTableHtml(state.diagram);
}

// ---------- ダイヤグラムの表示設定（拡大率・テーマ・入出庫/運用系5トグル、計画・運転整理タブ共通） ----------
//
// issue #8（拡大縮小・テーマ）、参考画像Diagram/image/06123.png（入出庫記号・
// 運用番号）参照。入出庫記号・運用つなぎ線・運用番号（入出庫/折り返し）・
// 列車番号は`lib/oudParser.js`のOperationプロパティ解読／inferOperationChains
// が公式仕様の裏付けなし・統計的推定/ヒューリスティックであるため、デフォ
// ルトONにしつつ簡単にOFFにできるようトグルを用意している（NOTES.md参照）。

function updateDiagramControls() {
  const zoomLabel = `${Math.round(state.diagramZoomY * 100)}%`;
  el.planZoomLabel.textContent = zoomLabel;
  el.dispatchZoomLabel.textContent = zoomLabel;
  el.actualZoomLabel.textContent = zoomLabel;
  el.dutyZoomLabel.textContent = zoomLabel;
  el.planShowDepot.checked = state.showDepotMarkers;
  el.dispatchShowDepot.checked = state.showDepotMarkers;
  el.planShowChainLink.checked = state.showChainLines;
  el.dispatchShowChainLink.checked = state.showChainLines;
  el.planShowDepotOpnum.checked = state.showDepotOperationNumbers;
  el.dispatchShowDepotOpnum.checked = state.showDepotOperationNumbers;
  el.planShowTurnbackOpnum.checked = state.showTurnbackOperationNumbers;
  el.dispatchShowTurnbackOpnum.checked = state.showTurnbackOperationNumbers;
  el.planShowTrainNum.checked = state.showTrainNumbers;
  el.dispatchShowTrainNum.checked = state.showTrainNumbers;
  el.themeSelect.value = state.theme;
}

// 縦方向（駅間隔）ズームは専用の＋/－ボタンで変更する（2026-07-14、
// スライダーから変更——横方向はダイヤグラム上のホイール操作に一本化した
// ため、スライダーが縦横どちらを動かしているのか分かりにくかった）。
// ZOOM_Y_MIN/MAXはstate初期化（localStorageからの復元）でも使うため
// ファイル先頭で定義済み。
const ZOOM_Y_STEP = 1.15; // ボタン1クリックあたりの倍率

function stepDiagramZoomY(factor) {
  state.diagramZoomY = Math.min(ZOOM_Y_MAX, Math.max(ZOOM_Y_MIN, state.diagramZoomY * factor));
  localStorage.setItem('tline-zoom-y', String(state.diagramZoomY));
  updateDiagramControls();
  renderTabLazy('plan', renderPlanTab);
  renderTabLazy('dispatch', renderDispatchTab);
  renderTabLazy('actual', renderActualTab);
  renderTabLazy('duty', renderDutyTab);
}

el.planZoomIn.addEventListener('click', () => stepDiagramZoomY(ZOOM_Y_STEP));
el.planZoomOut.addEventListener('click', () => stepDiagramZoomY(1 / ZOOM_Y_STEP));
el.dispatchZoomIn.addEventListener('click', () => stepDiagramZoomY(ZOOM_Y_STEP));
el.dispatchZoomOut.addEventListener('click', () => stepDiagramZoomY(1 / ZOOM_Y_STEP));
el.actualZoomIn.addEventListener('click', () => stepDiagramZoomY(ZOOM_Y_STEP));
el.actualZoomOut.addEventListener('click', () => stepDiagramZoomY(1 / ZOOM_Y_STEP));
el.dutyZoomIn.addEventListener('click', () => stepDiagramZoomY(ZOOM_Y_STEP));
el.dutyZoomOut.addEventListener('click', () => stepDiagramZoomY(1 / ZOOM_Y_STEP));

// ---------- ダイヤグラムのドラッグ操作（左右どちらのボタンでもパン）・ホイール操作（横方向のみズーム） ----------
//
// OuDiaSecondや一般的な地図/図面ビューアの操作感を参考にした便利機能:
// 左右どちらかのボタンを押したままドラッグでスクロール（2026-08-01、
// 「左ドラッグでもパンできるように」——元は右クリックのみで左は将来の
// 選択操作用に空けておく方針だったが、選択機能自体が未実装かつSVG側にも
// クリックで反応する要素が無いため両方に開放した）、マウスホイールは縦
// （駅間隔）を変えず横（時間軸）だけをズームする（diagramView.mjsの
// renderDiagramの`zoomX`引数）。カーソル位置の時刻がズーム後も画面上の
// 同じ位置に留まるよう、スクロール位置を補正する（地図アプリ等でおなじみ
// の「カーソル位置を中心にズーム」の挙動）。
// ZOOM_X_MIN/MAXはstate初期化（localStorageからの復元）でも使うため
// ファイル先頭で定義済み。
const ZOOM_X_STEP = 1.12; // ホイール1ノッチあたりの倍率

function setupDiagramPanZoom(container) {
  let dragging = false;
  let dragButton = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartScrollLeft = 0;
  let dragStartScrollTop = 0;

  // 右クリックでの独自パン操作を割り当てているため、既定のコンテキスト
  // メニューは常に抑止する。
  container.addEventListener('contextmenu', (e) => e.preventDefault());

  // 左右どちらのボタンでもパンできる（2026-08-01要望）。左は元々「将来の
  // 選択操作用に空けておく」方針だったが、まだ選択機能自体が無く、SVG側に
  // クリックで反応する要素（列車線など）も無いため、今のところ競合しない。
  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    dragging = true;
    dragButton = e.button;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartScrollLeft = container.scrollLeft;
    dragStartScrollTop = container.scrollTop;
    container.classList.add('diagram-container--dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    container.scrollLeft = dragStartScrollLeft - (e.clientX - dragStartX);
    container.scrollTop = dragStartScrollTop - (e.clientY - dragStartY);
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragging || e.button !== dragButton) return;
    dragging = false;
    dragButton = null;
    container.classList.remove('diagram-container--dragging');
  });

  // どのタブのダイヤグラムを見ても同じ表示範囲になるよう、スクロール位置
  // もズーム率と同様state共通にする（2026-08-01要望）。上のドラッグ・下の
  // ホイールズームどちらの経路でもscrollLeft/Topの代入は最終的にここを
  // 通る（プログラムからの代入でも'scroll'イベントは発火する）ので、
  // 個別に同期処理を書く必要はない。
  container.addEventListener('scroll', () => {
    state.diagramScrollLeft = container.scrollLeft;
    state.diagramScrollTop = container.scrollTop;
  });

  container.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const oldZoomX = state.diagramZoomX;
      const newZoomX = Math.min(ZOOM_X_MAX, Math.max(ZOOM_X_MIN, oldZoomX * (e.deltaY < 0 ? ZOOM_X_STEP : 1 / ZOOM_X_STEP)));
      if (newZoomX === oldZoomX) return;

      // カーソル位置のコンテンツ座標（SVG内のx、MARGIN.left起点）を求め、
      // ズーム後にその座標が再び同じ画面位置に来るようスクロール位置を
      // 合わせる。MARGIN.leftはズームしても動かない固定オフセットなので、
      // 「MARGIN.leftからの距離」だけを比率でスケールする。
      const rect = container.getBoundingClientRect();
      const cursorClientX = e.clientX - rect.left;
      const cursorContentX = container.scrollLeft + cursorClientX;
      const ratio = newZoomX / oldZoomX;
      const newCursorContentX = MARGIN.left + (cursorContentX - MARGIN.left) * ratio;

      state.diagramZoomX = newZoomX;
      localStorage.setItem('tline-zoom-x', String(state.diagramZoomX));
      renderTabLazy('plan', renderPlanTab);
      renderTabLazy('dispatch', renderDispatchTab);
      renderTabLazy('actual', renderActualTab);
      renderTabLazy('duty', renderDutyTab);

      container.scrollLeft = newCursorContentX - cursorClientX;
    },
    { passive: false }
  );
}

setupDiagramPanZoom(el.planDiagram);
setupDiagramPanZoom(el.dispatchDiagram);
setupDiagramPanZoom(el.actualDiagram);
setupDiagramPanZoom(el.dutyDiagram);

// 入出庫・運用系5トグルの共通ハンドラ生成。それぞれ独立に効くので、まとめて
// 1つの関数で作る（issue #10、2026-07-14の5分割）。
function bindDiagramToggle(stateKey, planEl, dispatchEl) {
  const apply = (checked) => {
    state[stateKey] = checked;
    updateDiagramControls();
    renderTabLazy('plan', renderPlanTab);
    renderTabLazy('dispatch', renderDispatchTab);
  };
  planEl.addEventListener('change', () => apply(planEl.checked));
  dispatchEl.addEventListener('change', () => apply(dispatchEl.checked));
}

bindDiagramToggle('showDepotMarkers', el.planShowDepot, el.dispatchShowDepot);
bindDiagramToggle('showChainLines', el.planShowChainLink, el.dispatchShowChainLink);
bindDiagramToggle('showDepotOperationNumbers', el.planShowDepotOpnum, el.dispatchShowDepotOpnum);
bindDiagramToggle('showTurnbackOperationNumbers', el.planShowTurnbackOpnum, el.dispatchShowTurnbackOpnum);
bindDiagramToggle('showTrainNumbers', el.planShowTrainNum, el.dispatchShowTrainNum);

el.themeSelect.addEventListener('change', () => {
  state.theme = el.themeSelect.value;
  localStorage.setItem('tline-theme', state.theme);
  document.documentElement.dataset.theme = state.theme;
  updateDiagramControls();
  renderTabLazy('plan', renderPlanTab);
  renderTabLazy('dispatch', renderDispatchTab);
});

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

// issue #4「運転整理の競合検知」— findNewTrackConflicts（renderer/dispatch.mjs）
// が返す「調整前には無かった番線の重なり」だけを一覧表示する。調整前から
// 存在する重なり（増解結等、正規の可能性がある）は対象外——このチェックが
// 答える問いは「今回の調整で何か壊れたか」だけで、ダイヤ全体の健全性検証
// ではない。
function dispatchConflictsHtml(conflicts) {
  if (conflicts.length === 0) return '';
  const stationById = new Map(state.diagram.line.stations.map((s) => [s.id, s]));
  const trainById = new Map(state.diagram.trains.map((t) => [t.id, t]));
  const items = conflicts
    .map((c) => {
      const station = stationById.get(c.stationId);
      const a = trainById.get(c.trainAId);
      const b = trainById.get(c.trainBId);
      const track = c.trackLabel ? `${c.trackLabel}番線` : `番線${c.track}`;
      return `<li>${station ? station.name : c.stationId} ${track}: 「${a ? a.number : c.trainAId}」と「${b ? b.number : c.trainBId}」の時刻が重なります（${formatTime(c.overlapStart)}〜${formatTime(c.overlapEnd)}）</li>`;
    })
    .join('');
  return `<div class="dispatch-conflicts-warning">⚠ この調整で新たに${conflicts.length}件の番線競合が発生します<ul>${items}</ul></div>`;
}

// 仕業「調整機能」（issue #2続報、2026-08-01）— duty.mjsのfindDutiesBroken
// ByAdjustmentのdocコメント参照。仕業は参照している列車の時刻をそのつど
// 引くだけなので、運転整理の遅延が仕業を「乗り継ぎ不能」にしていないかを
// 警告する形が実質的な「調整」チェックになる。dispatchConflictsHtmlと
// 同じ「調整前には無かった問題だけを報告する」設計。
function dispatchDutyWarningsHtml(brokenDuties) {
  if (brokenDuties.length === 0) return '';
  const items = brokenDuties.map((d) => `<li>仕業「${d.name}」— 区間の乗り継ぎ時刻が重なり、成立しなくなります</li>`).join('');
  return `<div class="dispatch-conflicts-warning">⚠ この調整で${brokenDuties.length}件の仕業が乗り継ぎ不能になります<ul>${items}</ul></div>`;
}

function renderDispatchTab() {
  const train = state.diagram.trains.find((t) => t.id === state.dispatchTrainId);
  renderDiagramSynced(
    el.dispatchDiagram,
    { stations: state.diagram.line.stations, trains: state.diagram.trains },
    { highlightTrainId: train?.id, adjustedTrain: state.adjustedTrain, ...diagramDisplayOptions() }
  );
  el.dispatchTable.innerHTML = state.adjustedTrain ? stopTableHtml(state.diagram, { trainOverride: state.adjustedTrain }) : stopTableHtml(state.diagram);
  const conflicts = state.adjustedTrain ? findNewTrackConflicts(state.diagram.trains, state.adjustedTrain) : [];
  const brokenDuties = state.adjustedTrain ? findDutiesBrokenByAdjustment(state.duties, state.diagram.trains, state.adjustedTrain) : [];
  el.dispatchConflicts.innerHTML = dispatchConflictsHtml(conflicts) + dispatchDutyWarningsHtml(brokenDuties);
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

// 表示・編集中の運転日の実績マップ（なければ作る）。日付ごとに完全に独立
// したMap——別の日を選ぶと空の（またはその日に保存済みの）実績になる。
function actualMapForCurrentDate() {
  let map = state.actualByDate.get(state.actualDate);
  if (!map) {
    map = new Map();
    state.actualByDate.set(state.actualDate, map);
  }
  return map;
}

// 実績タブの差分基準（比較対象セレクタに追随）: 「運転整理後」比較時、
// state.adjustedTrainは常に1列車分しか保持していない（運転整理タブのv1
// 仕様）ため、選択中の列車だけ整理後時刻、他は計画時刻のまま。
function actualBaselineFor(train) {
  const compareToDispatch = state.actualCompareTarget === 'dispatch';
  return compareToDispatch && state.adjustedTrain && state.adjustedTrain.id === train.id ? state.adjustedTrain : train;
}

// 遅延の自動補完（issue #5の方針「実績ダイヤ＝計画ダイヤにいったんする。
// A駅で+2分なら、その列車のその後のダイヤも+2分にする」）: 編集された
// セルの実績と基準時刻の差（遅延秒）を、同じ列車の「その停車の以降」の
// 全セル（着・発とも、着を編集した場合は同駅の発も含む）に基準時刻+遅延で
// 埋める。手入力済み（manual*フラグあり）のセルだけは訂正値として尊重し
// 上書きしない——自動補完で埋まったセル（フラグなし）は、後からより手前の
// 駅で遅延が訂正されたときに再補完で更新される。
function propagateActualDelay(train, baselineStops, stopIndex, field, map) {
  const editedStop = baselineStops[stopIndex];
  const editedKey = `${train.id}:${editedStop.stationId}`;
  const editedEntry = map.get(editedKey);
  const base = parseTime(editedStop[field]);
  const actual = parseTime(editedEntry ? editedEntry[field] : null);
  if (base == null || actual == null) return;
  const delta = actual - base;
  for (let i = stopIndex; i < baselineStops.length; i++) {
    const stop = baselineStops[i];
    const key = `${train.id}:${stop.stationId}`;
    const entry = map.get(key) || {};
    for (const f of ['arrival', 'departure']) {
      if (i === stopIndex && (f === field || (field === 'departure' && f === 'arrival'))) continue; // 編集セル自身と、発編集時のもう過ぎた着はそのまま
      if (stop[f] == null) continue;
      const manualFlag = f === 'arrival' ? 'manualArrival' : 'manualDeparture';
      if (entry[manualFlag]) continue;
      entry[f] = shiftTime(stop[f], delta);
    }
    if (entry.arrival != null || entry.departure != null) map.set(key, entry);
  }
}

function actualTableHtml() {
  const baseLabel = state.actualCompareTarget === 'dispatch' ? '整理後' : '計画';
  const header = `<thead><tr><th>列車</th><th>駅</th><th>${baseLabel}着</th><th>実績着</th><th>差</th><th>${baseLabel}発</th><th>実績発</th><th>差</th></tr></thead>`;
  const rows = [];
  const actualMap = actualMapForCurrentDate();
  for (const train of state.diagram.trains) {
    const baseline = actualBaselineFor(train);
    baseline.stops.forEach((stop, stopIndex) => {
      const station = state.diagram.line.stations.find((s) => s.id === stop.stationId);
      const key = `${train.id}:${stop.stationId}`;
      const actual = actualMap.get(key) || {};
      const arrDelta = deltaSeconds(stop.arrival, actual.arrival);
      const depDelta = deltaSeconds(stop.departure, actual.departure);
      // 未入力セルは「実績＝計画（基準）どおり」の扱い（issue #5）——空欄の
      // ままにし、基準時刻をplaceholderでうっすら見せる。自動補完で埋まった
      // セル（値ありmanualフラグなし）は--autoクラスで手入力と見分ける。
      const inputHtml = (field, value, manual, baseTime) => {
        if (baseTime == null) return '—';
        const cls = value != null && !manual ? ' class="actual-input--auto" title="自動補完された値（手入力で訂正できます）"' : '';
        return `<input data-train-id="${train.id}" data-stop-index="${stopIndex}" data-field="${field}" value="${value ?? ''}" placeholder="${baseTime}"${cls} />`;
      };
      rows.push(`
        <tr>
          <th>${train.number}</th>
          <th>${station ? station.name : stop.stationId}</th>
          <td>${stop.arrival ?? '—'}</td>
          <td>${inputHtml('arrival', actual.arrival, actual.manualArrival, stop.arrival)}</td>
          <td class="${deltaClass(arrDelta)}">${formatDelta(arrDelta)}</td>
          <td>${stop.departure ?? '—'}</td>
          <td>${inputHtml('departure', actual.departure, actual.manualDeparture, stop.departure)}</td>
          <td class="${deltaClass(depDelta)}">${formatDelta(depDelta)}</td>
        </tr>`);
    });
  }
  return header + `<tbody>${rows.join('')}</tbody>`;
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

// 実績タブのダイヤグラム用オーバーレイ列車一覧（2026-08-01要望「実績も
// 実績ダイヤグラムをオーバーレイで描画したい」）。運転整理タブの
// adjustedTrain（1列車のみ）と違い、実績はどの列車にも入力されうるため、
// 表示中の運転日に実績セルを1つでも持つ列車をすべて対象にする（未入力の
// セルはactualTableHtmlと同じくbaseline＝計画/整理後の時刻のまま）。
function actualAdjustedTrains() {
  const actualMap = actualMapForCurrentDate();
  const result = [];
  for (const train of state.diagram.trains) {
    const baseline = actualBaselineFor(train);
    const hasAnyActual = baseline.stops.some((stop) => actualMap.has(`${train.id}:${stop.stationId}`));
    if (!hasAnyActual) continue;
    const stops = baseline.stops.map((stop) => {
      const entry = actualMap.get(`${train.id}:${stop.stationId}`);
      return { ...stop, arrival: entry?.arrival ?? stop.arrival, departure: entry?.departure ?? stop.departure };
    });
    result.push({ ...train, stops });
  }
  return result;
}

function renderActualTab() {
  el.actualDate.value = state.actualDate;
  el.actualAutoComplete.checked = state.actualAutoComplete;
  el.actualCompareTarget.value = state.actualCompareTarget;
  el.actualCompareNote.textContent = actualCompareNoteText();
  renderDiagramSynced(
    el.actualDiagram,
    { stations: state.diagram.line.stations, trains: state.diagram.trains },
    { adjustedTrains: actualAdjustedTrains(), ...diagramDisplayOptions() }
  );
  el.actualTable.innerHTML = actualTableHtml();
  el.actualTable.querySelectorAll('input').forEach((input) => {
    input.addEventListener('change', () => {
      const trainId = input.dataset.trainId;
      const stopIndex = Number(input.dataset.stopIndex);
      const field = input.dataset.field;
      const train = state.diagram.trains.find((t) => t.id === trainId);
      if (!train) return;
      const baseline = actualBaselineFor(train);
      const stop = baseline.stops[stopIndex];
      if (!stop) return;
      const map = actualMapForCurrentDate();
      const key = `${trainId}:${stop.stationId}`;
      const entry = map.get(key) || {};
      const value = input.value.trim() || null;
      const manualFlag = field === 'arrival' ? 'manualArrival' : 'manualDeparture';
      entry[field] = value;
      // 手入力の印。空欄に戻したらフラグも消す（＝再び自動補完の対象になる）。
      if (value != null) entry[manualFlag] = true;
      else delete entry[manualFlag];
      if (entry.arrival == null && entry.departure == null) map.delete(key);
      else map.set(key, entry);
      if (value != null && state.actualAutoComplete) {
        propagateActualDelay(train, baseline.stops, stopIndex, field, map);
      }
      renderActualTab(); // re-render to recompute the delta column; loses focus, acceptable for this skeleton
    });
  });
}

el.actualCompareTarget.addEventListener('change', () => {
  state.actualCompareTarget = el.actualCompareTarget.value;
  renderActualTab();
});

el.actualDate.addEventListener('change', () => {
  state.actualDate = el.actualDate.value || todayDateString();
  renderActualTab();
});

el.actualAutoComplete.addEventListener('change', () => {
  state.actualAutoComplete = el.actualAutoComplete.checked;
});

// ---------- 仕業 ----------
//
// issue #2。duty.mjsのdocコメント参照——.oud/.oud2に存在しないTLINE独自
// データなので、計画タブのように取り込むのではなく、既に読み込み済みの
// 列車から区間（列車1本の一部区間でもよい）を選んで積み上げていく形の
// フォームで作成する。1つの仕業＝乗車区間のリスト（`state.dutyDraft`が
// 編集中の1件、確定すると`state.duties`に追加/上書きされる）。

function populateDutySegmentTrainSelect() {
  el.dutySegmentTrain.innerHTML = state.diagram.trains.map((t) => `<option value="${t.id}">${t.number}</option>`).join('');
  updateDutySegmentFromOptions();
}

function stationName(stationId) {
  return state.diagram.line.stations.find((s) => s.id === stationId)?.name ?? stationId;
}

function updateDutySegmentFromOptions() {
  const train = state.diagram.trains.find((t) => t.id === el.dutySegmentTrain.value);
  if (!train) {
    el.dutySegmentFrom.innerHTML = '';
    el.dutySegmentTo.innerHTML = '';
    return;
  }
  el.dutySegmentFrom.innerHTML = train.stops.map((s, i) => `<option value="${i}">${stationName(s.stationId)}</option>`).join('');
  updateDutySegmentToOptions();
}

// 降車駅は乗車駅より後の停車だけを選べるようにする（乗務員は列車を逆走
// できない）。<option value>は列車内の停車index——同名駅の再訪（issue #6
// の支線等）があっても、fromより後という位置関係だけで正しく絞り込める。
function updateDutySegmentToOptions() {
  const train = state.diagram.trains.find((t) => t.id === el.dutySegmentTrain.value);
  if (!train) return;
  const fromIndex = Number(el.dutySegmentFrom.value) || 0;
  el.dutySegmentTo.innerHTML = train.stops
    .map((s, i) => ({ i, s }))
    .filter(({ i }) => i > fromIndex)
    .map(({ i, s }) => `<option value="${i}">${stationName(s.stationId)}</option>`)
    .join('');
}

el.dutySegmentTrain.addEventListener('change', updateDutySegmentFromOptions);
el.dutySegmentFrom.addEventListener('change', updateDutySegmentToOptions);

el.dutySegmentForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const train = state.diagram.trains.find((t) => t.id === el.dutySegmentTrain.value);
  const fromIndex = Number(el.dutySegmentFrom.value);
  const toIndex = Number(el.dutySegmentTo.value);
  if (!train || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || toIndex <= fromIndex) {
    showToast('降車駅は乗車駅より後の停車を選んでください。', 'error');
    return;
  }
  const segment = { trainId: train.id, fromStationId: train.stops[fromIndex].stationId, toStationId: train.stops[toIndex].stationId };
  const candidateSegments = [...state.dutyDraft.segments, segment];
  if (findDutyOverlaps(candidateSegments, state.diagram.trains).length > 0) {
    showToast('この区間は既に追加した区間と時刻が重なっています（同じ乗務員が同時に2つの列車には乗れません）。', 'error');
    return;
  }
  state.dutyDraft.segments.push(segment);
  renderTabLazy('duty', renderDutyTab);
});

el.dutySegmentTable.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-remove-index]');
  if (!btn) return;
  state.dutyDraft.segments.splice(Number(btn.dataset.removeIndex), 1);
  renderTabLazy('duty', renderDutyTab);
});

el.dutySaveForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el.dutyName.value.trim();
  if (!name) {
    showToast('仕業番号／名称を入力してください。', 'error');
    return;
  }
  if (state.dutyDraft.segments.length === 0) {
    showToast('区間を1つ以上追加してください。', 'error');
    return;
  }
  const id = state.dutyDraft.id || `duty-${crypto.randomUUID()}`;
  const duty = { id, name, segments: state.dutyDraft.segments };
  const existingIndex = state.duties.findIndex((d) => d.id === id);
  if (existingIndex === -1) state.duties.push(duty);
  else state.duties[existingIndex] = duty;
  state.dutyDraft = { id: null, name: '', segments: [] };
  el.dutyName.value = '';
  showToast(`仕業「${name}」を保存しました。`, 'info');
  renderTabLazy('duty', renderDutyTab);
});

el.dutyNew.addEventListener('click', () => {
  state.dutyDraft = { id: null, name: '', segments: [] };
  el.dutyName.value = '';
  renderTabLazy('duty', renderDutyTab);
});

el.dutyListTable.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-duty-id]');
  if (!btn) return;
  const duty = state.duties.find((d) => d.id === btn.dataset.dutyId);
  if (!duty) return;
  if (btn.dataset.action === 'edit') {
    state.dutyDraft = { id: duty.id, name: duty.name, segments: [...duty.segments] };
    el.dutyName.value = duty.name;
  } else if (btn.dataset.action === 'delete') {
    state.duties = state.duties.filter((d) => d.id !== duty.id);
    if (state.dutyDraft.id === duty.id) {
      state.dutyDraft = { id: null, name: '', segments: [] };
      el.dutyName.value = '';
    }
  }
  renderTabLazy('duty', renderDutyTab);
});

function dutySegmentTableHtml() {
  const header = '<thead><tr><th>列車</th><th>区間</th><th>時刻</th><th></th></tr></thead>';
  if (state.dutyDraft.segments.length === 0) return `${header}<tbody><tr><td colspan="4">区間はまだありません</td></tr></tbody>`;
  const rows = state.dutyDraft.segments
    .map((s, i) => {
      const train = state.diagram.trains.find((t) => t.id === s.trainId);
      const range = segmentTimeRange(s, state.diagram.trains);
      const timeText = range ? `${formatTime(range.start)}〜${formatTime(range.end)}` : '—';
      return `<tr><td>${train ? train.number : s.trainId}</td><td>${stationName(s.fromStationId)} → ${stationName(s.toStationId)}</td><td>${timeText}</td><td><button type="button" data-remove-index="${i}">削除</button></td></tr>`;
    })
    .join('');
  return `${header}<tbody>${rows}</tbody>`;
}

function dutyListTableHtml() {
  const header = '<thead><tr><th>仕業</th><th>区間数</th><th>時間帯</th><th></th></tr></thead>';
  if (state.duties.length === 0) return `${header}<tbody><tr><td colspan="4">まだ仕業が登録されていません</td></tr></tbody>`;
  const rows = state.duties
    .map((duty) => {
      const ranges = duty.segments.map((s) => segmentTimeRange(s, state.diagram.trains)).filter(Boolean);
      const span = ranges.length
        ? `${formatTime(Math.min(...ranges.map((r) => r.start)))}〜${formatTime(Math.max(...ranges.map((r) => r.end)))}`
        : '—';
      return `<tr><td>${duty.name}</td><td>${duty.segments.length}区間</td><td>${span}</td><td><button type="button" data-action="edit" data-duty-id="${duty.id}">編集</button> <button type="button" data-action="delete" data-duty-id="${duty.id}">削除</button></td></tr>`;
    })
    .join('');
  return `${header}<tbody>${rows}</tbody>`;
}

// ダイヤグラムは編集中の仕業（dutyDraft）に含まれる列車を丸ごとハイライト
// する（区間の一部だけを強調する精密な描画はしていない——列車のどの区間が
// 対象かはダイヤグラム下の表で確認する想定）。
function renderDutyTab() {
  el.dutySegmentTable.innerHTML = dutySegmentTableHtml();
  el.dutyListTable.innerHTML = dutyListTableHtml();
  renderDiagramSynced(
    el.dutyDiagram,
    { stations: state.diagram.line.stations, trains: state.diagram.trains },
    { highlightTrainIds: new Set(state.dutyDraft.segments.map((s) => s.trainId)), ...diagramDisplayOptions() }
  );
}

// ---------- ファイル操作（開く・保存・最近使ったファイル） ----------
//
// 独自の .tline 形式（計画データの line/trains をそのまま
// JSON化したもの）の開く・保存に加え、.oud/.oud2（OuDia/OuDiaSecond）
// からのインポートに対応（lib/oudParser.js、下記「.oud/.oud2インポート」
// 参照）。「開く」ボタンは拡張子を見てtline/oudどちらのフローにも分岐する
// （元は別ボタンだったが、ユーザーからのフィードバックで統合）。インポート
// したダイヤは.tlineファイルとして開いたものではないため、取り込み後は
// currentFilePathをnull（サンプルデータと同様の「未保存」扱い）にする——
// 保存するには「名前を付けて保存」が必要。

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
// （adjustedTrain/actualByDate）は新しいダイヤに対しては意味を
// 持たないためリセットする。
// `description` は.oudインポートなどcurrentFilePathを持たない取り込みで、
// 「サンプルデータ」表示と区別するためのラベル（例:「碧洛電車.oud2 / 通常」）。
function loadDiagram(diagram, filePath, description) {
  if (!isValidDiagram(diagram)) {
    showToast('ダイヤファイルの形式が正しくありません（line.stations / trains が必要です）。', 'error');
    return;
  }
  state.diagram = { line: diagram.line, trains: diagram.trains }; // dispatch/actualはrestoreOpsExtrasが別途扱う（state.diagramには含めない）
  state.currentFilePath = filePath || null;
  state.currentFileDescription = filePath ? null : description || null;
  state.dispatchTrainId = diagram.trains[0]?.id ?? null;
  state.dispatchStationId = diagram.trains[0]?.stops?.[0]?.stationId ?? null;
  state.adjustedTrain = null;
  state.actualByDate = new Map();
  state.actualDate = todayDateString();
  state.actualCompareTarget = 'plan';
  state.duties = [];
  state.dutyDraft = { id: null, name: '', segments: [] };
  el.dutyName.value = '';

  updateFileLabel();
  renderTabLazy('plan', renderPlanTab);
  populateDispatchSelectors();
  renderTabLazy('dispatch', renderDispatchTab);
  renderActualTab();
  populateDutySegmentTrainSelect();
  renderTabLazy('duty', renderDutyTab);
}

// 運転整理・実績の保存形式（issue #3、確定）: 計画(line/trains)と同じ.tline
// ファイル内に、任意の`dispatch`/`actual`セクションを追加する（別拡張子・別
// ファイルにはしない）。どちらのキーもない旧来のplanのみ.tlineファイルも
// そのまま開ける後方互換を維持する。
// - dispatch: 運転整理タブの最後の適用状態（v1同様、保持できるのは1列車分のみ）
//   { trainId, fromStationId, deltaSeconds }
// - actualByDate: 実績タブの入力値を運転日ごとに保持（issue #5、2026-07-15
//   に旧`actual`キーから移行）。MapはJSON化できないのでObjectにして保存し、
//   読み込み時にMapへ戻す。
//   { "YYYY-MM-DD": { "trainId:stationId": { arrival, departure, manualArrival?, manualDeparture? } } }
//   旧形式（日付なしの`actual`キー）は読み込みのみ後方互換で対応
//   （restoreOpsExtras参照）、保存は常に新形式で行う。
// - duties: 仕業タブで作成した仕業一覧（issue #2、duty.mjs参照）。
//   [{ id, name, segments: [{ trainId, fromStationId, toStationId }] }]
function buildSavePayload() {
  const payload = { line: state.diagram.line, trains: state.diagram.trains };
  if (state.adjustedTrain) {
    payload.dispatch = { trainId: state.dispatchTrainId, fromStationId: state.dispatchStationId, deltaSeconds: state.dispatchDelta };
  }
  const actualByDate = {};
  for (const [date, map] of state.actualByDate) {
    if (map.size === 0) continue; // 表示しただけで何も入力しなかった日は保存しない
    actualByDate[date] = Object.fromEntries(map);
  }
  if (Object.keys(actualByDate).length > 0) payload.actualByDate = actualByDate;
  if (state.duties.length > 0) payload.duties = state.duties; // 仕業（issue #2、TLINE独自データ）
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
      renderTabLazy('dispatch', renderDispatchTab);
    }
  }
  if (loaded.actualByDate) {
    state.actualByDate = new Map(
      Object.entries(loaded.actualByDate).map(([date, entries]) => [date, new Map(Object.entries(entries))])
    );
    // 保存されている実績のうち最新の運転日を初期表示にする（今日の日付の
    // ままだと、過去日の実績を保存したファイルを開いても空に見えるため）。
    const dates = [...state.actualByDate.keys()].sort();
    if (dates.length > 0) state.actualDate = dates[dates.length - 1];
  } else if (loaded.actual) {
    // 旧形式（日付なし）: 編集中の運転日（今日）の実績として読み込む。
    // 旧データは全て手入力だったので、自動補完に上書きされないよう
    // manual*フラグを付けて取り込む。
    const entries = Object.entries(loaded.actual).map(([key, e]) => [
      key,
      { ...e, ...(e.arrival != null ? { manualArrival: true } : {}), ...(e.departure != null ? { manualDeparture: true } : {}) },
    ]);
    state.actualByDate = new Map([[state.actualDate, new Map(entries)]]);
  }
  renderActualTab();
  if (loaded.duties) state.duties = loaded.duties;
  renderTabLazy('duty', renderDutyTab);
}

// 最近使ったファイルの一覧をpath->entryで保持（.oud/.oud2再選択時にkindで
// 開き方を分岐するため、<option>のvalue=pathからentryを引けるようにする）。
let recentFilesByPath = new Map();

async function refreshRecentFiles() {
  const list = await window.tline.getRecentFiles();
  recentFilesByPath = new Map(list.map((e) => [e.path, e]));
  el.recentFilesSelect.innerHTML =
    '<option value="">最近使ったファイル…</option>' + list.map((e) => `<option value="${e.path}">${e.name}</option>`).join('');
}

// 拡張子で.tline(自前JSON)か.oud/.oud2(OuDia/OuDiaSecond)かを判定。
// `kind`（最近使ったファイルのエントリに保存済みの種別、旧エントリでは
// undefined）があればそちらを優先し、なければパスの拡張子で判定する。
function isOudPath(filePath, kind) {
  if (kind) return kind === 'oud';
  return /\.oud2?$/i.test(filePath);
}

async function openTlineFile(filePath) {
  try {
    const { diagram } = await window.tline.openFile(filePath);
    loadDiagram(diagram, filePath);
    restoreOpsExtras(diagram);
    await refreshRecentFiles();
  } catch (err) {
    showToast(`ファイルを開けませんでした: ${err && err.message ? err.message : err}`, 'error');
    await window.tline.removeRecentFile(filePath);
    await refreshRecentFiles();
  }
}

// .oud/.oud2はDiaを1つ選ぶ手順が要るため即読み込みではなくパネルを開く
// （「開く」ボタン・「最近使ったファイル」再選択、どちらから来ても共通）。
async function openOudFile(filePath) {
  try {
    const { lineName, dias } = await window.tline.listOudDias(filePath);
    if (dias.length === 0) {
      showToast('このファイルにはダイヤ（Dia）が見つかりませんでした。', 'error');
      return;
    }
    state.pendingOudImport = { filePath, lineName };
    el.oudImportLabel.textContent = `${basename(filePath)}（${lineName || '路線名なし'}）`;
    el.oudDiaSelect.innerHTML = dias.map((d) => `<option value="${d.index}">${d.name}（${d.trainCount}本）</option>`).join('');
    el.oudImportPanel.classList.remove('hidden');
  } catch (err) {
    showToast(`OuDiaファイルを読み込めませんでした: ${err && err.message ? err.message : err}`, 'error');
    await window.tline.removeRecentFile(filePath);
    await refreshRecentFiles();
  }
}

el.btnFileOpen.addEventListener('click', async () => {
  const filePath = await window.tline.chooseOpenPath();
  if (!filePath) return;
  if (isOudPath(filePath)) {
    await openOudFile(filePath);
  } else {
    await openTlineFile(filePath);
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
  const entry = recentFilesByPath.get(filePath);
  if (isOudPath(filePath, entry?.kind)) {
    await openOudFile(filePath);
  } else {
    await openTlineFile(filePath);
  }
  el.recentFilesSelect.value = '';
});

// ---------- .oud/.oud2インポート ----------
//
// 2段階フロー: ファイルを選ぶ（「開く」ボタンまたは「最近使ったファイル」、
// 上のopenOudFile参照）→Dia一覧を取得（複数持つファイルが普通、NOTES.md
// 参照）→ユーザーがDiaを選んで「取り込む」でTLINEのデータモデルに変換して
// 読み込む。取り込み後、未確定（timesConfident:false）の列車があれば件数を
// 知らせる（見た目上の区別はissue #1の今後の課題）。取り込みが成功すると
// メインプロセス側（main.jsのoud:import）が最近使ったファイルにkind:'oud'
// で登録するので、ここでもrefreshRecentFilesを呼んで一覧に反映する。

function hideOudImportPanel() {
  state.pendingOudImport = null;
  el.oudImportPanel.classList.add('hidden');
  el.oudDiaSelect.innerHTML = '';
}

el.oudDiaConfirm.addEventListener('click', async () => {
  if (!state.pendingOudImport) return;
  const diaIndex = Number(el.oudDiaSelect.value);
  try {
    const { diagram, stats } = await window.tline.importOud(state.pendingOudImport.filePath, diaIndex);
    loadDiagram(diagram, null, `${basename(state.pendingOudImport.filePath)} / ${stats.diaName}`);
    hideOudImportPanel();
    await refreshRecentFiles();
    const notes = [];
    if (stats.skippedTrains > 0) notes.push(`時刻データのない${stats.skippedTrains}本は除外`);
    if (stats.unconfidentTrains > 0) notes.push(`${stats.unconfidentTrains}本は時刻の解読精度が低い可能性あり`);
    // issue #11「番号なし運用同士の誤接続は検証手段がない」— 運用番号による
    // 裏付けのない折り返しつなぎ（近接ヒューリスティックのみ）がどれだけ
    // あるかをここで知らせる。ダイヤグラム側は該当する弧を薄く表示する
    // （renderer/diagramView.mjsのturnbackArcSvg参照）。
    if (stats.unverifiedChainLinks > 0) {
      notes.push(`運用のつなぎ${stats.totalChainLinks}件中${stats.unverifiedChainLinks}件は運用番号による裏付けなし（ダイヤグラム上は薄く表示）`);
    }
    showToast(`「${stats.diaName}」から${stats.importedTrains}本の列車を取り込みました。${notes.length ? '（' + notes.join('、') + '）' : ''}`);
  } catch (err) {
    showToast(`ダイヤを取り込めませんでした: ${err && err.message ? err.message : err}`, 'error');
  }
});

el.oudDiaCancel.addEventListener('click', () => {
  hideOudImportPanel();
});

// ---------- Init ----------

document.documentElement.dataset.theme = state.theme;
updateFileLabel();
updateDiagramControls();
renderTabLazy('plan', renderPlanTab);
populateDispatchSelectors();
renderTabLazy('dispatch', renderDispatchTab);
renderActualTab();
populateDutySegmentTrainSelect();
renderTabLazy('duty', renderDutyTab);
refreshRecentFiles();
