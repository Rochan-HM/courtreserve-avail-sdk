export interface EnrollmentRequest {
  kind: "owner-approval-required";
  clubName: string;
  verifiedPublicPage: null;
  autoJoin: false;
  requestedAction: "browser-enrollment";
  sdkPerforms: readonly [];
  willNot: readonly [
    "autojoin",
    "accept waivers",
    "submit signup forms",
    "create memberships",
    "store member passwords",
    "infer a club from a numeric id in a URL",
  ];
  reason: string;
}

/**
 * No verified public signup URL is hardcoded. Booking links that redirect to the
 * portal shell are not signup pages and are not returned here.
 * The parent agent may open a browser only after the owner approves this request.
 */
export function requestClubEnrollment(input: { clubName: string }): EnrollmentRequest {
  const clubName = input.clubName.trim();
  if (!clubName) throw new Error("Club name is required. A numeric organization id is not a membership.");
  return {
    kind: "owner-approval-required",
    clubName,
    verifiedPublicPage: null,
    autoJoin: false,
    requestedAction: "browser-enrollment",
    sdkPerforms: [],
    willNot: [
      "autojoin",
      "accept waivers",
      "submit signup forms",
      "create memberships",
      "store member passwords",
      "infer a club from a numeric id in a URL",
    ],
    reason:
      "No documented member API can join a club, and no verified public signup URL is on file for this name. Approve browser-based enrollment in the parent if you want to continue. This SDK will not submit the signup.",
  };
}
