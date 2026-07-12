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
// starting at the line's first declared station (index 0), in route
// order** — there is no offset to solve for:
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
// `handling` (0-2) and `track` are not modeled here — this project only
// needs arrival/departure, and their exact meaning isn't documented (see
// NOTES.md「今後さらに欲しい.oud情報」). Checked against every changelog entry
// from FileType 1.05 through 1.17 (the full version range covered by
// Diagram/ samples): none of them change the EkiJikoku grammar after its
// 1.07 introduction, so it's treated as stable across all supported files.
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
  // Single time, no '/' — see module comment: treated as an instantaneous
  // stop (arrival and departure coincide) rather than guessing a direction.
  const time = parseTimeToken(aTok);
  return { arrival: time, departure: time };
}

// Decodes one train's EkiJikoku against the line's station list (chunks
// always start at station index 0 — see module comment). Returns
// { stops: [{stationIndex, arrival, departure}], confident } — `stops` only
// includes stations with a recorded arrival or departure (stations with no
// chunk data are omitted, matching this project's data model); times are
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
    stops.push({ stationIndex: i, arrival: parsed.arrival, departure: parsed.departure });
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
