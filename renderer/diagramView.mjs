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

// Exported so renderer/app.mjs's wheel-zoom handler (see setupDiagramPanZoom)
// can convert a screen/scroll x-coordinate to the same content-space x the
// SVG itself uses (timeToX below always starts at MARGIN.left, not 0) when
// keeping the point under the cursor fixed across a zoom step.
// top/bottom leave room for the hour-label row PLUS a turnback arc + its
// operation number bulging past the first/last station's line (the arc cap
// extends TURNBACK_BULGE px outside the plot and its number another ~13px —
// with the old 24px top margin those landed exactly on the hour labels
// whenever the line's terminus station was the diagram's top row).
export const MARGIN = { top: 52, right: 24, bottom: 48, left: 64 };
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
//
// Returns an ARRAY OF SEGMENTS (each an array of [x,y] points), not one flat
// point list — a branching line (e.g. Diagram/高根鉄道TM.oud2's 高岡東 split)
// is represented in OuDiaSecond by repeating the junction station later in
// the station list (see NOTES.md「支線・分岐の表現」), so a 支線普通-type
// train that only serves the branch has stops like
// [...,{index:1,高岡東,21:08:50},{index:10,高岡東(also!),21:08:50},...] —
// same instant, station index jumping from 1 to 10. Connecting those two
// points with a straight line would draw a false diagonal cutting across
// every station in between (2..9), which it never actually visits — that's
// exactly the "運行無しのところにも線がある" bug reported against 支線普通.
// Detected by: two consecutive points whose station *order* (position in
// `stations`, not raw stationId) differs by more than 1, AND whose station
// *name* is the same (the repeated-junction signature) — verified against
// every Diagram/ sample (132 such jumps, all at a real repeated-junction
// station; every OTHER order jump >1 in the same data has a different
// station name, i.e. a genuine skip-stop segment that should stay
// connected). Originally this checked "zero elapsed time" instead of same
// name, which only caught the 下り(down) direction's 57 cases — 上り(up)
// trains cross the same junction with a nonzero gap between its two
// station-list entries (real transfer/reversal time at 高岡東, e.g. ~3min),
// so the elapsed-time check silently let the false diagonal through for
// every up-direction 支線普通 train even after the down-direction fix.
function trainPolylineSegments(train, stations, maxDistanceKm, plotHeight, startHour, hourWidth) {
  const byId = new Map(stations.map((s) => [s.id, s]));
  const orderById = new Map(stations.map((s, i) => [s.id, i]));
  const segments = [];
  let current = [];
  let prevOrder = null;
  let prevName = null;

  const pushPoint = (station, seconds) => {
    const order = orderById.get(station.id);
    if (prevOrder != null && Math.abs(order - prevOrder) > 1 && station.name === prevName) {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
    current.push([timeToX(seconds, startHour, hourWidth), distanceToY(station.distanceKm, maxDistanceKm, plotHeight)]);
    prevOrder = order;
    prevName = station.name;
  };

  for (const stop of train.stops) {
    const station = byId.get(stop.stationId);
    if (!station) continue;
    // A train can have separate arrival/departure — draw both as distinct
    // points on the same vertical (dwell time shows as a short flat segment)
    // rather than collapsing to one instant.
    if (stop.arrival != null) {
      const t = parseTime(stop.arrival);
      if (t != null) pushPoint(station, t);
    }
    if (stop.departure != null) {
      const t = parseTime(stop.departure);
      if (t != null) pushPoint(station, t);
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

// Small ○ (出区/leaves depot・路線外始発) or ▽ (入区/enters depot・路線外終着)
// marker at a train's origin/terminus point, drawn in that train's own line
// color. Definition (2026-07-14, see NOTES.md「入出庫の定義」): a boundary
// marker is drawn at an endpoint whenever renderDiagram's caller did NOT
// find an operation-chain partner for it (see `chainNextTrainId`/
// `chainPrevTrainId` in lib/oudParser.js's inferOperationChains) — NOT based
// on the Operation field's own `linked` code, which turned out unreliable in
// both directions: a `linked: true` endpoint (e.g. 高根鉄道TM.oud2's
// 回2010A) can have no real previous train, AND a `linked: false` endpoint
// (2110A's origin, in the same file) can still be a genuine same-track
// hand-off from another train. Whenever a chain partner *is* found, a
// connecting line is drawn instead (see operationChainLineSvg) and no
// boundary marker is drawn on that end.
// `depotWork` — the Operation field's decoded 入出庫(depot entry/exit)
// record for this endpoint, if any (lib/oudParser.jsのparseDepotWork参照、
// issue #11/#12の2026-07-16調査で判明: 営業列車として現れる直前/直後に
// 車両基地との間で発生した回送的な出入りの着発時刻)。`track`の意味は
// まだ仮説段階（車庫側の入出庫経路/番線と推測）のため、確定情報として
// ではなく「参考情報」と明記した上でツールチップにのみ出す — 通常表示
// には影響しない、控えめな追加情報。
function depotMarkerSvg([x, y], kind, color, depotWork) {
  const title = depotWork
    ? `<title>入出庫(参考): ${depotWork.arrival}→${depotWork.departure}${depotWork.track != null ? ` (番線${depotWork.track}?)` : ''}</title>`
    : '';
  if (kind === 'origin') return `<circle cx="${x}" cy="${y}" r="5" class="diagram-depot-marker" style="stroke:${color};">${title}</circle>`;
  const size = 6;
  return `<polygon points="${x - size},${y - size} ${x + size},${y - size} ${x},${y + size}" class="diagram-depot-marker" style="stroke:${color};">${title}</polygon>`;
}

// The short operation-number label ("10A", "82B" — matches
// Diagram/image/06123.png) shown beside a train's depot-boundary ○/▽
// marker whenever that endpoint's `operationNumber` is present (matches the
// OuDiaSecond manual's "出区の○印及び入区の△印の横に、運用番号が表記され
// ます"). `side` — 'left' for an origin ○ (the train line extends to the
// right, so the left is clear) / 'right' for a terminus ▽ (line arrives
// from the left) — matching the reference image, where the number sits
// horizontally next to the marker on the side away from the line.
// Chain-matched endpoints don't use this — their number is drawn once per
// pair at the turnback arc's apex instead (see turnbackNumberSvg).
function operationLabelSvg([x, y], text, color, side) {
  if (side === 'left') {
    return `<text x="${x - 9}" y="${y + 3}" text-anchor="end" class="diagram-operation-label" style="fill:${color};">${text}</text>`;
  }
  return `<text x="${x + 9}" y="${y + 3}" class="diagram-operation-label" style="fill:${color};">${text}</text>`;
}

// 折り返しのつなぎ: the connection between two trains inferOperationChains
// matched as the same physical train set continuing under a new number.
// Drawn as a smooth rounded cap (quarter-curve corners + flat middle) that
// bulges past the station line AWAY from the two train lines — matching
// Diagram/image/06123.png, where an arriving line curves over the station
// line and comes back down as the departing line, reading as one continuous
// stroke (2026-07-15 feedback: "折り返しのつなぎ方…もっと06123に近づけて").
// This replaces the previous straight line nudged 5px below the station
// gridline with end/middle dots — the bulge itself now keeps the connector
// clear of the gridline, so no offset or dots are needed.
//
// Both chain endpoints land on the same station (same y — see
// inferOperationChains), so the bulge side is decided by where the two
// lines' neighbor points sit: both below the station → the station is the
// apex of the turnback → bulge up; both above → bulge down; mixed (a
// same-direction continuation rather than a reversal, rare) → a small
// downward bulge just to stay off the gridline.
const TURNBACK_BULGE = 9; // px past the station line the cap extends
const TURNBACK_CORNER = 12; // max horizontal radius of the rounded corners

function turnbackGeometry(fromEnd, fromInner, toStart, toInner) {
  const [x1, y1] = fromEnd;
  const [x2, y2] = toStart;
  const yRef = (y1 + y2) / 2;
  const fromBelow = fromInner ? fromInner[1] > yRef + 0.5 : false;
  const toBelow = toInner ? toInner[1] > yRef + 0.5 : false;
  const fromAbove = fromInner ? fromInner[1] < yRef - 0.5 : false;
  const toAbove = toInner ? toInner[1] < yRef - 0.5 : false;
  let sign;
  let bulge;
  if (fromBelow && toBelow) {
    sign = -1;
    bulge = TURNBACK_BULGE;
  } else if (fromAbove && toAbove) {
    sign = 1;
    bulge = TURNBACK_BULGE;
  } else {
    sign = 1;
    bulge = 5;
  }
  const apexY = yRef + sign * bulge;
  const mx = (x1 + x2) / 2;
  const rx = Math.min(TURNBACK_CORNER, Math.max((x2 - x1) / 2, 0));
  return { x1, y1, x2, y2, apexY, mx, rx, sign };
}

// Split at the midpoint into two paths so each half carries its own train's
// type color AND dash pattern (a 回送 leg keeps its dashed style through the
// turnback, as in the reference image's green 82B arcs).
// `unverified` (issue #11「番号なし運用同士の誤接続は検証手段がない」) — true
// when this link has no recorded 運用番号 anywhere on its chain to cross-check
// it against (see the caller and lib/oudParser.js's unverifiedChainLinks
// comment): a pure proximity/track/gap match, not a false-positive detector,
// but the one thing this project CAN show is which arcs it can't verify.
// Rendered at reduced opacity via a CSS class (not stroke-dasharray, which
// the inline train-type style above would just override) plus a hover
// tooltip explaining why, so a user auditing a garage-like station (e.g. the
// issue's 江ノ原信号場 example) can visually tell "confirmed continuation"
// from "best guess" instead of every arc reading with equal confidence.
function turnbackArcSvg(geo, fromColor, fromDash, toColor, toDash, unverified) {
  const { x1, y1, x2, y2, apexY, mx, rx } = geo;
  const c1 = Math.min(x1 + rx, mx);
  const c2 = Math.max(x2 - rx, mx);
  const d1 = `M ${x1} ${y1} Q ${x1} ${apexY} ${c1} ${apexY}` + (c1 < mx ? ` L ${mx} ${apexY}` : '');
  const d2 = (c2 > mx ? `M ${mx} ${apexY} L ${c2} ${apexY}` : `M ${mx} ${apexY}`) + ` Q ${x2} ${apexY} ${x2} ${y2}`;
  const dashStyle = (dash) => (dash ? `stroke-dasharray:${dash};` : '');
  const cls = `diagram-operation-chain-line${unverified ? ' diagram-operation-chain-line--unverified' : ''}`;
  const title = unverified ? '<title>運用番号による裏付けなし（近接推定のみ）</title>' : '';
  return (
    `<path d="${d1}" class="${cls}" style="stroke:${fromColor};${dashStyle(fromDash)}">${title}</path>` +
    `<path d="${d2}" class="${cls}" style="stroke:${toColor};${dashStyle(toDash)}">${title}</path>`
  );
}

// 同方向継続のつなぎ: a chain connection where the train does NOT reverse
// direction — it just changes number/type at the same station (e.g. 回送
// が本線列車に化ける、Diagram/image「スクリーンショット 2026-07-16
// 165202.png」参照）。turnbackGeometry/turnbackArcSvgの「站の外側へ弧を
// 描く」表現は方向反転（同じ側から来て同じ側へ折り返す）を前提にしており、
// 反転しないケースに使うと不自然な小さな段差にしかならなかった
// （turnbackGeometryのelse分岐、bulge=5の「a small downward bulge just
// to stay off the gridline」がまさにこれ）。2026-07-16のプロジェクト
// オーナー指摘を受け、方向反転しない場合は代わりにこちらを使う——到着線・
// 出発線それぞれの傾き（fromInner/toInner、なければ水平とみなす）へ滑らかに
// 接続する3次ベジェのS字カーブ。isReversalConnectionでどちらを使うか判定。
function isReversalConnection(fromInner, toInner, yRef) {
  const fromBelow = fromInner ? fromInner[1] > yRef + 0.5 : false;
  const toBelow = toInner ? toInner[1] > yRef + 0.5 : false;
  const fromAbove = fromInner ? fromInner[1] < yRef - 0.5 : false;
  const toAbove = toInner ? toInner[1] < yRef - 0.5 : false;
  return (fromBelow && toBelow) || (fromAbove && toAbove);
}

function unitVector([dx, dy]) {
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// Builds a single cubic Bezier from fromEnd to toStart whose tangent at
// each end matches that train's own approach/departure slope, then splits
// it at t=0.5 (De Casteljau) into two halves so each can carry its own
// train's color/dash — same two-tone trick turnbackArcSvg uses, just on a
// smooth curve instead of a flat-topped cap (there's no "outside the
// station line" apex to bulge toward here, since the lines aren't
// reversing — see module comment above).
function throughGeometry(fromEnd, fromInner, toStart, toInner) {
  const [x1, y1] = fromEnd;
  const [x2, y2] = toStart;
  const dirFrom = fromInner ? unitVector([x1 - fromInner[0], y1 - fromInner[1]]) : [1, 0];
  const dirTo = toInner ? unitVector([toInner[0] - x2, toInner[1] - y2]) : [1, 0];
  const controlDist = Math.min(Math.max(x2 - x1, 1) * 0.5, 40);
  const c1 = [x1 + dirFrom[0] * controlDist, y1 + dirFrom[1] * controlDist];
  const c2 = [x2 - dirTo[0] * controlDist, y2 - dirTo[1] * controlDist];
  const p01 = midpoint(fromEnd, c1);
  const p12 = midpoint(c1, c2);
  const p23 = midpoint(c2, toStart);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const mid = midpoint(p012, p123);
  return { p1: fromEnd, c1a: p01, c1b: p012, mid, c2a: p123, c2b: p23, p2: toStart };
}

function throughConnectorSvg(geo, fromColor, fromDash, toColor, toDash, unverified) {
  const { p1, c1a, c1b, mid, c2a, c2b, p2 } = geo;
  const d1 = `M ${p1[0]} ${p1[1]} C ${c1a[0]} ${c1a[1]} ${c1b[0]} ${c1b[1]} ${mid[0]} ${mid[1]}`;
  const d2 = `M ${mid[0]} ${mid[1]} C ${c2a[0]} ${c2a[1]} ${c2b[0]} ${c2b[1]} ${p2[0]} ${p2[1]}`;
  const dashStyle = (dash) => (dash ? `stroke-dasharray:${dash};` : '');
  const cls = `diagram-operation-chain-line${unverified ? ' diagram-operation-chain-line--unverified' : ''}`;
  const title = unverified ? '<title>運用番号による裏付けなし（近接推定のみ）</title>' : '';
  return (
    `<path d="${d1}" class="${cls}" style="stroke:${fromColor};${dashStyle(fromDash)}">${title}</path>` +
    `<path d="${d2}" class="${cls}" style="stroke:${toColor};${dashStyle(toDash)}">${title}</path>`
  );
}

// 折り返し運番と同じ役割だが、弧の頂点ではなくS字カーブの中点のすぐ上に
// 置く（頂点=stationの外側という概念がこちらにはないため）。
function throughNumberSvg(geo, text, color) {
  return `<text x="${geo.mid[0]}" y="${geo.mid[1] - 8}" text-anchor="middle" class="diagram-operation-label" style="fill:${color};">${text}</text>`;
}

// 折り返し運番: drawn ONCE per matched pair, horizontally centered on the
// outside of the turnback arc's apex (above an upward cap, below a downward
// one) — matching the reference image's "14A"/"10A" over the caps at 高岡
// and under the dips at 高根港. Replaces the previous per-endpoint labels,
// which drew the same number twice (once at each train's endpoint) slightly
// offset from each other.
function turnbackNumberSvg(geo, text, color) {
  const y = geo.sign < 0 ? geo.apexY - 4 : geo.apexY + 13;
  return `<text x="${geo.mx}" y="${y}" text-anchor="middle" class="diagram-operation-label" style="fill:${color};">${text}</text>`;
}

// The train's own number ("2110A" etc.), drawn ALONG its own line — rotated
// to the slope of the first actually-moving stretch and sitting just above
// it, the way the reference image writes "2114A" diagonally along each
// departing stroke (2026-07-15 feedback: "列番表示の場所…もっと06123に
// 近づけて"; previously this was a horizontal label floating at the origin
// point). Uses the first point pair with real horizontal AND vertical
// movement so a dwell (flat) segment at the origin doesn't yield a bogus
// 0° angle; falls back to the first segment's overall direction for trains
// that never move vertically (degenerate but possible in hand-made data).
function trainNumberLabelSvg(segments, text, color) {
  let pair = null;
  for (const points of segments) {
    for (let i = 0; i + 1 < points.length; i++) {
      if (points[i + 1][0] - points[i][0] > 1 && Math.abs(points[i + 1][1] - points[i][1]) > 1) {
        pair = [points[i], points[i + 1]];
        break;
      }
    }
    if (pair) break;
  }
  if (!pair) {
    const points = segments[0];
    pair = [points[0], points[points.length - 1]];
  }
  const [[ax, ay], [bx, by]] = pair;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const angle = Math.round(Math.atan2(by - ay, bx - ax) * (180 / Math.PI) * 10) / 10;
  return `<text transform="translate(${mx} ${my}) rotate(${angle})" dy="-3" text-anchor="middle" class="diagram-train-number-label" style="fill:${color};">${text}</text>`;
}

// Builds the little colored-line swatch + label row shown above the
// diagram, one entry per distinct train type actually present among
// `trains` (not every type declared in the source file — an unused type
// would just be dead legend clutter). Plain HTML (not SVG) so it wraps
// naturally via CSS flex-wrap regardless of how many types a file declares
// (real samples range from 2 to 9 — see NOTES.md「種別ごとの色分け」)
// instead of needing hand-rolled column/row math inside the SVG.
function legendHtml(trains, resolveColor) {
  const seen = new Map();
  for (const train of trains) {
    if (!train.trainType || seen.has(train.trainType.name)) continue;
    seen.set(train.trainType.name, train.trainType);
  }
  if (seen.size === 0) return '';
  const items = [...seen.values()]
    .map((type) => {
      const color = resolveColor(type.color);
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

// `zoomY` — a display-only scale multiplier (default 1) applied to the
// vertical (station-spacing) pixel density only, so a dense real-world
// import can be shrunk to fit without changing any underlying data (see
// issue #8's "拡大縮小...スライダーが欲しい" request). Driven by dedicated
// ＋/－ buttons in renderer/app.mjs (`stepDiagramZoomY`) — a plain slider
// used to control both axes at once, which got confusing once horizontal
// zoom moved to the mouse wheel (below), so vertical got its own explicit
// control (2026-07-14 feedback: "縦方向のズームと縮小は専用のボタンで").
// `zoomX` — the horizontal-only multiplier (`hourWidth = HOUR_WIDTH *
// zoomX`, entirely independent from `zoomY`/`plotHeight`) — driven by the
// mouse wheel over the diagram (renderer/app.mjs's setupDiagramPanZoom),
// matching the "縦固定・横方向のみホイールでズーム" request: the time axis
// can be zoomed independently for a closer look at a dense stretch of a
// dense timetable without also stretching the (already-fixed) station
// spacing.
// `theme` — 'dark' (default), 'light', or 'classic'; only 'dark' applies the
// dark-background visibility blend to train-type colors (see
// ensureVisibleOnDark) — OuDiaSecond's own colors already assume a
// light/white background, so both 'light' and 'classic' use them completely
// as-is (matching Diagram/image/06123.png, the reference the project owner
// supplied). 'classic' additionally draws 10-minute minor gridlines (inline
// below, right after the station gridlines) to match that reference's
// denser grid — issue #8's "クラシックモード(oudUIをがっつり参考に)"
// request; 'dark'/'light' don't draw them at all (rather than
// drawing-but-hiding via CSS) since nothing else about those two themes
// calls for the denser grid.
// Five independent overlay toggles (all default true, issue #10,
// 2026-07-14 split from the original 2 — "入出庫記号" and "運用番号" —
// into 5 so each renders/hides on its own):
//   showDepotMarkers            — 入出庫記号(○/▽), drawn at an endpoint
//                                 whenever inferOperationChains found NO
//                                 chain partner there (see depotMarkerSvg).
//   showChainLines              — 運用のつなぎ線 (operationChainLineSvg),
//                                 drawn once per chain-matched pair.
//   showDepotOperationNumbers   — 入出庫運番: the Operation field's
//                                 operationNumber label at an endpoint with
//                                 NO chain partner (alongside a depot
//                                 marker, when showDepotMarkers is also on).
//   showTurnbackOperationNumbers — 折り返し運番: the same label, but at an
//                                 endpoint that DOES have a chain partner
//                                 (alongside a connecting line).
//   showTrainNumbers            — the train's own number (trainNumberLabelSvg).
// Depot-vs-chain status is independent of these toggles (it's a property of
// the data, from inferOperationChains) — the toggles only control which of
// the two mutually-exclusive renderings (marker vs. line, depot-number vs.
// turnback-number) is drawn for the endpoints that actually have that
// status; an endpoint whose status is hidden by its toggle draws nothing,
// it does not fall back to the other rendering.
export function renderDiagram(
  container,
  { stations, trains },
  {
    highlightTrainId,
    adjustedTrain,
    zoomY = 1,
    zoomX = 1,
    theme = 'dark',
    showDepotMarkers = true,
    showChainLines = true,
    showDepotOperationNumbers = true,
    showTurnbackOperationNumbers = true,
    showTrainNumbers = true,
  } = {}
) {
  const maxDistanceKm = Math.max(...stations.map((s) => s.distanceKm), 1);
  const plotHeight = Math.max(200, stations.length * 60 * zoomY);
  const hourWidth = HOUR_WIDTH * zoomX;
  const { startHour, endHour } = computeHourRange(adjustedTrain ? [...trains, adjustedTrain] : trains);
  const plotWidth = (endHour - startHour) * hourWidth;
  const width = MARGIN.left + plotWidth + MARGIN.right;
  const height = MARGIN.top + plotHeight + MARGIN.bottom;
  const resolveColor = (hex) => (theme === 'dark' ? ensureVisibleOnDark(hex) : hex);

  const svgParts = [];
  svgParts.push(`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="diagram-svg">`);

  // Station horizontal gridlines + labels.
  for (const station of stations) {
    const y = distanceToY(station.distanceKm, maxDistanceKm, plotHeight);
    svgParts.push(`<line x1="${MARGIN.left}" y1="${y}" x2="${MARGIN.left + plotWidth}" y2="${y}" class="diagram-grid-line" />`);
    svgParts.push(`<text x="${MARGIN.left - 8}" y="${y + 4}" class="diagram-station-label" text-anchor="end">${station.name}</text>`);
  }

  // Classic theme only: 10-minute minor gridlines between each hour line,
  // drawn first so the hour lines/train lines layer on top — see the
  // renderDiagram doc comment above for why this is theme-gated instead of
  // always-rendered-but-CSS-hidden.
  if (theme === 'classic') {
    for (let h = startHour; h < endHour; h++) {
      for (let m = 10; m < 60; m += 10) {
        const x = timeToX(h * 3600 + m * 60, startHour, hourWidth);
        svgParts.push(`<line x1="${x}" y1="${MARGIN.top}" x2="${x}" y2="${MARGIN.top + plotHeight}" class="diagram-grid-line-minor" />`);
      }
    }
  }

  // Hourly vertical gridlines + labels. Labeled at the top edge (matching
  // Diagram/image/06123.png, whose hour row runs along the top) AND at the
  // bottom — a tall diagram lives in a vertically-scrolling container, so
  // whichever edge is currently visible still has readable hour marks.
  for (let h = startHour; h <= endHour; h++) {
    const x = timeToX(h * 3600, startHour, hourWidth);
    svgParts.push(`<line x1="${x}" y1="${MARGIN.top}" x2="${x}" y2="${MARGIN.top + plotHeight}" class="diagram-grid-line" />`);
    svgParts.push(`<text x="${x}" y="${MARGIN.top - 30}" class="diagram-hour-label" text-anchor="middle">${h % 24}</text>`);
    svgParts.push(`<text x="${x}" y="${MARGIN.top + plotHeight + 34}" class="diagram-hour-label" text-anchor="middle">${h % 24}</text>`);
  }

  // First point / last point / resolved color per train id — collected
  // while drawing each train's own line so the chain-line pass below (which
  // needs BOTH ends of a pair, potentially from trains processed in either
  // order, and each end's own color — see operationChainLineSvg) can look
  // them up after every train has been drawn once.
  const endpointsByTrainId = new Map();

  for (const train of trains) {
    const segments = trainPolylineSegments(train, stations, maxDistanceKm, plotHeight, startHour, hourWidth);
    if (segments.length === 0) continue;
    const isHighlighted = train.id === highlightTrainId;
    // Color/style by train type (OuDiaSecond's own Ressyasyubetsu — 普通/
    // 急行/回送 etc., each with its own diagram line color; see NOTES.md
    // 「種別ごとの色分け」). Falls back to the plain default (no inline
    // style) for data with no type info, e.g. hand-authored plan data.
    // Skipped while highlighted so the highlight color (set by the CSS
    // class below, which an inline style would otherwise outrank) wins.
    const resolvedColor = train.trainType ? resolveColor(train.trainType.color) : null;
    const typeStyle =
      resolvedColor && !isHighlighted
        ? ` style="stroke:${resolvedColor};${train.trainType.dashArray ? `stroke-dasharray:${train.trainType.dashArray};` : ''}"`
        : '';
    for (const points of segments) {
      const d = points.map((p) => p.join(',')).join(' ');
      svgParts.push(
        `<polyline points="${d}" class="diagram-train-line${isHighlighted ? ' diagram-train-line--highlight' : ''}" data-train-id="${train.id}"${typeStyle} />`
      );
    }

    const markerColor = resolvedColor || 'var(--color-accent)';
    const firstPoint = segments[0][0];
    const firstSegment = segments[0];
    const lastSegment = segments[segments.length - 1];
    const lastPoint = lastSegment[lastSegment.length - 1];
    // "Inner" neighbors — the nearest point on each end whose y actually
    // differs from the endpoint's (skipping same-station dwell points) —
    // tell turnbackGeometry which side of the station line each train's
    // line approaches from, so the turnback cap bulges away from both.
    let firstInner = null;
    for (let i = 1; i < firstSegment.length; i++) {
      if (Math.abs(firstSegment[i][1] - firstPoint[1]) > 0.5) {
        firstInner = firstSegment[i];
        break;
      }
    }
    let lastInner = null;
    for (let i = lastSegment.length - 2; i >= 0; i--) {
      if (Math.abs(lastSegment[i][1] - lastPoint[1]) > 0.5) {
        lastInner = lastSegment[i];
        break;
      }
    }
    endpointsByTrainId.set(train.id, {
      firstPoint,
      lastPoint,
      firstInner,
      lastInner,
      color: markerColor,
      dash: (train.trainType && train.trainType.dashArray) || null,
      train,
    });

    if (showTrainNumbers && train.number) {
      svgParts.push(trainNumberLabelSvg(segments, train.number, markerColor));
    }

    if (train.operation) {
      const { origin, terminal } = train.operation;
      const hasIncomingChain = !!train.chainPrevTrainId;
      const hasOutgoingChain = !!train.chainNextTrainId;
      // 出区/入区(等) marker vs. connecting line: see depotMarkerSvg's doc
      // comment — a boundary marker is drawn only when no chain partner was
      // found for that end, independent of the Operation field's own code.
      if (showDepotMarkers && !hasIncomingChain) {
        svgParts.push(depotMarkerSvg(firstPoint, 'origin', markerColor, origin && origin.depotWork));
      }
      if (showDepotMarkers && !hasOutgoingChain) {
        svgParts.push(depotMarkerSvg(lastPoint, 'terminal', markerColor, terminal && terminal.depotWork));
      }
      // 入出庫運番（チェーンなし端点）のみここで描く。折り返し運番
      // （チェーンあり端点）は下のチェーンパスで弧の頂点にペアごとに
      // 1つだけ描く（以前は両列車の端点に同じ番号が2回出ていた）。
      // depot-vs-chain状態そのものは常にhasIncomingChain/hasOutgoingChain
      // から決まり、トグルはその状態の表示/非表示だけを切り替える
      // （他方へのフォールバックはしない）。番号自体はチェーン伝播済みの
      // train.operationNumber（lib/oudParser.jsのpropagateOperationNumbers
      // 参照——ファイル上は運用の先頭列車にしか記録されないので、入区▽側
      // は伝播なしではほぼ常に無番号になってしまう）を優先し、端点固有の
      // 値にフォールバックする。
      const originNumber = train.operationNumber || (origin && origin.operationNumber);
      const terminalNumber = train.operationNumber || (terminal && terminal.operationNumber);
      if (originNumber && !hasIncomingChain && showDepotOperationNumbers) {
        svgParts.push(operationLabelSvg(firstPoint, originNumber, markerColor, 'left'));
      }
      if (terminalNumber && !hasOutgoingChain && showDepotOperationNumbers) {
        svgParts.push(operationLabelSvg(lastPoint, terminalNumber, markerColor, 'right'));
      }
    }
  }

  // 折り返しのつなぎ（弧）＋折り返し運番: once per matched pair (from the
  // earlier train's `chainNextTrainId` side only, so a mutual pair isn't
  // drawn twice) after every train's own endpoints/colors are known. The
  // two toggles are independent — the number still draws at the arc apex
  // position even when the arc itself is hidden.
  if (showChainLines || showTurnbackOperationNumbers) {
    for (const train of trains) {
      if (!train.chainNextTrainId) continue;
      const from = endpointsByTrainId.get(train.id);
      const to = endpointsByTrainId.get(train.chainNextTrainId);
      if (!from || !to) continue; // partner train had no drawable points (e.g. filtered elsewhere)
      // Reversal (turnback, arc bulging past the station line) vs.
      // same-direction continuation (S-curve blending the two slopes) — see
      // isReversalConnection's doc comment above.
      const yRef = (from.lastPoint[1] + to.firstPoint[1]) / 2;
      const reversal = isReversalConnection(from.lastInner, to.firstInner, yRef);
      const geo = reversal
        ? turnbackGeometry(from.lastPoint, from.lastInner, to.firstPoint, to.firstInner)
        : throughGeometry(from.lastPoint, from.lastInner, to.firstPoint, to.firstInner);
      // The chain-propagated number (see lib/oudParser.js's
      // propagateOperationNumbers — the file records the 運用番号 only at
      // the operation's 出区 head, so mid-chain turnbacks need the
      // propagated field), with the raw per-endpoint values as fallback for
      // data that reached us without the propagation pass. Computed before
      // the toggle checks below because turnbackArcSvg also needs it (its
      // absence is what makes a link "unverified" — see there).
      const toOp = to.train.operation;
      const fromOp = from.train.operation;
      const number =
        to.train.operationNumber ||
        from.train.operationNumber ||
        (toOp && toOp.origin && toOp.origin.operationNumber) ||
        (fromOp && fromOp.terminal && fromOp.terminal.operationNumber);
      if (showChainLines) {
        svgParts.push(
          reversal
            ? turnbackArcSvg(geo, from.color, from.dash, to.color, to.dash, !number)
            : throughConnectorSvg(geo, from.color, from.dash, to.color, to.dash, !number)
        );
      }
      if (showTurnbackOperationNumbers && number) {
        svgParts.push(reversal ? turnbackNumberSvg(geo, number, to.color) : throughNumberSvg(geo, number, to.color));
      }
    }
  }

  // The 運転整理-shifted version of one train, overlaid dashed on top of its
  // (still-visible) original plan line — so the delay's effect is visible at
  // a glance rather than replacing the plan outright.
  if (adjustedTrain) {
    const segments = trainPolylineSegments(adjustedTrain, stations, maxDistanceKm, plotHeight, startHour, hourWidth);
    for (const points of segments) {
      const d = points.map((p) => p.join(',')).join(' ');
      svgParts.push(
        `<polyline points="${d}" class="diagram-train-line diagram-train-line--adjusted" data-train-id="${adjustedTrain.id}" />`
      );
    }
  }

  svgParts.push('</svg>');
  container.innerHTML = legendHtml(trains, resolveColor) + svgParts.join('');
}
