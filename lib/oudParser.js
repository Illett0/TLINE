'use strict';

// Clean-room parser for OuDia/OuDiaSecond's .oud/.oud2 text format. Written
// from scratch against real (non-confidential) sample files under
// Diagram/ and OuDiaSecond's own public changelog articles describing the
// format's evolution (see NOTES.md「サンプルデータの扱い」/「.oud2フォーマット
// 構造メモ」for the license reasoning, sources, and how this was derived) —
// no OuDiaParser/clouddia source was read or referenced.
//
// Status: the outer dot-hierarchy, station/train-identity extraction, and
// EkiJikoku (per-station times) grammar are all confirmed against a
// deliberately-constructed minimal test file plus 400+ trains across every
// real sample in Diagram/ (see decodeEkiJikoku below and NOTES.md for the
// verification). Remaining gaps (multi-Dia selection, UI wiring, handling
// code / track semantics) are tracked in issue #1.

// Strips a leading UTF-8 BOM if present (all real sample files had one).
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Parses the dot-hierarchy into a generic tree: `Block.` opens a named
// block, a lone `.` line closes the innermost open block, `key=value` sets a
// property on the current block. Repeated block names become an array.
// Returns { props: {...}, children: { blockName: [node, ...] } }.
function parseTree(text) {
  const lines = stripBom(text).split(/\r\n|\r|\n/);
  const root = { props: {}, children: {} };
  const stack = [root];

  for (const line of lines) {
    if (line === '') continue;
    if (line === '.') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const eq = line.indexOf('=');
    // A block-open line has no '=' and ends with '.' (e.g. "Rosen.", "Eki.").
    if (eq === -1 && line.endsWith('.')) {
      const name = line.slice(0, -1);
      const node = { props: {}, children: {} };
      const parent = stack[stack.length - 1];
      (parent.children[name] || (parent.children[name] = [])).push(node);
      stack.push(node);
      continue;
    }
    if (eq !== -1) {
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      stack[stack.length - 1].props[key] = value;
    }
    // Lines matching neither pattern (shouldn't happen in a well-formed
    // file) are silently skipped rather than throwing — a single unknown
    // line shouldn't abort an otherwise-readable import.
  }
  return root;
}

function firstChild(node, name) {
  const list = node.children[name];
  return list && list.length > 0 ? list[0] : null;
}

function allChildren(node, name) {
  return node.children[name] || [];
}

