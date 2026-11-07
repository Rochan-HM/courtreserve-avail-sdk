import { QueryValidationError } from "../errors.js";
import { ticksToClock, type DayHours } from "./hours.js";

const PORTAL_ORIGIN = "https://app.courtreserve.com";

export interface MemberOrganization {
  id: string;
  name: string;
  primary: boolean;
  viewing: boolean;
  city: string | null;
  hours: DayHours[];
}

export interface MemberLocation {
  id: string;
  name: string;
  bookingUrl: string;
}

export interface SchedulerCourt {
  id: string;
  label: string;
}

export interface SchedulerPage {
  costTypeId: string;
  customSchedulerId: string;
  slotMinutes: number;
  timeZone: string;
  memberIds: string;
  selectedCourtIds: string[];
  courts: SchedulerCourt[];
}

export interface PortalNavigation {
  requestData: string;
  jwtToken: string | null;
  orgName: string;
  locations: MemberLocation[];
}

export function absolutePortalUrl(path: string): string {
  if (path.startsWith("https://") || path.startsWith("http://")) return path;
  if (!path.startsWith("/")) return `${PORTAL_ORIGIN}/${path}`;
  return `${PORTAL_ORIGIN}${path}`;
}

export function parseOrganizations(payload: unknown): MemberOrganization[] {
  const data = record(payload).Data;
  if (!Array.isArray(data)) throw new QueryValidationError("Organization list did not include a Data array.");
  return data.map((item) => {
    const row = record(item);
    const id = String(row.Id ?? "");
    const name = String(row.Name ?? "").trim();
    if (!id || !name) throw new QueryValidationError("An organization was missing an id or name.");
    const hours = Array.isArray(row.HoursOfOperation) ? row.HoursOfOperation.map(parseHours) : [];
    const city = typeof row.City === "string" && row.City.trim() ? row.City.trim() : null;
    return {
      id,
      name,
      primary: row.IsPrimary === true,
      viewing: row.IsViewingNow === true,
      city,
      hours,
    };
  });
}

export function parseNavigation(payload: unknown, orgId: string): PortalNavigation {
  const data = record(record(payload).data ?? record(payload).Data);
  const requestData = typeof data.RequestData === "string" ? data.RequestData : "";
  if (!requestData) throw new QueryValidationError("Portal navigation did not include session request data.");
  const locations: MemberLocation[] = [];
  walk(data.Navigation, (node) => {
    const key = typeof node.Key === "string" ? node.Key : "";
    const url = typeof node.Url === "string" ? node.Url : "";
    if (!key.startsWith("scheduler_") || !url) return;
    locations.push({
      id: key.slice("scheduler_".length) || "default",
      name: String(node.Label ?? "").trim() || "Book a Court",
      bookingUrl: absolutePortalUrl(url),
    });
  });
  if (locations.length === 0) {
    locations.push({
      id: "default",
      name: String(data.OrgName ?? "Courts"),
      bookingUrl: `${PORTAL_ORIGIN}/Online/Reservations/Index/${orgId}`,
    });
  }
  return {
    requestData,
    jwtToken: typeof data.JwtToken === "string" ? data.JwtToken : null,
    orgName: String(data.OrgName ?? ""),
    locations,
  };
}

export function parseSchedulerPage(html: string): SchedulerPage {
  const costTypeId = first(html, /CostTypeId:\s*'(\d+)'/);
  const customSchedulerId = first(html, /CustomSchedulerId:\s*'([^']*)'/) ?? "";
  const slotMinutes = Number(first(html, /ReservationMinInterval:\s*'(\d+)'/));
  const selectedCourtIds = (first(html, /SelectedCourtIds:\s*'([^']*)'/) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const timeZone = first(html, /(?:browserTimeZone|timeZone|TimeZone):\s*'([A-Za-z0-9_+\-/]+)'/) ?? "America/Los_Angeles";
  const memberIds = first(html, /MemberIds:\s*'([^']*)'/) ?? "";
  if (!costTypeId || !Number.isInteger(slotMinutes) || slotMinutes <= 0 || selectedCourtIds.length === 0) {
    throw new QueryValidationError("The booking page did not include scheduler id, slot length, and courts.");
  }
  const courts: SchedulerCourt[] = [];
  const seen = new Set<string>();
  const pattern = /data-courtid=(\d+)[\s\S]{0,700}?"Value":"([^"]+)"/g;
  for (const match of html.matchAll(pattern)) {
    const id = match[1] ?? "";
    const label = decodeHtml(match[2] ?? "").trim();
    if (!id || !label || seen.has(id) || !/court/i.test(label)) continue;
    seen.add(id);
    courts.push({ id, label });
  }
  if (courts.length === 0) {
    throw new QueryValidationError("The booking page listed court ids but no court names.");
  }
  return { costTypeId, customSchedulerId, slotMinutes, timeZone, memberIds, selectedCourtIds, courts };
}

export interface MemberBooking {
  id: string;
  organizationId: string;
  organizationName: string;
  typeName: string;
  courts: string;
  when: string;
  startUtc: string | null;
  timeZone: string | null;
  upcoming: boolean;
  canceled: boolean;
  bookingsUrl: string;
}

export function parseBookings(payload: unknown): MemberBooking[] {
  const data = record(payload).Data;
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? findBookingRows(data) : [];
  return rows.map((item) => {
    const row = record(item);
    const organizationId = String(row.OrganizationId ?? "");
    return {
      id: String(row.ReservationId ?? ""),
      organizationId,
      organizationName: String(row.OrganizationName ?? ""),
      typeName: String(row.TypeName ?? row.EventName ?? "Booking"),
      courts: String(row.CourtsDisplay ?? ""),
      when: String(row.DisplayDateAndTimes ?? row.TimeRangeDisplay ?? ""),
      startUtc: typeof row.ReservationStartDateTime === "string" ? row.ReservationStartDateTime : null,
      timeZone: typeof row.TimeZone === "string" ? row.TimeZone : null,
      upcoming: row.IsUpcoming === true,
      canceled: row.IsCanceled === true,
      bookingsUrl: organizationId
        ? `${PORTAL_ORIGIN}/Online/Bookings/List/${organizationId}`
        : `${PORTAL_ORIGIN}/Online/Bookings/List`,
    };
  });
}

function findBookingRows(data: object): unknown[] {
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function parseHours(value: unknown): DayHours {
  const row = record(value);
  return {
    dayName: String(row.DayName ?? ""),
    openLocal: ticksToClock(Number(row.OpenTime)),
    closeLocal: ticksToClock(Number(row.CloseTime)),
    closed: row.IsClosed === true,
  };
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const node = item as Record<string, unknown>;
    visit(node);
    walk(node.Children, visit);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QueryValidationError("CourtReserve returned a response this SDK could not read.");
  }
  return value as Record<string, unknown>;
}

function first(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern);
  return match?.[1] ?? null;
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("\\u003c", "<")
    .replaceAll("\\u003e", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'");
}
