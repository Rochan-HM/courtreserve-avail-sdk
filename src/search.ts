import { DateTime } from "luxon";
import { classifyWindow, elapsedEnd } from "./intervals.js";
import { durationAllowed, durationBlocker } from "./policy.js";
import { LiveSearchBlockedError } from "./errors.js";
import { MembershipScope, type FixtureScheduleSource } from "./scope.js";
import { addMinutes, formatInstant, resolveLocalDateTime } from "./time.js";
import type {
  CourtSchedule,
  CourtSwitchHit,
  ExactHit,
  OverlappingPaidHit,
  ReservationTypePolicy,
  ScheduleSnapshot,
  SearchHit,
  SearchRequest,
  SearchResult,
  WindowSpan,
} from "./types.js";

const DEFAULT_MAX_AGE_MS = 120_000;
const SWITCH_PATTERNS = [
  { pattern: "30+60" as const, parts: [30, 60] as const },
  { pattern: "60+30" as const, parts: [60, 30] as const },
];

export function searchSnapshot(snapshot: ScheduleSnapshot, request: SearchRequest): SearchResult {
  const evaluatedAt = request.nowUtc ?? new Date().toISOString();
  const warnings: string[] = [];
  const blockers: string[] = [];
  if (snapshot.courtDirectory === "unconfirmed") warnings.push("court-directory-unconfirmed");
  if (snapshot.source !== "fixture") warnings.push("not-a-member-schedule");

  const base = (): SearchResult => ({
    mode: "offline-planner",
    authority: snapshot.source,
    clubId: snapshot.clubId,
    timeZone: snapshot.timeZone,
    observedAt: snapshot.observedAt,
    evaluatedAt,
    dataAgeMs: ageMs(snapshot.observedAt, evaluatedAt),
    stale: false,
    usable: false,
    price: null,
    courtDirectory: snapshot.courtDirectory,
    warnings,
    blockers,
    hits: [],
    rejections: [],
    diagnostics: {
      physicallyOpenCourtIds: [],
      note: "Physical openness is not a booking match. Hits require a fully open interval and a known allowed duration. Unknown time is not free.",
    },
  });

  const freshness = freshnessBlocker(snapshot.observedAt, evaluatedAt, request.maxAgeMs);
  if (freshness) {
    blockers.push(freshness);
    const result = base();
    result.stale = freshness === "stale" || freshness === "missing-observed-at";
    return result;
  }

  if (!Number.isInteger(request.durationMinutes) || request.durationMinutes <= 0) {
    blockers.push("invalid-duration");
    return base();
  }

  const resolved = resolveLocalDateTime({
    date: request.date,
    time: request.startLocal,
    timeZone: snapshot.timeZone,
    disambiguation: request.disambiguation ?? "reject",
  });
  if (!resolved.ok) {
    blockers.push(resolved.reason);
    return base();
  }

  const startUtc = resolved.utcMillis;
  const endUtc = elapsedEnd(startUtc, request.durationMinutes);
  const policy = snapshot.reservationTypes.find((item) => item.id === request.reservationTypeId);
  if (!policy) {
    blockers.push("unknown-reservation-type");
    return base();
  }

  const courts = [...snapshot.courts].sort((a, b) => a.courtLabel.localeCompare(b.courtLabel) || a.courtId.localeCompare(b.courtId));
  const openCourts = courts.filter((court) => classifyWindow(court, startUtc, endUtc).ok);
  const result = base();
  result.diagnostics.physicallyOpenCourtIds = openCourts.map((court) => court.courtId);

  const constraint = durationBlocker(policy, request.durationMinutes);
  if (constraint === "constraints-unknown") {
    blockers.push("constraints-unknown");
    result.rejections = courts.map((court) => ({
      courtId: court.courtId,
      courtLabel: court.courtLabel,
      reason: "constraints-unknown",
    }));
    return result;
  }

  const hits: SearchHit[] = [];
  const rejections: SearchResult["rejections"] = [];
  for (const court of courts) {
    const window = classifyWindow(court, startUtc, endUtc);
    if (!window.ok) {
      rejections.push({ courtId: court.courtId, courtLabel: court.courtLabel, reason: window.reason });
      continue;
    }
    if (constraint) {
      rejections.push({ courtId: court.courtId, courtLabel: court.courtLabel, reason: constraint });
      continue;
    }
    hits.push(exactHit(court, policy, snapshot.timeZone, startUtc, endUtc, request.durationMinutes));
  }

  if (request.allowCourtSwitch && request.durationMinutes === 90) {
    hits.push(...courtSwitches(courts, policy, snapshot.timeZone, startUtc));
  }
  if (request.allowOverlappingPaidRental) {
    hits.push(...paidRentals(courts, policy, snapshot.timeZone, startUtc, endUtc, request.durationMinutes));
  }

  result.hits = sortHits(hits);
  result.rejections = rejections;
  result.usable = blockers.length === 0;
  return result;
}

