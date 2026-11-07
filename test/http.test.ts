import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { CourtReserveReadClient, availabilityParams } from "../src/admin/http.js";
import { readOrganizationSnapshot } from "../src/admin/read.js";
import { ApiStatusError, QueryValidationError, RateLimitError } from "../src/errors.js";
import { organizationReadApi } from "../src/feasibility.js";

const credentials = { username: "Org_example", password: "s3cret-value" };

function client(handler: (url: URL, init: RequestInit) => Promise<Response> | Response, limits?: { maxRequests: number; windowMs: number }) {
  let now = 0;
  const sleeps: number[] = [];
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const api = new CourtReserveReadClient(
    "organization",
    credentials,
    "https://api.courtreserve.com",
    {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ url, init: init ?? {} });
        return handler(url, init ?? {});
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
    },
    { maxRequests: limits?.maxRequests ?? 60, windowMs: limits?.windowMs ?? 60_000, maxRetries: 2 },
  );
  return { api, calls, sleeps };
}

describe("organization read client", () => {
  it("sends GET Basic auth only to the documented availability path", async () => {
    const { api, calls } = client(() => new Response(JSON.stringify({ IsSuccessStatusCode: true, Data: [] }), { status: 200 }));
    await api.getAvailability({ date: "2026-11-07", courtTypeId: 4 });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url.origin, "https://api.courtreserve.com");
    assert.equal(call.url.pathname, organizationReadApi.availability.path);
    assert.equal(call.url.searchParams.get("date"), "2026-11-07");
    assert.equal(call.url.searchParams.get("courtTypeId"), "4");
    assert.equal(call.url.searchParams.has("organizationId"), false);
    assert.equal(call.init.method, "GET");
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("authorization"), `Basic ${Buffer.from("Org_example:s3cret-value").toString("base64")}`);
  });

  it("keeps a 32-day range and a mixed query off the network", () => {
    const { calls } = client(() => new Response("{}", { status: 200 }));
    assert.throws(() => availabilityParams({ fromDate: "2026-01-01", toDate: "2026-02-01" }), QueryValidationError);
    assert.throws(() => availabilityParams({ date: "2026-01-01", fromDate: "2026-01-02", toDate: "2026-01-03" }), QueryValidationError);
    assert.equal(inclusiveOk(), 31);
    assert.equal(calls.length, 0);
  });

  it("honors Retry-After on 429 and does not retry 401 or 400", async () => {
    let attempt = 0;
    const limited = client(() => {
      attempt += 1;
      if (attempt === 1) return new Response("slow", { status: 429, headers: { "retry-after": "2" } });
      return new Response("{}", { status: 200 });
    });
    await limited.api.getCourts();
    assert.deepEqual(limited.sleeps, [2000]);
    assert.equal(limited.calls.length, 2);

    const denied = client(() => new Response("token s3cret-value", { status: 401 }));
    await assert.rejects(() => denied.api.getCourts(), (error: unknown) => {
      assert.equal(error instanceof ApiStatusError, true);
      assert.equal(String(error).includes("s3cret-value"), false);
      return true;
    });
    assert.equal(denied.calls.length, 1);

    const invalid = client(() => new Response("bad", { status: 400 }));
    await assert.rejects(() => invalid.api.getAvailability({ date: "2026-01-01" }), ApiStatusError);
    assert.equal(invalid.calls.length, 1);
  });

  it("waits for the client-side per-key ceiling and stops when Retry-After is missing a parseable value only after retries", async () => {
    const paced = client(() => new Response("{}", { status: 200 }), { maxRequests: 1, windowMs: 1_000 });
    await paced.api.getCourts();
    await paced.api.getReservationTypes();
    assert.equal(paced.sleeps[0], 1000);

    let tries = 0;
    const exhausted = client(() => {
      tries += 1;
      return new Response("", { status: 429 });
    });
    await assert.rejects(() => exhausted.api.getCourts(), RateLimitError);
    assert.equal(tries, 3);
  });

  it("reads availability, courts, and types without a club id", async () => {
    const bodies = [
      payloadBody(),
      { IsSuccessStatusCode: true, Data: [{ Id: 1, Label: "Court 1" }, { Id: 2, Label: "Court 2" }] },
      { IsSuccessStatusCode: true, Data: [{ Id: 9, Name: "Member" }] },
    ];
    const { api, calls } = client(() => new Response(JSON.stringify(bodies.shift()), { status: 200 }));
    const snapshot = await readOrganizationSnapshot(api, { date: "2026-06-15" }, "2026-06-15T07:00:00.000-07:00");
    assert.deepEqual(
      calls.map((call) => call.url.pathname),
      [
        "/api/v1/reservation/availability",
        "/api/v1/reservation/courts",
        "/api/v1/reservation/reservationtypes",
      ],
    );
    assert.equal(calls.every((call) => call.url.searchParams.has("sId") === false), true);
    assert.equal(snapshot.clubId, null);
    assert.equal(snapshot.reservationTypes[0]?.constraintsKnown, false);
    assert.equal(snapshot.courts.some((court) => court.coverage === "missing"), true);
  });
});

describe("published contract snapshot", () => {
  it("contains the read routes exercised above and no member login route", () => {
    const contract = JSON.parse(readFileSync("contracts/courtreserve-read.snapshot.json", "utf8")) as {
      organization: { paths: Record<string, unknown> };
      integrations: { paths: Record<string, unknown> };
    };
    assert.ok(contract.organization.paths["/api/v1/reservation/availability"]);
    assert.ok(contract.integrations.paths["/api/v1/courtsapp/availability"]);
    const paths = [
      ...Object.keys(contract.organization.paths),
      ...Object.keys(contract.integrations.paths),
    ];
    assert.equal(paths.some((path) => /login|oauth|password/i.test(path)), false);
    assert.equal(paths.some((path) => path.includes("createcourtblock")), false);
  });
});

function inclusiveOk(): number {
  const params = availabilityParams({ fromDate: "2026-01-01", toDate: "2026-01-31" });
  assert.equal(params.get("fromDate"), "2026-01-01");
  return 31;
}

function payloadBody() {
  return {
    IsSuccessStatusCode: true,
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
              OpenTime: "08:00:00",
              CloseTime: "12:00:00",
              Reservations: [],
            },
          ],
        },
      ],
    },
  };
}
