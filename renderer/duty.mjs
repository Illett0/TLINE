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

// 仕業の「調整機能」— a duty's segments don't carry their own time, they
// resolve it by looking up whichever train they reference (segmentTimeRange
// above), so there's no independent schedule to shift the way 運転整理's
// applyDelay shifts a train. What a delay *can* do is make a duty
// infeasible: delay train A enough and its segment now overlaps the next
// segment's train B (the crew can no longer be at both places). Diffs
// against the un-adjusted baseline exactly like dispatch.mjs's
// findNewTrackConflicts (issue #4) — a duty that already had an overlap
// before this delay isn't this delay's fault and isn't reported again, only
// duties the delay newly breaks are.
export function findDutiesBrokenByAdjustment(duties, baseTrains, adjustedTrain) {
  const adjustedTrains = baseTrains.map((t) => (t.id === adjustedTrain.id ? adjustedTrain : t));
  return duties.filter((duty) => {
    if (!duty.segments.some((s) => s.trainId === adjustedTrain.id)) return false; // this duty doesn't touch the delayed train at all
    const wasOk = findDutyOverlaps(duty.segments, baseTrains).length === 0;
    const isOkNow = findDutyOverlaps(duty.segments, adjustedTrains).length === 0;
    return wasOk && !isOkNow;
  });
}

// 仕業調整機能・その2（issue #2、2026-08-07拡張）: 乗り継ぎ余裕時分
// （バッファ）のチェック。findDutyOverlapsは「同時に2列車には乗れない」
// という物理的な不可能しか見ないが、実際の乗務員繰りでは乗り換えに
// 徒歩・改札等の最低時間が要る。duty.minConnectionSeconds（未設定/0なら
// チェックしない）を、同じ駅で乗り継ぐ隣接区間ペア（時刻順に並べたとき
// segments[i].toStationId === segments[i+1].fromStationId のペアだけ——
// 駅が違う乗り継ぎはそもそも徒歩移動の想定がTLINEのデータモデルにない
// ため対象外）に適用する。
export function findDutyBufferViolations(duty, trains) {
  if (!duty.minConnectionSeconds) return [];
  const resolved = duty.segments
    .map((segment, index) => ({ index, segment, range: segmentTimeRange(segment, trains) }))
    .filter((r) => r.range)
    .sort((a, b) => a.range.start - b.range.start);
  const violations = [];
  for (let i = 0; i < resolved.length - 1; i++) {
    const cur = resolved[i];
    const next = resolved[i + 1];
    if (cur.segment.toStationId !== next.segment.fromStationId) continue;
    const gapSeconds = next.range.start - cur.range.end;
    if (gapSeconds < duty.minConnectionSeconds) {
      violations.push({ fromIndex: cur.index, toIndex: next.index, gapSeconds });
    }
  }
  return violations;
}

function bufferViolationKey(v) {
  return `${v.fromIndex}-${v.toIndex}`;
}

// findDutiesBrokenByAdjustmentと同じ「調整前には無かった問題だけ」diff。
// バッファ違反は区間ペア単位でキー化して比較する（違反件数の増減だけでは
// 「Aが直って代わりにBが壊れた」を見逃すため）。
export function findDutiesWithNewBufferViolations(duties, baseTrains, adjustedTrain) {
  const adjustedTrains = baseTrains.map((t) => (t.id === adjustedTrain.id ? adjustedTrain : t));
  return duties.filter((duty) => {
    if (!duty.segments.some((s) => s.trainId === adjustedTrain.id)) return false;
    const baseKeys = new Set(findDutyBufferViolations(duty, baseTrains).map(bufferViolationKey));
    const newOnes = findDutyBufferViolations(duty, adjustedTrains).filter((v) => !baseKeys.has(bufferViolationKey(v)));
    return newOnes.length > 0;
  });
}

// 仕業調整機能・その3（issue #2、2026-08-07拡張）: 乗り継ぎ不能になった
// 区間の振り替え候補探し。segmentと同じ乗車駅・降車駅に停まり、
// [minTime, maxTime]（前後の区間の時刻＋バッファで決まる、隣がなければ
// 無制限）に収まる別の列車を、乗車時刻が早い順に返す。
// 同名駅の逆順再訪（支線区間の駅リスト再登場、issue #6）を誤って拾わない
// よう、降車時刻が乗車時刻より後の停車ペアだけを候補にする。
export function findReplacementCandidates(segment, trains, { excludeTrainId, minTime = -Infinity, maxTime = Infinity } = {}) {
  const candidates = [];
  for (const train of trains) {
    if (train.id === excludeTrainId) continue;
    const fromStop = train.stops.find((s) => s.stationId === segment.fromStationId);
    const toStop = train.stops.find((s) => s.stationId === segment.toStationId);
    if (!fromStop || !toStop) continue;
    const start = parseTime(fromStop.departure ?? fromStop.arrival);
    const end = parseTime(toStop.arrival ?? toStop.departure);
    if (start == null || end == null || end <= start) continue;
    if (start < minTime || end > maxTime) continue;
    candidates.push({ trainId: train.id, start, end });
  }
  return candidates.sort((a, b) => a.start - b.start);
}

// 上記3つを束ね、運転整理タブが「この仕業のどの区間を、どの列車に
// 振り替えられるか」をそのまま表示できる形にする。遅延した列車自身が
// 使われている区間（複数ありうる）ごとに、前後の区間の時刻に収まる代替
// 候補を探す。候補が1件もない区間はsuggestionsに含めない（表示側で
// 「候補なし」を無理に出さない）。
export function findDutySwapSuggestions(duty, baseTrains, adjustedTrain) {
  const adjustedTrains = baseTrains.map((t) => (t.id === adjustedTrain.id ? adjustedTrain : t));
  const sorted = duty.segments
    .map((segment, index) => ({ index, segment, range: segmentTimeRange(segment, adjustedTrains) }))
    .filter((r) => r.range)
    .sort((a, b) => a.range.start - b.range.start);

  const suggestions = [];
  sorted.forEach((entry, pos) => {
    if (entry.segment.trainId !== adjustedTrain.id) return;
    const buffer = duty.minConnectionSeconds || 0;
    const prev = sorted[pos - 1];
    const next = sorted[pos + 1];
    const minTime = prev ? prev.range.end + buffer : -Infinity;
    const maxTime = next ? next.range.start - buffer : Infinity;
    const candidates = findReplacementCandidates(entry.segment, adjustedTrains, {
      excludeTrainId: adjustedTrain.id,
      minTime,
      maxTime,
    });
    if (candidates.length > 0) suggestions.push({ segmentIndex: entry.index, candidates });
  });
  return suggestions;
}
