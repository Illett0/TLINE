// Pure 運転整理 (dispatch adjustment) logic — no DOM access, same spirit as
// PathBrowser's aggregate.mjs. v1 rule (see NOTES.md "運転整理のロジック"):
// shifting a train by N seconds at a given station delays (or advances)
// every stop from that station onward by the same amount; stops before it
// are untouched.

import { parseTime, shiftTime } from './timeUtils.mjs';

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

// issue #4「運転整理の競合検知」— OuDiaSecondの「交差支障チェックルール」
// （駅ごとに前後動作のペアと最低時隔をルールとして定義し違反を検知する
// 仕組み、詳細はNOTES.md参照）を参考にした最小構成: ルール設定UIは持たず、
// 同じ駅・同じ番線を2列車が同時に占有していたら（時隔0秒未満＝重なり）
// 競合の"候補"として検知する。
//
// 各停車の占有区間は [到着, 出発]（着発どちらか一方しかない始発/終着駅の
// 停車は、その一方の時刻を点として扱う）。`track`が無い停車（TLINE手動
// 作成データ等、番線情報がそもそも無い）は比較対象にしない——「不明」を
// 「同じ番線」とみなすと存在しない競合を作り出してしまうため。
//
// `trains` — 検査対象の列車配列（運転整理タブでは、調整後の列車で1本だけ
// 差し替えたものを渡す想定 — renderer/app.mjsのrenderDispatchTab参照）。
// 返り値: [{ stationId, track, trackLabel, trainAId, trainBId, overlapStart, overlapEnd }]
// （overlapStart/Endは秒、timeUtils.mjsのformatTimeで表示用に変換する想定）。
//
// 実データ（高根鉄道.oud2ほか）で全ファイル横断検証したところ、**未調整の
// 計画そのものに同一番線の重なりが17件existed**（例: 高岡駅で列車Bが
// 21:11:30～21:23:00番線4に滞泊し、その途中の21:15:30～21:17:00に列車Aが
// 同じ番線を使う）。増解結（同じ番線での連結・切り離し、issue #11で判明
// 済みの実在する運用）の可能性が高く、単純な重なり検知だけでは正規の
// ダイヤも誤って警告してしまう。そのため、この関数自体は「重なりの候補を
// 網羅的に返す」プリミティブに留め、実際にUIへ出す判定は
// findNewTrackConflicts（下記）が「調整前には無かった組み合わせ」だけに
// 絞り込む。
export function findTrackConflicts(trains) {
  const occupanciesByStation = new Map();
  for (const train of trains) {
    for (const stop of train.stops) {
      if (stop.track == null) continue;
      const arr = parseTime(stop.arrival);
      const dep = parseTime(stop.departure);
      const start = arr ?? dep;
      const end = dep ?? arr;
      if (start == null || end == null) continue;
      const [lo, hi] = start <= end ? [start, end] : [end, start];
      if (!occupanciesByStation.has(stop.stationId)) occupanciesByStation.set(stop.stationId, []);
      occupanciesByStation.get(stop.stationId).push({ trainId: train.id, track: stop.track, trackLabel: stop.trackLabel, start: lo, end: hi });
    }
  }

  const conflicts = [];
  for (const [stationId, occupancies] of occupanciesByStation) {
    for (let i = 0; i < occupancies.length; i++) {
      for (let j = i + 1; j < occupancies.length; j++) {
        const a = occupancies[i];
        const b = occupancies[j];
        if (a.trainId === b.trainId || a.track !== b.track) continue;
        const overlapStart = Math.max(a.start, b.start);
        const overlapEnd = Math.min(a.end, b.end);
        // Strict `<` — two trains handing off a track at the exact same
        // instant (one's departure equals the other's arrival) is a clean
        // back-to-back use, not a conflict. The one exception: both stops
        // are themselves zero-duration instants (a.start===a.end,
        // b.start===b.end — the single-time-fallback pattern at an origin
        // stop, arrival===departure) at the exact same second. That's not a
        // handoff between two ranges, it's two distinct trains claiming to
        // occupy the same platform at the same instant, which is always a
        // real conflict.
        const isDegenerateCoincidence = a.start === a.end && b.start === b.end && a.start === b.start;
        if (overlapStart < overlapEnd || isDegenerateCoincidence) {
          conflicts.push({
            stationId,
            track: a.track,
            trackLabel: a.trackLabel || b.trackLabel || null,
            trainAId: a.trainId,
            trainBId: b.trainId,
            overlapStart,
            overlapEnd,
          });
        }
      }
    }
  }
  return conflicts;
}

function conflictKey(c) {
  const [a, b] = [c.trainAId, c.trainBId].sort();
  return `${c.stationId} ${c.track} ${a} ${b}`;
}

// The conflict check a user actually wants from 運転整理: "did shifting this
// train just make it collide with something it didn't collide with before?"
// — not "does this diagram contain any same-track overlap," which (per
// findTrackConflicts's doc comment) also matches legitimate pre-existing
// 増解結 pairs baked into the source data that this tool has no way to tell
// apart from a real mistake. Diffing against the un-adjusted baseline sides
// steps that: any pair already overlapping before the adjustment is assumed
// intentional (or at least not this adjustment's fault) and is excluded;
// only pairs that overlap in the adjusted diagram but did NOT in the
// baseline are reported.
export function findNewTrackConflicts(baseTrains, adjustedTrain) {
  const baseKeys = new Set(findTrackConflicts(baseTrains).map(conflictKey));
  const adjustedTrains = baseTrains.map((t) => (t.id === adjustedTrain.id ? adjustedTrain : t));
  return findTrackConflicts(adjustedTrains).filter((c) => !baseKeys.has(conflictKey(c)));
}