// ---- EkiJikoku (per-train station times) decoding ----
//
// Grammar per OuDiaSecond's own published changelog (Ver2.00.05, FileType
// 1.05→1.07 — see NOTES.md「EkiJikoku（時刻本体）」for the source URL and
// full derivation): each station gets one comma-separated chunk, **always
// starting at chunk position 0 = the first station *this train's own
// timeline* visits, in visiting order** — there is no offset to solve for.
// For a Kudari (下り) train that's the same as the line's declared station
// order (index 0 = the line's first station), which is what this function
// assumes throughout (its `stationIndex` is the raw chunk position). A
// Nobori (上り) train visits the line in the *opposite* physical order
// though, so chunk position 0 there is the line's *last* station — the
// caller (parseDiagram) re-maps `stationIndex` for `up` trains after
// calling this function; see the comment there for how that was confirmed:
//
//   EkiJikoku = chunk (',' chunk)*
//   chunk     = '' | [0-2] ';' hhmmss ['/' hhmmss] ['$' track]
//
// A train that doesn't serve the line's later stations simply has fewer
// chunks (the array ends early); a train that doesn't serve some of the
// *earlier* stations still gets an empty chunk for each of them (verified
// against a deliberately-constructed minimal test file — Diagram/test.oud2
// — where a train skipping station A got a genuinely empty leading chunk
// rather than starting its array at station B). Confirmed at scale too:
// decoding every train in every Diagram/ sample this way (400+ trains
// across 7 Dia blocks in the densest file) produced monotonically
// non-decreasing times for all but one train, and that one exception is a
// train crossing midnight (see below), not a misalignment.
//
// `handling` (0-2, 運行なし/停車/通過) is not modeled here — this project only
// needs arrival/departure, and decodeEkiJikoku's arrival==departure fallback
// already covers what handling would otherwise disambiguate (see NOTES.md
// 「駅扱いコード」for the derivation). `track` (the number after `$`) *is*
// captured and passed through as an additive `stops[].track` field (see
// toTlineDiagram) — verified against Diagram/ samples to be a small integer
// (0-5 across every file) consistent with a platform/track number, though it
// doesn't always stay within the count of that station's declared
// `EkiTrack2` blocks (some platforms are used without ever being named) —
// so it's kept as a raw number, not resolved to a track name. Checked
// against every changelog entry from FileType 1.05 through 1.17 (the full
// version range covered by Diagram/ samples): none of them change the
// EkiJikoku grammar after its 1.07 introduction, so it's treated as stable
// across all supported files.
//
// A single time with no `/` occurs at any position (not just a train's
// first/last stop — verified empirically, e.g. many mid-route entries in
// dense timetables are bare too), and isn't reliably disambiguated by the
// station's `Ekijikokukeisiki` display format (that format describes the
// station's *default* display convention, not this specific train's
// direction — a station tagged `Jikokukeisiki_NoboriChaku`, meaning
// "up-direction shows arrival only", still gets a bare *departure* time
// for a down-direction train's own origin stop in the test file). Treated
// simply as arrival == departure == that time (an effectively-instantaneous
// stop) rather than guessing a direction-dependent interpretation.
//
// Time tokens are digit strings with the trailing `:00` seconds dropped when
// exactly on the minute: 4 digits = HHMM (seconds implied 00), 6 digits =
// HHMMSS. (E.g. "1619" = 16:19:00, "204350" = 20:43:50.) Shorter tokens
// (3 digits, e.g. "010" = 00:10:00) show up for early-morning/near-origin
// times in small test data and are padded the same way.

function parseTimeToken(token) {
  if (!token) return null;
  if (!/^\d{3,6}$/.test(token)) return null;
  const padded = token.length > 4 ? token.padStart(6, '0') : token.padStart(4, '0');
  const hh = padded.slice(0, 2);
  const mm = padded.slice(2, 4);
  const ss = padded.length > 4 ? padded.slice(4, 6) : '00';
  return `${hh}:${mm}:${ss}`;
}

function timeToSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

