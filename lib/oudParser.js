'use strict';

// Clean-room parser for OuDia/OuDiaSecond's .oud/.oud2 text format. Written
// from scratch against real (non-confidential) sample files under
// Diagram/（see NOTES.md「サンプルデータの扱い」/「.oud2フォーマット構造メモ」
// for the license reasoning and how this structure was derived）— no
// OuDiaParser/clouddia source was read or referenced.
//
// Status: the outer dot-hierarchy and station/train-identity extraction are
// solid (verified against real files). The EkiJikoku field (per-station
// arrival/departure times) is NOT decoded yet — the encoding is denser than
// "one $-segment per station" and needs minimal controlled test files to
// pin down safely (see NOTES.md). Until then, `stops` is intentionally left
// null on every train rather than guessing and risking silently-wrong times.

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
// Confirmed against real sample files (see NOTES.md「EkiJikoku（時刻本体）」):
// `$` separates one segment per station the train's route covers, in route
// order, PLUS one trailing non-station segment (a single number — meaning
// still unknown, dropped here). A stopping train that covers the line's full
// N declared stations has N+1 `$`-segments; a train that only covers part of
// the route (e.g. a short shuttle) has fewer, and which stations they
// correspond to isn't recorded explicitly — resolved by trying every
// contiguous alignment and keeping the one whose decoded times never go
// backwards (a train can't arrive somewhere before it left the previous
// station). This is a heuristic for the partial-route case; full-route
// trains are exact.
//
// Within a station's segment, comma separates per-track candidate slots
// (a station with several EkiTrack2 entries gets a comma slot per track);
// exactly one slot — the one containing `;` — holds real data, the rest are
// empty (no stop on that track) or bare digits with no time. A `;`-having
// slot's value is `trackNumber;time` or `trackNumber;arrival/departure`.
// No `;`-having slot at all means the train passes that station without
// stopping.
//
// Time tokens are digit strings with the trailing `:00` seconds dropped when
// exactly on the minute: 4 digits = HHMM (seconds implied 00), 6 digits =
// HHMMSS. (E.g. "1619" = 16:19:00, "204350" = 20:43:50.)

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

// One comma-separated track slot, e.g. "1;1619/1620", "1;1615", "0" (empty).
function parseTrackSlot(slot) {
  const semi = slot.indexOf(';');
  if (semi === -1) return null; // no time recorded on this track slot
  const timePart = slot.slice(semi + 1);
  const [a, d] = timePart.split('/');
  return { arrival: parseTimeToken(a), departure: a && d === '' ? null : parseTimeToken(d) };
}

// One `$`-separated per-station segment, e.g. "0,1;1619/1620" or "0,1" (pass).
function parseStationSegment(segment) {
  for (const slot of segment.split(',')) {
    const parsed = parseTrackSlot(slot);
    if (parsed) return parsed;
  }
  return { arrival: null, departure: null }; // passed without stopping
}

// Tries aligning `segments` (already stripped of the trailing non-station
// segment) against a route of `stationCount` stations, starting at every
// possible offset, and keeps the offset(s) whose decoded times are
// monotonically non-decreasing. Returns { offset, confident } — confident is
// true only when exactly one offset satisfies the constraint.
function findAlignment(segments, stationCount) {
  if (segments.length === stationCount) return { offset: 0, confident: true };
  if (segments.length > stationCount) return { offset: null, confident: false };

  const candidates = [];
  const maxOffset = stationCount - segments.length;
  for (let offset = 0; offset <= maxOffset; offset++) {
    const stops = segments.map(parseStationSegment);
    const times = stops.flatMap((s) => [s.arrival, s.departure].filter(Boolean));
    const seconds = times.map(timeToSeconds);
    const monotonic = seconds.every((v, i) => i === 0 || v >= seconds[i - 1]);
    if (monotonic) candidates.push(offset);
  }
  return { offset: candidates[0] ?? null, confident: candidates.length === 1 };
}

// Decodes one train's EkiJikoku against the line's station list. Returns
// { stops: [{stationIndex, arrival, departure}], confident } — `stops` only
// includes stations with a recorded arrival or departure (passed-through
// stations are omitted, matching this project's data model). Returns null
// if raw is empty or decoding failed entirely (more segments than stations,
// e.g. a corrupt/unrecognized file).
function decodeEkiJikoku(raw, stationCount) {
  if (!raw) return null;
  let segments = raw.split('$');
  // Drop the trailing non-station segment when the count lines up with
  // "full route + 1"; a partial-route train still gets the same +1 tail.
  if (segments.length > 0) segments = segments.slice(0, -1);
  if (segments.length === 0) return null;

  const { offset, confident } = findAlignment(segments, stationCount);
  if (offset == null) return null;

  const stops = [];
  segments.forEach((segment, i) => {
    const parsed = parseStationSegment(segment);
    if (parsed.arrival || parsed.departure) {
      stops.push({ stationIndex: offset + i, arrival: parsed.arrival, departure: parsed.departure });
    }
  });
  return { stops, confident };
}

// Extracts station list + trains (direction, number, and — where decodable —
// stop times) from a parsed .oud/.oud2 file. Returns null if the file
// doesn't look like a Rosen-based OuDia diagram at all (rather than throwing
// on unrelated text files a user might mistakenly pick). Only the first
// `Dia.` block is read; files with multiple named diagrams (パターンダイヤ,
// 仕業 variants, etc. — see NOTES.md) need a Dia picker, not built yet.
function parseDiagram(text) {
  const tree = parseTree(text);
  const rosen = firstChild(tree, 'Rosen');
  if (!rosen) return null;

  const stations = allChildren(rosen, 'Eki').map((eki, index) => ({
    index,
    name: eki.props['Ekimei'] || '',
    shortName: eki.props['EkimeiJikokuRyaku'] || '',
    displayFormat: eki.props['Ekijikokukeisiki'] || null,
  }));

  const dia = firstChild(rosen, 'Dia');
  const trains = [];
  if (dia) {
    for (const dirBlockName of ['Kudari', 'Nobori']) {
      const dirBlock = firstChild(dia, dirBlockName);
      if (!dirBlock) continue;
      for (const ressya of allChildren(dirBlock, 'Ressya')) {
        const raw = ressya.props['EkiJikoku'] || '';
        const decoded = decodeEkiJikoku(raw, stations.length);
        trains.push({
          number: ressya.props['Ressyabangou'] || '',
          direction: dirBlockName === 'Kudari' ? 'down' : 'up',
          stops: decoded ? decoded.stops : null,
          timesConfident: decoded ? decoded.confident : false,
        });
      }
    }
  }

  return { lineName: rosen.props['Rosenmei'] || '', stations, trains };
}

module.exports = { parseTree, parseDiagram, decodeEkiJikoku, parseTimeToken };
