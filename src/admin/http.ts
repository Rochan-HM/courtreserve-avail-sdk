import { ApiStatusError, QueryValidationError, RateLimitError, TransportError } from "../errors.js";
import { courtsAppReadApi, organizationReadApi } from "../feasibility.js";
import { inclusiveCalendarDays } from "../time.js";

export interface ApiCredentials {
  username: string;
  password: string;
}

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface RateLimitPolicy {
  maxRequests: number;
  windowMs: number;
  maxRetries: number;
  /** Client cap so a huge Retry-After cannot stall the process. The header value is still reported. */
  maxHonoredRetryAfterMs: number;
}

export interface AvailabilityQuery {
  date?: string;
  fromDate?: string;
  toDate?: string;
  courtTypeId?: number;
}

const DEFAULT_LIMITS: RateLimitPolicy = {
  maxRequests: organizationReadApi.rateLimit.requestsPerMinute,
  windowMs: 60_000,
  maxRetries: 2,
  maxHonoredRetryAfterMs: 120_000,
};

export class CourtReserveReadClient {
  private readonly sentAt: number[] = [];
  private tail: Promise<void> = Promise.resolve();
  private readonly limits: RateLimitPolicy;
  private readonly deps: HttpDeps;

  constructor(
    readonly api: "organization" | "courtsapp",
    private readonly credentials: ApiCredentials,
    private readonly baseUrl = organizationReadApi.host,
    deps?: Partial<HttpDeps>,
    limits?: Partial<RateLimitPolicy>,
  ) {
    if (!credentials.username || !credentials.password) {
      throw new Error("API key username and password are both required.");
    }
    const url = new URL(baseUrl);
    if (url.username || url.password) throw new Error("Base URL must not embed credentials.");
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error("CourtReserve reads use HTTPS.");
    }
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.deps = {
      fetch: deps?.fetch ?? fetch,
      sleep: deps?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: deps?.now ?? (() => Date.now()),
    };
  }

  getAvailability(query: AvailabilityQuery): Promise<unknown> {
    return this.get(this.paths.availability, availabilityParams(query));
  }

  getCourts(): Promise<unknown> {
    return this.get(this.paths.courts, new URLSearchParams());
  }

  getReservationTypes(): Promise<unknown> {
    return this.get(this.paths.reservationTypes, new URLSearchParams());
  }

  private get paths() {
    return this.api === "organization"
      ? {
          availability: organizationReadApi.availability.path,
          courts: organizationReadApi.courts.path,
          reservationTypes: organizationReadApi.reservationTypes.path,
        }
      : {
          availability: courtsAppReadApi.availability.path,
          courts: courtsAppReadApi.courts.path,
          reservationTypes: courtsAppReadApi.reservationTypes.path,
        };
  }

  private async get(path: string, params: URLSearchParams): Promise<unknown> {
    if (!Object.values(this.paths).includes(path)) {
      throw new QueryValidationError("Refusing a path that is not a documented read route.");
    }
    const url = new URL(path, this.baseUrl);
    url.search = params.toString();
    const headers = {
      accept: "application/json",
      authorization: basic(this.credentials),
      "user-agent": "courtreserve-availability-sdk/0.1",
    };
    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.limits.maxRetries; attempt += 1) {
      await this.schedule();
      let response: Response;
      try {
        response = await this.deps.fetch(url, { method: "GET", headers });
      } catch {
        if (attempt === this.limits.maxRetries) {
          throw new TransportError(`GET ${path} failed before a response.`);
        }
        await this.deps.sleep(500 * 2 ** attempt);
        continue;
      }
      lastStatus = response.status;
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.deps.now());
        if (attempt === this.limits.maxRetries) {
          throw new RateLimitError(`GET ${path} returned 429.`, retryAfterMs);
        }
        if (retryAfterMs === null) {
          await this.deps.sleep(1000 * 2 ** attempt);
          continue;
        }
        if (retryAfterMs > this.limits.maxHonoredRetryAfterMs) {
          throw new RateLimitError(
            `GET ${path} asked to wait ${retryAfterMs}ms, above the client cap.`,
            retryAfterMs,
          );
        }
        await this.deps.sleep(retryAfterMs);
        continue;
      }
      if (response.status >= 500 && response.status <= 599) {
        if (attempt === this.limits.maxRetries) {
          throw new ApiStatusError(response.status, `GET ${path} returned ${response.status}.`);
        }
        await this.deps.sleep(500 * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new ApiStatusError(
          response.status,
          `GET ${path} returned ${response.status}. ${redact(text, this.credentials)}`.trim(),
        );
      }
      if (!text.trim()) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ApiStatusError(response.status, `GET ${path} returned a non-JSON body.`);
      }
    }
    throw new ApiStatusError(lastStatus, `GET ${path} failed.`);
  }

  private async schedule(): Promise<void> {
    const run = this.tail.then(() => this.acquire());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async acquire(): Promise<void> {
    while (true) {
      const now = this.deps.now();
      const fresh = this.sentAt.filter((sent) => now - sent < this.limits.windowMs);
      this.sentAt.length = 0;
      this.sentAt.push(...fresh);
      if (this.sentAt.length < this.limits.maxRequests) {
        this.sentAt.push(now);
        return;
      }
      const oldest = this.sentAt[0]!;
      await this.deps.sleep(Math.max(this.limits.windowMs - (now - oldest), 1));
    }
  }
}

export function availabilityParams(query: AvailabilityQuery): URLSearchParams {
  const date = query.date?.trim();
  const fromDate = query.fromDate?.trim();
  const toDate = query.toDate?.trim();
  const hasDate = Boolean(date);
  const hasRange = Boolean(fromDate || toDate);
  if (hasDate && hasRange) {
    throw new QueryValidationError("Pass date or fromDate/toDate, not both. The documented API rejects the mix.");
  }
  if (!hasDate && !(fromDate && toDate)) {
    throw new QueryValidationError("Pass date, or both fromDate and toDate.");
  }
  const params = new URLSearchParams();
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new QueryValidationError("date must be yyyy-MM-dd.");
    params.set("date", date);
  } else if (fromDate && toDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      throw new QueryValidationError("fromDate and toDate must be yyyy-MM-dd.");
    }
    const days = inclusiveCalendarDays(fromDate, toDate);
    if (days === null || days <= 0) throw new QueryValidationError("toDate must be on or after fromDate.");
    if (days > organizationReadApi.availability.maxInclusiveDays) {
      throw new QueryValidationError("Date range is capped at 31 inclusive days. This request was not sent.");
    }
    params.set("fromDate", fromDate);
    params.set("toDate", toDate);
  }
  if (query.courtTypeId !== undefined) {
    if (!Number.isInteger(query.courtTypeId)) throw new QueryValidationError("courtTypeId must be an integer.");
    params.set("courtTypeId", String(query.courtTypeId));
  }
  return params;
}

function basic(credentials: ApiCredentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`;
}

function redact(body: string, credentials: ApiCredentials): string {
  let text = body.slice(0, 300);
  for (const secret of [credentials.password, credentials.username]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text.replace(/\s+/g, " ").trim();
}

function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0 && /^\d+(\.\d+)?$/.test(header.trim())) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}
