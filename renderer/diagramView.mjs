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
const FALLBACK_START_HOUR = 5; // used only when a diagram has no decodable stop times at all
const FALLBACK_END_HOUR = 26;

// The time axis used to be a fixed 5:00-26:00 window. That made diagrams
// built from real .oud imports effectively blank: a run concentrated in a
// few late-night hours (e.g. 21:00-23:00) still reserved the full 21-hour
// width, so the actual train lines sat far outside the visible (unscrolled)
// part of .diagram-container; a run starting before 5:00 (e.g. the
// deliberately early Diagram/test.oud2 fixture, 00:00-00:22) landed at a
// negative x and was clipped by the SVG viewBox entirely — see issue #1's
// "上り・下りどちらか一方しか表示されない" report, which turned out to be
// this (both directions were always in the DOM; only the axis was wrong).
// Fitting the axis to the actual stop-time range fixes both.
function computeHourRange(trains) {
  let minSeconds = Infinity;
  let maxSeconds = -Infinity;
  for (const train of trains) {
    for (const stop of train.stops) {
      for (const field of ['arrival', 'departure']) {
        const t = parseTime(stop[field]);
        if (t == null) continue;
        if (t < minSeconds) minSeconds = t;
        if (t > maxSeconds) maxSeconds = t;
      }
    }
  }
  if (!Number.isFinite(minSeconds) || !Number.isFinite(maxSeconds)) {
    return { startHour: FALLBACK_START_HOUR, endHour: FALLBACK_END_HOUR };
  }
  // 1h padding on each side so lines don't touch the plot edge; clamp to a
  // sane minimum span so a diagram with only one instant-in-time stop still
  // gets a readable axis rather than a near-zero-width plot.
  const startHour = Math.max(0, Math.floor(minSeconds / 3600) - 1);
  const endHour = Math.max(startHour + 2, Math.ceil(maxSeconds / 3600) + 1);
  return { startHour, endHour };
}

function timeToX(seconds, startHour, hourWidth) {
  return MARGIN.left + ((seconds - startHour * 3600) / 3600) * hourWidth;
}

function distanceToY(distanceKm, maxDistanceKm, plotHeight) {
  return MARGIN.top + (distanceKm / maxDistanceKm) * plotHeight;
}

// OuDiaSecond's own train-type colors are meant for a light diagram
// background — 普通(local)'s conventional color is plain black, which is
// invisible against TLINE's dark theme (--color-bg). Blend any color that's
// too dark toward white until it clears a visibility floor; colors that are
// already bright enough (the vast majority — reds/blues/oranges etc. used
// for faster train classes) pass through unchanged.
function ensureVisibleOnDark(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  const relLuminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const FLOOR = 0.35;
  if (relLuminance >= FLOOR) return hex;
  const t = (FLOOR - relLuminance) / (1 - relLuminance);
  r = Math.round(r + (255 - r) * t);
  g = Math.round(g + (255 - g) * t);
  b = Math.round(b + (255 - b) * t);
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

// `trains` — array of { id, number, direction, stops: [{stationId, arrival, departure}] }.
// `variant` — 'plan' (solid, default color) or 'adjusted' (dashed, warning
// color) — lets 運転整理 draw the original plan and the shifted result on
// the same axes for comparison.
function trainPolylinePoints(train, stations, maxDistanceKm, plotHeight, startHour, hourWidth) {
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
      if (t != null) points.push([timeToX(t, startHour, hourWidth), distanceToY(station.distanceKm, maxDistanceKm, plotHeight)]);
    }
    if (stop.departure != null) {
      const t = parseTime(stop.departure);
      if (t != null) points.push([timeToX(t, startHour, hourWidth), distanceToY(station.distanceKm, maxDistanceKm, plotHeight)]);
    }
  }
  return points;
}

