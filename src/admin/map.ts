import { MapError } from "../errors.js";
import { combineCourtDays, intervalsForCourtDay, missingCourt } from "../intervals.js";
import type { CourtSchedule, ReservationTypePolicy, ScheduleSnapshot } from "../types.js";

export interface CatalogCourt {
  id: string;
  label: string;
  typeId?: string;
  typeName?: string;
}

export function mapOrganizationAvailability(
  payload: unknown,
  options: {
    observedAt: string | null;
    courts?: CatalogCourt[];
    reservationTypes?: ReservationTypePolicy[];
  },
): ScheduleSnapshot {
  const data = unwrapOrganization(payload);
  return mapAvailabilityDocument(data, {
    ...options,
    source: "organization-api",
    sourceNote:
      "Mapped from the Organization API availability schema. clubId is null because this route does not identify a member's clubs. Pricing is not part of this contract.",
  });
}

export function mapCourtsAppAvailability(
  payload: unknown,
  options: {
    observedAt: string | null;
    courts?: CatalogCourt[];
    reservationTypes?: ReservationTypePolicy[];
  },
): ScheduleSnapshot {
  return mapAvailabilityDocument(payload, {
    ...options,
    source: "courtsapp-integrations-api",
    sourceNote:
      "Mapped from the Integrations CourtsApp availability schema. Not a member session. Court-day Cost and FeeType are not copied, because they are not a quote for the searched window.",
  });
}

export function mapOrganizationCourts(payload: unknown): CatalogCourt[] {
  const data = unwrapOrganization(payload);
  const rows = asArray(data);
  if (!rows) throw new MapError("Court list Data was not an array.");
  return rows.map((row) => mapCatalogRow(row));
}

export function mapCourtsAppCourts(payload: unknown): CatalogCourt[] {
  const rows = asArray(payload);
  if (!rows) throw new MapError("CourtsApp court list was not an array.");
  return rows.map((row) =>
    mapCatalogRow(row, ["CourtId", "Id"], ["CourtLabel", "Label"], ["CourtTypeId", "TypeId"], ["CourtTypeName", "TypeName"]),
  );
}

export function mapOrganizationReservationTypes(payload: unknown): ReservationTypePolicy[] {
  const data = unwrapOrganization(payload);
  const rows = asArray(data);
  if (!rows) throw new MapError("Reservation type Data was not an array.");
  return rows.map((row) => {
    const id = asId(read(row, "Id"));
    if (!id) throw new MapError("Reservation type is missing Id.");
    const name = asString(read(row, "Name"));
    return {
      id,
      ...(name ? { name } : {}),
      constraintsKnown: false,
    };
  });
}

export function mapCourtsAppReservationTypes(payload: unknown): ReservationTypePolicy[] {
  const rows = asArray(payload);
  if (!rows) throw new MapError("CourtsApp reservation types were not an array.");
  return rows.map((row) => {
    const id = asId(read(row, "Id"));
    if (!id) throw new MapError("CourtsApp reservation type is missing Id.");
    const name = asString(read(row, "Name"));
    return {
      id,
      ...(name ? { name } : {}),
      constraintsKnown: false,
      uninterpreted: {
        minTime: asOptionalInt(read(row, "MinTime")),
        maxTime: asOptionalInt(read(row, "MaxTime")),
        defaultMinutes: asOptionalInt(read(row, "DefaultMinutes")),
        incrementMinutes: asOptionalInt(read(row, "IncrementMinutes")),
      },
    };
  });
}

