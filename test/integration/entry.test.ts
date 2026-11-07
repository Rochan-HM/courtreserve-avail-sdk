/**
 * Public entry-point tests. Import the built package and the built CLI only.
 * Labels: fixture, mock, live-unauthenticated, live-authenticated.
 * Live authenticated member search is asserted as not performed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  ApiStatusError,
  ClubNotJoinedError,
  CourtReserveReadClient,
  LiveSearchBlockedError,
  MembershipScope,
  describeSupportedAuth,
  intervalsForCourtDay,
  loginAsMember,
  searchJoinedClub,
  searchSnapshot,
} from "../../dist/index.js";
import type { CourtSchedule, ReservationTypePolicy, ScheduleSnapshot } from "../../dist/index.js";

const observedAt = "2026-06-15T17:00:00.000-07:00";
const zone = "America/Los_Angeles";

const policy: ReservationTypePolicy = {
  id: "member-hit",
  name: "Member hit",
  constraintsKnown: true,
  allowedDurationsMinutes: [30, 60, 90, 120],
  minimumDurationMinutes: 30,
  maximumDurationMinutes: 120,
};

function schedule(courts: CourtSchedule[], extras: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  return {
    clubId: "fixture-north",
    timeZone: zone,
    observedAt,
    courtDirectory: "confirmed",
    courts,
    reservationTypes: [policy],
    priceQuote: null,
    source: "fixture",
    sourceNote: "integration fixture",
    ...extras,
  };
}

function dayCourt(input: {
  courtId: string;
  courtLabel: string;
  date?: string;
  openLocal: string;
  closeLocal: string;
  reservations?: Array<{ start: string; end: string }>;
}): CourtSchedule {
  return intervalsForCourtDay({
    courtId: input.courtId,
    courtLabel: input.courtLabel,
    date: input.date ?? "2026-06-15",
    timeZone: zone,
    openLocal: input.openLocal,
    closeLocal: input.closeLocal,
    reservations: input.reservations ?? [],
  });
}

describe("[fixture] public searchJoinedClub", () => {
  it("requires a continuous open interval and rejects a hole between open cells", async () => {
    const continuous: CourtSchedule = {
      courtId: "court-continuous",
      courtLabel: "Continuous",
      coverage: "complete",
      intervals: [
        { startUtc: "2026-06-16T01:00:00.000Z", endUtc: "2026-06-16T01:30:00.000Z", status: "open" },
        { startUtc: "2026-06-16T01:30:00.000Z", endUtc: "2026-06-16T02:30:00.000Z", status: "open" },
      ],
    };
    const hole: CourtSchedule = {
      courtId: "court-hole",
      courtLabel: "Hole",
      coverage: "complete",
      intervals: [
        { startUtc: "2026-06-16T01:00:00.000Z", endUtc: "2026-06-16T01:30:00.000Z", status: "open" },
        { startUtc: "2026-06-16T02:00:00.000Z", endUtc: "2026-06-16T02:30:00.000Z", status: "open" },
      ],
    };
    const corrupt: CourtSchedule = {
      courtId: "court-corrupt",
      courtLabel: "Corrupt",
      coverage: "complete",
      intervals: [
        { startUtc: "not-a-time", endUtc: "also-no", status: "reserved" },
        { startUtc: "2026-06-16T01:00:00.000Z", endUtc: "2026-06-16T02:30:00.000Z", status: "open" },
      ],
    };
    const scope = MembershipScope.fixture(
      [{ clubId: "fixture-north", displayName: "Fixture North", timeZone: zone }],
      "synthetic fixture, not a member account",
    );
    const result = await searchJoinedClub({
      scope,
      clubId: "fixture-north",
      source: {
        transport: "fixture",
        async load(clubId: string) {
          assert.equal(clubId, "fixture-north");
          return schedule([continuous, hole, corrupt]);
        },
      },
      request: {
        date: "2026-06-15",
        startLocal: "18:00",
        durationMinutes: 90,
        reservationTypeId: "member-hit",
        nowUtc: observedAt,
      },
    });
    assert.equal(result.evidence, "fixture");
    assert.equal(result.membershipDiscovery, "none");
    assert.equal(result.mode, "fixture-membership");
    assert.deepEqual(
      result.hits.filter((hit) => hit.kind === "exact").map((hit) => hit.courtId),
      ["court-continuous"],
    );
    assert.equal(result.rejections.find((row) => row.courtId === "court-hole")?.reason, "unknown-coverage");
    assert.equal(result.rejections.find((row) => row.courtId === "court-corrupt")?.reason, "unknown-coverage");
    assert.equal(result.price, null);
  });

  it("keeps 30+60 and 60+30 on elapsed time, including across the spring-forward gap", async () => {
    const when = "2026-03-08T00:30:00.000-08:00";
    const courts = [
      dayCourt({ courtId: "early", courtLabel: "Early", date: "2026-03-08", openLocal: "01:00", closeLocal: "01:30" }),
      dayCourt({ courtId: "late", courtLabel: "Late", date: "2026-03-08", openLocal: "01:30", closeLocal: "03:30" }),
      dayCourt({ courtId: "all-morning", courtLabel: "All morning", date: "2026-03-08", openLocal: "00:00", closeLocal: "06:00" }),
    ];
    const scope = MembershipScope.fixture(
      [{ clubId: "fixture-north", displayName: "Fixture North", timeZone: zone }],
      "synthetic fixture, not a member account",
    );
    const result = await searchJoinedClub({
      scope,
      clubId: "fixture-north",
      source: { transport: "fixture", async load() { return schedule(courts, { observedAt: when }); } },
      request: {
        date: "2026-03-08",
        startLocal: "01:00",
        durationMinutes: 90,
        reservationTypeId: "member-hit",
        allowCourtSwitch: true,
        nowUtc: when,
      },
    });
    assert.equal(result.evidence, "fixture");
    assert.equal(result.hits[0]?.kind, "exact");
    const forward = result.hits.find(
      (hit) => hit.kind === "court-switch" && hit.pattern === "30+60" && hit.segments[0]?.courtId === "early" && hit.segments[1]?.courtId === "late",
    );
    assert.equal(forward?.kind, "court-switch");
    if (forward?.kind !== "court-switch") return;
    const elapsed = Date.parse(forward.segments[1]!.endUtc) - Date.parse(forward.segments[0]!.startUtc);
    assert.equal(elapsed, 90 * 60_000);
    assert.equal(forward.segments[0]!.endUtc, forward.segments[1]!.startUtc);
    assert.equal(forward.segments[0]!.durationMinutes, 30);
    assert.equal(forward.segments[1]!.durationMinutes, 60);
    assert.match(forward.segments[1]!.endLocal, /T03:30:00/);
    assert.match(forward.segments[1]!.endLocal, /-07:00$/);
    const backward = result.hits.find(
      (hit) => hit.kind === "court-switch" && hit.pattern === "60+30" && hit.segments[0]?.courtId === "all-morning",
    );
    assert.ok(backward);
    assert.equal(
      result.hits.some((hit) => hit.kind === "court-switch" && hit.segments[0]?.courtId === hit.segments[1]?.courtId),
      false,
    );
  });

  it("blocks a 30-minute switch segment when the minimum duration is 60", async () => {
    const strict: ReservationTypePolicy = { ...policy, minimumDurationMinutes: 60 };
    const courts = [
      dayCourt({ courtId: "early", courtLabel: "Early", openLocal: "18:00", closeLocal: "18:30" }),
      dayCourt({ courtId: "late", courtLabel: "Late", openLocal: "18:30", closeLocal: "19:30" }),
      dayCourt({ courtId: "full", courtLabel: "Full", openLocal: "17:00", closeLocal: "21:00" }),
    ];
    const result = await searchJoinedClub({
      scope: MembershipScope.fixture([{ clubId: "fixture-north", displayName: "Fixture North", timeZone: zone }], "synthetic fixture"),
      clubId: "fixture-north",
      source: {
        transport: "fixture",
        async load() {
          return schedule(courts, { reservationTypes: [strict] });
        },
      },
      request: {
        date: "2026-06-15",
        startLocal: "18:00",
        durationMinutes: 90,
        reservationTypeId: "member-hit",
        allowCourtSwitch: true,
        nowUtc: observedAt,
      },
    });
    assert.equal(result.evidence, "fixture");
    assert.deepEqual(
      result.hits.map((hit) => hit.kind),
      ["exact"],
    );
    const only = result.hits[0];
    assert.equal(only?.kind, "exact");
    if (only?.kind === "exact") assert.equal(only.courtId, "full");
  });

  it("rejects a club that is not in the fixture membership before loading a schedule", async () => {
    let loads = 0;
    await assert.rejects(
      () =>
        searchJoinedClub({
          scope: MembershipScope.fixture([{ clubId: "fixture-north", displayName: "Fixture North" }], "synthetic fixture"),
          clubId: "5889",
          source: {
            transport: "fixture",
            async load() {
              loads += 1;
              return schedule([]);
            },
          },
          request: {
            date: "2026-06-15",
            startLocal: "18:00",
            durationMinutes: 90,
            reservationTypeId: "member-hit",
            nowUtc: observedAt,
          },
        }),
      (error: unknown) => error instanceof ClubNotJoinedError && error.clubId === "5889",
    );
    assert.equal(loads, 0);
  });

  it("does not treat a fixture list as permission to call a live admin client", async () => {
    let loads = 0;
    await assert.rejects(
      () =>
        searchJoinedClub({
          scope: MembershipScope.fixture([{ clubId: "fixture-north", displayName: "Fixture North" }], "synthetic fixture"),
          clubId: "fixture-north",
          source: {
            transport: "organization-api" as unknown as "fixture",
            async load() {
              loads += 1;
              return schedule([]);
            },
          },
          request: {
            date: "2026-06-15",
            startLocal: "18:00",
            durationMinutes: 90,
            reservationTypeId: "member-hit",
            nowUtc: observedAt,
          },
        }),
      LiveSearchBlockedError,
    );
    assert.equal(loads, 0);
    const auth = describeSupportedAuth();
    assert.equal(auth.liveReadRequires.equivalentToMemberLogin, false);
    assert.equal(auth.memberLogin.supported, false);
  });

  it("drops hits when the snapshot is stale or the club zone disagrees", async () => {
    const open = dayCourt({ courtId: "full", courtLabel: "Full", openLocal: "08:00", closeLocal: "21:00" });
    const stale = await searchJoinedClub({
      scope: MembershipScope.fixture([{ clubId: "fixture-north", displayName: "Fixture North", timeZone: zone }], "synthetic fixture"),
      clubId: "fixture-north",
      source: {
        transport: "fixture",
        async load() {
          return schedule([open], { observedAt: "2026-06-15T12:00:00.000-07:00" });
        },
      },
      request: {
        date: "2026-06-15",
        startLocal: "18:00",
        durationMinutes: 90,
        reservationTypeId: "member-hit",
        nowUtc: observedAt,
        maxAgeMs: 120_000,
      },
    });
    assert.equal(stale.evidence, "fixture");
    assert.equal(stale.stale, true);
    assert.equal(stale.hits.length, 0);

    const mismatch = await searchJoinedClub({
      scope: MembershipScope.fixture(
        [{ clubId: "fixture-north", displayName: "Fixture North", timeZone: "America/New_York" }],
        "synthetic fixture",
      ),
      clubId: "fixture-north",
      source: { transport: "fixture", async load() { return schedule([open]); } },
      request: {
        date: "2026-06-15",
        startLocal: "18:00",
        durationMinutes: 90,
        reservationTypeId: "member-hit",
        nowUtc: observedAt,
      },
    });
    assert.equal(mismatch.evidence, "fixture");
    assert.equal(mismatch.blockers.includes("timezone-mismatch"), true);
    assert.equal(mismatch.hits.length, 0);
    assert.equal(mismatch.usable, false);
  });

  it("leaves an unknown court out of the hits", () => {
    const result = searchSnapshot(
      schedule([
        {
          courtId: "offscreen",
          courtLabel: "Offscreen",
          coverage: "missing",
          intervals: [],
        },
      ]),
      {
        date: "2026-06-15",
        startLocal: "18:00",
        durationMinutes: 90,
        reservationTypeId: "member-hit",
        nowUtc: observedAt,
      },
    );
    assert.equal(result.evidence, "offline-planner");
    assert.equal(result.membershipDiscovery, "none");
    assert.equal(result.hits.length, 0);
    assert.equal(result.rejections[0]?.reason, "missing-from-payload");
  });
});

describe("[mock] public CourtReserveReadClient", () => {
  it("surfaces 401 once and follows Retry-After on 429", async () => {
    let now = 0;
    const sleeps: number[] = [];
    let availabilityCalls = 0;
    const client = new CourtReserveReadClient(
      "organization",
      { username: "Org_example", password: "mock-secret" },
      "https://api.courtreserve.com",
      {
        fetch: async (input) => {
          const url = new URL(String(input));
          assert.equal(url.pathname, "/api/v1/reservation/availability");
          availabilityCalls += 1;
          if (availabilityCalls === 1) {
            return new Response("mock-secret", { status: 429, headers: { "retry-after": "2" } });
          }
          return new Response(JSON.stringify({ IsSuccessStatusCode: true, Data: {} }), { status: 200 });
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        now: () => now,
      },
    );
    await client.getAvailability({ date: "2026-11-07" });
    assert.deepEqual(sleeps, [2000]);

    const denied = new CourtReserveReadClient(
      "organization",
      { username: "Org_example", password: "mock-secret" },
      "https://api.courtreserve.com",
      {
        fetch: async () => new Response("see mock-secret", { status: 401, headers: { "www-authenticate": "Basic" } }),
        sleep: async () => {
          throw new Error("401 must not be retried");
        },
        now: () => 0,
      },
      { maxRetries: 2 },
    );
    await assert.rejects(() => denied.getAvailability({ date: "2026-11-07" }), (error: unknown) => {
      assert.equal(error instanceof ApiStatusError && error.status, 401);
      assert.equal(String(error).includes("mock-secret"), false);
      return true;
    });
  });
});

describe("[live-unauthenticated] documented availability route", () => {
  it("GET /api/v1/reservation/availability without a real key returns 401", async () => {
    const client = new CourtReserveReadClient(
      "organization",
      { username: "sdk-live-unauthenticated", password: "sdk-live-unauthenticated" },
      "https://api.courtreserve.com",
      {
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }),
      },
    );
    await assert.rejects(() => client.getAvailability({ date: "2026-11-07" }), (error: unknown) => {
      assert.equal(error instanceof ApiStatusError, true);
      if (error instanceof ApiStatusError) assert.equal(error.status, 401);
      assert.equal(String(error).includes("sdk-live-unauthenticated"), false);
      return true;
    });
  });
});

describe("[live-authenticated] not performed", () => {
  it("does not log in with a member password or claim joined-club discovery", () => {
    const auth = describeSupportedAuth();
    assert.equal(auth.authenticatedMemberTesting, "not-performed");
    assert.equal(auth.memberLogin.supported, false);
    assert.equal(auth.memberLogin.route, null);
    assert.equal(auth.acceptedSecretNames.memberPortalPassword, null);
    assert.throws(loginAsMember);
  });
});

describe("[fixture] built CLI", () => {
  it("prints fixture evidence and an exact Court B hit", () => {
    const run = spawnSync(
      process.execPath,
      [
        "dist/cli.js",
        "search",
        "--membership",
        "fixtures/membership.json",
        "--schedule",
        "fixtures/north-evening.json",
        "--club",
        "fixture-north",
        "--date",
        "2026-06-15",
        "--start",
        "18:00",
        "--duration",
        "90",
        "--type",
        "member-hit",
        "--now",
        "2026-06-15T17:00:00.000-07:00",
        "--allow-court-switch",
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Evidence: fixture/);
    assert.match(run.stdout, /Membership discovery: none/);
    assert.match(run.stdout, /Fixture membership is not a CourtReserve member's joined clubs/);
    assert.match(run.stdout, /Court B/);
    assert.match(run.stdout, /30\+60:/);
    assert.match(run.stdout, /Price: not quoted/);
    assert.equal(run.stdout.includes("member session"), false);
  });
});
