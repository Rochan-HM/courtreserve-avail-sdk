import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QueryValidationError } from "../src/errors.js";
import { cookiesForSession, readMemberCredentials } from "../src/member/login.js";

describe("headless member login", () => {
  it("reads USERNAME and PASSWORD from .env and lets the environment override the file", () => {
    const fromFile = readMemberCredentials({}, "USERNAME=member@example.com\nPASSWORD=file-secret\n");
    assert.equal(fromFile.username, "member@example.com");
    assert.equal(fromFile.password, "file-secret");
    const fromEnv = readMemberCredentials(
      { USERNAME: "env@example.com", PASSWORD: "env-secret" },
      "USERNAME=member@example.com\nPASSWORD=file-secret\n",
    );
    assert.equal(fromEnv.username, "env@example.com");
    assert.equal(fromEnv.password, "env-secret");
  });

  it("refuses to start when either credential is missing", () => {
    assert.throws(() => readMemberCredentials({}, "USERNAME=member@example.com\n"), QueryValidationError);
  });

  it("keeps CourtReserve cookies and drops empty or unrelated ones", () => {
    const kept = cookiesForSession([
      { name: ".AspNet.ApplicationCookie", value: "session", domain: "app.courtreserve.com", path: "/" },
      { name: "PreferenceOrgId", value: "5889", domain: ".courtreserve.com", path: "/" },
      { name: "intercom-session", value: "", domain: ".courtreserve.com", path: "/" },
      { name: "other", value: "x", domain: "example.com", path: "/" },
    ]);
    assert.deepEqual(kept.map((cookie) => cookie.name), [".AspNet.ApplicationCookie", "PreferenceOrgId"]);
  });
});