// Reformats an "HH:MM:SS" string after adding `days` whole days worth of
// seconds — used for late-night trains whose EkiJikoku times wrap past
// midnight (stored as plain 00:xx:xx, not >24:00), so TLINE's own
// >24:00 convention (see NOTES.md「データモデル」) can represent them
// without an apparent time-travel backwards in the diagram.
function addDays(hhmmss, days) {
  const totalSeconds = timeToSeconds(hhmmss) + days * 86400;
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// One comma-separated station chunk, e.g. "1;1619/1620$1", "1;1615$0",
// "2;204350$0", or "" (no data for this station).
function parseStationChunk(chunk) {
  if (!chunk) return { arrival: null, departure: null, track: null };
  const semi = chunk.indexOf(';');
  if (semi === -1) return { arrival: null, departure: null, track: null }; // handling code with no time attached

  const afterSemi = chunk.slice(semi + 1);
  const dollar = afterSemi.indexOf('$');
  const timePart = dollar === -1 ? afterSemi : afterSemi.slice(0, dollar);
  const trackTok = dollar === -1 ? null : afterSemi.slice(dollar + 1);
  const track = trackTok !== null && trackTok !== '' && /^\d+$/.test(trackTok) ? Number(trackTok) : null;
  const [aTok, dTok] = timePart.split('/');

  if (dTok !== undefined) {
    // Explicit arrival/departure pair; either side can be empty ("204730/").
    return { arrival: parseTimeToken(aTok), departure: parseTimeToken(dTok), track };
  }
  // Single time, no '/' — see module comment: treated as an instantaneous
  // stop (arrival and departure coincide) rather than guessing a direction.
  const time = parseTimeToken(aTok);
  return { arrival: time, departure: time, track };
}

// Decodes one train's EkiJikoku against the line's station list (chunks
// always start at station index 0 — see module comment). Returns
// { stops: [{stationIndex, arrival, departure, track}], confident } —
// `stops` only includes stations with a recorded arrival or departure
// (stations with no chunk data are omitted, matching this project's data
// model); `track` is the raw `$`-suffixed number (null if absent — see
// module comment on its still-imprecise meaning). Times are
// pushed past 24:00 (via `addDays`) if a midnight crossing is detected, so
// `stops` is always chronologically non-decreasing when `confident`.
// `confident` is true unless the decoded sequence still isn't monotonic
// after that adjustment (a genuine anomaly — corrupt data, or a modeling
// gap this parser doesn't understand yet). Returns null if raw is empty.
function decodeEkiJikoku(raw, stations) {
  if (!raw) return null;
  const chunks = raw.split(',');

  const stops = [];
  let days = 0;
  let prevSeconds = -Infinity;
  let confident = true;
  chunks.forEach((chunk, i) => {
    if (i >= stations.length) {
      confident = false; // more chunks than declared stations — shouldn't happen
      return;
    }
    const parsed = parseStationChunk(chunk);
    if (!parsed.arrival && !parsed.departure) return;

    for (const key of ['arrival', 'departure']) {
      if (!parsed[key]) continue;
      let seconds = timeToSeconds(parsed[key]) + days * 86400;
      if (seconds < prevSeconds - 3600) {
        // Dropped by more than an hour — a midnight wrap, not just two
        // events at the same station recorded slightly out of order.
        days += 1;
        seconds += 86400;
      }
      if (seconds < prevSeconds) confident = false; // still non-monotonic — flag rather than hide
      parsed[key] = days > 0 ? addDays(parsed[key], days) : parsed[key];
      prevSeconds = Math.max(prevSeconds, seconds);
    }
    stops.push({ stationIndex: i, arrival: parsed.arrival, departure: parsed.departure, track: parsed.track });
  });
  return { stops, confident };
}

// Converts an OuDiaSecond color property (8 hex chars, e.g. "000000FF") to a
// CSS "#rrggbb" string. Empirically these are Delphi-style TColor values
// written out as hex: byte 1 (unused/alpha) + byte 2 = blue + byte 3 = green
// + byte 4 = red — i.e. "AABBGGRR", not the "RRGGBB" order CSS expects.
// Verified against Diagram/高根鉄道TM.oud2's Ressyasyubetsu colors matching
// their real-world convention once decoded this way: 急行(express)
// "000000FF" → blue=00,green=00,red=FF → #FF0000 (red, the standard color
// for express trains on a real diagram); 回送(deadhead) "00808080" → gray
// (#808080) in every sample file, matching its usual muted/dashed treatment.
function oudColorToCss(hex8) {
  if (!hex8 || !/^[0-9A-Fa-f]{8}$/.test(hex8)) return null;
  const b = hex8.slice(2, 4);
  const g = hex8.slice(4, 6);
  const r = hex8.slice(6, 8);
  return `#${r}${g}${b}`.toLowerCase();
}

// Ressyasyubetsu's DiagramSenStyle → an SVG stroke-dasharray. Real files use
// 実線(solid)/破線(dashed, typically 回送)/点線(dotted, typically 試運転)/
// 一点鎖線(dash-dot) — see NOTES.md「種別ごとの色分け」.
function oudLineStyleToDashArray(style) {
  switch (style) {
    case 'SenStyle_Hasen':
      return '7,4';
    case 'SenStyle_Tensen':
      return '1.5,3';
    case 'SenStyle_Ittensasen':
      return '9,3,2,3';
    default:
      return null; // SenStyle_Jissen (solid) or unrecognized
  }
}

// Parses one `Ressya.`'s `Operation<chunkPosition><A|B>` property — a
// per-train, per-endpoint work-item record (前後作業: what happens *before*
// this train's own run starts / *after* it ends — B tags the first stop the
// train's own EkiJikoku has data for, A tags the last one, confirmed by
// checking every sample: the numeric suffix always exactly matches the
// train's own first/last populated chunk position). No official grammar for
// the *value* was found (checked OuDiaSecond's public changelog articles —
// see NOTES.md「運用番号・入出庫の解読」— nothing beyond the property NAMES
// `JikokuhyouOperationOrigin`/`...Terminal` existing at all); the following
// is inferred purely from statistics over every Diagram/ sample (2548
// Operation values checked):
//
//   value = "<code>/<time?>$<rest?>" [',' more entries — coupling/
//            splitting scenarios, not handled here, see below]
//
//   code 5 (2208/2548, ~87%) — no linked operation. This end of the train's
//   run is a plain depot boundary: 出区 (leaves the depot) if it's the B
//   (origin) side, 入区 (enters the depot) if it's the A (terminus) side.
//   code 3 (258/2548, ~10%) — linked to another operation. `rest` on the B
//   side is `/<operationNumber>` (e.g. "/10A") — these match the short
//   codes on the reference diagram image the project owner supplied
//   (Diagram/image/06123.png). `rest` on the A side never has one; the
//   number is evidently only ever recorded once, on whichever train's B
//   side picks the operation up next. `time` is when that handoff happens
//   (~1-2 minutes before this train's own first stop, consistent with a
//   same-platform, same-consist turnaround) — kept parsed but not yet used
//   to actually re-draw a connecting line between the two trains (see
//   NOTES.md — searching every stop in every Dia for a matching timestamp
//   found no reliable unique candidate, so drawing a connection would risk
//   linking the wrong trains; only the depot-boundary signal and the raw
//   operation-number string are used for now).
//   codes 0/1/2/6 (82/2548, ~3%) — only ever seen inside a comma-separated
//   multi-entry value (a train being split/coupled with specific OTHER
//   TRAIN NUMBERS referenced mid-string, e.g.
//   "0/4$2135/2136$0,0/3$2137/2138$0,5/$0"). Not modeled — returns `null`
//   (no depot marker drawn either way) rather than guessing at a multi-train
//   coupling scenario from three data points.
function parseOperationEndpoint(raw) {
  if (!raw) return null;
  const entries = raw.split(',');
  if (entries.length > 1) return null; // coupling/splitting — not modeled, see above
  const dollar = entries[0].indexOf('$');
  const before = dollar === -1 ? entries[0] : entries[0].slice(0, dollar);
  const after = dollar === -1 ? '' : entries[0].slice(dollar + 1);
  const [code, timeToken] = before.split('/');
  if (code === '5') return { linked: false, time: null, operationNumber: null };
  if (code === '3') {
    const operationNumber = after.startsWith('/') ? after.slice(1) || null : null;
    return { linked: true, time: parseTimeToken(timeToken) || null, operationNumber };
  }
  return null; // rare/multi-train code — not modeled
}

// Extracts the Rosen-level `Ressyasyubetsu.` blocks (train type/category
// definitions — 普通/急行/回送 etc., each with its own diagram line color
// and style) into a lookup array indexed the same way `Ressya.`'s
// `Syubetsu` property references them (verified: `Syubetsu=5` on a train
// matches the 6th — 0-indexed — Ressyasyubetsu block in every sample file).
function parseTrainTypes(rosen) {
  return allChildren(rosen, 'Ressyasyubetsu').map((t) => ({
    name: t.props['Syubetsumei'] || '',
    abbreviation: t.props['Ryakusyou'] || '',
    color: oudColorToCss(t.props['DiagramSenColor']) || '#4fa3ff',
    dashArray: oudLineStyleToDashArray(t.props['DiagramSenStyle']),
  }));
}

// Extracts station list + every `Dia.` block (direction, train number, and —
// where decodable — stop times) from a parsed .oud/.oud2 file. Returns null
// if the file doesn't look like a Rosen-based OuDia diagram at all (rather
// than throwing on unrelated text files a user might mistakenly pick).
//
// A real file commonly holds several named Dia blocks (パターンダイヤ, 仕業
// variants, etc. — see NOTES.md; 高根鉄道TM.oud2 has 7), so every Dia is
// decoded here and returned as a list for the caller (UI) to pick from —
// see toTlineDiagram below for turning one chosen Dia into TLINE's own plan
// data model.
//
// `station.distanceKm` is derived from `NextEkiDistance` (a display-only
// spacing value, not a real kilometer figure — see NOTES.md「.oud2フォーマット
// 構造メモ」), scaled down by 100 to land in a plausible km range for
// renderer/diagramView.mjs's axis; it's a relative-position proxy, not a
// claim of real distance. Most real files only set `NextEkiDistance` on a
// handful of stations (or none at all — checked across every sample in
// Diagram/: only 2 of 10 have it anywhere); the rest fall back to the
// Rosen-level `DiagramDgrYZahyouKyoriDefault` (present on every sample
// checked), which is the uniform spacing OuDiaSecond itself falls back to
// when a station has no explicit override.
function parseDiagram(text) {
  const tree = parseTree(text);
  const rosen = firstChild(tree, 'Rosen');
  if (!rosen) return null;

  const rawDefaultDistance = Number(rosen.props['DiagramDgrYZahyouKyoriDefault']);
  const defaultStationDistance = Number.isFinite(rawDefaultDistance) && rawDefaultDistance > 0 ? rawDefaultDistance : 60;

  const trainTypes = parseTrainTypes(rosen);

  const stations = [];
  let cumulativeDistance = 0;
  for (const eki of allChildren(rosen, 'Eki')) {
    const index = stations.length;
    stations.push({
      index,
      name: eki.props['Ekimei'] || '',
      shortName: eki.props['EkimeiJikokuRyaku'] || '',
      displayFormat: eki.props['Ekijikokukeisiki'] || null,
      distanceKm: Math.round(cumulativeDistance) / 100,
    });
    const nextDistance = Number(eki.props['NextEkiDistance']);
    cumulativeDistance += Number.isFinite(nextDistance) ? nextDistance : defaultStationDistance;
  }

  const dias = allChildren(rosen, 'Dia').map((dia, diaIndex) => {
    const trains = [];
    for (const dirBlockName of ['Kudari', 'Nobori']) {
      const dirBlock = firstChild(dia, dirBlockName);
      if (!dirBlock) continue;
      const direction = dirBlockName === 'Kudari' ? 'down' : 'up';
      for (const ressya of allChildren(dirBlock, 'Ressya')) {
        const raw = ressya.props['EkiJikoku'] || '';
        const decoded = decodeEkiJikoku(raw, stations);
        // EkiJikoku's chunk position is always index 0 = the first station
        // this train's own timeline visits, in visiting order — for a
        // Kudari (下り) train that already matches the line's declared
        // station order (index 0 = the line's own first station), but a
        // Nobori (上り) train visits the line in the opposite physical
        // order, so chunk position 0 there is the LINE's *last* station.
        // Verified against real data (Diagram/碧洛電車.oud2): decoded
        // as-is (no reversal), an "up" train's times increase with chunk
        // position exactly like a "down" train's — i.e. it reads as
        // traveling the same physical direction as 下り, which contradicts
        // 上り/下り being opposite directions on the same line (confirmed
        // by the project owner, who knows this network and OuDiaSecond's
        // own convention). Reversing only the *station* each stop is
        // labeled with (not the stop order/times) fixes this: the array
        // stays in chronological order (needed for the polyline to draw
        // correctly), each stop just points at line-index
        // `stations.length - 1 - chunkPosition` instead of `chunkPosition`.
        const stops = decoded
          ? decoded.stops.map((s) => (direction === 'up' ? { ...s, stationIndex: stations.length - 1 - s.stationIndex } : s))
          : [];
        const typeIndex = Number(ressya.props['Syubetsu']);

        // Operation<chunkPosition><A|B> is keyed by the train's own *raw*
        // (pre up/down-reversal) chunk position — find the first/last chunk
        // this train actually has EkiJikoku data for (see decodeEkiJikoku's
        // chunk-position convention) and look up its B/A property. See
        // parseOperationEndpoint for the value grammar and how confident
        // (or not) each part of it is.
        const populatedPositions = [];
        raw.split(',').forEach((chunk, i) => {
          if (chunk && chunk.includes(';')) populatedPositions.push(i);
        });
        const operation =
          populatedPositions.length > 0
            ? {
                origin: parseOperationEndpoint(ressya.props[`Operation${populatedPositions[0]}B`]),
                terminal: parseOperationEndpoint(ressya.props[`Operation${populatedPositions[populatedPositions.length - 1]}A`]),
              }
            : null;

        trains.push({
          number: ressya.props['Ressyabangou'] || '',
          direction,
          stops,
          timesConfident: decoded ? decoded.confident : false,
          trainType: Number.isInteger(typeIndex) ? trainTypes[typeIndex] || null : null,
          operation,
        });
      }
    }
    return { name: dia.props['DiaName'] || `ダイヤ${diaIndex + 1}`, trains };
  });

  return { lineName: rosen.props['Rosenmei'] || '', stations, dias, trainTypes };
}

// Converts one Dia (picked by index into `parsed.dias`, e.g. from a UI Dia
// picker) into TLINE's own plan data model (see NOTES.md「データモデル」and
// renderer/app.mjs's isValidDiagram — `{ line: { name, stations }, trains }`
// with stations/stops keyed by a stable string id, not a numeric index).
//
// Trains with zero decoded stops (no EkiJikoku data at all) are dropped —
// there's nothing to draw or dispatch-adjust — and counted in `stats` so the
// caller can tell the user what was skipped rather than silently losing
// trains. `timesConfident` (per train), `track` (per stop), `trainType`
// (per train — `{name, abbreviation, color, dashArray}` or null if the file
// has no Ressyasyubetsu match, e.g. hand-authored plan data), and
// `operation` (per train — `{origin, terminal}`, each either null or
// `{linked, time, operationNumber}`, see parseOperationEndpoint) are carried
// through as extra (data-model-additive) fields; renderer/diagramView.mjs
// reads `trainType` to color/style each line and `operation` to draw
// depot-boundary markers / operation-number labels, falling back to nothing
// when null. `track` has no consumer yet (kept for a future track-aware
// conflict check, issue #4).
function toTlineDiagram(parsed, diaIndex) {
  const dia = parsed.dias[diaIndex];
  if (!dia) return null;

  const stationId = (index) => `oud-st${index}`;
  const stations = parsed.stations.map((s) => ({
    id: stationId(s.index),
    name: s.name,
    distanceKm: s.distanceKm,
  }));

  let skippedTrains = 0;
  let unconfidentTrains = 0;
  const trains = [];
  dia.trains.forEach((train, i) => {
    if (!train.stops || train.stops.length === 0) {
      skippedTrains += 1;
      return;
    }
    if (!train.timesConfident) unconfidentTrains += 1;
    trains.push({
      id: `oud-${diaIndex}-${train.direction}-${i}`,
      number: train.number,
      direction: train.direction,
      timesConfident: train.timesConfident,
      trainType: train.trainType,
      operation: train.operation,
      stops: train.stops.map((s) => ({
        stationId: stationId(s.stationIndex),
        arrival: s.arrival,
        departure: s.departure,
        track: s.track,
      })),
    });
  });

  return {
    diagram: { line: { name: parsed.lineName, stations }, trains },
    stats: {
      diaName: dia.name,
      totalTrains: dia.trains.length,
      importedTrains: trains.length,
      skippedTrains,
      unconfidentTrains,
    },
  };
}

module.exports = { parseTree, parseDiagram, decodeEkiJikoku, parseTimeToken, toTlineDiagram };
