import { MapError } from "./errors.js";
import { addMinutes, dayBounds, parseFacilityTime } from "./time.js";
import type { CourtSchedule, IntervalStatus, TimeInterval } from "./types.js";

interface Segment {
  start: number;
  end: number;
  status: IntervalStatus;
}

export interface CourtDayInput {
  courtId: string;
  courtLabel: string;
  courtTypeId?: string;
  courtTypeName?: string;
  date: string;
  timeZone: string;
  openLocal: string | null;
  closeLocal: string | null;
  /** Null means the payload did not say which slots are booked. That is not an empty book. */
  reservations: Array<{ start: string; end: string }> | null;
}

export function intervalsForCourtDay(input: CourtDayInput): CourtSchedule {
  const bounds = dayBounds(input.date, input.timeZone);
  const base = {
    courtId: input.courtId,
    courtLabel: input.courtLabel,
    ...(input.courtTypeId !== undefined ? { courtTypeId: input.courtTypeId } : {}),
    ...(input.courtTypeName !== undefined ? { courtTypeName: input.courtTypeName } : {}),
  };
  if (!bounds) {
    return { ...base, coverage: "partial", intervals: [] };
  }
  const unknownDay = (): CourtSchedule => ({
    ...base,
    coverage: "partial",
    intervals: [toInterval(bounds.startUtc, bounds.endUtc, "unknown")],
  });

  if (!input.openLocal || !input.closeLocal || input.reservations === null) return unknownDay();

  const open = parseFacilityTime(input.openLocal, input.date, input.timeZone, "reject");
  const close = parseFacilityTime(input.closeLocal, input.date, input.timeZone, "reject");
  if (!open.ok || !close.ok || close.utcMillis <= open.utcMillis) return unknownDay();

  let segments: Segment[] = [
    { start: bounds.startUtc, end: open.utcMillis, status: "unavailable" },
    { start: open.utcMillis, end: close.utcMillis, status: "open" },
    { start: close.utcMillis, end: bounds.endUtc, status: "unavailable" },
  ];
  segments = segments.filter((segment) => segment.end > segment.start);

  for (const reservation of input.reservations) {
    const start = parseFacilityTime(reservation.start, input.date, input.timeZone, "reject");
    const end = parseFacilityTime(reservation.end, input.date, input.timeZone, "reject");
    if (!start.ok || !end.ok || end.utcMillis <= start.utcMillis) return unknownDay();
    segments = overlay(segments, {
      start: Math.max(bounds.startUtc, start.utcMillis),
      end: Math.min(bounds.endUtc, end.utcMillis),
      status: "reserved",
    });
  }

  return {
    ...base,
    coverage: "complete",
    intervals: mergeAdjacent(segments).map((segment) => toInterval(segment.start, segment.end, segment.status)),
  };
}

export function missingCourt(input: {
  courtId: string;
  courtLabel: string;
  courtTypeId?: string;
  courtTypeName?: string;
}): CourtSchedule {
  return {
    courtId: input.courtId,
    courtLabel: input.courtLabel,
    ...(input.courtTypeId !== undefined ? { courtTypeId: input.courtTypeId } : {}),
    ...(input.courtTypeName !== undefined ? { courtTypeName: input.courtTypeName } : {}),
    coverage: "missing",
    intervals: [],
  };
}

export function combineCourtDays(days: CourtSchedule[]): CourtSchedule {
  if (days.length === 0) {
    throw new MapError("Cannot combine an empty court.");
  }
  const first = days[0]!;
  const intervals = days.flatMap((day) => day.intervals);
  const coverage = days.every((day) => day.coverage === "complete")
    ? "complete"
    : days.every((day) => day.coverage === "missing")
      ? "missing"
      : "partial";
  return {
    courtId: first.courtId,
    courtLabel: first.courtLabel,
    ...(first.courtTypeId !== undefined ? { courtTypeId: first.courtTypeId } : {}),
    ...(first.courtTypeName !== undefined ? { courtTypeName: first.courtTypeName } : {}),
    coverage,
    intervals: mergeIntervalRecords(intervals),
  };
}

export type WindowClass =
  | { ok: true }
  | { ok: false; reason: "reserved-conflict" | "unavailable" | "unknown-coverage" | "missing-from-payload" };

export function classifyWindow(court: CourtSchedule, startUtc: number, endUtc: number): WindowClass {
  if (court.coverage === "missing") return { ok: false, reason: "missing-from-payload" };
  if (endUtc <= startUtc) return { ok: false, reason: "unknown-coverage" };

  const segments = court.intervals
    .map((interval) => ({
      start: Date.parse(interval.startUtc),
      end: Date.parse(interval.endUtc),
      status: interval.status,
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .filter((segment) => segment.start < endUtc && segment.end > startUtc)
    .sort((a, b) => a.start - b.start);

  if (segments.some((segment) => segment.status === "reserved")) return { ok: false, reason: "reserved-conflict" };
  if (segments.some((segment) => segment.status === "unavailable")) return { ok: false, reason: "unavailable" };
  if (segments.some((segment) => segment.status !== "open")) return { ok: false, reason: "unknown-coverage" };

  let cursor = startUtc;
  for (const segment of segments) {
    if (segment.start > cursor) return { ok: false, reason: "unknown-coverage" };
    cursor = Math.max(cursor, segment.end);
    if (cursor >= endUtc) return { ok: true };
  }
  return { ok: false, reason: "unknown-coverage" };
}

export function isoInterval(startUtc: number, endUtc: number, status: IntervalStatus): TimeInterval {
  return toInterval(startUtc, endUtc, status);
}

export function elapsedEnd(startUtc: number, durationMinutes: number): number {
  return addMinutes(startUtc, durationMinutes);
}

function overlay(segments: Segment[], cut: Segment): Segment[] {
  if (cut.end <= cut.start) return segments;
  const next: Segment[] = [];
  for (const segment of segments) {
    if (cut.end <= segment.start || cut.start >= segment.end) {
      next.push(segment);
      continue;
    }
    if (cut.start > segment.start) next.push({ start: segment.start, end: cut.start, status: segment.status });
    const overlapStart = Math.max(segment.start, cut.start);
    const overlapEnd = Math.min(segment.end, cut.end);
    if (overlapEnd > overlapStart) next.push({ start: overlapStart, end: overlapEnd, status: cut.status });
    if (cut.end < segment.end) next.push({ start: cut.end, end: segment.end, status: segment.status });
  }
  return mergeAdjacent(next.filter((segment) => segment.end > segment.start));
}

function mergeAdjacent(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Segment[] = [];
  for (const segment of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...segment });
      continue;
    }
    if (segment.start < previous.end && segment.status !== previous.status) {
      throw new MapError("Interval overlay left overlapping statuses.");
    }
    if (segment.start <= previous.end && segment.status === previous.status) {
      previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

function mergeIntervalRecords(intervals: TimeInterval[]): TimeInterval[] {
  const segments: Segment[] = [];
  for (const interval of intervals) {
    const start = Date.parse(interval.startUtc);
    const end = Date.parse(interval.endUtc);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    segments.push({ start, end, status: interval.status });
  }
  return mergeAdjacent(segments).map((segment) => toInterval(segment.start, segment.end, segment.status));
}

function toInterval(start: number, end: number, status: IntervalStatus): TimeInterval {
  return {
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(end).toISOString(),
    status,
  };
}
