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
// train's own first/last populated chunk position).
//
// OuDiaSecond's public manual (「駅作業の概要」,
// https://oudiasecond.seesaa.net/article/467616218.html) documents the
// *concept* this maps to — opening work is one of 出区(leaves the depot) /
// 路線外始発(originates off-line) / 前列車接続(connects from a previous
// train); closing work is 入区(enters the depot) / 路線外終着(terminates
// off-line) / 次列車接続(connects to a next train) — confirming the
// depot-vs-linked distinction below is the right concept. It does NOT
// document the on-disk *value grammar* though, so the actual parsing here
// is still inferred from statistics over every Diagram/ sample (2548
// Operation values checked) — see NOTES.md「運用番号・入出庫の解読」:
//
//   value = "<code>/<time?>$<rest?>" [',' more entries — coupling/
//            splitting scenarios, not handled here, see below]
//
//   code 5 (2208/2548, ~87%) — no linked operation: 出区/入区 (plain depot
//   boundary, matching the manual's most common case).
//   code 3 (258/2548, ~10%) — 前列車接続/次列車接続 (linked to another
//   operation). `rest` on the B side is `/<operationNumber>` (e.g. "/10A")
//   — matches the short codes on the reference diagram image the project
//   owner supplied (Diagram/image/06123.png) and the manual's statement
//   that "出区の○印及び入区の△印の横に、運用番号が表記されます" (the
//   operation number is shown next to both markers) — though here it's
//   only ever present in the raw string on the B/incoming side; the manual
//   implies a number is shown at 出区 too, but no distinct field for that
//   case was found, so an un-linked (code 5) origin currently gets a ○ with
//   no number rather than a guessed one. `time` is when the handoff happens
//   (~1-2 minutes before this train's own first stop, consistent with a
//   same-platform, same-consist turnaround) — kept parsed and still shown
//   as a label when present, but **not used to detect connections anymore**
//   (see inferOperationChains below for why and what replaced it).
//
//   Confirmed 2026-07-13: the project owner checked 高根鉄道TM.oud2's
//   回2010A (the code-3 case above, Operation2B="3/2059$/10A") directly in
//   OuDiaSecond's own UI — there is in fact no previous train for it to
//   connect from. So `linked: true` does NOT mean "this is a real
//   continuation of another train's run"; it just means the record happens
//   to carry an operation-number string alongside an otherwise ordinary
//   depot boundary.
//
//   Further findings 2026-07-14 (this field's `linked`/`time` fully given up
//   on as a connection signal — see inferOperationChains below): re-checking
//   回2010A's OWN LAST stop (not the code-3 origin end investigated above)
//   against every OTHER train's first stop in the same Dia by matching
//   station+番線(track)+arrival→departure gap directly (bypassing this
//   field entirely) turned up 回2010A → 2110A: a 90-second, same-track
//   hand-off at 品山 — an obvious real 回送→本線 duty continuation. Yet
//   `2110A.operation.origin.linked` is `false` (code 5, "plain depot
//   boundary") and `回2010A.operation.terminal.linked` is also `false` — so
//   this field's code doesn't reliably flag genuine connections even when
//   they demonstrably exist in the data, on either train's either end. That
//   makes code 3 too unreliable to gate connection-drawing on (false
//   negatives, on top of the earlier-confirmed false positive) and code 5
//   too unreliable to treat as a confirmed depot boundary. inferOperationChains
//   replaces both with a check against the trains' own stop data instead.
//   codes 0/1/2/6 (82/2548, ~3%) — only ever seen inside a comma-separated
//   multi-entry value (a train being split/coupled with specific OTHER
//   TRAIN NUMBERS referenced mid-string, e.g.
//   "0/4$2135/2136$0,0/3$2137/2138$0,5/$0", plus a companion
//   `Operation<pos>.<n><A|B>` property for sub-entry `n` in some samples —
//   e.g. `Operation5A.0A`). Likely 路線外始発/終着 and/or coupling — not
//   modeled. Returns `null` (no depot marker drawn either way) rather than
//   guessing at a multi-train scenario from a handful of data points.
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

