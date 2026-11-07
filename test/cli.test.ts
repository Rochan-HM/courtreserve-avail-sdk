import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { credentialsFromEnv, loginAsMember } from "../src/auth.js";
import { main } from "../src/cli.js";
import { CredentialsMissingError } from "../src/errors.js";
import { acceptedSecretNames, describeSupportedAuth } from "../src/feasibility.js";

describe("cli and auth report", () => {
  it("describes member login as unavailable and names only the organization API key variables", () => {
    const report = describeSupportedAuth();
    assert.equal(report.memberLogin.supported, false);
    assert.equal(report.memberLogin.host, null);
    assert.equal(report.memberLogin.route, null);
    assert.equal(report.authenticatedMemberTesting, "not-performed");
    assert.equal(acceptedSecretNames.memberPortalPassword, null);
    assert.equal(acceptedSecretNames.organizationApiUsername, "COURTRESERVE_API_USERNAME");
    assert.equal(report.liveReadRequires.unauthenticatedProbe.status, 401);
    assert.throws(() => credentialsFromEnv({}), CredentialsMissingError);
    assert.throws(() => loginAsMember(), (error: unknown) => String(error).includes("1Password") === false);
  });

  it("lists fixture clubs, searches them, and refuses an id outside that list", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      assert.equal(await main(["node", "cli", "clubs", "--membership", "fixtures/membership.json"]), 0);
      assert.match(logs[0] ?? "", /fixture-north/);
      assert.match(logs[0] ?? "", /Fixture membership/);
      logs.length = 0;
      assert.equal(
        await main([
          "node",
          "cli",
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
        ]),
        0,
      );
      assert.match(logs[0] ?? "", /Court B/);
      assert.match(logs[0] ?? "", /Price: not quoted/);
      assert.equal(
        await main([
          "node",
          "cli",
          "search",
          "--membership",
          "fixtures/membership.json",
          "--schedule",
          "fixtures/north-evening.json",
          "--club",
          "5889",
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
        ]),
        3,
      );
      assert.match(errors.join("\n"), /5889/);
      assert.equal(await main(["node", "cli", "enroll", "--name", "Fixture North"]), 0);
      assert.match(logs.at(-1) ?? "", /"autoJoin": false/);
      assert.equal(await main(["node", "cli", "search", "--password", "s3cret-value"]), 2);
      assert.equal(errors.join("\n").includes("s3cret-value"), false);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});
