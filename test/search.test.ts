import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { intervalsForCourtDay } from "../src/intervals.js";
import { parseFixtureSchedule } from "../src/fixtures.js";
import { searchSnapshot } from "../src/search.js";
import type { SearchRequest } from "../src/types.js";
import { court, memberHit, observedAt, snapshot } from "./helpers.js";

const now = observedAt;

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    date: "2026-06-15",
    startLocal: "18:00",
    durationMinutes: 90,
    reservationTypeId: "member-hit",
    nowUtc: now,
    ...overrides,
  };
}

describe("availability search", () => {
  it("treats a 90-minute window that spans a reserved 30-minute cell as a conflict", () => {
    const result = searchSnapshot(
      snapshot([
        court({
          courtId: "court-a",
          courtLabel: "Court A",
          openLocal: "08:00",
          closeLocal: "21:00",
          reservations: [{ start: "18:30", end: "19:00" }],
        }),
      ]),
      request(),
    );
    assert.equal(result.hits.length, 0);
    assert.equal(result.rejections[0]?.reason, "reserved-conflict");
    assert.equal(result.price, null);
  });

  it("allows a window that only touches a reservation at a boundary", () => {
    const schedule = snapshot([
      court({
        courtId: "court-a",
        courtLabel: "Court A",
        openLocal: "08:00",
        closeLocal: "21:00",
        reservations: [{ start: "10:00", end: "11:00" }],
      }),
    ]);
    const adjacent = searchSnapshot(schedule, request({ startLocal: "11:00", durationMinutes: 90 }));
    assert.equal(adjacent.hits[0]?.kind, "exact");
    const overlap = searchSnapshot(schedule, request({ startLocal: "10:00", durationMinutes: 90 }));
    assert.equal(overlap.hits.length, 0);
    assert.equal(overlap.rejections[0]?.reason, "reserved-conflict");
    const oneMinute = searchSnapshot(schedule, request({ startLocal: "10:59", durationMinutes: 30 }));
    assert.equal(oneMinute.hits.length, 0);
  });

  it("keeps an unknown gap from counting as free, including a court missing from the payload", () => {
    const open = court({
      courtId: "court-a",
      courtLabel: "Court A",
      openLocal: "08:00",
      closeLocal: "21:00",
    });
    open.coverage = "partial";
    open.intervals.splice(1, 0, {
      startUtc: "2026-06-16T01:15:00.000Z",
      endUtc: "2026-06-16T01:45:00.000Z",
      status: "unknown",
    });
    const result = searchSnapshot(
      snapshot([
        open,
        { courtId: "court-offscreen", courtLabel: "Court Offscreen", coverage: "missing", intervals: [] },
      ]),
      request(),
    );
    assert.equal(result.hits.length, 0);
    assert.deepEqual(
      result.rejections.map((rejection) => rejection.reason).sort(),
      ["missing-from-payload", "unknown-coverage"],
    );
  });

  it("accepts a known open window when an unknown interval is elsewhere the same day", () => {
    const partial = court({
      courtId: "court-a",
      courtLabel: "Court A",
      openLocal: "08:00",
      closeLocal: "21:00",
    });
    partial.coverage = "partial";
    partial.intervals.unshift({
      startUtc: "2026-06-15T15:00:00.000Z",
      endUtc: "2026-06-15T16:00:00.000Z",
      status: "unknown",
    });
    const result = searchSnapshot(snapshot([partial]), request());
    assert.equal(result.hits[0]?.kind, "exact");
  });

  it("crosses the spring-forward gap using elapsed time and rejects a start in the missing hour", () => {
    const schedule = snapshot(
      [
        intervalsForCourtDay({
          courtId: "court-a",
          courtLabel: "Court A",
          date: "2026-03-08",
          timeZone: "America/Los_Angeles",
          openLocal: "00:00",
          closeLocal: "06:00",
          reservations: [],
        }),
      ],
      memberHit,
      { observedAt: "2026-03-08T00:30:00.000-08:00" },
    );
    const crossed = searchSnapshot(
      schedule,
      request({
        date: "2026-03-08",
        startLocal: "01:00",
        nowUtc: "2026-03-08T00:30:00.000-08:00",
      }),
    );
    assert.equal(crossed.hits.length, 1);
    assert.equal(crossed.hits[0]?.kind, "exact");
    if (crossed.hits[0]?.kind !== "exact") return;
    assert.match(crossed.hits[0].endLocal, /T03:30:00/);
    assert.match(crossed.hits[0].endLocal, /-07:00$/);
    const missing = searchSnapshot(
      schedule,
      request({
        date: "2026-03-08",
        startLocal: "02:30",
        nowUtc: "2026-03-08T00:30:00.000-08:00",
      }),
    );
    assert.deepEqual(missing.blockers, ["nonexistent-local-time"]);
    assert.equal(missing.hits.length, 0);
  });

  it("distinguishes the two 1:30am instants after fall back", () => {
    const schedule = snapshot(
      [
        {
          courtId: "court-a",
          courtLabel: "Court A",
          coverage: "complete",
          intervals: [
            { startUtc: "2026-11-01T07:00:00.000Z", endUtc: "2026-11-01T08:15:00.000Z", status: "open" },
            { startUtc: "2026-11-01T08:15:00.000Z", endUtc: "2026-11-01T08:45:00.000Z", status: "reserved" },
            { startUtc: "2026-11-01T08:45:00.000Z", endUtc: "2026-11-01T12:00:00.000Z", status: "open" },
          ],
        },
      ],
      { ...memberHit, allowedDurationsMinutes: [30, 60, 90] },
      { observedAt: "2026-11-01T00:15:00.000-07:00" },
    );
    const base = {
      date: "2026-11-01",
      startLocal: "01:15",
      durationMinutes: 30,
      nowUtc: "2026-11-01T00:15:00.000-07:00",
    };
    const ambiguous = searchSnapshot(schedule, request(base));
    assert.deepEqual(ambiguous.blockers, ["ambiguous-local-time"]);
    const earlier = searchSnapshot(schedule, request({ ...base, disambiguation: "earlier" }));
    const later = searchSnapshot(schedule, request({ ...base, disambiguation: "later" }));
    assert.equal(earlier.hits.length, 0);
    assert.equal(earlier.rejections[0]?.reason, "reserved-conflict");
    assert.equal(later.hits[0]?.kind, "exact");
  });

  it("offers 30+60 and 60+30 switches only when both segment durations are allowed", () => {
    const courts = [
      court({
        courtId: "left",
        courtLabel: "Left",
        openLocal: "18:00",
        closeLocal: "18:30",
      }),
      court({
        courtId: "right",
        courtLabel: "Right",
        openLocal: "18:30",
        closeLocal: "19:30",
      }),
    ];
    const allowed = searchSnapshot(
      snapshot(courts),
      request({ allowCourtSwitch: true }),
    );
    assert.equal(allowed.hits.some((hit) => hit.kind === "exact"), false);
    assert.equal(allowed.hits.some((hit) => hit.kind === "court-switch" && hit.pattern === "30+60"), true);
    assert.equal(allowed.hits.some((hit) => hit.kind === "court-switch" && hit.pattern === "60+30"), false);

    const full = court({ courtId: "full", courtLabel: "Full", openLocal: "17:00", closeLocal: "21:00" });
    const minimumSixty = searchSnapshot(
      snapshot([...courts, full], { ...memberHit, minimumDurationMinutes: 60 }),
      request({ allowCourtSwitch: true }),
    );
    assert.deepEqual(
      minimumSixty.hits.map((hit) => hit.kind),
      ["exact"],
    );

    const noThirty = searchSnapshot(
      snapshot([...courts, full], { ...memberHit, allowedDurationsMinutes: [60, 90] }),
      request({ allowCourtSwitch: true }),
    );
    assert.equal(noThirty.hits.some((hit) => hit.kind === "court-switch"), false);
    assert.equal(noThirty.hits[0]?.kind, "exact");
  });

  it("ranks a single-court exact window ahead of a longer paid rental and labels the extra time", () => {
    const schedule = snapshot([
      court({
        courtId: "court-a",
        courtLabel: "Court A",
        openLocal: "17:00",
        closeLocal: "21:00",
        reservations: [{ start: "19:30", end: "20:00" }],
      }),
    ]);
    const result = searchSnapshot(schedule, request({ allowOverlappingPaidRental: true }));
    assert.equal(result.hits[0]?.kind, "exact");
    if (result.hits[0]?.kind === "exact") assert.equal(result.hits[0].durationMinutes, 90);
    const paid = result.hits.find((hit) => hit.kind === "overlapping-paid-rental");
    assert.equal(paid?.kind, "overlapping-paid-rental");
    if (paid?.kind !== "overlapping-paid-rental") return;
    assert.equal(paid.paid.durationMinutes, 120);
    assert.equal(paid.extraPaidMinutes, 30);
    assert.equal(paid.extraPlacement, "before");
    assert.equal(paid.price, null);
    assert.equal(JSON.stringify(result).includes("19.99"), false);
  });

  it("withholds an exact 90 when the type minimum is 120 and reports the longer rental separately", () => {
    const result = searchSnapshot(
      snapshot(
        [court({ courtId: "court-a", courtLabel: "Court A", openLocal: "17:00", closeLocal: "21:00" })],
        { ...memberHit, minimumDurationMinutes: 120 },
      ),
      request({ allowOverlappingPaidRental: true }),
    );
    assert.equal(result.hits.some((hit) => hit.kind === "exact"), false);
    assert.equal(result.rejections[0]?.reason, "below-minimum-duration");
    const paid = result.hits.filter((hit) => hit.kind === "overlapping-paid-rental");
    assert.equal(paid.length > 0, true);
    assert.equal(paid.every((hit) => hit.kind === "overlapping-paid-rental" && hit.extraPaidMinutes === 30), true);
  });

  it("returns no booking match when duration constraints are unknown", () => {
    const result = searchSnapshot(
      snapshot(
        [court({ courtId: "court-a", courtLabel: "Court A", openLocal: "08:00", closeLocal: "21:00" })],
        { id: "member-hit", constraintsKnown: false },
      ),
      request(),
    );
    assert.deepEqual(result.blockers, ["constraints-unknown"]);
    assert.equal(result.hits.length, 0);
    assert.deepEqual(result.diagnostics.physicallyOpenCourtIds, ["court-a"]);
    assert.equal(result.usable, false);
  });

  it("blocks stale and unobserved snapshots", () => {
    const courts = [court({ courtId: "court-a", courtLabel: "Court A", openLocal: "08:00", closeLocal: "21:00" })];
    const stale = searchSnapshot(
      snapshot(courts, memberHit, { observedAt: "2026-06-15T12:00:00.000-07:00" }),
      request({ maxAgeMs: 120_000 }),
    );
    assert.equal(stale.stale, true);
    assert.equal(stale.hits.length, 0);
    const missing = searchSnapshot(snapshot(courts, memberHit, { observedAt: null }), request({ maxAgeMs: null }));
    assert.deepEqual(missing.blockers, ["missing-observed-at"]);
    assert.equal(missing.hits.length, 0);
  });

  it("matches the synthetic evening fixture without treating the offscreen court as free", () => {
    const schedule = parseFixtureSchedule(JSON.parse(readFileSync("fixtures/north-evening.json", "utf8")));
    const exact = searchSnapshot(schedule, request());
    assert.deepEqual(
      exact.hits.filter((hit) => hit.kind === "exact").map((hit) => hit.courtId),
      ["court-b"],
    );
    assert.equal(exact.rejections.find((rejection) => rejection.courtId === "court-a")?.reason, "reserved-conflict");
    assert.equal(exact.rejections.find((rejection) => rejection.courtId === "court-offscreen")?.reason, "missing-from-payload");

    const withSwitch = searchSnapshot(schedule, request({ allowCourtSwitch: true }));
    assert.equal(withSwitch.hits[0]?.kind, "exact");
    const pair = withSwitch.hits.find(
      (hit) =>
        hit.kind === "court-switch" &&
        hit.pattern === "30+60" &&
        hit.segments[0]?.courtId === "court-a" &&
        hit.segments[1]?.courtId === "court-b",
    );
    assert.ok(pair);
    assert.equal(
      withSwitch.hits.some(
        (hit) => hit.kind === "court-switch" && hit.pattern === "60+30" && hit.segments[0]?.courtId === "court-a",
      ),
      false,
    );
    assert.equal(
      withSwitch.hits.some((hit) => hit.kind === "court-switch" && hit.segments[0]?.courtId === hit.segments[1]?.courtId),
      false,
    );
  });
});