// Infers 運用のつなぎ (operation chains — the same physical train set
// continuing under a new train number, e.g. a 回送/deadhead arriving then
// immediately re-departing as a revenue service) directly from the trains'
// own decoded stop data, WITHOUT reading the Operation field's `linked`/
// `time` at all — see the long comment above parseOperationEndpoint for why
// that field turned out not to be a reliable connection signal (neither a
// reliable positive nor a reliable negative one).
//
// The signal used instead: train A's own run ends (its LAST stop's arrival)
// at the same station and the same declared 番線(track) that train B's own
// run begins (its FIRST stop's departure) shortly after — a same-platform
// hand-off is about as strong a same-physical-vehicle signal as this file
// format exposes short of an explicit consist ID. Confirmed against
// Diagram/高根鉄道TM.oud2's Dia「2h"T"Mパターン　仕業」: 回2010A's last stop
// (品山, track 1, arrives 21:01:30) precedes 2110A's first stop (品山,
// track 1, departs 21:03:00) by 90 seconds — an obvious 回送→本線 duty
// continuation neither train's Operation field flags as linked.
//
// Both a station+track match AND a gap within [0, MAX_HANDOFF_GAP_SECONDS]
// are required — track compatibility (equal, or either side 0 = 番線未指定,
// see tracksCompatible below) is what makes this trustworthy (same station,
// two *different nonzero* tracks, within the window is just as likely two
// unrelated trains passing through as a real hand-off; see NOTES.md
// 「入出庫の定義」for the broader search that ruled out time-only or
// Operation-field-time matching). Ties are deliberately left unresolved: if
// station+track+gap turns up more than one plausible next (or previous)
// train, or the two trains' *mutual* nearest match disagree (A's nearest
// candidate is B, but B's nearest candidate is some other train C), no
// chain is recorded for that endpoint at all — connecting the wrong two
// trains is worse than falling back to a plain depot marker, and a single
// physical train set can't fan out into two different next trains or merge
// from two different previous ones.
//
// Mutates `trains` in place, adding `chainNextIndex`/`chainPrevIndex`
// (indices back into this same array, or left `undefined`/absent when no
// chain was found) — parseDiagram calls this once per Dia, and
// toTlineDiagram resolves the indices to the TLINE train ids it assigns
// (see there for why that has to be a second pass).
const MAX_HANDOFF_GAP_SECONDS = 15 * 60;

function inferOperationChains(trains) {
  const arrivals = []; // one entry per train that has stops: its own last stop
  const departures = []; // ...and its own first stop
  trains.forEach((train, index) => {
    if (!train.stops || train.stops.length === 0) return;
    const first = train.stops[0];
    const last = train.stops[train.stops.length - 1];
    const depTimeToken = first.departure || first.arrival;
    const arrTimeToken = last.arrival || last.departure;
    if (depTimeToken) departures.push({ index, stationIndex: first.stationIndex, track: first.track, time: timeToSeconds(depTimeToken) });
    if (arrTimeToken) arrivals.push({ index, stationIndex: last.stationIndex, track: last.track, time: timeToSeconds(arrTimeToken) });
  });

  // Track compatibility: exact equality, OR either side is 0. Track 0 turned
  // out to mean "番線未指定" rather than a real platform (2026-07-15,
  // arbitrated against Diagram/image/06123.png — OuDiaSecond's own rendering
  // of this data): 5110A arrives 高根 track0 21:33:10 and 2111A departs 高根
  // track3 21:42:00, and the reference image labels that turnback arc "10A"
  // (=5110A's operation continuing into 2111A) even though the recorded
  // tracks differ. Same for 2120A(0)→2221A(3)="20A" and 2212A(0)→2213A(3)=
  // "12A" — note the last one also rules out plain time-nearest-any-track
  // matching: 2205A (track2) arrives 高根 only 1m40s before 2213A departs,
  // but the reference labels the arc "12A" (the track-0 arrival 8m50s
  // earlier), not "04A". Two genuinely-different nonzero tracks (e.g. 2205A's
  // track2 vs 2213A's track3) still never match.
  function tracksCompatible(t1, t2) {
    return t1 === t2 || t1 === 0 || t2 === 0;
  }

  // Nearest same-station+compatible-track departure (nonnegative gap, within
  // the window) for each arrival, and the mirror search for each departure —
  // kept as two explicit passes (rather than one parameterized helper) so
  // "mutual nearest" below is checking two independently-computed answers,
  // not the same search read backwards.
  function nearestDeparture(arrival) {
    if (arrival.track == null) return null;
    let best = null;
    for (const d of departures) {
      if (d.index === arrival.index || d.stationIndex !== arrival.stationIndex || d.track == null || !tracksCompatible(d.track, arrival.track)) continue;
      const gap = d.time - arrival.time;
      if (gap < 0 || gap > MAX_HANDOFF_GAP_SECONDS) continue;
      if (!best || gap < best.gap) best = { index: d.index, gap };
    }
    return best;
  }
  function nearestArrival(departure) {
    if (departure.track == null) return null;
    let best = null;
    for (const a of arrivals) {
      if (a.index === departure.index || a.stationIndex !== departure.stationIndex || a.track == null || !tracksCompatible(a.track, departure.track)) continue;
      const gap = departure.time - a.time;
      if (gap < 0 || gap > MAX_HANDOFF_GAP_SECONDS) continue;
      if (!best || gap < best.gap) best = { index: a.index, gap };
    }
    return best;
  }

  const nextFor = new Map(); // arrival's train index -> best departure match
  for (const a of arrivals) {
    const match = nearestDeparture(a);
    if (match) nextFor.set(a.index, match);
  }
  const prevFor = new Map(); // departure's train index -> best arrival match
  for (const d of departures) {
    const match = nearestArrival(d);
    if (match) prevFor.set(d.index, match);
  }

  for (const [fromIndex, next] of nextFor) {
    const back = prevFor.get(next.index);
    if (back && back.index === fromIndex) {
      trains[fromIndex].chainNextIndex = next.index;
      trains[next.index].chainPrevIndex = fromIndex;
    }
  }
}

