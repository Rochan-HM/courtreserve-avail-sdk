import { DateTime } from "luxon";
import { QueryValidationError } from "../errors.js";
import { resolveLocalDateTime } from "../time.js";

export interface DayHours {
  dayName: string;
  openLocal: string;
  closeLocal: string;
  closed: boolean;
}

/** CourtReserve HoursOfOperation times are .NET ticks from midnight. */
export function ticksToClock(ticks: number): string {
  if (!Number.isFinite(ticks) || ticks < 0) {
    throw new QueryValidationError("Operating hours contained a time this SDK could not read.");
  }
  const seconds = Math.floor(ticks / 10_000_000);
  if (seconds >= 86_340) return "24:00";
  const hour = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function hoursForDate(hours: readonly DayHours[], date: string, timeZone: string): DayHours {
  const local = DateTime.fromISO(date, { zone: timeZone });
  if (!local.isValid) throw new QueryValidationError(`Date ${date} is not a calendar day in ${timeZone}.`);
  const dayName = local.toFormat("cccc");
  const match = hours.find((day) => day.dayName.toLowerCase() === dayName.toLowerCase());
  if (!match) throw new QueryValidationError(`No operating hours are listed for ${dayName}.`);
  return match;
}

export interface BusyInterval {
  startUtc: string;
  endUtc: string;
}

export interface OpenRange {
  startUtc: string;
  endUtc: string;
  startLocal: string;
  endLocal: string;
  durationMinutes: number;
}

/**
 * Free ranges inside operating hours. Busy intervals are half-open.
 * A reservation that ends when a slot starts does not block that slot.
 * Slot length is elapsed time in the facility zone, so a spring-forward hour is not a second 60 minutes on the clock.
 */
export function openRanges(input: {
  date: string;
  timeZone: string;
  openLocal: string;
  closeLocal: string;
  slotMinutes: number;
  busy: readonly BusyInterval[];
}): OpenRange[] {
  if (!Number.isInteger(input.slotMinutes) || input.slotMinutes <= 0) {
    throw new QueryValidationError("Scheduler slot length must be a positive whole number of minutes.");
  }
  const start = resolveLocalDateTime({
    date: input.date,
    time: input.openLocal,
    timeZone: input.timeZone,
  });
  if (!start.ok) throw new QueryValidationError(`Opening time ${input.openLocal} is not a real local time on ${input.date}.`);

  const close = input.closeLocal === "24:00"
    ? resolveLocalDateTime({
        date: nextDate(input.date, input.timeZone),
        time: "00:00",
        timeZone: input.timeZone,
      })
    : resolveLocalDateTime({
        date: input.date,
        time: input.closeLocal,
        timeZone: input.timeZone,
      });
  if (!close.ok) throw new QueryValidationError(`Closing time ${input.closeLocal} is not a real local time on ${input.date}.`);

  const busy = input.busy.map((interval) => ({
    start: Date.parse(interval.startUtc),
    end: Date.parse(interval.endUtc),
  }));
  let cursor = DateTime.fromMillis(start.utcMillis, { zone: "utc" });
  const end = DateTime.fromMillis(close.utcMillis, { zone: "utc" });
  const free: Array<{ start: DateTime; end: DateTime }> = [];
  while (cursor < end) {
    const next = cursor.plus({ minutes: input.slotMinutes });
    if (next > end) break;
    const startMs = cursor.toMillis();
    const endMs = next.toMillis();
    const blocked = busy.some((interval) => startMs < interval.end && interval.start < endMs);
    if (!blocked) free.push({ start: cursor, end: next });
    cursor = next;
  }

  const ranges: OpenRange[] = [];
  for (const slot of free) {
    const previous = ranges.at(-1);
    if (previous && Date.parse(previous.endUtc) === slot.start.toMillis()) {
      previous.endUtc = slot.end.toUTC().toISO() ?? previous.endUtc;
      previous.endLocal = formatLocal(slot.end, input.timeZone, input.date);
      previous.durationMinutes += input.slotMinutes;
      continue;
    }
    ranges.push({
      startUtc: slot.start.toUTC().toISO() ?? "",
      endUtc: slot.end.toUTC().toISO() ?? "",
      startLocal: formatLocal(slot.start, input.timeZone, input.date),
      endLocal: formatLocal(slot.end, input.timeZone, input.date),
      durationMinutes: input.slotMinutes,
    });
  }
  return ranges;
}

function formatLocal(instant: DateTime, timeZone: string, date: string): string {
  const local = instant.setZone(timeZone);
  if (local.toISODate() !== date && local.toFormat("HH:mm") === "00:00") return "24:00";
  return local.toFormat("HH:mm");
}

function nextDate(date: string, timeZone: string): string {
  const next = DateTime.fromISO(date, { zone: timeZone }).plus({ days: 1 });
  if (!next.isValid) throw new QueryValidationError(`Date ${date} is not a calendar day in ${timeZone}.`);
  return next.toISODate() ?? date;
}
