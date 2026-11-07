# CourtReserve availability search

Read-only TypeScript library and CLI for searching court time. It plans exact windows, court switches, and longer paid rentals from a normalized schedule. A 30-minute calendar row is not treated as a booking duration.

Member password login is unsupported. The published CourtReserve APIs authenticate with an organization API key, which is a different principal from a club member. Authenticated member testing was not performed.

## Install

```bash
npm install
npm test
npm run typecheck
npm run build
```

Node.js 22 or newer. The package is private and is not published.

## CLI

Fixture data is synthetic. It is labeled as a fixture and is not a live club schedule.

```bash
node dist/cli.js auth

node dist/cli.js clubs --membership fixtures/membership.json

node dist/cli.js search \
  --membership fixtures/membership.json \
  --schedule fixtures/north-evening.json \
  --club fixture-north \
  --date 2026-06-15 \
  --start 18:00 \
  --duration 90 \
  --type member-hit \
  --now 2026-06-15T17:00:00.000-07:00

node dist/cli.js search \
  --membership fixtures/membership.json \
  --schedule fixtures/north-evening.json \
  --club fixture-north \
  --date 2026-06-15 \
  --start 18:00 \
  --duration 90 \
  --type member-hit \
  --now 2026-06-15T17:00:00.000-07:00 \
  --allow-court-switch \
  --allow-paid-overlap \
  --json

node dist/cli.js enroll --name "Fixture North"
```

`search` reads clubs only from the membership file. An id that file does not list, including a number copied from a public booking URL, is rejected before any schedule lookup. `--password` and `--session` are rejected and are not recorded.

## Library

```ts
import {
  MembershipScope,
  fixtureScheduleSource,
  parseFixtureMembership,
  parseFixtureSchedule,
  searchJoinedClub,
} from "courtreserve-availability";

const scope = parseFixtureMembership(membershipJson);
const schedule = parseFixtureSchedule(scheduleJson);

const result = await searchJoinedClub({
  scope,
  clubId: "fixture-north",
  source: fixtureScheduleSource([schedule]),
  request: {
    date: "2026-06-15",
    startLocal: "18:00",
    durationMinutes: 90,
    reservationTypeId: "member-hit",
    nowUtc: "2026-06-15T17:00:00.000-07:00",
    allowCourtSwitch: true,
  },
});
```

`result.price` is always `null`. Hits are `exact`, `court-switch` (`30+60` or `60+30`), or `overlapping-paid-rental`. An overlapping paid rental reports `extraPaidMinutes` and the paid window. It is a separate kind from an exact 90-minute match.

`searchSnapshot` is the offline planner. It will score a schedule the caller already holds. `searchJoinedClub` is the scoped entry: fixture membership plus a fixture schedule only.

```ts
import { loginAsMember } from "courtreserve-availability";

loginAsMember();
// throws MemberLoginUnsupportedError
```

## Search rules

Intervals are half-open. A reservation that ends at the search start is adjacent, so it is free of conflict. One overlapping minute is a conflict. `unknown`, a gap, or a court missing from the payload is not free.

The requested duration is elapsed time in the facility IANA zone. On the 2026-03-08 spring-forward morning in `America/Los_Angeles`, 01:00 plus 90 elapsed minutes ends at 03:30 PDT. 02:30 does not exist and produces no hit. On the 2026-11-01 fall-back morning, 01:30 is ambiguous and is rejected unless `disambiguation` is `earlier` or `later`.

A court switch is considered only for a 90-minute request, and only when the reservation type allows both 30 and 60 minutes. Exact single-court hits are ordered first. The same court is not reported as a switch.

A positive hit also requires `constraintsKnown` and an `allowedDurationsMinutes` entry. A minimum or maximum is applied on top of that list. Organization API reservation types do not include durations. CourtsApp returns `MinTime` and `MaxTime` as integers without a documented unit, so those values are kept on `uninterpreted` and do not unlock a hit. `DefaultMinutes` and `IncrementMinutes` are stored the same way.

Snapshots need `observedAt`. The default freshness window is 120 seconds, which is a local policy. Pass `maxAgeMs: null` to disable the age check. A missing `observedAt` still blocks hits. `courtDirectory: "unconfirmed"` adds a warning because the availability payload was not checked against the court catalog. Omitted catalog courts are `coverage: "missing"`.

## Auth

There is no documented member-auth endpoint, so there is no environment variable for a member portal password. `loginAsMember` does not take a secret and does not open a network call.

| Principal | Host | Credential | Read route |
| --- | --- | --- | --- |
| Member portal login | none published | none accepted | none |
| Organization API key | `https://api.courtreserve.com` | `COURTRESERVE_API_USERNAME`, `COURTRESERVE_API_PASSWORD` | `GET /api/v1/reservation/availability` |
| CourtsApp integration key | `https://api.courtreserve.com` | same Basic auth variables | `GET /api/v1/courtsapp/availability` |

The organization key is created by a club admin under Settings → Additional Features → Integrations. The help center says API access is on the Advance, Momentum, and Enterprise plans, with the API add-on enabled, and that keys can be limited to Read on a role. The availability operation requires the Reservation role with Read. Basic auth is the published scheme. A probe without credentials on 2026-11-07 returned **401** with `WWW-Authenticate: Basic` and an empty body. The CourtsApp availability route returned the same 401.

Documented limits used by the client:

- 60 requests per minute per API key, from the [API overview](https://api.courtreserve.com/apihelp/index). A 429 response uses the `Retry-After` header as a number of seconds. The client also waits out its own 60-request window. It caps an honored wait at 120 seconds.
- Availability date ranges are capped at 31 inclusive days. `date` cannot be combined with `fromDate`/`toDate`. The client rejects those queries before sending them. The 32-day boundary was not provoked against the live service.

`readOrganizationSnapshot` calls three documented GETs: availability, courts, and reservation types. It has no club-id parameter. The returned snapshot has `clubId: null` and `source: "organization-api"`. That snapshot is the organization bound to the API key. It is not a list of clubs a member has joined, and `searchJoinedClub` will not load it.

1Password fill runs in the parent browser. This process does not receive the username, password, cookies, or session, and it does not ask for a vault password. Do not place a member portal password in `COURTRESERVE_API_USERNAME` or `COURTRESERVE_API_PASSWORD`.

## Joining a club

`requestClubEnrollment({ clubName })` returns `kind: "owner-approval-required"`, `autoJoin: false`, and `verifiedPublicPage: null`. No public signup URL was verified for a named club. The SDK does not submit a form, accept a waiver, create a membership, or turn a number in a booking URL into a club.

## Feasibility, checked 2026-11-07

Published sources:

- [API overview](https://api.courtreserve.com/apihelp/index) — HTTPS JSON, Basic auth, 60 requests/minute, `Retry-After` on 429. Organization and Enterprise APIs are for club plans, not a member password grant.
- [Organization swagger](https://api.courtreserve.com/swagger/docs/ORGANIZATION) — `GET /api/v1/reservation/availability`, `GET /api/v1/reservation/courts`, `GET /api/v1/reservation/reservationtypes`. Availability returns facility-local wall times, an IANA `TimeZone`, operating hours, and booked `StartTime`/`EndTime` pairs. The prose says pricing is absent. Reservation types expose id, name, colors, order, and revenue category. An excerpt is in `contracts/courtreserve-read.snapshot.json`.
- [Integrations swagger](https://api.courtreserve.com/swagger/docs/INTEGRATIONS) — CourtsApp `GET /api/v1/courtsapp/availability`, courts, and reservation types. Availability can include a court-day `Cost` and `FeeType`. This SDK drops them so they are not shown as the price of a searched window. Reservation types add `MinTime`, `MaxTime`, `DefaultMinutes`, and `IncrementMinutes`. Only the last two names say minutes; `MinTime` and `MaxTime` stay uninterpreted.
- [Enterprise swagger](https://api.courtreserve.com/swagger/docs/ENTERPRISE) — reporting routes for an organization id chosen by the API key. No availability route and no member login route.
- [Set up API access](https://help.courtreserve.com/en/articles/10414722-set-up-api-access-integration) and [Understanding the CourtReserve API](https://help.courtreserve.com/en/articles/12771256-understanding-the-courtreserve-api) — admin-created keys, read versus write roles.
- [Calendar feeds](https://help.courtreserve.com/en/articles/11180356-calendar-feeds-from-courtreserve-for-system-users) — an admin-built iCal URL. It lists reservations and events, refreshes on the calendar vendor's delay, and does not publish free courts. Silence in an iCal feed is not free time, so this SDK does not treat a feed as an availability source.
- [Widgets](https://help.courtreserve.com/en/articles/4805998-overview-widgets) — browser embeds, including an availability snapshot. They are not an HTTP member API.

Public booking links were fetched once each. All four responded 302 to `/Online/Portal/Index/{id}` and then a portal HTML shell whose visible text was the title “CourtReserve”. No reservation grid was in that HTML. The JavaScript bundle was not downloaded. Those URLs were not treated as membership, signup, or a data contract:

- `https://app.courtreserve.com/Online/Reservations/Bookings/5889?sId=340`
- `https://app.courtreserve.com/Online/Reservations/Bookings/5889?sId=341`
- `https://app.courtreserve.com/Online/Reservations/Bookings/5889?sId=16754`
- `https://app.courtreserve.com/Online/Reservations/Index/12714`

SSO routes such as `GET /api/v1/member/getssolink` exist on the Organization API. They require a Member-role API key and mint a member link. They are not a member password grant, and this SDK does not call them.

No official npm SDK was found. Third-party MCP servers describe the same organization API and also expose write tools. They are not a member login.

## What was exercised

Live, unauthenticated:

- The three swagger documents and the help pages above returned public documentation.
- `GET /api/v1/reservation/availability?date=2026-11-07` returned 401.
- `GET /api/v1/courtsapp/availability?date=2026-11-07` returned 401.
- The four booking URLs returned the portal shell described above.

Mocked or synthetic:

- Overlap, adjacency, unknown gaps, missing courts, DST, court switches, minimum durations, stale data, and mapper behavior. See `test/`.
- HTTP retry, `Retry-After`, and the 31-day guard, using an injected `fetch`.
- Schema-shaped JSON in unit tests. Those objects follow the swagger field names. They are not captured authenticated payloads. Casing was not confirmed live, so the mapper accepts PascalCase and camelCase.

Not performed:

- Authenticated member testing.
- Any call with an API key.
- A 429 from the live service.
- A 32-day live request.
- Booking, payment, holds, guest records, waivers, or account changes.

## Layout

- `src/search.ts` — planner
- `src/scope.ts` — fixture membership gate
- `src/admin/` — documented GET client and mappers
- `src/feasibility.ts` — the auth report the CLI prints
- `contracts/courtreserve-read.snapshot.json` — read-route excerpt from the public swaggers
- `fixtures/` — synthetic schedules
