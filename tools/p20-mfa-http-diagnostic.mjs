import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const gateway = new URL(process.env.SRD_GATEWAY_URL || "http://127.0.0.1:8080");
const mailpit = new URL(process.env.SRD_MAILPIT_URL || "http://127.0.0.1:8025");
const fixturePath = path.resolve(process.env.SRD_FIXTURE_PATH || "assembled/.local/e2e-fixture.json");
const tracePath = path.resolve(process.env.SRD_P20_TRACE_PATH || "test-results/p20-mfa-http-trace.jsonl");
const junitPath = path.resolve(process.env.SRD_P20_JUNIT_PATH || "test-results/p20-mfa-http.junit.xml");
const summaryPath = path.resolve(process.env.SRD_P20_SUMMARY_PATH || "test-results/p20-mfa-http-summary.json");
const correlationId = randomUUID();
const events = [];
const cases = [];
const expectedStages = ["prelogin-session", "csrf-bootstrap", "organization-context", "login-response", "mfa-mail", "mfa-verification", "authenticated-session"];
let activeStage = "startup";
let failureCode = "";

class DiagnosticFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function assert(condition, code) {
  if (!condition) throw new DiagnosticFailure(code);
}

function recordCase(name, passed, message = "") {
  cases.push({ name, passed, message });
}

function safeErrorCode(payload) {
  const candidate = payload?.error?.code;
  const safeCodes = new Set([
    "authentication_required", "csrf_mismatch", "dependency_unavailable", "invalid_credentials",
    "invalid_challenge", "rate_limited", "terms_required", "validation_failed",
  ]);
  if (typeof candidate !== "string") return "unspecified";
  const normalized = candidate.toLowerCase();
  if (safeCodes.has(normalized) || /^http_[1-5][0-9]{2}$/.test(normalized)) return normalized;
  return "unspecified";
}

function safeRoute(pathname) {
  return pathname
    .replace(/^\/api\/v1\/organizations\/[^/]+$/, "/api/v1/organizations/:code")
    .replace(/^\/api\/v1\/message\/[^/]+$/, "/api/v1/message/:id");
}