export async function searchJoinedClub(args: {
  scope: MembershipScope;
  clubId: string;
  source: FixtureScheduleSource;
  request: SearchRequest;
}): Promise<SearchResult> {
  const club = args.scope.requireClub(args.clubId);
  if (args.source.transport !== "fixture" || args.scope.origin !== "fixture") {
    throw new LiveSearchBlockedError(
      "Live court search is blocked. Joined clubs can only come from a documented member session, and no such session exists.",
    );
  }
  const snapshot = await args.source.load(club.clubId);
  if (snapshot.source !== "fixture" || snapshot.clubId !== club.clubId) {
    throw new LiveSearchBlockedError("Refusing to search a schedule that is not the fixture for this joined club.");
  }
  if (club.timeZone && club.timeZone !== snapshot.timeZone) {
    const result = searchSnapshot(snapshot, args.request);
    result.mode = "scoped-membership";
    result.authority = "fixture";
    result.clubDisplayName = club.displayName;
    result.blockers = ["timezone-mismatch", ...result.blockers];
    result.hits = [];
    result.usable = false;
    return result;
  }
  const result = searchSnapshot(snapshot, args.request);
  result.mode = "scoped-membership";
  result.authority = "fixture";
  result.clubDisplayName = club.displayName;
  result.warnings = result.warnings.filter((warning) => warning !== "not-a-member-schedule");
  result.warnings.unshift("fixture-membership");
  return result;
}

function exactHit(
  court: CourtSchedule,
  policy: ReservationTypePolicy,
  timeZone: string,
  startUtc: number,
  endUtc: number,
  durationMinutes: number,
): ExactHit {
  const start = formatInstant(startUtc, timeZone);
  const end = formatInstant(endUtc, timeZone);
  return {
    kind: "exact",
    courtId: court.courtId,
    courtLabel: court.courtLabel,
    reservationTypeId: policy.id,
    startUtc: start.utc,
    endUtc: end.utc,
    startLocal: start.local,
    endLocal: end.local,
    durationMinutes,
    price: null,
  };
}

function courtSwitches(
  courts: CourtSchedule[],
  policy: ReservationTypePolicy,
  timeZone: string,
  startUtc: number,
): CourtSwitchHit[] {
  if (!durationAllowed(policy, 30) || !durationAllowed(policy, 60)) return [];
  const hits: CourtSwitchHit[] = [];
  for (const pattern of SWITCH_PATTERNS) {
    const [firstMinutes, secondMinutes] = pattern.parts;
    const firstEnd = addMinutes(startUtc, firstMinutes);
    const secondEnd = addMinutes(firstEnd, secondMinutes);
    for (const first of courts) {
      if (!classifyWindow(first, startUtc, firstEnd).ok) continue;
      for (const second of courts) {
        if (second.courtId === first.courtId) continue;
        if (!classifyWindow(second, firstEnd, secondEnd).ok) continue;
        const a = formatInstant(startUtc, timeZone);
        const mid = formatInstant(firstEnd, timeZone);
        const b = formatInstant(secondEnd, timeZone);
        hits.push({
          kind: "court-switch",
          pattern: pattern.pattern,
          reservationTypeId: policy.id,
          durationMinutes: 90,
          price: null,
          segments: [
            {
              courtId: first.courtId,
              courtLabel: first.courtLabel,
              startUtc: a.utc,
              endUtc: mid.utc,
              startLocal: a.local,
              endLocal: mid.local,
              durationMinutes: firstMinutes,
            },
            {
              courtId: second.courtId,
              courtLabel: second.courtLabel,
              startUtc: mid.utc,
              endUtc: b.utc,
              startLocal: mid.local,
              endLocal: b.local,
              durationMinutes: secondMinutes,
            },
          ],
        });
      }
    }
  }
  return hits;
}

