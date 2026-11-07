import type { ReservationTypePolicy } from "./types.js";

export function durationAllowed(policy: ReservationTypePolicy, minutes: number): boolean {
  if (!policy.constraintsKnown) return false;
  const allowed = policy.allowedDurationsMinutes;
  if (!allowed || allowed.length === 0) return false;
  if (!allowed.includes(minutes)) return false;
  if (policy.minimumDurationMinutes != null && minutes < policy.minimumDurationMinutes) return false;
  if (policy.maximumDurationMinutes != null && minutes > policy.maximumDurationMinutes) return false;
  return true;
}

export function durationBlocker(policy: ReservationTypePolicy, minutes: number): string | null {
  if (!policy.constraintsKnown) return "constraints-unknown";
  const allowed = policy.allowedDurationsMinutes;
  if (!allowed || allowed.length === 0 || !allowed.includes(minutes)) return "duration-not-allowed";
  if (policy.minimumDurationMinutes != null && minutes < policy.minimumDurationMinutes) {
    return "below-minimum-duration";
  }
  if (policy.maximumDurationMinutes != null && minutes > policy.maximumDurationMinutes) {
    return "above-maximum-duration";
  }
  return null;
}
