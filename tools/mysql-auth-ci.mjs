import fs from "node:fs";
import path from "node:path";

const fixturePath = path.resolve(process.argv[2] || "assembled/.local/e2e-fixture.json");
const resultsPath = path.resolve(process.env.SRD_JUNIT_PATH || "test-results/p10-mysql-auth.junit.xml");
const gateway = new URL(process.env.SRD_GATEWAY_URL || "http://127.0.0.1:8080");
const mailpit = new URL(process.env.SRD_MAILPIT_URL || "http://127.0.0.1:8025");

for (const target of [gateway, mailpit]) {
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname)) {
    throw new Error("Integration targets must remain on loopback HTTP.");
  }
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const cases = [];

function assert(condition, label) {
  if (!condition) throw new Error(label);
}

function equal(actual, expected, label) {
  assert(actual === expected, label);
}

function safeErrorLabel(error) {
  if (error instanceof Error && /^[a-z0-9-]+$/.test(error.message)) return error.message;
  const code = error?.cause?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return `network-${code.toLowerCase()}`;
  if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) return "fetch-failed";
  if (error instanceof Error && error.name === "TypeError") return "unexpected-typeerror";
  return "unexpected-error";
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

class HttpSession {
  #cookies = new Map();

  async request(method, route, body, csrf) {
    const url = new URL(route, gateway);
    assert(url.origin === gateway.origin, "gateway-origin-escape");
    const headers = new Headers({ Accept: "application/json" });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (csrf) headers.set("X-CSRF-TOKEN", csrf);
    if (this.#cookies.size) headers.set("Cookie", [...this.#cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const firstPart = cookie.split(";", 1)[0];
      const separator = firstPart.indexOf("=");
      if (separator > 0) this.#cookies.set(firstPart.slice(0, separator), firstPart.slice(separator + 1));
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // Status checks below report a safe, stable failure without printing response bodies.
    }
    return { status: response.status, data };
  }

  async csrf() {
    const response = await this.request("GET", "/api/v1/csrf");
    equal(response.status, 200, "csrf-endpoint");
    assert(typeof response.data?.data?.token === "string", "csrf-token-missing");
    return response.data.data.token;
  }
}