function paidRentals(
  courts: CourtSchedule[],
  policy: ReservationTypePolicy,
  timeZone: string,
  requestedStart: number,
  requestedEnd: number,
  requestedMinutes: number,
): OverlappingPaidHit[] {
  const durations = (policy.allowedDurationsMinutes ?? [])
    .filter((minutes) => minutes > requestedMinutes && durationAllowed(policy, minutes))
    .sort((a, b) => a - b);
  const hits: OverlappingPaidHit[] = [];
  for (const court of courts) {
    for (const minutes of durations) {
      const suffixEnd = addMinutes(requestedStart, minutes);
      if (classifyWindow(court, requestedStart, suffixEnd).ok) {
        hits.push(
          paidHit(court, policy, timeZone, requestedStart, requestedEnd, requestedMinutes, requestedStart, suffixEnd, minutes, "after"),
        );
      }
      const prefixStart = addMinutes(requestedEnd, -minutes);
      if (classifyWindow(court, prefixStart, requestedEnd).ok) {
        hits.push(
          paidHit(court, policy, timeZone, requestedStart, requestedEnd, requestedMinutes, prefixStart, requestedEnd, minutes, "before"),
        );
      }
    }
  }
  return hits;
}

function paidHit(
  court: CourtSchedule,
  policy: ReservationTypePolicy,
  timeZone: string,
  requestedStart: number,
  requestedEnd: number,
  requestedMinutes: number,
  paidStart: number,
  paidEnd: number,
  paidMinutes: number,
  extraPlacement: "before" | "after",
): OverlappingPaidHit {
  return {
    kind: "overlapping-paid-rental",
    courtId: court.courtId,
    courtLabel: court.courtLabel,
    reservationTypeId: policy.id,
    requested: span(timeZone, requestedStart, requestedEnd, requestedMinutes),
    paid: span(timeZone, paidStart, paidEnd, paidMinutes),
    extraPaidMinutes: paidMinutes - requestedMinutes,
    extraPlacement,
    price: null,
  };
}

function span(timeZone: string, startUtc: number, endUtc: number, durationMinutes: number): WindowSpan {
  const start = formatInstant(startUtc, timeZone);
  const end = formatInstant(endUtc, timeZone);
  return {
    startUtc: start.utc,
    endUtc: end.utc,
    startLocal: start.local,
    endLocal: end.local,
    durationMinutes,
  };
}

function sortHits(hits: SearchHit[]): SearchHit[] {
  const rank = (hit: SearchHit) => (hit.kind === "exact" ? 0 : hit.kind === "court-switch" ? 1 : 2);
  return [...hits].sort((a, b) => {
    const byKind = rank(a) - rank(b);
    if (byKind !== 0) return byKind;
    if (a.kind === "court-switch" && b.kind === "court-switch") {
      const pattern = a.pattern.localeCompare(b.pattern);
      if (pattern !== 0) return pattern;
      const first = a.segments[0]!.courtLabel.localeCompare(b.segments[0]!.courtLabel);
      if (first !== 0) return first;
      return a.segments[1]!.courtLabel.localeCompare(b.segments[1]!.courtLabel);
    }
    if (a.kind === "overlapping-paid-rental" && b.kind === "overlapping-paid-rental") {
      const extra = a.extraPaidMinutes - b.extraPaidMinutes;
      if (extra !== 0) return extra;
      const placement = a.extraPlacement.localeCompare(b.extraPlacement);
      if (placement !== 0) return placement;
    }
    const labelA = "courtLabel" in a ? a.courtLabel : "";
    const labelB = "courtLabel" in b ? b.courtLabel : "";
    return labelA.localeCompare(labelB);
  });
}

function freshnessBlocker(observedAt: string | null, evaluatedAt: string, maxAgeMs: number | null | undefined): string | null {
  if (!observedAt) return "missing-observed-at";
  const age = ageMs(observedAt, evaluatedAt);
  if (age === null) return "missing-observed-at";
  const limit = maxAgeMs === undefined ? DEFAULT_MAX_AGE_MS : maxAgeMs;
  if (limit === null) return null;
  if (age > limit || age < -limit) return "stale";
  return null;
}

function ageMs(observedAt: string | null, evaluatedAt: string): number | null {
  if (!observedAt) return null;
  const observed = DateTime.fromISO(observedAt);
  const evaluated = DateTime.fromISO(evaluatedAt);
  if (!observed.isValid || !evaluated.isValid) return null;
  return evaluated.toMillis() - observed.toMillis();
}