// Builds the little colored-line swatch + label row shown above the
// diagram, one entry per distinct train type actually present among
// `trains` (not every type declared in the source file — an unused type
// would just be dead legend clutter). Plain HTML (not SVG) so it wraps
// naturally via CSS flex-wrap regardless of how many types a file declares
// (real samples range from 2 to 9 — see NOTES.md「種別ごとの色分け」)
// instead of needing hand-rolled column/row math inside the SVG.
function legendHtml(trains) {
  const seen = new Map();
  for (const train of trains) {
    if (!train.trainType || seen.has(train.trainType.name)) continue;
    seen.set(train.trainType.name, train.trainType);
  }
  if (seen.size === 0) return '';
  const items = [...seen.values()]
    .map((type) => {
      const color = ensureVisibleOnDark(type.color);
      const dash = type.dashArray ? ` stroke-dasharray="${type.dashArray}"` : '';
      return (
        `<span class="diagram-legend-item">` +
        `<svg width="20" height="10" class="diagram-legend-swatch"><line x1="0" y1="5" x2="20" y2="5" stroke="${color}" stroke-width="2"${dash} /></svg>` +
        `<span>${type.abbreviation || type.name}</span>` +
        `</span>`
      );
    })
    .join('');
  return `<div class="diagram-legend">${items}</div>`;
}

// `zoom` — a display-only scale multiplier (default 1) applied uniformly to
// both axes' pixel-per-unit density, so a dense real-world import can be
// shrunk to fit without changing any underlying data (see issue #8's "拡大
// 縮小...スライダーが欲しい" request). renderer/app.mjs owns the actual
// slider state and re-calls renderDiagram with a new value.
export function renderDiagram(container, { stations, trains }, { highlightTrainId, adjustedTrain, zoom = 1 } = {}) {
  const maxDistanceKm = Math.max(...stations.map((s) => s.distanceKm), 1);
  const plotHeight = Math.max(200, stations.length * 60 * zoom);
  const hourWidth = HOUR_WIDTH * zoom;
  const { startHour, endHour } = computeHourRange(adjustedTrain ? [...trains, adjustedTrain] : trains);
  const plotWidth = (endHour - startHour) * hourWidth;
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
  for (let h = startHour; h <= endHour; h++) {
    const x = timeToX(h * 3600, startHour, hourWidth);
    svgParts.push(`<line x1="${x}" y1="${MARGIN.top}" x2="${x}" y2="${MARGIN.top + plotHeight}" class="diagram-grid-line" />`);
    svgParts.push(`<text x="${x}" y="${MARGIN.top + plotHeight + 18}" class="diagram-hour-label" text-anchor="middle">${h % 24}</text>`);
  }

  for (const train of trains) {
    const points = trainPolylinePoints(train, stations, maxDistanceKm, plotHeight, startHour, hourWidth);
    if (points.length < 2) continue;
    const d = points.map((p) => p.join(',')).join(' ');
    const isHighlighted = train.id === highlightTrainId;
    // Color/style by train type (OuDiaSecond's own Ressyasyubetsu — 普通/
    // 急行/回送 etc., each with its own diagram line color; see NOTES.md
    // 「種別ごとの色分け」). Falls back to the plain default (no inline
    // style) for data with no type info, e.g. hand-authored plan data.
    // Skipped while highlighted so the highlight color (set by the CSS
    // class below, which an inline style would otherwise outrank) wins.
    const typeStyle =
      train.trainType && !isHighlighted
        ? ` style="stroke:${ensureVisibleOnDark(train.trainType.color)};${train.trainType.dashArray ? `stroke-dasharray:${train.trainType.dashArray};` : ''}"`
        : '';
    svgParts.push(
      `<polyline points="${d}" class="diagram-train-line${isHighlighted ? ' diagram-train-line--highlight' : ''}" data-train-id="${train.id}"${typeStyle} />`
    );
  }

  // The 運転整理-shifted version of one train, overlaid dashed on top of its
  // (still-visible) original plan line — so the delay's effect is visible at
  // a glance rather than replacing the plan outright.
  if (adjustedTrain) {
    const points = trainPolylinePoints(adjustedTrain, stations, maxDistanceKm, plotHeight, startHour, hourWidth);
    if (points.length >= 2) {
      const d = points.map((p) => p.join(',')).join(' ');
      svgParts.push(
        `<polyline points="${d}" class="diagram-train-line diagram-train-line--adjusted" data-train-id="${adjustedTrain.id}" />`
      );
    }
  }

  svgParts.push('</svg>');
  container.innerHTML = legendHtml(trains) + svgParts.join('');
}
