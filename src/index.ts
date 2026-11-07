export { credentialsFromEnv, loginAsMember } from "./auth.js";
export {
  CourtReserveReadClient,
  availabilityParams,
  type ApiCredentials,
  type AvailabilityQuery,
  type HttpDeps,
  type RateLimitPolicy,
} from "./admin/http.js";
export {
  mapCourtsAppAvailability,
  mapCourtsAppCourts,
  mapCourtsAppReservationTypes,
  mapOrganizationAvailability,
  mapOrganizationCourts,
  mapOrganizationReservationTypes,
  type CatalogCourt,
} from "./admin/map.js";
export { readCourtsAppSnapshot, readOrganizationSnapshot } from "./admin/read.js";
export {
  ApiStatusError,
  ClubNotJoinedError,
  CredentialsMissingError,
  LiveSearchBlockedError,
  MapError,
  MemberLoginUnsupportedError,
  QueryValidationError,
  RateLimitError,
  SnapshotValidationError,
  TransportError,
} from "./errors.js";
export { requestClubEnrollment, type EnrollmentRequest } from "./enrollment.js";
export {
  acceptedSecretNames,
  courtsAppReadApi,
  describeSupportedAuth,
  memberLoginSupport,
  organizationReadApi,
  publicCalendarProbes,
} from "./feasibility.js";
export { parseFixtureMembership, parseFixtureSchedule } from "./fixtures.js";
export { classifyWindow, intervalsForCourtDay, missingCourt } from "./intervals.js";
export { durationAllowed } from "./policy.js";
export { searchJoinedClub, searchSnapshot } from "./search.js";
export { MembershipScope, fixtureScheduleSource, type FixtureScheduleSource, type JoinedClub } from "./scope.js";
export { addMinutes, formatInstant, resolveLocalDateTime } from "./time.js";
export type {
  CourtSchedule,
  CourtSwitchHit,
  ExactHit,
  IntervalStatus,
  OverlappingPaidHit,
  ReservationTypePolicy,
  ScheduleSnapshot,
  SearchHit,
  SearchRequest,
  SearchResult,
  TimeInterval,
} from "./types.js";