function safeLog(event) {
  events.push({ correlationId, ...event });
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

class GatewaySession {
  #cookies = new Map();

  async request(stage, method, route, body, csrf) {
    const url = new URL(route, gateway);
    assert(url.origin === gateway.origin, "gateway-origin-escape");
    const headers = new Headers({ Accept: "application/json", "X-Correlation-ID": correlationId });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (csrf) headers.set("X-CSRF-TOKEN", csrf);
    const sessionCookieBefore = this.#cookies.has("srd_session");
    if (this.#cookies.size) headers.set("Cookie", [...this.#cookies].map(([key, value]) => key + "=" + value).join("; "));

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      safeLog({ service: "gateway", event: "http_exchange", stage, method, path: safeRoute(url.pathname), status: null,
        requestHasSessionCookie: sessionCookieBefore, requestHasCsrfToken: Boolean(csrf), requestHasCorrelationId: true, responseSetsSessionCookie: false,
        errorCode: error?.cause?.code && /^[A-Z0-9_]{1,40}$/.test(error.cause.code) ? "network-" + error.cause.code.toLowerCase() : "network-error" });
      throw new DiagnosticFailure("gateway-request-failed-" + stage);
    }

    let sessionCookieSet = false;
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const firstPart = cookie.split(";", 1)[0];
      const separator = firstPart.indexOf("=");
      if (separator > 0) {
        const name = firstPart.slice(0, separator);
        this.#cookies.set(name, firstPart.slice(separator + 1));
        if (name === "srd_session") sessionCookieSet = true;
      }
    }

    let payload = null;
    try { payload = await response.json(); } catch { /* status-only diagnostics */ }
    const event = {
      service: "gateway",
      event: "http_exchange",
      stage,
      method,
      path: safeRoute(url.pathname),
      status: response.status,
      requestHasSessionCookie: sessionCookieBefore,
      requestHasCsrfToken: Boolean(csrf),
      requestHasCorrelationId: true,
      responseSetsSessionCookie: sessionCookieSet,
      responseCorrelationIdMatches: response.headers.get("X-Correlation-ID") === correlationId,
      errorCode: response.ok ? null : safeErrorCode(payload),
    };
    if (stage === "login-response") {
      event.loginRequestHasEmail = typeof body?.email === "string";
      event.loginRequestHasPassword = typeof body?.password === "string";
      event.loginRequestHasOrganizationContext = body?.organization_code === process.env.SRD_EXPECTED_ORGANIZATION_CODE;
      event.loginRequestTermsAccepted = body?.accepted === true && body?.terms_version_id === process.env.SRD_EXPECTED_TERMS_VERSION_ID;
      event.mfaChallengeIssued = typeof payload?.data?.challenge_id === "string";
    }
    safeLog(event);
    return { status: response.status, payload, sessionCookieSet };
  }

  hasSessionCookie() { return this.#cookies.has("srd_session"); }
}

async function mailpitMessages() {
  let response;
  try {
    response = await fetch(new URL("/api/v1/messages", mailpit), { signal: AbortSignal.timeout(10000) });
  } catch {
    safeLog({ service: "mailpit", event: "message_count", status: null, freshRecipientMessages: null, errorCode: "mailpit-request-failed" });
    throw new DiagnosticFailure("mailpit-request-failed");
  }
  if (response.status !== 200) {
    safeLog({ service: "mailpit", event: "message_count", status: response.status, freshRecipientMessages: null, errorCode: "mailpit-unavailable" });
    throw new DiagnosticFailure("mailpit-unavailable");
  }
  const payload = await response.json();
  return payload.messages || [];
}

async function waitForMessage(email, previousIds) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const messages = await mailpitMessages();
    const fresh = messages.filter((item) => !previousIds.has(item.ID)
      && item.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase()));
    safeLog({ service: "mailpit", event: "message_count", status: 200, freshRecipientMessages: fresh.length, errorCode: null });
    if (fresh.length) {
      const response = await fetch(new URL("/api/v1/message/" + encodeURIComponent(fresh[0].ID), mailpit), { signal: AbortSignal.timeout(10000) });
      if (response.status !== 200) throw new DiagnosticFailure("mailpit-message-unavailable");
      const detail = await response.json();
      const code = String(detail.Text || "").match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
      throw new DiagnosticFailure("mfa-mail-has-no-parseable-code");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  safeLog({ service: "mailpit", event: "message_count", status: 200, freshRecipientMessages: 0, errorCode: null });
  throw new DiagnosticFailure("mfa-mail-timeout");
}

async function writeEvidence(outcome) {
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  fs.mkdirSync(path.dirname(junitPath), { recursive: true });
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(tracePath, events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""), "utf8");
  const completed = new Map(cases.map((item) => [item.name, item]));
  const testcases = expectedStages.map((name) => {
    const test = completed.get(name);
    if (!test) return "  <testcase classname=\"srd.p20.mfa-http\" name=\"" + xml(name) + "\"><skipped message=\"not-reached\"/></testcase>";
    return test.passed
      ? "  <testcase classname=\"srd.p20.mfa-http\" name=\"" + xml(name) + "\"/>"
      : "  <testcase classname=\"srd.p20.mfa-http\" name=\"" + xml(name) + "\"><failure message=\"" + xml(test.message) + "\"/></testcase>";
  }).join("\n");
  const failures = cases.filter((item) => !item.passed).length;
  const skipped = expectedStages.length - cases.length;
  fs.writeFileSync(junitPath, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuite name=\"SRD P20 MFA HTTP diagnostic\" tests=\"" + expectedStages.length + "\" failures=\"" + failures + "\" errors=\"0\" skipped=\"" + skipped + "\">\n" + testcases + "\n</testsuite>\n", "utf8");
  const summary = {
    correlationId,
    outcome,
    failureCode: failureCode || null,
    stageResults: expectedStages.map((name) => ({ name, result: completed.has(name) ? (completed.get(name).passed ? "PASS" : "FAIL") : "NOT_RUN" })),
    eventCount: events.length,
    containsCredentials: false,
    containsCookiesOrTokens: false,
    containsMfaCode: false,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
}

