#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { describeSupportedAuth } from "./feasibility.js";
import { parseFixtureMembership, parseFixtureSchedule } from "./fixtures.js";
import { ClubNotJoinedError, LiveSearchBlockedError } from "./errors.js";
import { requestClubEnrollment } from "./enrollment.js";
import { fixtureScheduleSource } from "./scope.js";
import { searchJoinedClub } from "./search.js";
import type { SearchRequest, SearchResult } from "./types.js";

export async function main(argv: string[]): Promise<number> {
  if (argv.some((arg) => arg === "--password" || arg.startsWith("--password=") || arg === "--session" || arg.startsWith("--session="))) {
    console.error("This CLI has no member password or session flag. A 1Password item cannot be passed in.");
    return 2;
  }
  const [command, ...rest] = argv.slice(2);
  try {
    switch (command) {
      case "auth":
        console.log(JSON.stringify(describeSupportedAuth(), null, 2));
        return 0;
      case "enroll":
        return enroll(rest);
      case "clubs":
        return clubs(rest);
      case "search":
        return await search(rest);
      default:
        console.error("Commands: auth, clubs, search, enroll");
        return 2;
    }
  } catch (error) {
    if (error instanceof ClubNotJoinedError) {
      console.error(error.message);
      return 3;
    }
    if (error instanceof LiveSearchBlockedError) {
      console.error(error.message);
      return 4;
    }
    const message = error instanceof Error ? error.message : "Command failed.";
    console.error(message);
    return 1;
  }
}

function enroll(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { name: { type: "string" } },
    strict: true,
  });
  if (!values.name) {
    console.error("enroll requires --name.");
    return 2;
  }
  console.log(JSON.stringify(requestClubEnrollment({ clubName: values.name }), null, 2));
  return 0;
}

function clubs(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { membership: { type: "string" } },
    strict: true,
  });
  if (!values.membership) {
    console.error("clubs requires --membership pointing at a fixture file.");
    return 2;
  }
  const scope = parseFixtureMembership(readJson(values.membership));
  console.log(
    JSON.stringify(
      {
        origin: scope.origin,
        label: scope.label,
        clubs: scope.listJoinedClubs(),
        note: "Fixture membership. This list did not come from a CourtReserve member session.",
      },
      null,
      2,
    ),
  );
  return 0;
}

async function search(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      membership: { type: "string" },
      schedule: { type: "string" },
      club: { type: "string" },
      date: { type: "string" },
      start: { type: "string" },
      duration: { type: "string" },
      type: { type: "string" },
      now: { type: "string" },
      "max-age-ms": { type: "string" },
      disambiguation: { type: "string" },
      "allow-court-switch": { type: "boolean" },
      "allow-paid-overlap": { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: true,
  });
  if (!values.membership || !values.schedule || !values.club || !values.date || !values.start || !values.duration || !values.type) {
    console.error("search requires --membership, --schedule, --club, --date, --start, --duration, and --type.");
    return 2;
  }
  const durationMinutes = Number(values.duration);
  if (!Number.isInteger(durationMinutes)) {
    console.error("--duration must be a whole number of minutes.");
    return 2;
  }
  const disambiguation = values.disambiguation ?? "reject";
  if (disambiguation !== "reject" && disambiguation !== "earlier" && disambiguation !== "later") {
    console.error("--disambiguation must be reject, earlier, or later.");
    return 2;
  }
  const request: SearchRequest = {
    date: values.date,
    startLocal: values.start,
    durationMinutes,
    reservationTypeId: values.type,
    disambiguation,
    allowCourtSwitch: values["allow-court-switch"] === true,
    allowOverlappingPaidRental: values["allow-paid-overlap"] === true,
    ...(values.now ? { nowUtc: values.now } : {}),
    ...(values["max-age-ms"] ? { maxAgeMs: Number(values["max-age-ms"]) } : {}),
  };
  const scope = parseFixtureMembership(readJson(values.membership));
  const schedule = parseFixtureSchedule(readJson(values.schedule));
  const result = await searchJoinedClub({
    scope,
    clubId: values.club,
    source: fixtureScheduleSource([schedule]),
    request,
  });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatSearch(result));
  return 0;
}

export function formatSearch(result: SearchResult): string {
  const lines = [
    `Evidence: ${result.evidence}`,
    "Membership discovery: none",
    result.evidence === "fixture"
      ? "Fixture membership is not a CourtReserve member's joined clubs."
      : "Offline planner. This result did not discover joined clubs.",
    `Mode: ${result.mode}`,
    `Authority: ${result.authority}`,
    `Club: ${result.clubDisplayName ?? result.clubId ?? "unscoped"}`,
    `Usable: ${result.usable ? "yes" : "no"}`,
    `Observed: ${result.observedAt ?? "missing"}`,
    `Evaluated: ${result.evaluatedAt}`,
    "Price: not quoted",
  ];
  if (result.blockers.length > 0) lines.push(`Blockers: ${result.blockers.join(", ")}`);
  if (result.warnings.length > 0) lines.push(`Warnings: ${result.warnings.join(", ")}`);
  const exact = result.hits.filter((hit) => hit.kind === "exact");
  const switches = result.hits.filter((hit) => hit.kind === "court-switch");
  const paid = result.hits.filter((hit) => hit.kind === "overlapping-paid-rental");
  lines.push("", "Exact matches");
  if (exact.length === 0) lines.push("- none");
  for (const hit of exact) {
    if (hit.kind !== "exact") continue;
    lines.push(`- ${hit.courtLabel} ${hit.startLocal} to ${hit.endLocal} (${hit.durationMinutes} min)`);
  }
  lines.push("", "Court switches");
  if (switches.length === 0) lines.push("- none");
  for (const hit of switches) {
    if (hit.kind !== "court-switch") continue;
    const parts = hit.segments.map((segment) => `${segment.courtLabel} ${segment.durationMinutes} min`).join(" then ");
    lines.push(`- ${hit.pattern}: ${parts}`);
  }
  lines.push("", "Overlapping paid rentals");
  if (paid.length === 0) lines.push("- none");
  for (const hit of paid) {
    if (hit.kind !== "overlapping-paid-rental") continue;
    lines.push(
      `- ${hit.courtLabel} pays ${hit.paid.durationMinutes} min (${hit.extraPaidMinutes} extra ${hit.extraPlacement}) for a ${hit.requested.durationMinutes} min request`,
    );
  }
  if (result.rejections.length > 0) {
    lines.push("", "Rejections");
    for (const rejection of result.rejections) lines.push(`- ${rejection.courtLabel}: ${rejection.reason}`);
  }
  return lines.join("\n");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
