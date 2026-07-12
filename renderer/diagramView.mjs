// Renders a train diagram (ダイヤグラム) as SVG: x-axis = time, y-axis =
// station distance (km) along the line. Each train is a polyline through its
// stop times at each station it calls at — this is the same visual OuDia's
// diagram view uses, reimplemented independently against our own data model
// (see NOTES.md "データモデル").
//
// No DOM lookups beyond the passed-in container — pure rendering function,
// callable from any tab that needs to draw a diagram (計画 as-is, 運転整理
// overlaying original + adjusted).

import { parseTime } from './timeUtils.mjs';

const MARGIN = { top: 24, right: 24, bottom: 32, left: 64 };
const HOUR_WIDTH = 90; // px per hour on the time axis
const START_HOUR = 5;
const END_HOUR = 26; // covers into next-day late trains (25:xx, 26:xx)

function timeToX(seconds) {
  return MARGIN.left + ((seconds - START_HOUR * 3600) / 3600) * HOUR_WIDTH;
}

function distanceToY(distanceKm, maxDistanceKm, plotHeight) {
  return MARGIN.top + (distanceKm / maxDistanceKm) * plotHeight;
}

// `trains` — array of { id, number, direction, stops: [{stationId, arrival, departure}] }.
// `variant` — 'plan' (solid, default color) or 'adjusted' (dashed, warning
// color) — lets 運転整理 draw the original plan and the shifted result on
// the same axes for comparison.
function trainPolylinePoints(train, stations, maxDistanceKm, plotHeight) {
  const byId = new Map(stations.map((s) => [s.id, s]));
  const points = [];
  for (const stop of train.stops) {
    const station = byId.get(stop.stationId);
    if (!station) continue;
    // A train can have separate arrival/departure — draw both as distinct
    // points on the same vertical (dwell time shows as a short flat segment)
    // rather than collapsing to one instant.
    if (stop.arrival != null) {
      const t = parseTime(stop.arrival);
      if (t != null) points.push([timeToX(t), distanceToY(station.distanceKm, maxDistanceKm, plotHeight)]);
    }
    if (stop.departure != null) {
      const t = parseTime(stop.departure);
      if (t != null) points.push([timeToX(t), distanceToY(station.distanceKm, maxDistanceKm, plotHeight)]);
    }
  }
  return points;
}

export function renderDiagram(container, { stations, trains }, { highlightTrainId, adjustedTrain } = {}) {
  const maxDistanceKm = Math.max(...stations.map((s) => s.distanceKm), 1);
  const plotHeight = Math.max(200, stations.length * 60);
  const plotWidth = (END_HOUR - START_HOUR) * HOUR_WIDTH;
  const width = MARGIN.left + plotWidth + MARGIN.right;
  const height = MARGIN.top + plotHeight + MARGIN.bottom;

  const svgParts = [];
  svgParts.push(`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="diagram-svg">`);

  // Station horizontal gridlines + labels.
  for (const station of stations) {
    const y = distanceToY(station.distanceKm, maxDistanceKm, plotHeight);
    svgParts.push(`<line x1="${MARGIN.left}" y1="${y}" x2="${MARGIN.left + plotWidth}" y2="${y}" class="diagram-grid-line" />`);
    svgParts.push(`<text x="${MARGIN.left - 8}" y="${y + 4}" class="diagram-station-label" text-anchor="end">${station.name}</text>`);
  }

  // Hourly vertical gridlines + labels.
  for (let h = START_HOUR; h <= END_HOUR; h++) {
    const x = timeToX(h * 3600);
    svgParts.push(`<line x1="${x}" y1="${MARGIN.top}" x2="${x}" y2="${MARGIN.top + plotHeight}" class="diagram-grid-line" />`);
    svgParts.push(`<text x="${x}" y="${MARGIN.top + plotHeight + 18}" class="diagram-hour-label" text-anchor="middle">${h % 24}</text>`);
  }

  for (const train of trains) {
    const points = trainPolylinePoints(train, stations, maxDistanceKm, plotHeight);
    if (points.length < 2) continue;
    const d = points.map((p) => p.join(',')).join(' ');
    const isHighlighted = train.id === highlightTrainId;
    svgParts.push(
      `<polyline points="${d}" class="diagram-train-line${isHighlighted ? ' diagram-train-line--highlight' : ''}" data-train-id="${train.id}" />`
    );
  }

  // The 運転整理-shifted version of one train, overlaid dashed on top of its
  // (still-visible) original plan line — so the delay's effect is visible at
  // a glance rather than replacing the plan outright.
  if (adjustedTrain) {
    const points = trainPolylinePoints(adjustedTrain, stations, maxDistanceKm, plotHeight);
    if (points.length >= 2) {
      const d = points.map((p) => p.join(',')).join(' ');
      svgParts.push(`<polyline points="${d}" class="diagram-train-line diagram-train-line--adjusted" data-train-id="${adjustedTrain.id}" />`);
    }
  }

  svgParts.push('</svg>');
  container.innerHTML = svgParts.join('');
}
