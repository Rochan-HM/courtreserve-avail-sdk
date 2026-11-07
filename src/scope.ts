import { ClubNotJoinedError, LiveSearchBlockedError } from "./errors.js";
import type { ScheduleSnapshot } from "./types.js";

export interface JoinedClub {
  clubId: string;
  displayName: string;
  timeZone?: string;
}

/**
 * A membership list this process is allowed to search.
 * The only constructor is an explicitly labeled fixture. Nothing in this package
 * can mint a member-session scope, because no documented member login exists.
 */
export class MembershipScope {
  readonly origin = "fixture" as const;

  private constructor(
    readonly clubs: readonly JoinedClub[],
    readonly label: string,
  ) {}

  static fixture(clubs: readonly JoinedClub[], label: string): MembershipScope {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("A fixture membership needs a label that says it is not a live account.");
    const seen = new Set<string>();
    for (const club of clubs) {
      if (!club.clubId.trim() || !club.displayName.trim()) {
        throw new Error("Each joined club needs a clubId and a displayName from the membership source.");
      }
      if (seen.has(club.clubId)) throw new Error(`Duplicate clubId ${club.clubId} in membership fixture.`);
      seen.add(club.clubId);
    }
    return new MembershipScope(clubs.map((club) => ({ ...club })), trimmed);
  }

  listJoinedClubs(): readonly JoinedClub[] {
    return this.clubs;
  }

  requireClub(clubId: string): JoinedClub {
    const club = this.clubs.find((item) => item.clubId === clubId);
    if (!club) throw new ClubNotJoinedError(clubId, this.clubs.map((item) => item.clubId));
    return club;
  }
}

export interface FixtureScheduleSource {
  readonly transport: "fixture";
  load(clubId: string): Promise<ScheduleSnapshot>;
}

export function fixtureScheduleSource(snapshots: readonly ScheduleSnapshot[]): FixtureScheduleSource {
  return {
    transport: "fixture",
    async load(clubId: string) {
      const snapshot = snapshots.find((item) => item.clubId === clubId);
      if (!snapshot) {
        throw new LiveSearchBlockedError(
          `No fixture schedule is loaded for ${JSON.stringify(clubId)}. Refusing to look up that id on a live API.`,
        );
      }
      if (snapshot.source !== "fixture") {
        throw new LiveSearchBlockedError("Fixture schedule source returned a non-fixture snapshot.");
      }
      return snapshot;
    },
  };
}
