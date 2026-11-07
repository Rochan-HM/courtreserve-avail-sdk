import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QueryValidationError } from "../src/errors.js";
import { openRanges, ticksToClock } from "../src/member/hours.js";
import { parseNavigation, parseSchedulerPage } from "../src/member/parse.js";
import { selectOrganization } from "../src/member/portal.js";

describe("member portal reads", () => {
  it("converts operating-hour ticks and keeps a 60-minute gap free when a reservation only touches its edge", () => {
    assert.equal(ticksToClock(288000000000), "08:00");
    assert.equal(ticksToClock(828000000000), "23:00");
    assert.equal(ticksToClock(863990000000), "24:00");
    const ranges = openRanges({
      date: "2026-11-07",
      timeZone: "America/Los_Angeles",
      openLocal: "18:00",
      closeLocal: "21:00",
      slotMinutes: 60,
      busy: [{ startUtc: "2026-11-08T03:00:00.000Z", endUtc: "2026-11-08T04:00:00.000Z" }],
    });
    assert.deepEqual(
      ranges.map((range) => `${range.startLocal}-${range.endLocal}`),
      ["18:00-19:00", "20:00-21:00"],
    );
  });

  it("blocks a slot that overlaps a reservation by one minute and does not treat a missing event as closed", () => {
    const blocked = openRanges({
      date: "2026-11-07",
      timeZone: "America/Los_Angeles",
      openLocal: "18:00",
      closeLocal: "20:00",
      slotMinutes: 60,
      busy: [{ startUtc: "2026-11-08T03:00:00.000Z", endUtc: "2026-11-08T03:01:00.000Z" }],
    });
    assert.deepEqual(
      blocked.map((range) => range.startLocal),
      ["18:00"],
    );
    const emptyCourt = openRanges({
      date: "2026-11-07",
      timeZone: "America/Los_Angeles",
      openLocal: "18:00",
      closeLocal: "20:00",
      slotMinutes: 60,
      busy: [],
    });
    assert.equal(emptyCourt[0]?.durationMinutes, 120);
  });

  it("steps elapsed minutes across the spring-forward gap", () => {
    const ranges = openRanges({
      date: "2026-03-08",
      timeZone: "America/Los_Angeles",
      openLocal: "01:00",
      closeLocal: "04:00",
      slotMinutes: 60,
      busy: [],
    });
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.startLocal, "01:00");
    assert.equal(ranges[0]?.endLocal, "04:00");
    assert.equal(ranges[0]?.durationMinutes, 120);
  });

  it("reads scheduler courts from the booking page and ignores an id that has no name", () => {
    const html = `
      CostTypeId: '78593',
      CustomSchedulerId: '340',
      ReservationMinInterval: '60',
      SelectedCourtIds: '340,9250',
      MemberIds: '1',
      timeZone: 'America/Los_Angeles',
      {"Text":"\\u003cspan data-courtid=9250 class=header-title-name\\u003e\\u003cspan class=bold-org-color\\u003eCourt #1 MENLO PARK\\u003c/span\\u003e","Value":"Court #1 MENLO PARK"}
    `;
    const page = parseSchedulerPage(html);
    assert.equal(page.slotMinutes, 60);
    assert.deepEqual(page.courts, [{ id: "9250", label: "Court #1 MENLO PARK" }]);
    assert.equal(page.selectedCourtIds.includes("340"), true);
  });

  it("lists bookable locations from portal navigation and keeps the browser booking url", () => {
    const navigation = parseNavigation(
      {
        data: {
          RequestData: "request-data",
          OrgName: "Synergy Badminton Academy",
          Navigation: [
            {
              Key: "reservations",
              Label: "Book a Court",
              Url: null,
              Children: [
                { Key: "scheduler_340", Label: "Menlo Park", Url: "/Online/Reservations/Bookings/5889?sId=340", Children: [] },
                { Key: "reservations_myreservations", Label: "My Reservations", Url: "/Online/Bookings/List/5889?type=1", Children: [] },
              ],
            },
          ],
        },
      },
      "5889",
    );
    assert.equal(navigation.locations.length, 1);
    assert.equal(navigation.locations[0]?.bookingUrl, "https://app.courtreserve.com/Online/Reservations/Bookings/5889?sId=340");
    assert.throws(
      () => selectOrganization([{ id: "1", name: "SK Badminton", primary: false, viewing: false, city: null, hours: [] }, { id: "2", name: "Synergy Badminton Academy", primary: false, viewing: false, city: null, hours: [] }], "badminton"),
      QueryValidationError,
    );
  });
});
