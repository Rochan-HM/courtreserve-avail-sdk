import { ApiStatusError, QueryValidationError, SessionExpiredError } from "../errors.js";
import { hoursForDate, openRanges, type OpenRange } from "./hours.js";
import {
  absolutePortalUrl,
  parseBookings,
  parseNavigation,
  parseOrganizations,
  parseSchedulerPage,
  type MemberBooking,
  type MemberLocation,
  type MemberOrganization,
  type SchedulerCourt,
} from "./parse.js";
import { cookieHeader, preferenceOrgId, type StoredCookie } from "./session.js";

const PORTAL = "https://app.courtreserve.com";
const BACKEND = "https://backend.courtreserve.com";

export interface OpenSlotCourt {
  courtId: string;
  courtLabel: string;
  ranges: OpenRange[];
}

export interface SlotSearch {
  organization: MemberOrganization;
  location: MemberLocation;
  date: string;
  timeZone: string;
  slotMinutes: number;
  hoursLabel: string;
  bookingUrl: string;
  reservationCount: number;
  courts: OpenSlotCourt[];
}

export async function listMemberOrganizations(cookies: readonly StoredCookie[]): Promise<MemberOrganization[]> {
  const orgId = preferenceOrgId(cookies);
  if (!orgId) throw new QueryValidationError("The session file has no PreferenceOrgId, so this SDK cannot choose a starting club.");
  const navigation = await loadNavigation(cookies, orgId);
  const payload = await getJson(
    cookies,
    `${BACKEND}/api/member-portal/my-organizations/get-list?orgId=${orgId}&RequestData=${encodeURIComponent(navigation.requestData)}`,
    navigation.jwtToken,
  );
  return parseOrganizations(payload);
}

export async function listMemberLocations(cookies: readonly StoredCookie[], orgId: string): Promise<MemberLocation[]> {
  return (await loadNavigation(cookies, orgId)).locations;
}

export async function bookingLink(
  cookies: readonly StoredCookie[],
  orgId: string,
  locationQuery: string,
): Promise<MemberLocation> {
  const locations = await listMemberLocations(cookies, orgId);
  return pickLocation(locations, locationQuery);
}

export async function searchOpenSlots(
  cookies: readonly StoredCookie[],
  orgId: string,
  locationQuery: string,
  date: string,
): Promise<SlotSearch> {
  const organizations = await listMemberOrganizations(cookies);
  const organization = organizations.find((item) => item.id === orgId);
  if (!organization) throw new QueryValidationError(`Organization ${orgId} is not in this member's club list.`);
  const location = await bookingLink(cookies, orgId, locationQuery);
  const navigation = await loadNavigation(cookies, orgId);
  const page = await getText(cookies, location.bookingUrl);
  const scheduler = parseSchedulerPage(page);
  const hours = hoursForDate(organization.hours, date, scheduler.timeZone);
  if (hours.closed) {
    return {
      organization,
      location,
      date,
      timeZone: scheduler.timeZone,
      slotMinutes: scheduler.slotMinutes,
      hoursLabel: "closed",
      bookingUrl: location.bookingUrl,
      reservationCount: 0,
      courts: scheduler.courts.map((court) => ({ courtId: court.id, courtLabel: court.label, ranges: [] })),
    };
  }
  const events = await loadSchedulerEvents(cookies, navigation, orgId, date, scheduler);
  const courts = scheduler.courts.map((court) => ({
    courtId: court.id,
    courtLabel: court.label,
    ranges: openRanges({
      date,
      timeZone: scheduler.timeZone,
      openLocal: hours.openLocal,
      closeLocal: hours.closeLocal,
      slotMinutes: scheduler.slotMinutes,
      busy: events
        .filter((event) => event.courtId === court.id || (event.label !== "" && event.label === court.label))
        .map((event) => ({ startUtc: event.startUtc, endUtc: event.endUtc })),
    }),
  }));
  return {
    organization,
    location,
    date,
    timeZone: scheduler.timeZone,
    slotMinutes: scheduler.slotMinutes,
    hoursLabel: `${hours.openLocal}–${hours.closeLocal}`,
    bookingUrl: location.bookingUrl,
    reservationCount: events.length,
    courts,
  };
}

