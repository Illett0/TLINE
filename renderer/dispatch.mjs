// Pure 運転整理 (dispatch adjustment) logic — no DOM access, same spirit as
// PathBrowser's aggregate.mjs. v1 rule (see NOTES.md "運転整理のロジック"):
// shifting a train by N seconds at a given station delays (or advances)
// every stop from that station onward by the same amount; stops before it
// are untouched. No conflict/meet-pass checking against other trains yet —
// that's a documented future step, not silently pretended to be handled.

import { shiftTime } from './timeUtils.mjs';

// `train` — { id, number, direction, stops: [{stationId, arrival, departure}] }.
// `fromStationId` — apply the shift starting at this stop (inclusive).
// `deltaSeconds` — positive = delay, negative = advance (run early).
// Returns a new train object; does not mutate the input.
export function applyDelay(train, fromStationId, deltaSeconds) {
  const fromIndex = train.stops.findIndex((s) => s.stationId === fromStationId);
  if (fromIndex === -1) return train;

  const stops = train.stops.map((stop, i) => {
    if (i < fromIndex) return stop;
    return {
      ...stop,
      arrival: shiftTime(stop.arrival, deltaSeconds),
      departure: shiftTime(stop.departure, deltaSeconds),
    };
  });

  return { ...train, stops };
}
