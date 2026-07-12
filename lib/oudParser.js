'use strict';

// Clean-room parser for OuDia/OuDiaSecond's .oud/.oud2 text format. Written
// from scratch against real (non-confidential) sample files under
// Diagram/ and OuDiaSecond's own public changelog articles describing the
// format's evolution (see NOTES.md「サンプルデータの扱い」/「.oud2フォーマット
// 構造メモ」for the license reasoning, sources, and how this was derived) —
// no OuDiaParser/clouddia source was read or referenced.
//
// Status: the outer dot-hierarchy, station/train-identity extraction, and
// EkiJikoku (per-station times) grammar are all confirmed. Full-route trains
// decode exactly; partial-route trains (short shuttles etc.) still rely on a
// monotonic-time heuristic to figure out which stations their data starts
// at, since that isn't recorded explicitly (see decodeEkiJikoku below and
// NOTES.md / issue #1 for the remaining gap).

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
// full derivation): each station gets one comma-separated chunk, in route
// order:
//
//   EkiJikoku = chunk (',' chunk)*
//   chunk     = '' | [0-2] ';' hhmmss ['/' hhmmss] ['$' track]
//
// i.e. an empty chunk (no data for that station — the changelog's own
// example starts "…,…" showing blank entries), or `handling;time[/time2]`
// optionally suffixed with `$trackNumber`. `handling` (0-2) and `track` are
// not modeled here — this project only needs arrival/departure. Checked
// against every changelog entry from FileType 1.05 through 1.17 (the full
// version range covered by the current Diagram/ samples): none of them
// change this grammar after its 1.07 introduction, so it's treated as
// stable across all supported files.
//
// A single time with no `/` is ambiguous (arrival-only vs. departure-only);
// resolved using the station's own `Ekijikokukeisiki` display-format flag
// (Hatsu = departure-only, Chaku/*Chaku = arrival-only, Hatsuchaku = both —
// though a Hatsuchaku station should already carry the `/` form).
//
// Chunk count equals the number of stations the train's own service pattern
// touches — for an all-stops local this is every declared `Eki.`, but a
// short shuttle only gets chunks for the stations on its own subrange, and
// nothing in the data says which stations those are. Resolved the same way
// as before: try every contiguous alignment against the full station list
// and keep the one(s) whose decoded times are monotonically non-decreasing
// (a train can't arrive somewhere before it left the previous station).
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

// One comma-separated station chunk, e.g. "1;1619/1620$1", "1;1615$0",
// "2;204350$0", or "" (no data for this station).
function parseStationChunk(chunk, displayFormat) {
  if (!chunk) return { arrival: null, departure: null };
  const semi = chunk.indexOf(';');
  if (semi === -1) return { arrival: null, departure: null }; // handling code with no time attached

  const afterSemi = chunk.slice(semi + 1);
  const dollar = afterSemi.indexOf('$');
  const timePart = dollar === -1 ? afterSemi : afterSemi.slice(0, dollar);
  const [aTok, dTok] = timePart.split('/');

  if (dTok !== undefined) {
    // Explicit arrival/departure pair; either side can be empty ("204730/").
    return { arrival: parseTimeToken(aTok), departure: parseTimeToken(dTok) };
  }
  // Single time, no '/' — disambiguate via the station's declared format.
  const time = parseTimeToken(aTok);
  if (displayFormat === 'Jikokukeisiki_Hatsu') return { arrival: null, departure: time };
  if (displayFormat && displayFormat.endsWith('Chaku') && displayFormat !== 'Jikokukeisiki_Hatsuchaku') {
    return { arrival: time, departure: null };
  }
  // Unknown/Hatsuchaku-but-collapsed format: best effort, treat as both
  // (a real single-instant stop where arrival and departure coincide).
  return { arrival: time, departure: time };
}

// Tries aligning `chunks` against a route of `stationCount` stations,
// starting at every possible offset, and keeps the offset(s) whose decoded
// times are monotonically non-decreasing. Returns { offset, confident } —
// confident is true only when exactly one offset satisfies the constraint.
function findAlignment(chunks, stations) {
  if (chunks.length === stations.length) return { offset: 0, confident: true };
  if (chunks.length > stations.length) return { offset: null, confident: false };

  const candidates = [];
  const maxOffset = stations.length - chunks.length;
  for (let offset = 0; offset <= maxOffset; offset++) {
    const stops = chunks.map((c, i) => parseStationChunk(c, stations[offset + i] && stations[offset + i].displayFormat));
    const times = stops.flatMap((s) => [s.arrival, s.departure].filter(Boolean));
    const seconds = times.map(timeToSeconds);
    const monotonic = seconds.every((v, i) => i === 0 || v >= seconds[i - 1]);
    if (monotonic) candidates.push(offset);
  }
  return { offset: candidates[0] ?? null, confident: candidates.length === 1 };
}

// Decodes one train's EkiJikoku against the line's station list. Returns
// { stops: [{stationIndex, arrival, departure}], confident } — `stops` only
// includes stations with a recorded arrival or departure (stations with no
// chunk data are omitted, matching this project's data model). Returns null
// if raw is empty or decoding failed entirely (more chunks than stations,
// e.g. a corrupt/unrecognized file).
function decodeEkiJikoku(raw, stations) {
  if (!raw) return null;
  const chunks = raw.split(',');

  const { offset, confident } = findAlignment(chunks, stations);
  if (offset == null) return null;

  const stops = [];
  chunks.forEach((chunk, i) => {
    const station = stations[offset + i];
    const parsed = parseStationChunk(chunk, station && station.displayFormat);
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
        const decoded = decodeEkiJikoku(raw, stations);
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
