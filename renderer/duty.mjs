// Pure 仕業 (crew duty) logic — no DOM access, same spirit as dispatch.mjs.
// issue #2: 仕業 does not exist in any .oud/.oud2 file's own data model (the
// project owner confirmed the OuDiaSecond "運用" concept some sample Dia
// names call 仕業 is really just the existing rolling-stock chain feature
// — lib/oudParser.js's inferOperationChains, issue #10/#11 — reused/relabeled
// by hand, not a distinct structure). So unlike everything else in this
// codebase, there is no real data to import or reverse-engineer against —
// 仕業 is a TLINE-original concept, defined entirely within a `.tline` file
// (same treatment as `dispatch`/`actualByDate`, never from .oud/.oud2).
//
// A duty is an ordered list of segments — each segment is "this crew rides
// one already-scheduled train from stationA to stationB" — because unlike a
// 運用 (which must stay with one continuous physical train), a crew member
// can change to a *different* train partway through their shift (a crew
// handover). `{ id, name, segments: [{ trainId, fromStationId, toStationId }] }`.

import { parseTime } from './timeUtils.mjs';

// Resolves one segment's boarding/alighting time (seconds) by finding the
// referenced train's own stops at fromStationId (board, so its departure —
// falling back to arrival for a segment that starts at that train's own
// terminus, which has no departure) and toStationId (alight, so its
// arrival, falling back to departure at that train's own origin). Returns
// null if the train or either stop can't be found, or has no parseable time
// — callers treat that as "can't check this segment," not "no conflict."
export function segmentTimeRange(segment, trains) {
  const train = trains.find((t) => t.id === segment.trainId);
  if (!train) return null;
  const fromStop = train.stops.find((s) => s.stationId === segment.fromStationId);
  const toStop = train.stops.find((s) => s.stationId === segment.toStationId);
  if (!fromStop || !toStop) return null;
  const start = parseTime(fromStop.departure ?? fromStop.arrival);
  const end = parseTime(toStop.arrival ?? toStop.departure);
  if (start == null || end == null) return null;
  return { start, end };
}

// A crew member can't ride two trains at once — returns the [i, j] index
// pairs (into `segments`) of any two segments whose time ranges overlap.
// Segments this function can't resolve a time range for (see
// segmentTimeRange) are silently skipped rather than flagged, matching
// findTrackConflicts's "no data means nothing to compare" stance.
export function findDutyOverlaps(segments, trains) {
  const ranges = segments.map((s) => segmentTimeRange(s, trains));
  const overlaps = [];
  for (let i = 0; i < segments.length; i++) {
    if (!ranges[i]) continue;
    for (let j = i + 1; j < segments.length; j++) {
      if (!ranges[j]) continue;
      if (Math.max(ranges[i].start, ranges[j].start) < Math.min(ranges[i].end, ranges[j].end)) overlaps.push([i, j]);
    }
  }
  return overlaps;
}
