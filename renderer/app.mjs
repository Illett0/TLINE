import { sampleDiagram } from '../data/sampleDiagram.mjs';
import { renderDiagram } from './diagramView.mjs';
import { applyDelay } from './dispatch.mjs';
import { parseTime } from './timeUtils.mjs';

const state = {
  diagram: sampleDiagram, // 計画 — static for now; load/save isn't implemented yet (see NOTES.md)
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
  dispatchForm: document.getElementById('dispatch-form'),
  dispatchTrain: document.getElementById('dispatch-train'),
  dispatchStation: document.getElementById('dispatch-station'),
  dispatchDelta: document.getElementById('dispatch-delta'),
  dispatchReset: document.getElementById('dispatch-reset'),
  dispatchDiagram: document.getElementById('dispatch-diagram'),
  dispatchTable: document.getElementById('dispatch-table'),
  actualTable: document.getElementById('actual-table'),
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

// ---------- Init ----------

renderPlanTab();
populateDispatchSelectors();
renderDispatchTab();
renderActualTab();
