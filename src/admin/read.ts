import type { AvailabilityQuery, CourtReserveReadClient } from "./http.js";
import {
  mapCourtsAppAvailability,
  mapCourtsAppCourts,
  mapCourtsAppReservationTypes,
  mapOrganizationAvailability,
  mapOrganizationCourts,
  mapOrganizationReservationTypes,
} from "./map.js";
import { QueryValidationError } from "../errors.js";
import type { ScheduleSnapshot } from "../types.js";

/**
 * Read the organization bound to an API key. The documented availability route has no club id
 * parameter, and the result is not a list of clubs a member joined.
 */
export async function readOrganizationSnapshot(
  client: CourtReserveReadClient,
  query: AvailabilityQuery,
  observedAt: string,
): Promise<ScheduleSnapshot> {
  if (client.api !== "organization") {
    throw new QueryValidationError("The organization reader refuses a CourtsApp client.");
  }
  const availability = await client.getAvailability(query);
  const courts = mapOrganizationCourts(await client.getCourts());
  const reservationTypes = mapOrganizationReservationTypes(await client.getReservationTypes());
  return mapOrganizationAvailability(availability, { observedAt, courts, reservationTypes });
}

/**
 * Read-only CourtsApp integration surface. Same Basic-auth host, not a member session.
 * MinTime and MaxTime are preserved as uninterpreted integers.
 */
export async function readCourtsAppSnapshot(
  client: CourtReserveReadClient,
  query: AvailabilityQuery,
  observedAt: string,
): Promise<ScheduleSnapshot> {
  if (client.api !== "courtsapp") {
    throw new QueryValidationError("The CourtsApp reader refuses an organization client.");
  }
  const availability = await client.getAvailability(query);
  const courts = mapCourtsAppCourts(await client.getCourts());
  const reservationTypes = mapCourtsAppReservationTypes(await client.getReservationTypes());
  return mapCourtsAppAvailability(availability, { observedAt, courts, reservationTypes });
}
