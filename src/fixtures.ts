import { SnapshotValidationError } from "./errors.js";
import { MembershipScope, type JoinedClub } from "./scope.js";
import type { CourtSchedule, IntervalStatus, ReservationTypePolicy, ScheduleSnapshot, TimeInterval } from "./types.js";

const STATUSES = new Set<IntervalStatus>(["open", "reserved", "unavailable", "unknown"]);

export function parseFixtureMembership(value: unknown): MembershipScope {
  if (!isRecord(value)) throw new SnapshotValidationError("Membership fixture must be an object.");
  const label = value.label;
  const clubs = value.clubs;
  if (typeof label !== "string" || !Array.isArray(clubs)) {
    throw new SnapshotValidationError("Membership fixture needs label and clubs.");
  }
  const parsed: JoinedClub[] = clubs.map((club) => {
    if (!isRecord(club) || typeof club.clubId !== "string" || typeof club.displayName !== "string") {
      throw new SnapshotValidationError("Each fixture club needs clubId and displayName.");
    }
    const timeZone = club.timeZone;
    if (timeZone !== undefined && typeof timeZone !== "string") {
      throw new SnapshotValidationError("Fixture club timeZone must be a string when present.");
    }
    return {
      clubId: club.clubId,
      displayName: club.displayName,
      ...(typeof timeZone === "string" ? { timeZone } : {}),
    };
  });
  return MembershipScope.fixture(parsed, label);
}

export function parseFixtureSchedule(value: unknown): ScheduleSnapshot {
  if (!isRecord(value)) throw new SnapshotValidationError("Schedule fixture must be an object.");
  if (value.source !== "fixture") {
    throw new SnapshotValidationError('Schedule fixture source must be "fixture".');
  }
  if (value.priceQuote !== null) throw new SnapshotValidationError("A fixture cannot carry a price quote.");
  if (typeof value.clubId !== "string" || !value.clubId) {
    throw new SnapshotValidationError("Fixture clubId is required.");
  }
  if (typeof value.timeZone !== "string" || typeof value.sourceNote !== "string") {
    throw new SnapshotValidationError("Fixture timeZone and sourceNote are required.");
  }
  if (value.observedAt !== null && typeof value.observedAt !== "string") {
    throw new SnapshotValidationError("observedAt must be an ISO string or null.");
  }
  if (value.courtDirectory !== "confirmed" && value.courtDirectory !== "unconfirmed") {
    throw new SnapshotValidationError("courtDirectory must be confirmed or unconfirmed.");
  }
  if (!Array.isArray(value.courts) || !Array.isArray(value.reservationTypes)) {
    throw new SnapshotValidationError("Fixture courts and reservationTypes must be arrays.");
  }
  return {
    clubId: value.clubId,
    timeZone: value.timeZone,
    observedAt: value.observedAt,
    courtDirectory: value.courtDirectory,
    courts: value.courts.map(parseCourt),
    reservationTypes: value.reservationTypes.map(parsePolicy),
    priceQuote: null,
    source: "fixture",
    sourceNote: value.sourceNote,
  };
}

function parseCourt(value: unknown): CourtSchedule {
  if (!isRecord(value) || typeof value.courtId !== "string" || typeof value.courtLabel !== "string") {
    throw new SnapshotValidationError("Court fixture needs courtId and courtLabel.");
  }
  if (value.coverage !== "complete" && value.coverage !== "partial" && value.coverage !== "missing") {
    throw new SnapshotValidationError("Court coverage is invalid.");
  }
  if (!Array.isArray(value.intervals)) throw new SnapshotValidationError("Court intervals must be an array.");
  const court: CourtSchedule = {
    courtId: value.courtId,
    courtLabel: value.courtLabel,
    coverage: value.coverage,
    intervals: value.intervals.map(parseInterval),
  };
  if (typeof value.courtTypeId === "string") court.courtTypeId = value.courtTypeId;
  if (typeof value.courtTypeName === "string") court.courtTypeName = value.courtTypeName;
  return court;
}

function parseInterval(value: unknown): TimeInterval {
  if (!isRecord(value) || typeof value.startUtc !== "string" || typeof value.endUtc !== "string") {
    throw new SnapshotValidationError("Interval needs startUtc and endUtc.");
  }
  if (typeof value.status !== "string" || !STATUSES.has(value.status as IntervalStatus)) {
    throw new SnapshotValidationError("Interval status must be open, reserved, unavailable, or unknown.");
  }
  if (Date.parse(value.endUtc) <= Date.parse(value.startUtc)) {
    throw new SnapshotValidationError("Interval end must be after start.");
  }
  return { startUtc: value.startUtc, endUtc: value.endUtc, status: value.status as IntervalStatus };
}

function parsePolicy(value: unknown): ReservationTypePolicy {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.constraintsKnown !== "boolean") {
    throw new SnapshotValidationError("Reservation type needs id and constraintsKnown.");
  }
  const policy: ReservationTypePolicy = { id: value.id, constraintsKnown: value.constraintsKnown };
  if (typeof value.name === "string") policy.name = value.name;
  if (value.allowedDurationsMinutes !== undefined) {
    if (!Array.isArray(value.allowedDurationsMinutes) || value.allowedDurationsMinutes.some((item) => !Number.isInteger(item))) {
      throw new SnapshotValidationError("allowedDurationsMinutes must be integers.");
    }
    policy.allowedDurationsMinutes = value.allowedDurationsMinutes as number[];
  }
  if (value.minimumDurationMinutes !== undefined) {
    if (typeof value.minimumDurationMinutes !== "number" || !Number.isInteger(value.minimumDurationMinutes)) {
      throw new SnapshotValidationError("minimumDurationMinutes must be an integer.");
    }
    policy.minimumDurationMinutes = value.minimumDurationMinutes;
  }
  if (value.maximumDurationMinutes !== undefined) {
    if (typeof value.maximumDurationMinutes !== "number" || !Number.isInteger(value.maximumDurationMinutes)) {
      throw new SnapshotValidationError("maximumDurationMinutes must be an integer.");
    }
    policy.maximumDurationMinutes = value.maximumDurationMinutes;
  }
  return policy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
