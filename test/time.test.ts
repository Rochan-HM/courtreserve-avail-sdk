import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addMinutes, resolveLocalDateTime } from "../src/time.js";

describe("facility local time", () => {
  it("converts a summer evening in Los Angeles to the matching UTC instant", () => {
    const resolved = resolveLocalDateTime({
      date: "2026-07-15",
      time: "18:00",
      timeZone: "America/Los_Angeles",
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(new Date(resolved.utcMillis).toISOString(), "2026-07-16T01:00:00.000Z");
  });

  it("rejects the missing hour on the 2026 spring-forward day", () => {
    const resolved = resolveLocalDateTime({
      date: "2026-03-08",
      time: "02:30",
      timeZone: "America/Los_Angeles",
    });
    assert.deepEqual(resolved, { ok: false, reason: "nonexistent-local-time" });
  });

  it("adds 90 elapsed minutes across the spring-forward gap", () => {
    const start = resolveLocalDateTime({
      date: "2026-03-08",
      time: "01:00",
      timeZone: "America/Los_Angeles",
    });
    assert.equal(start.ok, true);
    if (!start.ok) return;
    assert.equal(new Date(start.utcMillis).toISOString(), "2026-03-08T09:00:00.000Z");
    assert.equal(new Date(addMinutes(start.utcMillis, 90)).toISOString(), "2026-03-08T10:30:00.000Z");
  });

  it("rejects the repeated hour on the 2026 fall-back day unless the caller picks a side", () => {
    const rejected = resolveLocalDateTime({
      date: "2026-11-01",
      time: "01:30",
      timeZone: "America/Los_Angeles",
    });
    assert.deepEqual(rejected, { ok: false, reason: "ambiguous-local-time" });

    const earlier = resolveLocalDateTime({
      date: "2026-11-01",
      time: "01:30",
      timeZone: "America/Los_Angeles",
      disambiguation: "earlier",
    });
    const later = resolveLocalDateTime({
      date: "2026-11-01",
      time: "01:30",
      timeZone: "America/Los_Angeles",
      disambiguation: "later",
    });
    assert.equal(earlier.ok && later.ok, true);
    if (!earlier.ok || !later.ok) return;
    assert.equal(new Date(earlier.utcMillis).toISOString(), "2026-11-01T08:30:00.000Z");
    assert.equal(new Date(later.utcMillis).toISOString(), "2026-11-01T09:30:00.000Z");
  });
});