function mapAvailabilityDocument(
  data: unknown,
  options: {
    observedAt: string | null;
    courts?: CatalogCourt[];
    reservationTypes?: ReservationTypePolicy[];
    source: ScheduleSnapshot["source"];
    sourceNote: string;
  },
): ScheduleSnapshot {
  const timeZone = asString(read(data, "TimeZone"));
  const days = asArray(read(data, "Days"));
  if (!timeZone) throw new MapError("Availability response has no IANA TimeZone. Refusing to guess one.");
  if (!days) throw new MapError("Availability response has no Days array.");

  const byCourt = new Map<string, CourtSchedule[]>();
  for (const day of days) {
    const date = normalizeDate(asString(read(day, "Date")));
    const dayZone: string = asString(read(day, "TimeZone")) ?? timeZone;
    if (!date) throw new MapError("Availability day is missing Date.");
    if (dayZone !== timeZone) {
      throw new MapError("Availability day TimeZone does not match the response TimeZone.");
    }
    const courts = asArray(read(day, "Courts")) ?? [];
    for (const court of courts) {
      const courtId = asId(read(court, "CourtId"));
      const courtLabel = asString(read(court, "CourtLabel")) ?? courtId;
      if (!courtId || !courtLabel) throw new MapError("Availability court is missing CourtId.");
      const reservations = read(court, "Reservations");
      const parsedReservations = reservations === undefined || reservations === null ? null : asReservationList(reservations);
      const typeId = asId(read(court, "CourtTypeId"));
      const typeName = asString(read(court, "CourtTypeName"));
      const schedule = intervalsForCourtDay({
        courtId,
        courtLabel,
        ...(typeId ? { courtTypeId: typeId } : {}),
        ...(typeName ? { courtTypeName: typeName } : {}),
        date,
        timeZone,
        openLocal: asString(read(court, "OpenTime")),
        closeLocal: asString(read(court, "CloseTime")),
        reservations: parsedReservations,
      });
      const list = byCourt.get(courtId) ?? [];
      list.push(schedule);
      byCourt.set(courtId, list);
    }
  }

  const courts: CourtSchedule[] = [];
  const seen = new Set<string>();
  for (const [courtId, parts] of byCourt) {
    seen.add(courtId);
    courts.push(parts.length === 1 ? parts[0]! : combineCourtDays(parts));
  }
  if (options.courts) {
    for (const court of options.courts) {
      if (seen.has(court.id)) continue;
      courts.push(
        missingCourt({
          courtId: court.id,
          courtLabel: court.label,
          ...(court.typeId ? { courtTypeId: court.typeId } : {}),
          ...(court.typeName ? { courtTypeName: court.typeName } : {}),
        }),
      );
    }
  }

  return {
    clubId: null,
    timeZone,
    observedAt: options.observedAt,
    courtDirectory: options.courts ? "confirmed" : "unconfirmed",
    courts,
    reservationTypes: options.reservationTypes ?? [],
    priceQuote: null,
    source: options.source,
    sourceNote: options.sourceNote,
  };
}

function mapCatalogRow(
  row: unknown,
  idKeys = ["Id", "CourtId"],
  labelKeys = ["Label", "CourtLabel"],
  typeIdKeys = ["TypeId", "CourtTypeId"],
  typeNameKeys = ["TypeName", "CourtTypeName"],
): CatalogCourt {
  const id = firstString(row, idKeys);
  const label = firstString(row, labelKeys) ?? id;
  if (!id || !label) throw new MapError("Court catalog row is missing an id.");
  const typeId = firstString(row, typeIdKeys);
  const typeName = firstString(row, typeNameKeys);
  return {
    id,
    label,
    ...(typeId ? { typeId } : {}),
    ...(typeName ? { typeName } : {}),
  };
}

function unwrapOrganization(payload: unknown): unknown {
  if (!isRecord(payload)) throw new MapError("Organization response was not an object.");
  if (read(payload, "IsSuccessStatusCode") !== true) {
    const message = asString(read(payload, "ErrorMessage")) ?? "Organization response was not successful.";
    throw new MapError(message.slice(0, 300));
  }
  const data = read(payload, "Data");
  if (data === undefined || data === null) throw new MapError("Organization response did not include Data.");
  return data;
}

function asReservationList(value: unknown): Array<{ start: string; end: string }> | null {
  const rows = asArray(value);
  if (!rows) return null;
  const parsed: Array<{ start: string; end: string }> = [];
  for (const row of rows) {
    const start = asString(read(row, "StartTime"));
    const end = asString(read(row, "EndTime"));
    if (!start || !end) return null;
    parsed.push({ start, end });
  }
  return parsed;
}

function firstString(row: unknown, keys: string[]): string | null {
  for (const key of keys) {
    const value = asId(read(row, key));
    if (value) return value;
  }
  return null;
}

function read(obj: unknown, pascal: string): unknown {
  if (!isRecord(obj)) return undefined;
  const camel = pascal[0]!.toLowerCase() + pascal.slice(1);
  if (Object.prototype.hasOwnProperty.call(obj, pascal)) return obj[pascal];
  if (Object.prototype.hasOwnProperty.call(obj, camel)) return obj[camel];
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return asString(value);
}

function asOptionalInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1]! : null;
}
