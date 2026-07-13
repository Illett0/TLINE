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

function timeToX(seconds, startHour) {
  return MARGIN.left + ((seconds - startHour * 3600) / 3600) * HOUR_WIDTH;
}

function distanceToY(distanceKm, maxDistanceKm, plotHeight) {
  return MARGIN.top + (distanceKm / maxDistanceKm) * plotHeight;
}

// `trains` — array of { id, number, direction, stops: [{stationId, arrival, departure}] }.
// `variant` — 'plan' (solid, default color) or 'adjusted' (dashed, warning
// color) — lets 運転整理 draw the original plan and the shifted result on
// the same axes for comparison.
function trainPolylinePoints(train, stations, maxDistanceKm, plotHeight, startHour) {
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
      if (t != null) points.push([timeToX(t, startHour), distanceToY(station.distanceKm, maxDistanceKm, plotHeight)]);
    }
    if (stop.departure != null) {
      const t = parseTime(stop.departure);
      if (t != null) points.push([timeToX(t, startHour), distanceToY(station.distanceKm, maxDistanceKm, plotHeight)]);
    }
  }
  return points;
}

export function renderDiagram(container, { stations, trains }, { highlightTrainId, adjustedTrain } = {}) {
  const maxDistanceKm = Math.max(...stations.map((s) => s.distanceKm), 1);
  const plotHeight = Math.max(200, stations.length * 60);
  const { startHour, endHour } = computeHourRange(adjustedTrain ? [...trains, adjustedTrain] : trains);
  const plotWidth = (endHour - startHour) * HOUR_WIDTH;
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
    const x = timeToX(h * 3600, startHour);
    svgParts.push(`<line x1="${x}" y1="${MARGIN.top}" x2="${x}" y2="${MARGIN.top + plotHeight}" class="diagram-grid-line" />`);
    svgParts.push(`<text x="${x}" y="${MARGIN.top + plotHeight + 18}" class="diagram-hour-label" text-anchor="middle">${h % 24}</text>`);
  }

  for (const train of trains) {
    const points = trainPolylinePoints(train, stations, maxDistanceKm, plotHeight, startHour);
    if (points.length < 2) continue;
    const d = points.map((p) => p.join(',')).join(' ');
    const isHighlighted = train.id === highlightTrainId;
    // Direction-based color (see module comment on issue #1): with no
    // distinction, a dense real-world import (up to ~100 overlapping same-
    // color lines) reads as "only one direction is drawn" even though both
    // are present — up/down just can't be told apart at a glance.
    const directionClass = train.direction === 'up' ? ' diagram-train-line--up' : ' diagram-train-line--down';
    svgParts.push(
      `<polyline points="${d}" class="diagram-train-line${directionClass}${isHighlighted ? ' diagram-train-line--highlight' : ''}" data-train-id="${train.id}" />`
    );
  }

  // Legend so the direction colors above are actually interpretable.
  svgParts.push(
    `<g class="diagram-legend">` +
      `<line x1="${width - 140}" y1="${MARGIN.top - 14}" x2="${width - 116}" y2="${MARGIN.top - 14}" class="diagram-train-line diagram-train-line--down" />` +
      `<text x="${width - 110}" y="${MARGIN.top - 10}" class="diagram-legend-label">下り</text>` +
      `<line x1="${width - 70}" y1="${MARGIN.top - 14}" x2="${width - 46}" y2="${MARGIN.top - 14}" class="diagram-train-line diagram-train-line--up" />` +
      `<text x="${width - 40}" y="${MARGIN.top - 10}" class="diagram-legend-label">上り</text>` +
      `</g>`
  );

  // The 運転整理-shifted version of one train, overlaid dashed on top of its
  // (still-visible) original plan line — so the delay's effect is visible at
  // a glance rather than replacing the plan outright.
  if (adjustedTrain) {
    const points = trainPolylinePoints(adjustedTrain, stations, maxDistanceKm, plotHeight, startHour);
    if (points.length >= 2) {
      const d = points.map((p) => p.join(',')).join(' ');
      svgParts.push(
        `<polyline points="${d}" class="diagram-train-line diagram-train-line--adjusted" data-train-id="${adjustedTrain.id}" />`
      );
    }
  }

  svgParts.push('</svg>');
  container.innerHTML = svgParts.join('');
}
