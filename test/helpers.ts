import { intervalsForCourtDay } from "../src/intervals.js";
import type { CourtSchedule, ReservationTypePolicy, ScheduleSnapshot } from "../src/types.js";

export const observedAt = "2026-06-15T17:00:00.000-07:00";

export const memberHit: ReservationTypePolicy = {
  id: "member-hit",
  name: "Member hit",
  constraintsKnown: true,
  allowedDurationsMinutes: [30, 60, 90, 120],
  minimumDurationMinutes: 30,
  maximumDurationMinutes: 120,
};

export function court(input: {
  courtId: string;
  courtLabel: string;
  openLocal: string;
  closeLocal: string;
  reservations?: Array<{ start: string; end: string }>;
  date?: string;
  timeZone?: string;
}): CourtSchedule {
  return intervalsForCourtDay({
    courtId: input.courtId,
    courtLabel: input.courtLabel,
    date: input.date ?? "2026-06-15",
    timeZone: input.timeZone ?? "America/Los_Angeles",
    openLocal: input.openLocal,
    closeLocal: input.closeLocal,
    reservations: input.reservations ?? [],
  });
}

export function snapshot(courts: CourtSchedule[], policy: ReservationTypePolicy = memberHit, extras: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  return {
    clubId: "fixture-north",
    timeZone: "America/Los_Angeles",
    observedAt,
    courtDirectory: "confirmed",
    courts,
    reservationTypes: [policy],
    priceQuote: null,
    source: "fixture",
    sourceNote: "unit fixture",
    ...extras,
  };
}
