import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { QueryValidationError } from "../errors.js";
import { sessionPathFromEnv, type StoredCookie } from "./session.js";

const LOGIN_URL = "https://app.courtreserve.com/Account/Login";

export interface MemberCredentials {
  username: string;
  password: string;
}

export function readMemberCredentials(env: NodeJS.ProcessEnv, dotenvText = ""): MemberCredentials {
  const file = parseDotEnv(dotenvText);
  const username = env.USERNAME?.trim() || file.USERNAME || "";
  const password = env.PASSWORD || file.PASSWORD || "";
  if (!username || !password.trim()) {
    throw new QueryValidationError("Set USERNAME and PASSWORD in .env or the environment. Do not pass them as flags.");
  }
  return { username, password };
}

export function readDotEnvFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function cookiesForSession(cookies: readonly StoredCookie[]): StoredCookie[] {
  return cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    return cookie.name && cookie.value && (domain === "courtreserve.com" || domain.endsWith(".courtreserve.com"));
  });
}

export async function loginHeadless(
  credentials: MemberCredentials,
  options: { sessionPath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ path: string; cookieCount: number }> {
  const sessionPath = options.sessionPath ?? sessionPathFromEnv(options.env ?? process.env);
  const { Camoufox } = await import("camoufox");
  const browser = await Camoufox({
    headless: true,
    os: "macos",
    locale: "en-US",
    canvas_noise: false,
  });
  try {
    const page = await browser.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    const email = page.getByRole("textbox", { name: "Enter Your Email" });
    const formReady = await email.waitFor({ state: "visible", timeout: 20000 }).then(() => true).catch(() => false);
    if (!formReady) {
      throw new QueryValidationError(`Sign-in form did not appear. Page title: ${await page.title()}.`);
    }
    await email.fill(credentials.username);
    await page.getByRole("textbox", { name: "Enter Your Password" }).fill(credentials.password);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.toLowerCase().includes("/account/login"), { timeout: 45000 }).catch(() => undefined);
    if (page.url().toLowerCase().includes("/account/login")) {
      throw new QueryValidationError("Sign-in stayed on the login page. The account was not accepted, or the headless browser was blocked.");
    }
    const orgId = page.url().match(/\/(\d+)(?:[/?]|$)/)?.[1];
    if (orgId) {
      await page.goto(`https://app.courtreserve.com/Online/Portal/Index/${orgId}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    }
    const raw = await page.context().cookies(["https://app.courtreserve.com", "https://backend.courtreserve.com"]);
    const cookies = cookiesForSession(raw.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
    })));
    if (!cookies.some((cookie) => cookie.name === ".AspNet.ApplicationCookie")) {
      throw new QueryValidationError("Sign-in finished without a CourtReserve session cookie.");
    }
    if (!cookies.some((cookie) => cookie.name === "PreferenceOrgId" && /^\d+$/.test(cookie.value))) {
      throw new QueryValidationError("Sign-in finished without PreferenceOrgId. Open a club once in the browser and try again.");
    }
    writeFileSync(sessionPath, JSON.stringify(cookies));
    chmodSync(sessionPath, 0o600);
    return { path: sessionPath, cookieCount: cookies.length };
  } catch (error) {
    if (error instanceof QueryValidationError) throw error;
    const message = error instanceof Error ? error.message : "Headless login failed.";
    const redacted = message.split(credentials.password).join("[redacted]").split(credentials.username).join("[redacted]");
    throw new QueryValidationError(redacted.slice(0, 500));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
