#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { describeSupportedAuth } from "./feasibility.js";
import { parseFixtureMembership, parseFixtureSchedule } from "./fixtures.js";
import { ApiStatusError, ClubNotJoinedError, LiveSearchBlockedError, QueryValidationError, SessionExpiredError, SessionMissingError } from "./errors.js";
import { requestClubEnrollment } from "./enrollment.js";
import {
  bookingLink,
  listMemberBookings,
  listMemberLocations,
  listMemberOrganizations,
  searchOpenSlots,
  selectOrganization,
} from "./member/portal.js";
import { loadSessionFile, sessionPathFromEnv } from "./member/session.js";
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
      case "orgs":
        return await orgs();
      case "locations":
        return await locations(rest);
      case "slots":
        return await slots(rest);
      case "bookings":
        return await bookings(rest);
      case "book":
        return await book(rest);
      case "search":
        return await search(rest);
      default:
        console.error("Commands: auth, clubs, orgs, locations, slots, bookings, book, search, enroll");
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
    if (
      error instanceof SessionMissingError ||
      error instanceof SessionExpiredError ||
      error instanceof QueryValidationError ||
      error instanceof ApiStatusError
    ) {
      console.error(error.message);
      return 1;
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

async function orgs(): Promise<number> {
  const organizations = await listMemberOrganizations(loadSessionFile(sessionPathFromEnv(process.env)));
  for (const org of organizations) {
    const marks = [org.primary ? "primary" : "", org.viewing ? "viewing" : ""].filter(Boolean).join(", ");
    console.log(`${org.id}\t${org.name}${org.city ? ` (${org.city})` : ""}${marks ? ` [${marks}]` : ""}`);
  }
  return 0;
}

async function locations(args: string[]): Promise<number> {
  const org = await resolveOrg(args);
  const places = await listMemberLocations(loadSessionFile(sessionPathFromEnv(process.env)), org.id);
  console.log(`${org.name}`);
  for (const place of places) console.log(`${place.id}\t${place.name}\t${place.bookingUrl}`);
  return 0;
}

async function slots(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { org: { type: "string" }, club: { type: "string" }, location: { type: "string" }, date: { type: "string" } },
    strict: true,
  });
  if (!values.location || !values.date) {
    console.error("slots requires --location and --date, plus --org or --club.");
    return 2;
  }
  const org = await resolveOrg(args);
  const result = await searchOpenSlots(loadSessionFile(sessionPathFromEnv(process.env)), org.id, values.location, values.date);
  console.log(`${result.organization.name} / ${result.location.name}`);
  console.log(`Date: ${result.date} ${result.timeZone}`);
  console.log(`Hours: ${result.hoursLabel}`);
  console.log(`Slot length: ${result.slotMinutes} min`);
  console.log(`Reservations returned: ${result.reservationCount}`);
  console.log(`Book in browser: ${result.bookingUrl}`);
  console.log("This link opens the scheduler. It does not reserve a court.");
  for (const court of result.courts) {
    console.log("");
    console.log(court.courtLabel);
    if (court.ranges.length === 0) {
      console.log("- none");
      continue;
    }
    for (const range of court.ranges) console.log(`- ${range.startLocal}–${range.endLocal} (${range.durationMinutes} min)`);
  }
  return 0;
}

async function bookings(args: string[]): Promise<number> {
  const org = await resolveOrg(args);
  const rows = await listMemberBookings(loadSessionFile(sessionPathFromEnv(process.env)), org.id);
  const upcoming = rows.filter((row) => !row.canceled && bookingIsUpcoming(row));
  const past = rows.filter((row) => !row.canceled && !bookingIsUpcoming(row));
  console.log(`${org.name}`);
  console.log(`Open in browser: https://app.courtreserve.com/Online/Bookings/List/${org.id}`);
  printBookings("Upcoming", upcoming);
  printBookings("Past", past);
  return 0;
}

async function book(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { org: { type: "string" }, club: { type: "string" }, location: { type: "string" } },
    strict: true,
  });
  if (!values.location) {
    console.error("book requires --location, plus --org or --club.");
    return 2;
  }
  const org = await resolveOrg(args);
  const location = await bookingLink(loadSessionFile(sessionPathFromEnv(process.env)), org.id, values.location);
  console.log(`${org.name} / ${location.name}`);
  console.log(location.bookingUrl);
  console.log("Open this URL to book. This command does not reserve a court.");
  return 0;
}

async function resolveOrg(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      org: { type: "string" },
      club: { type: "string" },
      location: { type: "string" },
      date: { type: "string" },
    },
    strict: true,
  });
  const query = values.org ?? values.club;
  if (!query) throw new QueryValidationError("Pass --org or --club.");
  return selectOrganization(await listMemberOrganizations(loadSessionFile(sessionPathFromEnv(process.env))), query);
}

function bookingIsUpcoming(row: { upcoming: boolean; startUtc: string | null; timeZone: string | null }): boolean {
  if (!row.startUtc) return row.upcoming;
  const start = DateTime.fromISO(row.startUtc, { zone: row.timeZone || "America/Los_Angeles" });
  if (!start.isValid) return row.upcoming;
  return start.toUTC() > DateTime.utc();
}

function printBookings(title: string, rows: Array<{ when: string; typeName: string; courts: string; bookingsUrl: string }>): void {
  console.log("");
  console.log(title);
  if (rows.length === 0) {
    console.log("- none");
    return;
  }
  for (const row of rows) console.log(`- ${row.when} ${row.typeName} ${row.courts}`.trim());
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
