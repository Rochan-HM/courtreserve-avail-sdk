import type { MemberLoginSupport } from "./feasibility.js";

export class MemberLoginUnsupportedError extends Error {
  readonly code = "member-login-unsupported" as const;

  constructor(readonly support: MemberLoginSupport) {
    super(
      "CourtReserve does not publish a member login or joined-club API. A member password cannot be used by this SDK.",
    );
    this.name = "MemberLoginUnsupportedError";
  }
}

export class ClubNotJoinedError extends Error {
  readonly code = "club-not-joined" as const;

  constructor(
    readonly clubId: string,
    readonly joinedClubIds: readonly string[],
  ) {
    super(
      `Club ${JSON.stringify(clubId)} is not in the membership source. This SDK will not search a club that source did not return.`,
    );
    this.name = "ClubNotJoinedError";
  }
}

export class LiveSearchBlockedError extends Error {
  readonly code = "live-search-blocked" as const;

  constructor(message: string) {
    super(message);
    this.name = "LiveSearchBlockedError";
  }
}

export class CredentialsMissingError extends Error {
  readonly code = "credentials-missing" as const;

  constructor() {
    super(
      "Set COURTRESERVE_API_USERNAME and COURTRESERVE_API_PASSWORD to a club-issued API key. Do not put a member portal password in these variables.",
    );
    this.name = "CredentialsMissingError";
  }
}

export class QueryValidationError extends Error {
  readonly code = "query-validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

export class ApiStatusError extends Error {
  readonly code = "api-status" as const;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiStatusError";
  }
}

export class RateLimitError extends Error {
  readonly code = "rate-limited" as const;

  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class TransportError extends Error {
  readonly code = "transport" as const;

  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export class MapError extends Error {
  readonly code = "map" as const;

  constructor(message: string) {
    super(message);
    this.name = "MapError";
  }
}

export class SnapshotValidationError extends Error {
  readonly code = "snapshot-validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "SnapshotValidationError";
  }
}
