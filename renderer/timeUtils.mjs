// HH:MM:SS <-> seconds-since-midnight. No DOM access — reusable anywhere.
// Times past 24:00:00 (late-night trains numbered into the next day, as
// OuDia allows) are supported: parse accepts hours >= 24, format wraps them
// back into HH:MM:SS without normalizing to a new day.

export function parseTime(hhmmss) {
  if (!hhmmss) return null;
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(hhmmss.trim());
  if (!m) return null;
  const [, h, mi, s] = m;
  return Number(h) * 3600 + Number(mi) * 60 + Number(s);
}

export function formatTime(totalSeconds) {
  if (totalSeconds == null) return '';
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.abs(Math.round(totalSeconds));
  const h = Math.floor(abs / 3600);
  const mi = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function shiftTime(hhmmss, deltaSeconds) {
  const t = parseTime(hhmmss);
  if (t == null) return null;
  return formatTime(t + deltaSeconds);
}
