export type IntervalStatus = "open" | "reserved" | "unavailable" | "unknown";

export type ScheduleSourceKind = "fixture" | "organization-api" | "courtsapp-integrations-api";

export interface TimeInterval {
  startUtc: string;
  endUtc: string;
  status: IntervalStatus;
}

export interface CourtSchedule {
  courtId: string;
  courtLabel: string;
  courtTypeId?: string;
  courtTypeName?: string;
  /** complete: the source accounted for the whole day. partial: some instants are unknown. missing: the court was not in the payload. */
  coverage: "complete" | "partial" | "missing";
  intervals: TimeInterval[];
}

export interface ReservationTypePolicy {
  id: string;
  name?: string;
  /**
   * True only when the caller or a documented field with a known unit supplied a duration allow-list.
   * Organization reservation types do not include durations. CourtsApp MinTime/MaxTime have no documented unit,
   * so those integers do not set this flag.
   */
  constraintsKnown: boolean;
  allowedDurationsMinutes?: number[];
  minimumDurationMinutes?: number;
  maximumDurationMinutes?: number;
  /** Raw CourtsApp integers kept for inspection. Not used as minutes. */
  uninterpreted?: {
    minTime?: number | null;
    maxTime?: number | null;
    defaultMinutes?: number | null;
    incrementMinutes?: number | null;
  };
}

export interface ScheduleSnapshot {
  clubId: string | null;
  timeZone: string;
  observedAt: string | null;
  courtDirectory: "confirmed" | "unconfirmed";
  courts: CourtSchedule[];
  reservationTypes: ReservationTypePolicy[];
  /** This SDK never invents a rate. Documented court-day costs are not quotes for a searched window. */
  priceQuote: null;
  source: ScheduleSourceKind;
  sourceNote: string;
}

export interface SearchRequest {
  date: string;
  /** Facility-local clock, HH:mm or HH:mm:ss, in the snapshot time zone. */
  startLocal: string;
  durationMinutes: number;
  reservationTypeId: string;
  disambiguation?: "reject" | "earlier" | "later";
  allowCourtSwitch?: boolean;
  allowOverlappingPaidRental?: boolean;
  /** Freshness window. Defaults to 120000. Null disables the age check; a missing observedAt still blocks. */
  maxAgeMs?: number | null;
  nowUtc?: string;
}

export interface WindowSpan {
  startUtc: string;
  endUtc: string;
  startLocal: string;
  endLocal: string;
  durationMinutes: number;
}

export interface ExactHit {
  kind: "exact";
  courtId: string;
  courtLabel: string;
  reservationTypeId: string;
  startUtc: string;
  endUtc: string;
  startLocal: string;
  endLocal: string;
  durationMinutes: number;
  price: null;
}

export interface CourtSwitchHit {
  kind: "court-switch";
  pattern: "30+60" | "60+30";
  reservationTypeId: string;
  segments: Array<{
    courtId: string;
    courtLabel: string;
    startUtc: string;
    endUtc: string;
    startLocal: string;
    endLocal: string;
    durationMinutes: 30 | 60;
  }>;
  durationMinutes: 90;
  price: null;
}

export interface OverlappingPaidHit {
  kind: "overlapping-paid-rental";
  courtId: string;
  courtLabel: string;
  reservationTypeId: string;
  requested: WindowSpan;
  paid: WindowSpan;
  extraPaidMinutes: number;
  extraPlacement: "before" | "after";
  price: null;
}

export type SearchHit = ExactHit | CourtSwitchHit | OverlappingPaidHit;

export interface SearchResult {
  /** fixture-membership is a caller-supplied fixture list. It is not CourtReserve member discovery. */
  mode: "offline-planner" | "fixture-membership";
  /** How this result was produced. fixture is never a live joined-club lookup. */
  evidence: "fixture" | "offline-planner" | ScheduleSourceKind;
  /** This SDK has no member-club directory. Every result says so. */
  membershipDiscovery: "none";
  authority: ScheduleSourceKind | "fixture";
  clubId: string | null;
  clubDisplayName?: string;
  timeZone: string;
  observedAt: string | null;
  evaluatedAt: string;
  dataAgeMs: number | null;
  stale: boolean;
  usable: boolean;
  price: null;
  courtDirectory: ScheduleSnapshot["courtDirectory"];
  warnings: string[];
  blockers: string[];
  hits: SearchHit[];
  rejections: Array<{ courtId: string; courtLabel: string; reason: string }>;
  diagnostics: {
    physicallyOpenCourtIds: string[];
    note: string;
  };
}
