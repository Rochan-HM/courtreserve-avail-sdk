import type { ApiCredentials } from "./admin/http.js";
import { CredentialsMissingError, MemberLoginUnsupportedError } from "./errors.js";
import { memberLoginSupport } from "./feasibility.js";

/**
 * There is no supported member login. The argument is ignored and is never stored or sent.
 * Do not pass a 1Password password here.
 */
export function loginAsMember(_credentials?: unknown): never {
  throw new MemberLoginUnsupportedError(memberLoginSupport);
}

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): ApiCredentials {
  const username = env.COURTRESERVE_API_USERNAME?.trim() ?? "";
  const password = env.COURTRESERVE_API_PASSWORD ?? "";
  if (!username || !password.trim()) throw new CredentialsMissingError();
  return { username, password };
}
