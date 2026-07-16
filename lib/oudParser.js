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

// Formats a seconds-since-day-start count as "HH:MM:SS" — hours may exceed
// 24 for late-night trains (TLINE's own >24:00 convention, see NOTES.md
// 「データモデル」), so a next-day time renders as e.g. "24:05:00" instead
// of time-traveling backwards in the diagram.
function secondsToHms(totalSeconds) {
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
// `kitenSeconds` — the Rosen's KitenJikoku (起点時刻, e.g. "400"=4:00) in
// seconds, default 0. OuDia's diagram day STARTS at this time: any stored
// time earlier than it belongs to the NEXT calendar day (2026-07-15,
// found via Diagram/Noout/館浜野球臨司令v0421.oud2 — a 21:00-24:00+ Dia
// whose past-midnight trains are stored as plain 00:xx; without the shift
// a single 00:24-starting train stretched the time axis to a mostly-empty
// 0-26h and its cross-midnight operation chains went undetected, since a
// 23:59 arrival → "00:05" departure reads as a negative gap). Files with
// KitenJikoku=000 (test.oud2's deliberately-early 00:10 trains, 碧洛電車,
// by-Vague) get no shift — unchanged behavior. The pre-existing rewind
// check below stays as a second layer: it catches a wrap WITHIN one
// train's sequence that the kiten shift alone can't (e.g. a train running
// 3:50→4:10 with kiten 4:00 decodes as 27:50→28:10 via shift+rewind).
function decodeEkiJikoku(raw, stations, kitenSeconds = 0) {
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
      let seconds = timeToSeconds(parsed[key]);
      if (seconds < kitenSeconds) seconds += 86400; // 起点時刻より前＝翌日の時刻
      seconds += days * 86400;
      if (seconds < prevSeconds - 3600) {
        // Dropped by more than an hour — a midnight wrap, not just two
        // events at the same station recorded slightly out of order.
        days += 1;
        seconds += 86400;
      }
      if (seconds < prevSeconds) confident = false; // still non-monotonic — flag rather than hide
      parsed[key] = secondsToHms(seconds);
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
//   multi-entry value alongside a plain code-5 entry (e.g.
//   "5/$74,0/0$2050/205110$0"), plus rarer standalone occurrences paired
//   with a companion `Operation<pos>.<n><A|B>` sub-property (e.g.
//   `Operation30A`="1/1$73520" + `Operation30A.0B`="5/$"). Originally
//   guessed as 路線外始発/終着 and/or coupling (see issue #12); investigated
//   further 2026-07-16 (issue #11/#12) and now believed to be **入出庫**
//   (depot/yard entry-exit) records — a hidden movement to/from a car depot
//   immediately before/after the train's own visible run, confirmed by the
//   project owner ("入出庫みたいなプロパティがoudではある") and by
//   cross-checking against 高根鉄道TM.oud2 (a different author's file, no
//   OuterTerminal data at all): these codes cluster at each file's own
//   major terminus/depot station (館浜系: 大道寺・新野崎・江ノ原信号場・東井;
//   高根鉄道TM: 高根) regardless of OuterTerminal usage, which rules out a
//   路線外始発/終着 link. The common `0/<digit>$<time1>/<time2>$<trailing>`
//   shape (code "0", the dominant ~90% case) is decoded by
//   parseDepotWork below into `{track, arrival, departure}` — `digit`
//   varies at multi-track depots (高根: 0/1/3/4) and stays constant at
//   apparently single-track ones (館浜の各駅), consistent with it being a
//   depot-side track/route id, though that specific reading is still a
//   hypothesis. The rarer standalone code 1/2/6 shapes (paired with a
//   `.<n><A|B>` sub-entry) look structurally different again and remain
//   unmodeled.
// `side` — 'origin' (a ...B property) or 'terminal' (...A). The 運用番号 is
// only ever extracted on the origin/B side: the `$`-suffix grammar differs
// per side (2026-07-15, surveyed against Diagram/Noout/館浜*.oud2 — three
// files from a different author than the 高根鉄道 set, so the two
// conventions cross-check each other):
//   B side: `$<運用番号の断片>[/<断片>...]` — the operation's number, split
//     across slash-separated parts ("表示行"?). 高根鉄道TM writes it as
//     `$/10A` (empty first part, number on the second) and only on code-3
//     records; the 館浜 files write it directly as `$90`/`$06` on plain
//     code-5 出区 records (hundreds of them — this is what makes their
//     depot circles labeled), with `$0/` / `$` for "no number". "0" reads
//     as "none", never as a real number (see the A-side evidence next).
//   A side: `$<数値>` is a small CONSTANT per file (TM: always `0`; 館浜:
//     `0`=2097件, `3`=412件, `1`/`2` a handful) — nothing like the diverse
//     B-side number sets, so it's presumably an 入区先 (yard/depot) code,
//     NOT a number. Extracting it as one would label nearly every ▽ "0".
//     入区 markers get their number via chain propagation instead (see
//     propagateOperationNumbers).
// Decodes the dominant 入出庫 (depot entry/exit) shape out of a raw
// `Operation<pos><A|B>` value: a comma-separated entry matching
// `0/<digit>$<time1>/<time2>$<trailing>` (see the long comment above
// parseOperationEndpoint for how this was identified and cross-checked).
// Returns `{track, arrival, departure}` (`track` — the `digit`, believed to
// be a depot-side track/route id, `null` if empty — and the two decoded
// times) or `null` when no entry matches this exact shape (covers both
// "no code-0 entry at all" and the rarer, structurally different standalone
// code 1/2/6 cases this isn't modeling yet).
function parseDepotWork(raw) {
  if (!raw) return null;
  const entry = raw.split(',').find((e) => /^0\/\d*\$\d{3,6}\/\d{3,6}\$/.test(e));
  if (!entry) return null;
  const m = entry.match(/^0\/(\d*)\$(\d{3,6})\/(\d{3,6})\$/);
  return {
    track: m[1] === '' ? null : Number(m[1]),
    arrival: parseTimeToken(m[2]),
    departure: parseTimeToken(m[3]),
  };
}

function parseOperationEndpoint(raw, side) {
  if (!raw) return null;
  const depotWork = parseDepotWork(raw);
  // 増解結などの複数エントリ値でも、コード3/5のエントリ1つはその列車自身の
  // 出区/入区情報として読める（館浜ファイルでは "5/$74,0/0$2050/..." のように
  // 先頭が通常の出区記録になっている）。コード0/1/2/6のみの値は従来通りnull
  // （ただしdepotWorkがあればそちらだけでも返す — 下記）。
  const entry = raw.split(',').find((e) => {
    const code = e.split('/')[0];
    return code === '3' || code === '5';
  });
  if (!entry) return depotWork ? { linked: false, time: null, operationNumber: null, depotWork } : null;
  const dollar = entry.indexOf('$');
  const before = dollar === -1 ? entry : entry.slice(0, dollar);
  const after = dollar === -1 ? '' : entry.slice(dollar + 1);
  const [code, timeToken] = before.split('/');
  const numberParts = side === 'origin' ? after.split('/').filter((s) => s && s !== '0') : [];
  const operationNumber = numberParts.length > 0 ? numberParts.join('/') : null;
  if (code === '5') return { linked: false, time: null, operationNumber, depotWork };
  return { linked: true, time: parseTimeToken(timeToken) || null, operationNumber, depotWork };
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
// Second-pass (cross-track) window — see PASSES below. Upper bound raised
// 30min→60min (2026-07-15, project owner report: v0414「7-9」の676→777 is a
// real turnback with a 35m50s layover at 日野森, track0=0, and both ends are
// each other's ONLY candidate for a wide stretch — nothing else arrives or
// departs that station within nearly an hour on either side, so there's no
// competing-candidate risk). Re-scanned every Diagram/ sample for mutually-
// unique (arrival,departure) pairs in the 30-90min range with no gap cap at
// all: found 20 more, several on an EXACT matching track (e.g. 回802A→回803A,
// track4=4, 44min — almost certainly the same physical set sitting in a yard
// track between duties) — the previous 30min cap (calibrated from a single
// 24-25min example, see tracksCompatible's doc comment) was too tight for
// this file's own data, not just an edge case. Longest found: 52min: capped
// at 60min for margin. mutual-nearest-neighbor still gates every match (see
// PASSES below) — this only widens the search window, not the matching
// rule, so an endpoint still only links when both sides uniquely agree.
const CROSS_TRACK_MIN_GAP_SECONDS = 3 * 60;
const CROSS_TRACK_MAX_GAP_SECONDS = 60 * 60;

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
// track2 vs 2213A's track3) never match in the FIRST pass.
function tracksCompatible(t1, t2) {
  return t1 === t2 || t1 === 0 || t2 === 0;
}

// Ranks a compatible track pair: 2 = both sides recorded the SAME index
// (including 0===0) — the strongest signal this format exposes short of an
// explicit consist ID. 1 = compatible only because one side is 0 and the
// other isn't — plausible but not confirmed. 0 = incompatible (only
// reachable in pass 2, which doesn't filter on this at all).
//
// 0===0 was excluded from tier 2 until 2026-07-15 (treated as a "番線未
// 指定" wildcard, same weak tier as 0-vs-anything) — but that was wrong:
// lib/oudParser.jsのresolveTrackLabel（同日追加）で確認した通り、track
// 0はEkiTrack2の実在するインデックス0（未設定を表す特殊値ではない）。同じ
// 0という値を記録している2つの停車は、他のどの数値ペアとも同様に「同じ
// 実在する番線」を指している——弱い証拠として扱う理由がない。project
// owner報告のv0414「21-24」2109A→回2208A（どちらも館浜で番線0、935秒差）
// で発覚: 弱いtier1のまま扱っていたため、番線3の2299（520秒差、こちらも
// tier1)に競り負けていた。0===0をtier2に格上げすると、935秒差でも
// tier優先で2109Aが勝ち、相互最近傍も成立する（2299は自分の番線3と一致
// する他の候補を探すことになる）。
// 一方、0とそれ以外（例: 5110A(0)→2111A(3)、db28b36で参考画像により
// 検証済み）は「どちらかが番線0＝柔軟運用」という従来通りの弱い証拠の
// ままtier1に留める——この変更でtier1側の判定は変えていない。
function trackMatchTier(t1, t2) {
  if (t1 === t2) return 2;
  if (t1 === 0 || t2 === 0) return 1;
  return 0;
}

// Matching runs as two passes over the same endpoints (2026-07-15, prompted
// by the 館浜 files — a different author whose data records REAL tracks on
// nearly every stop, where 折り返し routinely moves the set to another
// platform, so first-pass track equality alone left most of their terminal
// turnbacks unconnected):
//   Pass 1 — track-compatible, gap [0, 15min]. High confidence; this is the
//     original rule and is what all the reference-image arbitration above
//     validated. Runs on every endpoint.
//   Pass 2 — endpoints LEFT OVER by pass 1 only: any tracks, gap
//     [3min, 30min]. The 3-minute floor is the physical shunting constraint
//     that makes ignoring tracks tolerable: a set cannot arrive on one
//     track and depart from a different one near-instantly, and the 館浜
//     data is full of such coincidences (e.g. 2165C arrives 館浜 track2 the
//     same minute 2284C departs track1 — different physical sets; naive
//     any-track nearest would wrongly join them). The 30-minute ceiling
//     covers observed real terminal layovers (大路: same-track 24-25min
//     turnbacks that pass 1's 15min cap missed). Restricting pass 2 to
//     pass-1 leftovers means it can never rearrange or steal a pass-1
//     match, only add to them.
// Both passes require mutual nearest (see below); an endpoint that stays
// unmatched falls back to a depot marker as before.
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

  const PASSES = [
    { requireCompatibleTracks: true, minGap: 0, maxGap: MAX_HANDOFF_GAP_SECONDS },
    { requireCompatibleTracks: false, minGap: CROSS_TRACK_MIN_GAP_SECONDS, maxGap: CROSS_TRACK_MAX_GAP_SECONDS },
  ];

  // Nearest same-station departure within the pass's constraints for each
  // arrival, and the mirror search for each departure — kept as two explicit
  // searches (rather than one read backwards) so "mutual nearest" below is
  // checking two independently-computed answers.
  //
  // "Nearest" ranks by track tier FIRST (see trackMatchTier — a confirmed
  // same-platform match beats a 番線未指定 wildcard match regardless of raw
  // gap), then by smallest gap within that tier (2026-07-15, project owner
  // feedback on Diagram/Noout/館浜運転会司令v0414.oud2's Dia「7-9」: 787C
  // arrives 館浜 track3 07:48:25, and the intended continuation is 786's
  // departure at 07:57:00, ALSO track3 (515s gap) — but pure-gap picking
  // instead chose 回721A's arrival, 07:49:30 track0/wildcard, 450s gap, 65s
  // closer purely by chance. A wildcard match isn't evidence of anything
  // beyond "compatible" — letting it outrank an exact, confirmed same-track
  // match let a weaker signal beat a stronger one whenever it happened to
  // land a little closer in time. Tier still only matters for BREAKING
  // ties among otherwise-eligible candidates; it can't rescue a candidate
  // pass.minGap/maxGap already excluded).
  function isBetter(candidateTier, candidateGap, best) {
    if (!best) return true;
    if (candidateTier !== best.tier) return candidateTier > best.tier;
    return candidateGap < best.gap;
  }
  function nearestDeparture(arrival, pool, pass) {
    if (arrival.track == null) return null;
    let best = null;
    for (const d of pool) {
      if (d.index === arrival.index || d.stationIndex !== arrival.stationIndex || d.track == null) continue;
      const tier = trackMatchTier(d.track, arrival.track);
      if (pass.requireCompatibleTracks && tier === 0) continue;
      const gap = d.time - arrival.time;
      if (gap < pass.minGap || gap > pass.maxGap) continue;
      if (isBetter(tier, gap, best)) best = { index: d.index, gap, tier };
    }
    return best;
  }
  function nearestArrival(departure, pool, pass) {
    if (departure.track == null) return null;
    let best = null;
    for (const a of pool) {
      if (a.index === departure.index || a.stationIndex !== departure.stationIndex || a.track == null) continue;
      const tier = trackMatchTier(a.track, departure.track);
      if (pass.requireCompatibleTracks && tier === 0) continue;
      const gap = departure.time - a.time;
      if (gap < pass.minGap || gap > pass.maxGap) continue;
      if (isBetter(tier, gap, best)) best = { index: a.index, gap, tier };
    }
    return best;
  }

  let freeArrivals = arrivals;
  let freeDepartures = departures;
  for (const pass of PASSES) {
    const nextFor = new Map(); // arrival's train index -> best departure match
    for (const a of freeArrivals) {
      const match = nearestDeparture(a, freeDepartures, pass);
      if (match) nextFor.set(a.index, match);
    }
    const prevFor = new Map(); // departure's train index -> best arrival match
    for (const d of freeDepartures) {
      const match = nearestArrival(d, freeArrivals, pass);
      if (match) prevFor.set(d.index, match);
    }
    for (const [fromIndex, next] of nextFor) {
      const back = prevFor.get(next.index);
      if (back && back.index === fromIndex) {
        trains[fromIndex].chainNextIndex = next.index;
        trains[next.index].chainPrevIndex = fromIndex;
      }
    }
    // Only endpoints still unmatched carry over to the next (looser) pass.
    freeArrivals = freeArrivals.filter((a) => trains[a.index].chainNextIndex == null);
    freeDepartures = freeDepartures.filter((d) => trains[d.index].chainPrevIndex == null);
  }
}

// oud2は、1本の物理列車が駅で長時間停車する（留置線での長時間滞泊など）
// 場合、その停車を1つのEkiJikoku内の着発ギャップとしてではなく、**同じ
// 列車番号・同じ方向の別々のRessyaブロック**として分割記録することがある
// （2026-07-15、project owner報告: Diagram/Noout/館浜運転会司令v0414.oud2
// のDia「7-9」で786が「館浜→駒野」「駒野→津崎」「津崎→江ノ原信号場」の
// 3ブロックに分かれている）。分割点のOperationは両側とも코드5（非リンク＝
// 通常の出区/入区）で記録されており、inferOperationChainsが読む前列車/
// 次列車接続の仕組みでは繋がれない——ファイルが「同じ列車」だと伝える手段
// は列車番号＋方向の一致だけ。
//
// ただし番号の一致だけでは不十分: パターンダイヤ（例:
// 高根鉄道TM.oud2の「パターンダイヤ2h(没)」）は同じ番号を周回ごとに
// 使い回すため、無条件に同番号でまとめると全く無関係な別走行を1本の
// 列車に融合してしまう。全サンプルファイルを横断して検証したところ、
// 同番号グループの隣接ペアには「境界駅が一致する」もの(204件、今回の
// ような本当の分割)と「一致しない」もの(308件、パターン周回の使い回し)
// がはっきり分かれていた——**境界駅の一致**を必須条件にすることで、両者を
// 安全に区別できる。
//
// 分割点の駅は、片方の区間では終着（着のみ）、もう片方では起点（発のみ、
// ただしdecodeEkiJikokuの単一時刻仕様により着=発として記録）として二重に
// 現れるので、1つの着発ペアに畳み込む（停車として自然な表示にする——issue
// 由来の「ただの停車として見なす」要望通り）。中間の分割点にあった
// Operation（出区/入区マーカー）はもう境界ではなくなるため捨て、先頭区間の
// origin・末尾区間のterminalだけを引き継ぐ。inferOperationChainsより前に
// 実行するので、ここで結合された列車はチェーン推定の対象にすらならない。
function mergeSameNumberTrains(trains) {
  const groups = new Map();
  trains.forEach((t) => {
    const key = `${t.direction} ${t.number}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });

  function mergeGroup(group) {
    const withStops = group.filter((t) => t.stops.length > 0);
    const withoutStops = group.filter((t) => t.stops.length === 0);
    withStops.sort(
      (a, b) => timeToSeconds(a.stops[0].departure || a.stops[0].arrival) - timeToSeconds(b.stops[0].departure || b.stops[0].arrival)
    );

    const chains = [];
    let current = null;
    for (const t of withStops) {
      if (current) {
        const lastStop = current.stops[current.stops.length - 1];
        const nextFirstStop = t.stops[0];
        if (lastStop.stationIndex === nextFirstStop.stationIndex) {
          current.stops[current.stops.length - 1] = {
            stationIndex: lastStop.stationIndex,
            arrival: lastStop.arrival ?? lastStop.departure,
            departure: nextFirstStop.departure ?? nextFirstStop.arrival,
            track: lastStop.track ?? nextFirstStop.track,
          };
          current.stops.push(...t.stops.slice(1));
          current.timesConfident = current.timesConfident && t.timesConfident;
          current.operation = { origin: current.operation && current.operation.origin, terminal: t.operation && t.operation.terminal };
          continue;
        }
        chains.push(current);
      }
      current = { ...t, stops: [...t.stops] };
    }
    if (current) chains.push(current);
    return [...chains, ...withoutStops];
  }

  const mergedByKey = new Map();
  for (const [key, group] of groups) {
    mergedByKey.set(key, group.length > 1 ? mergeGroup(group) : group);
  }

  // Preserve each key's first-occurrence position in the output rather than
  // grouping-then-flattening, so trains that were never part of a merge keep
  // their original column order in the timetable/legend.
  const emitted = new Set();
  const result = [];
  for (const t of trains) {
    const key = `${t.direction} ${t.number}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    result.push(...mergedByKey.get(key));
  }
  return result;
}

// 出区記録との整合チェック（2026-07-15、ユーザー要望「同じ運行番号で
// リンクして」）: a train whose origin carries a RECORDED 運用番号 is an
// explicit depot-out (出区) point — the strongest per-train operation
// identity the file offers. A chain link flowing INTO such a train is kept
// only when the chain's number (propagated from its own head) EQUALS the
// recorded one; otherwise the link is cut and the train becomes a new chain
// head. Measured across the 館浜 files before this pass existed, the
// proximity heuristic alone merged clearly-different operations at busy
// terminals — e.g. 野球臨's 2091C (運用90) chained into 2106A whose own
// 出区記録 says 運用06, and 19 of its 104 links flowed into a numbered
// 出区 point — while the matching-number cases it also produced
// (2153(52)→2252(52), 3741B(140)→3740(140)) are consistent continuations
// worth keeping. Chains with no number information on either side are left
// alone (nothing to compare). TM's 仕業 Dias get the same benefit with crew
// numbers: a crew-1 chain no longer swallows crew-9's first train.
function enforceRecordedNumberBoundaries(trains) {
  trains.forEach((train, headIndex) => {
    if (train.chainPrevIndex != null) return;
    const visited = new Set();
    let number = null;
    let index = headIndex;
    while (index != null && !visited.has(index)) {
      visited.add(index);
      const t = trains[index];
      const recorded = t.operation && t.operation.origin && t.operation.origin.operationNumber;
      if (recorded && t.chainPrevIndex != null && recorded !== number) {
        // 別（または不明）運用のチェーンが、明示的な出区点に流れ込んで
        // いる — リンクを切ってこの列車を新しい先頭にする。
        trains[t.chainPrevIndex].chainNextIndex = undefined;
        t.chainPrevIndex = undefined;
      }
      if (recorded) number = recorded;
      index = t.chainNextIndex != null ? t.chainNextIndex : null;
    }
  });
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

// `Eki.`'s `EkiTrack2Cont.`/`EkiTrack2.` blocks — the station's own declared
// track list (each with a `TrackName`/`TrackRyakusyou`, e.g. 高根鉄道TM.oud2's
// 高根: 1番線/2番線/.../TST上/TST下; Diagram/Noout/*.oud2's 大道寺: X/Y/E/①/②/
// ③/④ — station-specific, non-numeric, and NOT declaration-order==display-
// number in general, e.g. 新野崎's list starts ⑤,①,②,③,④). EkiJikoku's own
// `$N` track suffix (see parseStationChunk) is a 0-based index directly into
// THIS list — confirmed 2026-07-15 against project-owner-supplied ground
// truth from Diagram/Noout/館浜運転会司令v0414.oud2: 2177's recorded value at
// 大道寺 is 5, and 大道寺's list index 5 is "③" (3番線, matching what the
// owner independently knows this train's real platform to be). Until this,
// renderer/app.mjs's timetable displayed the raw `$N` number itself, which
// is wrong whenever a station's tracks aren't literally numbered 1..N in
// declaration order — true of nearly every 館浜 station (circled numerals,
// 上本/下本, X/Y/E) and any renumbered/reordered case elsewhere.
// Returns an array of labels (TrackRyakusyou preferred, TrackName fallback,
// null for a block with neither) indexed to match `$N` directly; `[]` for a
// station with no EkiTrack2Cont at all (hand-authored plan data, or a real
// file that just doesn't declare tracks for that station).
function parseTrackLabels(eki) {
  const cont = firstChild(eki, 'EkiTrack2Cont');
  if (!cont) return [];
  return allChildren(cont, 'EkiTrack2').map((t) => t.props['TrackRyakusyou'] || t.props['TrackName'] || null);
}

// `Eki.`'s `OuterTerminal.` blocks — candidate off-line destination names
// declared per-station (nested inside `Eki.`, not a Rosen-level list; e.g.
// Diagram/Noout/館浜野球臨司令v0421.oud2's 大路(index0) declares 9, 大道寺
// (index21, a branch point) declares 5). These are the names OuDiaSecond's
// UI offers when a user marks a train as starting/ending *off* the modeled
// line at that station (路線外始発/終着) — see issue #12.
//
// 2026-07-16 investigation (issue #12): searched for how a specific train
// references one of these names. Every `Ressya.` property key across three
// Noout files with OuterTerminal data was enumerated (Bikou/Canceled/
// EkiJikoku/Houkou/Operation<N><A|B>[.<n><A|B>]/Ressyabangou/Ressyamei/
// Syubetsu — no dedicated Outer/Gaisen-named property exists at all), so if
// a link is stored on disk it has to be inside the Operation field's code
// system. That was issue #12's own leading hypothesis (codes 0/1/2/6, only
// ever seen in multi-entry Operation values) — but it doesn't hold up:
//   - Code 0 is common (292 occurrences in 館浜運転会司令v0414.oud2 alone)
//     and spread across FIVE different stations, only one of which (大道寺)
//     has an OuterTerminal list at all — a real link would concentrate at
//     0/21 (this file's only two OuterTerminal-bearing stations).
//   - Codes 1/2/6 pair with a `Operation<pos><side>.<n><A|B>` sub-property
//     (e.g. `Operation30A`="1/1$73520" alongside `Operation30A.0B`="5/$")
//     describing a second, independent depot-boundary work item — i.e. this
//     is 増解結 (formation split/coupling): the code marks a split event,
//     the sub-entry is the split-off portion's own origin/terminal record.
//     Nothing in either value references an OuterTerminal index or name.
// Conclusion: codes 0/1/2/6 model coupling/splitting, not off-line termini.
// The real per-train link (if persisted at all — this file's own
// `DiagramDisplayOuterTerminal`/`DisplayOuterTerminalEkimei*Side` Dia-level
// toggles were all `0` in the sample that prompted issue #12, so the
// feature may simply be unused/off there rather than encoded-but-unread)
// remains unfound. Parsed here as additive per-station data only — nothing
// consumes it yet (see issue #12 for the open endpoint-label goal).
function parseOuterTerminals(eki) {
  return allChildren(eki, 'OuterTerminal').map((o) => ({
    name: o.props['OuterTerminalEkimei'] || '',
    jikokuAbbreviation: o.props['OuterTerminalJikokuRyaku'] || '',
    diaAbbreviation: o.props['OuterTerminalDiaRyaku'] || '',
  }));
}

// Resolves a stop's raw `$N` track value to that station's own declared
// label (see parseTrackLabels) — `null` when there's no stop-level track,
// no declared list for the station, or the index falls outside it (kept as
// `null` rather than the raw number even then, so a caller can't mistake a
// meaningless index for a real label; renderer/app.mjs falls back to the
// raw number itself in that case, matching pre-2026-07-15 behavior for
// stations this doesn't cover, e.g. hand-authored plan data).
function resolveTrackLabel(station, track) {
  if (track == null || !station.trackLabels) return null;
  return station.trackLabels[track] || null;
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
      trackLabels: parseTrackLabels(eki),
      outerTerminals: parseOuterTerminals(eki),
    });
    const nextDistance = Number(eki.props['NextEkiDistance']);
    nextEkiDistances.push(Number.isFinite(nextDistance) && nextDistance > 0 ? nextDistance : null);
  }

  // KitenJikoku (起点時刻) — Rosen-level, e.g. "400"=4:00. Times before it
  // belong to the next day; see decodeEkiJikoku's doc comment.
  const kitenSeconds = (() => {
    const t = parseTimeToken(rosen.props['KitenJikoku']);
    return t ? timeToSeconds(t) : 0;
  })();

  const dias = allChildren(rosen, 'Dia').map((dia, diaIndex) => {
    const trains = [];
    for (const dirBlockName of ['Kudari', 'Nobori']) {
      const dirBlock = firstChild(dia, dirBlockName);
      if (!dirBlock) continue;
      const direction = dirBlockName === 'Kudari' ? 'down' : 'up';
      for (const ressya of allChildren(dirBlock, 'Ressya')) {
        const raw = ressya.props['EkiJikoku'] || '';
        const decoded = decodeEkiJikoku(raw, stations, kitenSeconds);
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
                origin: parseOperationEndpoint(ressya.props[`Operation${populatedPositions[0]}B`], 'origin'),
                terminal: parseOperationEndpoint(ressya.props[`Operation${populatedPositions[populatedPositions.length - 1]}A`], 'terminal'),
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
    // Same-number split segments (see mergeSameNumberTrains) fold into one
    // train BEFORE chain detection runs, so inferOperationChains never sees
    // them as separate endpoints needing a heuristic reconnection.
    const mergedTrains = mergeSameNumberTrains(trains);
    // Chain detection needs every train's own first/last stop already
    // resolved to its final (post up/down-flip) physical stationIndex, so it
    // runs once per Dia after the Kudari/Nobori loop above has fully
    // populated `trains` — see inferOperationChains for the matching rule.
    inferOperationChains(mergedTrains);
    enforceRecordedNumberBoundaries(mergedTrains);
    propagateOperationNumbers(mergedTrains);
    return { name: dia.props['DiaName'] || `ダイヤ${diaIndex + 1}`, trains: mergedTrains };
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
    outerTerminals: s.outerTerminals, // [{name, jikokuAbbreviation, diaAbbreviation}] — see parseOuterTerminals; no consumer yet (issue #12)
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
        // Resolved via that station's own declared track list — see
        // resolveTrackLabel/parseTrackLabels — for display; `track` itself
        // stays the raw index (used by inferOperationChains upstream, and
        // kept here too in case a future consumer needs the raw value).
        trackLabel: resolveTrackLabel(parsed.stations[s.stationIndex], s.track),
      })),
    });
  });
  for (const train of trains) {
    train.chainNextTrainId = train.chainNextIndex != null ? idByIndex.get(train.chainNextIndex) || null : null;
    train.chainPrevTrainId = train.chainPrevIndex != null ? idByIndex.get(train.chainPrevIndex) || null : null;
    delete train.chainNextIndex;
    delete train.chainPrevIndex;
  }

  // issue #11「番号なし運用同士の誤接続は検証手段がない」— a chain link is
  // "verified" when propagateOperationNumbers found a recorded 運用番号
  // ANYWHERE on that chain (enforceRecordedNumberBoundaries would have cut
  // the link already if the number disagreed at a recorded 出区 point — see
  // there); a link on a chain with no recorded number anywhere is pure
  // proximity/track/gap heuristic with nothing to cross-check it against.
  // Counted here (once per link, from the earlier train's side) so the
  // import summary can tell the user how much of what they're about to see
  // is unverifiable rather than silently presenting every arc with equal
  // confidence (renderer/diagramView.mjs uses the same `operationNumber`
  // check to style these links differently).
  let unverifiedChainLinks = 0;
  let totalChainLinks = 0;
  for (const train of trains) {
    if (!train.chainNextTrainId) continue;
    totalChainLinks += 1;
    if (!train.operationNumber) unverifiedChainLinks += 1;
  }

  return {
    diagram: { line: { name: parsed.lineName, stations }, trains },
    stats: {
      diaName: dia.name,
      totalTrains: dia.trains.length,
      importedTrains: trains.length,
      skippedTrains,
      unconfidentTrains,
      totalChainLinks,
      unverifiedChainLinks,
    },
  };
}

module.exports = { parseTree, parseDiagram, decodeEkiJikoku, parseTimeToken, toTlineDiagram };