async function run() {
  assert(gateway.protocol === "http:" && ["127.0.0.1", "localhost"].includes(gateway.hostname), "gateway-must-be-loopback-http");
  assert(mailpit.protocol === "http:" && ["127.0.0.1", "localhost"].includes(mailpit.hostname), "mailpit-must-be-loopback-http");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const account = fixture.mobile_user;
  assert(account?.email === "android@srd-e2e.test" && typeof fixture.password === "string", "synthetic-viewer-fixture-invalid");
  const code = fixture.codeA || "srd-e2e-a";
  process.env.SRD_EXPECTED_ORGANIZATION_CODE = code;
  process.env.SRD_EXPECTED_TERMS_VERSION_ID = fixture.termsA;
  const previousMessages = await mailpitMessages();
  const previousIds = new Set(previousMessages.map((message) => message.ID));

  activeStage = "prelogin-session";
  const anonymous = await new GatewaySession().request(activeStage, "GET", "/api/v1/me");
  assert(anonymous.status === 401, "prelogin-me-status-unexpected");
  recordCase(activeStage, true);

  const client = new GatewaySession();
  activeStage = "csrf-bootstrap";
  const csrfResponse = await client.request(activeStage, "GET", "/api/v1/csrf");
  const csrf = csrfResponse.payload?.data?.token;
  assert(csrfResponse.status === 200 && typeof csrf === "string" && client.hasSessionCookie(), "csrf-bootstrap-failed");
  recordCase(activeStage, true);

  activeStage = "organization-context";
  const organization = await client.request(activeStage, "GET", "/api/v1/organizations/" + encodeURIComponent(code));
  assert(organization.status === 200 && organization.payload?.data?.id === fixture.orgA
    && organization.payload?.data?.code === code, "organization-context-invalid");
  recordCase(activeStage, true);

  activeStage = "login-response";
  const login = await client.request(activeStage, "POST", "/api/v1/auth/login", {
    email: account.email,
    password: fixture.password,
    organization_code: code,
    terms_version_id: fixture.termsA,
    accepted: true,
  }, csrf);
  assert(login.status === 200, "gateway-login-status-" + login.status);
  const challengeId = login.payload?.data?.challenge_id;
  assert(typeof challengeId === "string", "mfa-challenge-not-issued");
  recordCase(activeStage, true);

  activeStage = "mfa-mail";
  const mailCode = await waitForMessage(account.email, previousIds);
  assert(/^\d{6}$/.test(mailCode), "mfa-code-format-invalid");
  recordCase(activeStage, true);

  activeStage = "mfa-verification";
  const verified = await client.request(activeStage, "POST", "/api/v1/auth/verify", { challenge_id: challengeId, code: mailCode }, csrf);
  assert(verified.status === 200 && verified.payload?.data?.role === "viewer"
    && verified.payload?.data?.organization?.id === fixture.orgA && client.hasSessionCookie(), "mfa-verification-failed");
  recordCase(activeStage, true);

  activeStage = "authenticated-session";
  const me = await client.request(activeStage, "GET", "/api/v1/me");
  assert(me.status === 200 && me.payload?.data?.role === "viewer"
    && me.payload?.data?.organization?.id === fixture.orgA, "authenticated-session-invalid");
  recordCase(activeStage, true);
}

try {
  await run();
  console.log("PASS P20 isolated Gateway login, MFA delivery, verification and session diagnostic");
} catch (error) {
  failureCode = error instanceof DiagnosticFailure ? error.code : "unexpected-diagnostic-failure";
  if (!cases.some((item) => item.name === activeStage)) recordCase(activeStage, false, failureCode);
  console.error("FAIL P20 MFA HTTP diagnostic at " + activeStage + ": " + failureCode);
  process.exitCode = 1;
} finally {
  await writeEvidence(failureCode ? "FAIL" : "PASS");
}
