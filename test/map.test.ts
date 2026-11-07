import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MapError } from "../src/errors.js";
import {
  mapCourtsAppReservationTypes,
  mapOrganizationAvailability,
  mapOrganizationReservationTypes,
} from "../src/admin/map.js";
import { searchSnapshot } from "../src/search.js";

const observedAt = "2026-06-15T07:00:00.000-07:00";

function payload(extraCourtCost = false) {
  return {
    IsSuccessStatusCode: true,
    ErrorMessage: null,
    Data: {
      FromDate: "2026-06-15",
      ToDate: "2026-06-15",
      TimeZone: "America/Los_Angeles",
      Days: [
        {
          Date: "2026-06-15",
          TimeZone: "America/Los_Angeles",
          Courts: [
            {
              CourtId: 1,
              CourtLabel: "Court 1",
              CourtTypeId: 4,
              CourtTypeName: "Tennis",
              OpenTime: "08:00:00",
              CloseTime: "12:00:00",
              Reservations: [{ StartTime: "09:00:00", EndTime: "10:00:00" }],
              ...(extraCourtCost ? { Cost: 17.25, FeeType: "Hourly" } : {}),
            },
          ],
        },
      ],
    },
  };
}

describe("documented response mapping", () => {
  it("normalizes booked slots and leaves courts missing from the day unknown", () => {
    const snapshot = mapOrganizationAvailability(payload(true), {
      observedAt,
      courts: [
        { id: "1", label: "Court 1" },
        { id: "2", label: "Court 2" },
      ],
      reservationTypes: [{ id: "9", constraintsKnown: true, allowedDurationsMinutes: [90] }],
    });
    assert.equal(snapshot.clubId, null);
    assert.equal(snapshot.source, "organization-api");
    assert.equal(snapshot.priceQuote, null);
    assert.equal(JSON.stringify(snapshot).includes("17.25"), false);
    const court1 = snapshot.courts.find((court) => court.courtId === "1");
    assert.equal(court1?.coverage, "complete");
    assert.equal(court1?.intervals.some((interval) => interval.status === "reserved"), true);
    const court2 = snapshot.courts.find((court) => court.courtId === "2");
    assert.equal(court2?.coverage, "missing");

    const placed = {
      ...snapshot,
      clubId: "fixture-shaped",
      source: "fixture" as const,
      sourceNote: "mapper output copied into an offline fixture for the planner",
    };
    const open = searchSnapshot(placed, {
      date: "2026-06-15",
      startLocal: "10:30",
      durationMinutes: 90,
      reservationTypeId: "9",
      nowUtc: observedAt,
    });
    assert.equal(open.hits[0]?.kind, "exact");
    const conflict = searchSnapshot(placed, {
      date: "2026-06-15",
      startLocal: "09:30",
      durationMinutes: 60,
      reservationTypeId: "9",
      nowUtc: observedAt,
      maxAgeMs: null,
    });
    assert.equal(conflict.hits.filter((hit) => hit.kind === "exact").length, 0);
    assert.equal(conflict.rejections.find((rejection) => rejection.courtId === "1")?.reason, "reserved-conflict");
    assert.equal(conflict.rejections.find((rejection) => rejection.courtId === "2")?.reason, "missing-from-payload");
  });

  it("fails closed when the envelope is unsuccessful or a reservation list is absent", () => {
    assert.throws(
      () =>
        mapOrganizationAvailability(
          { IsSuccessStatusCode: false, ErrorMessage: "nope", Data: null },
          { observedAt },
        ),
      MapError,
    );
    const unknown = mapOrganizationAvailability(
      {
        isSuccessStatusCode: true,
        data: {
          timeZone: "America/Los_Angeles",
          days: [
            {
              date: "2026-06-15",
              timeZone: "America/Los_Angeles",
              courts: [{ courtId: 3, courtLabel: "Court 3", openTime: "08:00:00", closeTime: "12:00:00" }],
            },
          ],
        },
      },
      { observedAt },
    );
    assert.equal(unknown.courts[0]?.coverage, "partial");
    assert.equal(unknown.courts[0]?.intervals[0]?.status, "unknown");
    assert.equal(unknown.courtDirectory, "unconfirmed");
  });

  it("does not treat Organization or CourtsApp type fields as verified minute constraints", () => {
    const organization = mapOrganizationReservationTypes({
      IsSuccessStatusCode: true,
      Data: [{ Id: 9, Name: "Member", BackgroundColor: "#fff", TextColor: "#000", OrderIndex: 1, RevenueCategoryName: "Court" }],
    });
    assert.equal(organization[0]?.constraintsKnown, false);
    assert.equal("minimumDurationMinutes" in organization[0]!, false);

    const courtsApp = mapCourtsAppReservationTypes([
      { Id: 3, Name: "Singles", MinTime: 60, MaxTime: 120, DefaultMinutes: 90, IncrementMinutes: 30 },
    ]);
    assert.equal(courtsApp[0]?.constraintsKnown, false);
    assert.equal(courtsApp[0]?.uninterpreted?.minTime, 60);
    assert.equal(courtsApp[0]?.uninterpreted?.defaultMinutes, 90);
    assert.equal("allowedDurationsMinutes" in courtsApp[0]!, false);
  });
});
