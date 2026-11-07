import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClubNotJoinedError, LiveSearchBlockedError, MemberLoginUnsupportedError } from "../src/errors.js";
import { requestClubEnrollment } from "../src/enrollment.js";
import { loginAsMember } from "../src/auth.js";
import { searchJoinedClub } from "../src/search.js";
import { MembershipScope, fixtureScheduleSource } from "../src/scope.js";
import { court, observedAt, snapshot } from "./helpers.js";

describe("membership scope", () => {
  it("searches only clubs present in the fixture membership", async () => {
    let loads = 0;
    const schedule = snapshot([court({ courtId: "court-a", courtLabel: "Court A", openLocal: "08:00", closeLocal: "21:00" })]);
    const source = {
      transport: "fixture" as const,
      async load(clubId: string) {
        loads += 1;
        assert.equal(clubId, "fixture-north");
        return schedule;
      },
    };
    const scope = MembershipScope.fixture(
      [{ clubId: "fixture-north", displayName: "Fixture North", timeZone: "America/Los_Angeles" }],
      "synthetic fixture",
    );
    const result = await searchJoinedClub({
      scope,
      clubId: "fixture-north",
      source,
      request: {
        date: "2026-06-15",
        startLocal: "18:00",
        durationMinutes: 90,
        reservationTypeId: "member-hit",
        nowUtc: observedAt,
      },
    });
    assert.equal(loads, 1);
    assert.equal(result.mode, "scoped-membership");
    assert.equal(result.authority, "fixture");
    assert.equal(result.hits[0]?.kind, "exact");
    assert.equal(result.warnings.includes("fixture-membership"), true);
  });

  it("rejects an organization id that the membership source did not return, before loading a schedule", async () => {
    let loads = 0;
    const source = fixtureScheduleSource([
      snapshot([court({ courtId: "court-a", courtLabel: "Court A", openLocal: "08:00", closeLocal: "21:00" })]),
    ]);
    const wrapped = {
      transport: "fixture" as const,
      load: async (clubId: string) => {
        loads += 1;
        return source.load(clubId);
      },
    };
    const scope = MembershipScope.fixture([{ clubId: "fixture-north", displayName: "Fixture North" }], "synthetic fixture");
    await assert.rejects(
      () =>
        searchJoinedClub({
          scope,
          clubId: "5889",
          source: wrapped,
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

  it("refuses a live transport even for a club named in the fixture", async () => {
    let loads = 0;
    const scope = MembershipScope.fixture([{ clubId: "fixture-north", displayName: "Fixture North" }], "synthetic fixture");
    await assert.rejects(
      () =>
        searchJoinedClub({
          scope,
          clubId: "fixture-north",
          source: {
            transport: "organization-api" as unknown as "fixture",
            async load() {
              loads += 1;
              return snapshot([]);
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
  });

  it("has no constructor for a member session", () => {
    const password = "unique-pw-9f3a";
    assert.throws(() => loginAsMember({ username: "member@example.com", password }), MemberLoginUnsupportedError);
    try {
      loginAsMember({ password });
    } catch (error) {
      assert.equal(String(error).includes(password), false);
      assert.equal(error instanceof MemberLoginUnsupportedError && error.support.route, null);
    }
  });

  it("asks the owner to approve browser enrollment and does not join", () => {
    const request = requestClubEnrollment({ clubName: "Fixture North" });
    assert.equal(request.kind, "owner-approval-required");
    assert.equal(request.autoJoin, false);
    assert.equal(request.verifiedPublicPage, null);
    assert.equal(request.sdkPerforms.length, 0);
    assert.equal(request.willNot.includes("autojoin"), true);
    const numericName = requestClubEnrollment({ clubName: "5889" });
    assert.equal(numericName.verifiedPublicPage, null);
    assert.equal(JSON.stringify(numericName).includes("app.courtreserve.com"), false);
    assert.throws(() => requestClubEnrollment({ clubName: " " }), /Club name/);
  });
});