async function mailpitJson(route) {
  const response = await fetch(new URL(route, mailpit), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  equal(response.status, 200, "mailpit-http");
  return response.json();
}

async function waitForCode(email, previousIds) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const listing = await mailpitJson("/api/v1/messages");
    const message = listing.messages?.find((item) => !previousIds.has(item.ID) && item.To?.some((recipient) => recipient.Address === email));
    if (message) {
      const detail = await mailpitJson(`/api/v1/message/${encodeURIComponent(message.ID)}`);
      const match = String(detail.Text || "").match(/\b\d{6}\b/);
      if (match) return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("mfa-message-timeout");
}

async function authenticate(role, organizationCode, termsVersionId) {
  const user = fixture.users[role];
  assert(user?.email && fixture.password, "synthetic-fixture-incomplete");
  const client = new HttpSession();
  const oldMessages = await mailpitJson("/api/v1/messages");
  const previousIds = new Set(oldMessages.messages?.map((item) => item.ID) || []);
  const login = await client.request("POST", "/api/v1/auth/login", {
    email: user.email,
    password: fixture.password,
    organization_code: organizationCode,
    terms_version_id: termsVersionId,
    accepted: true,
  }, await client.csrf());
  equal(login.status, 200, "login-challenge");
  const challengeId = login.data?.data?.challenge_id;
  assert(typeof challengeId === "string", "mfa-challenge-missing");
  const code = await waitForCode(user.email, previousIds);
  const verified = await client.request("POST", "/api/v1/auth/verify", { challenge_id: challengeId, code }, await client.csrf());
  equal(verified.status, 200, "mfa-verification");
  return { client, principal: verified.data?.data };
}

async function runCase(name, operation) {
  try {
    await operation();
    cases.push({ name, passed: true, message: "" });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = safeErrorLabel(error);
    cases.push({ name, passed: false, message });
    console.error(`FAIL ${name}`);
  }
}

async function writeJUnit() {
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  const failures = cases.filter((item) => !item.passed).length;
  const testcases = cases.map((item) => item.passed
    ? `  <testcase classname="srd.mysql-auth" name="${xml(item.name)}"/>`
    : `  <testcase classname="srd.mysql-auth" name="${xml(item.name)}"><failure message="${xml(item.message)}"/></testcase>`).join("\n");
  fs.writeFileSync(resultsPath, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="SRD MySQL authentication and tenant boundary" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">\n${testcases}\n</testsuite>\n`);
}

try {
  await runCase("gateway exposes two migrated synthetic organizations", async () => {
    const client = new HttpSession();
    const health = await client.request("GET", "/api/v1/csrf");
    equal(health.status, 200, "gateway-http-health");
    assert(typeof health.data?.data?.token === "string", "gateway-csrf-unavailable");
    for (const [letter, code] of [["A", fixture.codeA || "srd-e2e-a"], ["B", fixture.codeB || "srd-e2e-b"]]) {
      const response = await client.request("GET", `/api/v1/organizations/${code}`);
      equal(response.status, 200, `organization-${letter}-status`);
      equal(response.data?.data?.id, fixture[`org${letter}`], `organization-${letter}-identity`);
    }
    assert(fixture.orgA !== fixture.orgB, "organizations-must-be-distinct");
  });

  let admin;
  await runCase("admin login completes SMTP MFA and establishes a MySQL session", async () => {
    admin = await authenticate("admin", fixture.codeA || "srd-e2e-a", fixture.termsA);
    equal(admin.principal?.role, "admin", "admin-role");
    equal(admin.principal?.organization?.id, fixture.orgA, "admin-organization");
    const me = await admin.client.request("GET", "/api/v1/me");
    equal(me.status, 200, "admin-session-status");
    equal(me.data?.data?.organization?.id, fixture.orgA, "admin-session-tenant");
  });

  await runCase("admin is denied in an organization without membership", async () => {
    assert(admin?.client, "admin-session-unavailable");
    const unaffiliatedClient = new HttpSession();
    const login = await unaffiliatedClient.request("POST", "/api/v1/auth/login", {
      email: fixture.users.admin.email,
      password: fixture.password,
      organization_code: fixture.codeB || "srd-e2e-b",
      terms_version_id: fixture.termsB,
      accepted: true,
    }, await unaffiliatedClient.csrf());
    equal(login.status, 401, "cross-tenant-login-denied");
    const switchResponse = await admin.client.request("POST", "/api/v1/auth/switchOrganization", {
      organization_code: fixture.codeB || "srd-e2e-b",
      terms_version_id: fixture.termsB,
      accepted: true,
    }, await admin.client.csrf());
    equal(switchResponse.status, 403, "cross-tenant-switch-denied");
    const stillAdmin = await admin.client.request("GET", "/api/v1/me");
    equal(stillAdmin.status, 200, "admin-session-survives-denial");
    equal(stillAdmin.data?.data?.organization?.id, fixture.orgA, "admin-session-remains-in-tenant-a");
  });

  await runCase("viewer login completes MFA but is denied member administration", async () => {
    const viewer = await authenticate("viewer", fixture.codeA || "srd-e2e-a", fixture.termsA);
    equal(viewer.principal?.role, "viewer", "viewer-role");
    equal(viewer.principal?.organization?.id, fixture.orgA, "viewer-organization");
    const members = await viewer.client.request("GET", "/api/v1/members");
    equal(members.status, 403, "viewer-members-denied");
    const forbiddenInvite = await viewer.client.request("POST", "/api/v1/invitations", {}, await viewer.client.csrf());
    equal(forbiddenInvite.status, 403, "viewer-invite-denied-before-validation");
  });
} finally {
  await writeJUnit();
}

if (cases.length !== 4 || cases.some((item) => !item.passed)) process.exitCode = 1;
