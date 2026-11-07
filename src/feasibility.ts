/**
 * Findings verified by fetching public CourtReserve documents and unauthenticated
 * GETs on 2026-11-07. This module does not call the network.
 */
export interface MemberLoginSupport {
  supported: false;
  host: null;
  route: null;
  credentialAccepted: null;
  reason: string;
  doNotProvide: readonly string[];
  checked: readonly string[];
}

export const memberLoginSupport: MemberLoginSupport = {
  supported: false,
  host: null,
  route: null,
  credentialAccepted: null,
  reason:
    "The published Organization, Enterprise, and Integrations swaggers authenticate with HTTP Basic API keys. None expose a member password grant, OAuth token route, or an endpoint that lists clubs a member has joined. Public booking URLs redirect to a JavaScript portal shell and do not include a schedule.",
  doNotProvide: [
    "CourtReserve member password from 1Password",
    "browser session cookies",
    "copied portal Authorization headers",
  ],
  checked: [
    "https://api.courtreserve.com/swagger/docs/ORGANIZATION",
    "https://api.courtreserve.com/swagger/docs/ENTERPRISE",
    "https://api.courtreserve.com/swagger/docs/INTEGRATIONS",
    "https://api.courtreserve.com/apihelp/index",
    "https://help.courtreserve.com/en/articles/10414722-set-up-api-access-integration",
    "https://help.courtreserve.com/en/articles/12771256-understanding-the-courtreserve-api",
  ],
};

export const organizationReadApi = {
  role: "club-admin-or-integration" as const,
  equivalentToMemberLogin: false,
  host: "https://api.courtreserve.com",
  auth: "Basic" as const,
  usernameEnv: "COURTRESERVE_API_USERNAME",
  passwordEnv: "COURTRESERVE_API_PASSWORD",
  availability: {
    method: "GET" as const,
    path: "/api/v1/reservation/availability",
    permission: "Reservation role with Read",
    maxInclusiveDays: 31,
  },
  courts: { method: "GET" as const, path: "/api/v1/reservation/courts" },
  reservationTypes: {
    method: "GET" as const,
    path: "/api/v1/reservation/reservationtypes",
    durationFieldsDocumented: false,
  },
  unauthenticatedProbe: {
    url: "https://api.courtreserve.com/api/v1/reservation/availability?date=2026-11-07",
    status: 401,
    wwwAuthenticate: "Basic",
    observedOn: "2026-11-07",
  },
  rateLimit: {
    requestsPerMinute: 60,
    per: "API key",
    httpStatus: 429,
    retryAfter: "seconds, Retry-After response header",
    source: "https://api.courtreserve.com/apihelp/index",
  },
};

export const courtsAppReadApi = {
  role: "integrations-basic-auth" as const,
  equivalentToMemberLogin: false,
  host: "https://api.courtreserve.com",
  auth: "Basic" as const,
  availability: { method: "GET" as const, path: "/api/v1/courtsapp/availability", maxInclusiveDays: 31 },
  courts: { method: "GET" as const, path: "/api/v1/courtsapp/courts" },
  reservationTypes: {
    method: "GET" as const,
    path: "/api/v1/courtsapp/reservation-types",
    documentedDurationFields: ["DefaultMinutes", "IncrementMinutes"],
    unitNotDocumented: ["MinTime", "MaxTime"],
  },
  unauthenticatedProbe: {
    url: "https://api.courtreserve.com/api/v1/courtsapp/availability?date=2026-11-07",
    status: 401,
    wwwAuthenticate: "Basic",
    observedOn: "2026-11-07",
  },
};

export const publicCalendarProbes = [
  {
    url: "https://app.courtreserve.com/Online/Reservations/Bookings/5889?sId=340",
    observed: "302 to a portal HTML shell. No reservation grid in the server HTML.",
  },
  {
    url: "https://app.courtreserve.com/Online/Reservations/Bookings/5889?sId=341",
    observed: "302 to a portal HTML shell. No reservation grid in the server HTML.",
  },
  {
    url: "https://app.courtreserve.com/Online/Reservations/Bookings/5889?sId=16754",
    observed: "302 to a portal HTML shell. No reservation grid in the server HTML.",
  },
  {
    url: "https://app.courtreserve.com/Online/Reservations/Index/12714",
    observed: "302 to a portal HTML shell. No reservation grid in the server HTML.",
  },
] as const;

/** Names this process can read if a parent injects them. Member portal passwords are absent on purpose. */
export const acceptedSecretNames = {
  memberPortalUsername: null,
  memberPortalPassword: null,
  organizationApiUsername: organizationReadApi.usernameEnv,
  organizationApiPassword: organizationReadApi.passwordEnv,
} as const;

export function describeSupportedAuth(): {
  memberLogin: MemberLoginSupport;
  liveReadRequires: typeof organizationReadApi;
  acceptedSecretNames: typeof acceptedSecretNames;
  onePassword: string;
  authenticatedMemberTesting: "not-performed";
} {
  return {
    memberLogin: memberLoginSupport,
    liveReadRequires: organizationReadApi,
    acceptedSecretNames,
    onePassword:
      "1Password fill stays in the parent browser. This process does not receive the username, password, cookies, or session, and it does not ask for the vault password.",
    authenticatedMemberTesting: "not-performed",
  };
}
