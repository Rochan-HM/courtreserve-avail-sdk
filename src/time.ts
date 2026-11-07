import { DateTime, IANAZone } from "luxon";

export type Disambiguation = "reject" | "earlier" | "later";

export type LocalResolution =
  | { ok: true; utcMillis: number; offsetMinutes: number }
  | {
      ok: false;
      reason: "invalid-zone" | "invalid-local-time" | "nonexistent-local-time" | "ambiguous-local-time";
    };

const OFFSET_SUFFIX = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

export function isValidTimeZone(timeZone: string): boolean {
  return IANAZone.isValidZone(timeZone);
}

/**
 * Resolve a facility-local wall time to one UTC instant.
 * Elapsed durations must be added to the UTC instant, not to the wall clock.
 * Ambiguous times (fall back) are rejected unless the caller names earlier or later.
 * Nonexistent times (spring forward) are always rejected.
 */
export function resolveLocalDateTime(input: {
  date: string;
  time: string;
  timeZone: string;
  disambiguation?: Disambiguation;
}): LocalResolution {
  const disambiguation = input.disambiguation ?? "reject";
  if (!isValidTimeZone(input.timeZone)) return { ok: false, reason: "invalid-zone" };
  const date = input.date.trim();
  const time = normalizeClock(input.time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !time) return { ok: false, reason: "invalid-local-time" };

  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute, second] = time.split(":").map(Number) as [number, number, number];
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: "invalid-local-time" };

  const localAsUtc = DateTime.fromObject(
    { year, month, day, hour, minute, second },
    { zone: "utc" },
  );
  if (!localAsUtc.isValid) return { ok: false, reason: "invalid-local-time" };

  const zone = IANAZone.create(input.timeZone);
  const hits: { utcMillis: number; offsetMinutes: number }[] = [];
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const utc = localAsUtc.minus({ minutes: offsetMinutes });
    if (zone.offset(utc.toMillis()) !== offsetMinutes) continue;
    const back = DateTime.fromMillis(utc.toMillis(), { zone: input.timeZone }).toFormat("yyyy-MM-dd HH:mm:ss");
    if (back !== `${date} ${time}`) continue;
    hits.push({ utcMillis: utc.toMillis(), offsetMinutes });
  }

  const unique = new Map<number, { utcMillis: number; offsetMinutes: number }>();
  for (const hit of hits) unique.set(hit.utcMillis, hit);
  const ordered = [...unique.values()].sort((a, b) => a.utcMillis - b.utcMillis);
  if (ordered.length === 0) return { ok: false, reason: "nonexistent-local-time" };
  if (ordered.length === 1) return { ok: true, ...ordered[0]! };
  if (disambiguation === "reject") return { ok: false, reason: "ambiguous-local-time" };
  const chosen = disambiguation === "earlier" ? ordered[0]! : ordered[ordered.length - 1]!;
  return { ok: true, ...chosen };
}

export function parseFacilityTime(
  value: string,
  fallbackDate: string,
  timeZone: string,
  disambiguation: Disambiguation = "reject",
): LocalResolution {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: "invalid-local-time" };
  if (OFFSET_SUFFIX.test(trimmed)) {
    const absolute = DateTime.fromISO(trimmed, { setZone: true });
    if (!absolute.isValid) return { ok: false, reason: "invalid-local-time" };
    return { ok: true, utcMillis: absolute.toUTC().toMillis(), offsetMinutes: absolute.offset };
  }

  let date = fallbackDate;
  let clock = trimmed;
  const datePrefix = /^(\d{4}-\d{2}-\d{2})[T\s](.+)$/.exec(trimmed);
  if (datePrefix) {
    date = datePrefix[1]!;
    clock = datePrefix[2]!;
  }
  return resolveLocalDateTime({ date, time: clock, timeZone, disambiguation });
}

export function formatInstant(utcMillis: number, timeZone: string): { utc: string; local: string } {
  const utc = DateTime.fromMillis(utcMillis, { zone: "utc" });
  const local = DateTime.fromMillis(utcMillis, { zone: timeZone });
  const utcIso = utc.toISO({ suppressMilliseconds: false });
  const localIso = local.toISO({ suppressMilliseconds: true });
  if (!utcIso || !localIso) {
    throw new Error("Could not format instant.");
  }
  return { utc: utcIso, local: localIso };
}

export function addMinutes(utcMillis: number, minutes: number): number {
  return utcMillis + minutes * 60_000;
}

export function dayBounds(
  date: string,
  timeZone: string,
): { startUtc: number; endUtc: number } | null {
  const start = resolveLocalDateTime({ date, time: "00:00:00", timeZone, disambiguation: "earlier" });
  if (!start.ok) return null;
  const next = DateTime.fromISO(date, { zone: timeZone }).plus({ days: 1 }).toISODate();
  if (!next) return null;
  const end = resolveLocalDateTime({ date: next, time: "00:00:00", timeZone, disambiguation: "earlier" });
  if (!end.ok || end.utcMillis <= start.utcMillis) return null;
  return { startUtc: start.utcMillis, endUtc: end.utcMillis };
}

export function inclusiveCalendarDays(fromDate: string, toDate: string): number | null {
  const from = DateTime.fromISO(fromDate, { zone: "utc" });
  const to = DateTime.fromISO(toDate, { zone: "utc" });
  if (!from.isValid || !to.isValid || fromDate.length < 10 || toDate.length < 10) return null;
  const days = Math.round(to.diff(from, "days").days) + 1;
  if (!Number.isFinite(days)) return null;
  return days;
}

function normalizeClock(time: string): string | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!match) return null;
  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`;
}