export async function listMemberBookings(cookies: readonly StoredCookie[], orgId: string): Promise<MemberBooking[]> {
  const navigation = await loadNavigation(cookies, orgId);
  const params = new URLSearchParams({
    id: orgId,
    requestData: navigation.requestData,
    uiCulture: "en-US",
    OrganizationId: orgId,
    BookingTypesString: "1",
    DatesString: "365",
    SkipRows: "0",
    IsCancelledView: "false",
    FilterSelectedDates: "365",
  });
  const payload = await getJson(
    cookies,
    `${BACKEND}/api/my-bookings-portal/get-list?${params.toString()}`,
    navigation.jwtToken,
  );
  return parseBookings(payload).map((booking) => ({
    ...booking,
    bookingsUrl: absolutePortalUrl(`/Online/Bookings/List/${orgId}`),
  }));
}

export function selectOrganization(organizations: readonly MemberOrganization[], query: string): MemberOrganization {
  const needle = query.trim().toLowerCase();
  const matches = organizations.filter((org) => org.id === query || org.name.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0] as MemberOrganization;
  const names = organizations.map((org) => `${org.id} ${org.name}`).join("; ");
  if (matches.length === 0) throw new QueryValidationError(`No joined club matches ${JSON.stringify(query)}. Clubs: ${names}`);
  throw new QueryValidationError(`More than one club matches ${JSON.stringify(query)}. Clubs: ${names}`);
}

async function loadNavigation(cookies: readonly StoredCookie[], orgId: string) {
  const payload = await getJson(cookies, `${PORTAL}/Online/Portal/PortalNavigation/${orgId}`, null);
  return parseNavigation(payload, orgId);
}

async function loadSchedulerEvents(
  cookies: readonly StoredCookie[],
  navigation: { requestData: string; jwtToken: string | null },
  orgId: string,
  date: string,
  scheduler: ReturnType<typeof parseSchedulerPage>,
): Promise<Array<{ courtId: string; label: string; startUtc: string; endUtc: string }>> {
  const [year, month, day] = date.split("-").map(Number);
  const jsonData = {
    orgId: Number(orgId),
    selectedDate: date,
    kendoDate: { year, month, day },
    timeZone: scheduler.timeZone,
    browserTimeZone: scheduler.timeZone,
    uiCulture: "en-US",
    costTypeId: Number(scheduler.costTypeId),
    customSchedulerId: scheduler.customSchedulerId ? Number(scheduler.customSchedulerId) : null,
    selectedCourtIds: scheduler.selectedCourtIds.join(","),
    selectedInstructorIds: "",
    isAdmin: false,
    reservationMinInterval: scheduler.slotMinutes,
    memberIds: scheduler.memberIds,
    memberFamilyId: null,
    embedCodeId: null,
    hideReservationDetailsOnMemberPortalScheduler: true,
    openMatchesOnly: false,
    requestData: navigation.requestData,
    shortDto: true,
  };
  const payload = await getJson(
    cookies,
    `${BACKEND}/api/scheduler/member-expanded?id=${orgId}&jsonData=${encodeURIComponent(JSON.stringify(jsonData))}`,
    navigation.jwtToken,
  );
  const data = (payload as { Data?: unknown }).Data;
  if (!Array.isArray(data)) throw new QueryValidationError("Scheduler response did not include events.");
  return data.flatMap((item) => {
    const row = item as { CourtId?: number | string; CourtLabel?: string | null; Start?: string; End?: string };
    if (row.CourtId == null || !row.Start || !row.End) return [];
    return [{
      courtId: String(row.CourtId),
      label: typeof row.CourtLabel === "string" ? row.CourtLabel.trim() : "",
      startUtc: toUtc(row.Start),
      endUtc: toUtc(row.End),
    }];
  });
}

function toUtc(value: string): string {
  if (value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value)) return value;
  return `${value}Z`;
}

function pickLocation(locations: readonly MemberLocation[], query: string): MemberLocation {
  const needle = query.trim().toLowerCase();
  const matches = locations.filter((location) => location.id === query || location.name.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0] as MemberLocation;
  const names = locations.map((location) => location.name).join(", ");
  if (matches.length === 0) throw new QueryValidationError(`No location matches ${JSON.stringify(query)}. Locations: ${names}`);
  throw new QueryValidationError(`More than one location matches ${JSON.stringify(query)}. Locations: ${names}`);
}

async function getJson(cookies: readonly StoredCookie[], url: string, jwt: string | null): Promise<unknown> {
  const text = await getText(cookies, url, jwt);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SessionExpiredError();
  }
}

async function getText(cookies: readonly StoredCookie[], url: string, jwt?: string | null): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/html",
    Cookie: cookieHeader(cookies, url),
  };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new SessionExpiredError();
  if (!response.ok) throw new ApiStatusError(response.status, `CourtReserve returned ${response.status} for a member read.`);
  if (text.includes("Log In to Access Your Account")) throw new SessionExpiredError();
  return text;
}

export type { SchedulerCourt };