// Walks each operation chain (see inferOperationChains) from its head and
// assigns every train on it a resolved `operationNumber`. The file itself
// records the 運用番号 string only ONCE per operation — on the head train's
// origin endpoint (the 出区 point; e.g. in 高根鉄道TM.oud2's Dia
// 「2h"T"Mパターン」exactly 7 trains carry one, all of them chain heads:
// 回2010A="10A", 2112A="12A", … — verified 2026-07-15, zero mid-chain or
// terminal-side occurrences in that Dia). OuDiaSecond's own diagram
// nevertheless shows that number at every turnback of the operation and at
// its final 入区 ▽ (see Diagram/image/06123.png, where "14A" repeats along
// one duty's whole zig-zag) — i.e. it treats the number as a property of
// the chain, not of the single endpoint it happens to be stored on. This
// pass reproduces that: carry the head's number forward along
// `chainNextIndex` links so renderer/diagramView.mjs can label depot
// markers and turnback arcs alike from one per-train field.
//
// A mid-chain origin number (never seen in real data, but the grammar
// allows it) replaces the running number from that train onward; a
// terminal-side number is only adopted when nothing better is known.
// The `visited` set guards against a hypothetical chain cycle (mutual
// nearest-neighbor matching over strictly-increasing times shouldn't
// produce one, but an infinite loop would take the whole import down).
function propagateOperationNumbers(trains) {
  trains.forEach((train, headIndex) => {
    if (train.chainPrevIndex != null) return; // mid-chain — its head will reach it
    const visited = new Set();
    let number = null;
    let index = headIndex;
    while (index != null && !visited.has(index)) {
      visited.add(index);
      const t = trains[index];
      const originNumber = t.operation && t.operation.origin && t.operation.origin.operationNumber;
      const terminalNumber = t.operation && t.operation.terminal && t.operation.terminal.operationNumber;
      if (originNumber) number = originNumber;
      if (!number && terminalNumber) number = terminalNumber;
      t.operationNumber = number || null;
      index = t.chainNextIndex != null ? t.chainNextIndex : null;
    }
  });
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

// `Eki.`'s `Ekikibo` property — station importance/scale (主要駅/一般駅
// etc.), used by renderer/app.mjs's timetable to decide how many time
// "boxes" a station's cell gets (2026-07-14 request, see NOTES.md「タイム
// テーブル」): confirmed present as exactly two values across every sample
// in Diagram/ — `Ekikibo_Syuyou`(主要, 54/141 stations) and
// `Ekikibo_Ippan`(一般, 87/141) — so mapped 1:1 to `'major'`/`'general'`.
// Returns `null` for anything else (absent property, or an unrecognized
// value) — the timetable falls back to a generic layout when this is null,
// rather than guessing which of the two a stranger value might mean.
function parseEkikibo(raw) {
  if (raw === 'Ekikibo_Syuyou') return 'major';
  if (raw === 'Ekikibo_Ippan') return 'general';
  return null;
}

// Median run time (seconds) between each adjacent station pair, measured
// from the trains' own decoded stops: two chronologically-consecutive stops
// whose (post up/down-flip) stationIndex differs by exactly ±1 contribute
// (departure of the earlier → arrival of the later). Pairs no train ever
// runs directly stay null. The ±1 requirement automatically excludes both
// skip-stop segments (an express jumping index 3→7 says nothing about any
// single pair's run time) and the repeated-junction branch seam (index
// 1→10 jumps at 高岡東 — see NOTES.md「支線・分岐の表現」). Median rather
// than min/mean so a single odd sample (a padded schedule, a decode quirk)
// can't skew the whole line's spacing.
function pairRunSecondsMedians(trains, pairCount) {
  const samples = Array.from({ length: pairCount }, () => []);
  for (const train of trains) {
    const stops = train.stops || [];
    for (let k = 0; k + 1 < stops.length; k++) {
      const a = stops[k];
      const b = stops[k + 1];
      if (Math.abs(b.stationIndex - a.stationIndex) !== 1) continue;
      const dep = a.departure || a.arrival;
      const arr = b.arrival || b.departure;
      if (!dep || !arr) continue;
      const t1 = timeToSeconds(dep);
      const t2 = timeToSeconds(arr);
      if (!(t2 > t1)) continue;
      samples[Math.min(a.stationIndex, b.stationIndex)].push(t2 - t1);
    }
  }
  return samples.map((list) => {
    if (list.length === 0) return null;
    list.sort((x, y) => x - y);
    return list[Math.floor(list.length / 2)];
  });
}

// Fills every station's cumulative `distanceKm` from per-pair spacing,
// resolved in this priority order (all four sources share the same rough
// unit — NextEkiDistance was already suspected to BE auto-derived run
// seconds, see NOTES.md「.oud2フォーマット構造メモ」):
//   1. explicit `NextEkiDistance` on the earlier station of the pair;
//   2. run-time medians from the Dia `KijunDiaIndex` points at —
//      OuDiaSecond V2's 基準運転時分 (standard run time) Dia, which is what
//      its own diagram derives Y spacing from (高根鉄道TM.oud2:
//      KijunDiaIndex=0 →「基準運転時分」Dia; spacing derived this way is
//      non-uniform matching the reference image 06123.png, fixing the
//      "駅間の距離が一定" report of 2026-07-15);
//   3. run-time medians across ALL Dias' trains (files without a usable
//      KijunDiaIndex — e.g. 碧洛電車.oud2 — still get realistic spacing);
//   4. `DiagramDgrYZahyouKyoriDefault` (uniform; also covers pairs with no
//      direct runs at all, like the main-line→branch-section seam).
function assignStationDistances(stations, dias, kijunDiaIndex, nextEkiDistances, defaultStationDistance) {
  const pairCount = Math.max(stations.length - 1, 0);
  const kijunDia = kijunDiaIndex != null ? dias[kijunDiaIndex] : undefined;
  const kijunMedians = kijunDia ? pairRunSecondsMedians(kijunDia.trains, pairCount) : null;
  const allMedians = pairRunSecondsMedians(dias.flatMap((d) => d.trains), pairCount);
  let cumulative = 0;
  stations.forEach((station, i) => {
    station.distanceKm = Math.round(cumulative) / 100;
    if (i >= pairCount) return;
    const gap =
      nextEkiDistances[i] ?? (kijunMedians ? kijunMedians[i] : null) ?? allMedians[i] ?? defaultStationDistance;
    cumulative += gap;
  });
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
// `station.distanceKm` is a display-only relative spacing (scaled down by
// 100 to land in a plausible km range for renderer/diagramView.mjs's axis;
// a relative-position proxy, not a claim of real distance — see NOTES.md
// 「.oud2フォーマット構造メモ」), resolved per adjacent station pair by
// assignStationDistances (see its doc comment for the priority order:
// explicit NextEkiDistance → 基準運転時分 Dia run times → all-Dia run
// times → the Rosen-level DiagramDgrYZahyouKyoriDefault uniform fallback).
// Before 2026-07-15 only NextEkiDistance/default were used, and since just
// 2 of 10 samples set NextEkiDistance at all, most files rendered with
// uniform station spacing — unlike OuDiaSecond's own rendering of the same
// data (Diagram/image/06123.png), whose spacing varies per pair.
function parseDiagram(text) {
  const tree = parseTree(text);
  const rosen = firstChild(tree, 'Rosen');
  if (!rosen) return null;

  const rawDefaultDistance = Number(rosen.props['DiagramDgrYZahyouKyoriDefault']);
  const defaultStationDistance = Number.isFinite(rawDefaultDistance) && rawDefaultDistance > 0 ? rawDefaultDistance : 60;

  const trainTypes = parseTrainTypes(rosen);

  const stations = [];
  const nextEkiDistances = []; // per station index: explicit NextEkiDistance, or null
  for (const eki of allChildren(rosen, 'Eki')) {
    const index = stations.length;
    stations.push({
      index,
      name: eki.props['Ekimei'] || '',
      shortName: eki.props['EkimeiJikokuRyaku'] || '',
      displayFormat: eki.props['Ekijikokukeisiki'] || null,
      distanceKm: 0, // filled in by assignStationDistances after every Dia (and its run times) is parsed
      scale: parseEkikibo(eki.props['Ekikibo']),
    });
    const nextDistance = Number(eki.props['NextEkiDistance']);
    nextEkiDistances.push(Number.isFinite(nextDistance) && nextDistance > 0 ? nextDistance : null);
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
    // Chain detection needs every train's own first/last stop already
    // resolved to its final (post up/down-flip) physical stationIndex, so it
    // runs once per Dia after the Kudari/Nobori loop above has fully
    // populated `trains` — see inferOperationChains for the matching rule.
    inferOperationChains(trains);
    propagateOperationNumbers(trains);
    return { name: dia.props['DiaName'] || `ダイヤ${diaIndex + 1}`, trains };
  });

  // Station spacing needs every Dia's decoded run times (sources 2 and 3 of
  // its priority order), so it runs last. KijunDiaIndex: Number(undefined)
  // is NaN for files without the property → null → skip source 2.
  const kijunDiaIndexRaw = Number(rosen.props['KijunDiaIndex']);
  assignStationDistances(
    stations,
    dias,
    Number.isInteger(kijunDiaIndexRaw) ? kijunDiaIndexRaw : null,
    nextEkiDistances,
    defaultStationDistance
  );

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
// has no Ressyasyubetsu match, e.g. hand-authored plan data), `operation`
// (per train — `{origin, terminal}`, each either null or `{linked, time,
// operationNumber}`, see parseOperationEndpoint — `operationNumber` labels
// only at this point, see inferOperationChains for why `linked` isn't used
// for connection detection), and `chainNextTrainId`/`chainPrevTrainId`
// (either a sibling train's `id` in this same result, or null — see
// inferOperationChains) are carried through as extra (data-model-additive)
// fields; renderer/diagramView.mjs reads `trainType` to color/style each
// line, `operation` for operation-number labels, and
// `chainNextTrainId`/`chainPrevTrainId` to decide between drawing a
// depot-boundary marker (no chain partner on that end) or a connecting line
// to the partner train (see there). `track` has no other consumer yet
// (kept for a future track-aware conflict check, issue #4).
function toTlineDiagram(parsed, diaIndex) {
  const dia = parsed.dias[diaIndex];
  if (!dia) return null;

  const stationId = (index) => `oud-st${index}`;
  const stations = parsed.stations.map((s) => ({
    id: stationId(s.index),
    name: s.name,
    distanceKm: s.distanceKm,
    scale: s.scale, // 'major' | 'general' | null — see parseEkikibo; renderer/app.mjs's stopTableHtml uses this
  }));

  let skippedTrains = 0;
  let unconfidentTrains = 0;
  const trains = [];
  // dia.trains index -> assigned TLINE id, only for trains actually kept
  // (skipped/empty ones have no id to chain to) — inferOperationChains
  // recorded chain partners by *that* index, so a second pass below
  // resolves them once every kept train has an id (a partner can appear
  // later in dia.trains than the train pointing at it).
  const idByIndex = new Map();
  dia.trains.forEach((train, i) => {
    if (!train.stops || train.stops.length === 0) {
      skippedTrains += 1;
      return;
    }
    if (!train.timesConfident) unconfidentTrains += 1;
    const id = `oud-${diaIndex}-${train.direction}-${i}`;
    idByIndex.set(i, id);
    trains.push({
      id,
      number: train.number,
      direction: train.direction,
      timesConfident: train.timesConfident,
      trainType: train.trainType,
      operation: train.operation,
      // The chain-propagated 運用番号 (or null) — see propagateOperationNumbers.
      operationNumber: train.operationNumber || null,
      chainNextIndex: train.chainNextIndex, // resolved to *TrainId below, then deleted
      chainPrevIndex: train.chainPrevIndex,
      stops: train.stops.map((s) => ({
        stationId: stationId(s.stationIndex),
        arrival: s.arrival,
        departure: s.departure,
        track: s.track,
      })),
    });
  });
  for (const train of trains) {
    train.chainNextTrainId = train.chainNextIndex != null ? idByIndex.get(train.chainNextIndex) || null : null;
    train.chainPrevTrainId = train.chainPrevIndex != null ? idByIndex.get(train.chainPrevIndex) || null : null;
    delete train.chainNextIndex;
    delete train.chainPrevIndex;
  }

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
