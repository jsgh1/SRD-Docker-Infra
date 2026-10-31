import fs from "node:fs";
import path from "node:path";

const fixturePath = path.resolve(process.argv[2] || "assembled/.local/e2e-fixture.json");
const resultsPath = path.resolve(process.env.SRD_P11_JUNIT_PATH || "test-results/p11-mysql-tenant.junit.xml");
const gateway = new URL(process.env.SRD_GATEWAY_URL || "http://127.0.0.1:8080");
const mailpit = new URL(process.env.SRD_MAILPIT_URL || "http://127.0.0.1:8025");

for (const target of [gateway, mailpit]) {
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname)) {
    throw new Error("integration-target-outside-loopback");
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

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function safeErrorLabel(error) {
  if (error instanceof Error && /^[a-z0-9-]+$/.test(error.message)) return error.message;
  const code = error?.cause?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return `network-${code.toLowerCase()}`;
  if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) return "fetch-failed";
  return "unexpected-error";
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
      // Tests assert stable status and safe payload properties without logging response bodies.
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
  const response = await fetch(new URL(route, mailpit), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  equal(response.status, 200, "mailpit-http");
  return response.json();
}

async function waitForCode(email, previousIds) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const listing = await mailpitJson("/api/v1/messages");
    const message = listing.messages?.find((item) => !previousIds.has(item.ID)
      && item.To?.some((recipient) => recipient.Address === email));
    if (message) {
      const detail = await mailpitJson(`/api/v1/message/${encodeURIComponent(message.ID)}`);
      const match = String(detail.Text || "").match(/\b\d{6}\b/);
      if (match) return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("mfa-message-timeout");
}

async function startChallenge(role, organizationCode, termsVersionId) {
  const user = fixture.users[role];
  assert(user?.email && fixture.password, "synthetic-fixture-incomplete");
  const client = new HttpSession();
  const listing = await mailpitJson("/api/v1/messages");
  const previousIds = new Set(listing.messages?.map((item) => item.ID) || []);
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
  return { client, challengeId, previousIds, user };
}

async function authenticate(role, organizationCode = fixture.codeA || "srd-e2e-a", termsVersionId = fixture.termsA) {
  const challenge = await startChallenge(role, organizationCode, termsVersionId);
  const code = await waitForCode(challenge.user.email, challenge.previousIds);
  const verified = await challenge.client.request("POST", "/api/v1/auth/verify", {
    challenge_id: challenge.challengeId,
    code,
  }, await challenge.client.csrf());
  equal(verified.status, 200, "mfa-verification");
  return { client: challenge.client, principal: verified.data?.data };
}

async function runCase(name, operation) {
  try {
    await operation();
    cases.push({ name, passed: true, message: "" });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, passed: false, message: safeErrorLabel(error) });
    console.error(`FAIL ${name}`);
  }
}

async function writeJUnit() {
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  const failures = cases.filter((item) => !item.passed).length;
  const testcases = cases.map((item) => item.passed
    ? `  <testcase classname="srd.mysql-tenant" name="${xml(item.name)}"/>`
    : `  <testcase classname="srd.mysql-tenant" name="${xml(item.name)}"><failure message="${xml(item.message)}"/></testcase>`)
    .join("\n");
  fs.writeFileSync(resultsPath, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="SRD MySQL role and tenant boundary" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">\n${testcases}\n</testsuite>\n`);
}

try {
  await runCase("one invalid MFA code is rejected without consuming the valid challenge", async () => {
    const challenge = await startChallenge("registrar", fixture.codeA || "srd-e2e-a", fixture.termsA);
    const code = await waitForCode(challenge.user.email, challenge.previousIds);
    const wrongCode = String((Number(code) + 1) % 1000000).padStart(6, "0");
    const rejected = await challenge.client.request("POST", "/api/v1/auth/verify", {
      challenge_id: challenge.challengeId,
      code: wrongCode,
    }, await challenge.client.csrf());
    equal(rejected.status, 422, "invalid-mfa-rejected");
    const accepted = await challenge.client.request("POST", "/api/v1/auth/verify", {
      challenge_id: challenge.challengeId,
      code,
    }, await challenge.client.csrf());
    equal(accepted.status, 200, "valid-mfa-after-single-invalid-attempt");
    equal(accepted.data?.data?.role, "registrar", "registrar-role-after-mfa");
  });

  await runCase("all six roles receive server-side permissions for real Gateway routes", async () => {
    const matrix = {
      superadmin: { members: 200, invitations: 422, personsWrite: 422, platform: 200 },
      admin: { members: 200, invitations: 422, personsWrite: 422, platform: 403 },
      registrar: { members: 403, invitations: 422, personsWrite: 422, platform: 403 },
      treasurer: { members: 403, invitations: 403, personsWrite: 403, platform: 403 },
      auditor: { members: 403, invitations: 403, personsWrite: 403, platform: 403 },
      viewer: { members: 403, invitations: 403, personsWrite: 403, platform: 403 },
    };
    for (const [role, expected] of Object.entries(matrix)) {
      const auth = await authenticate(role);
      equal(auth.principal?.role, role, `${role}-principal-role`);
      equal(auth.principal?.organization?.id, fixture.orgA, `${role}-tenant-a`);
      equal((await auth.client.request("GET", "/api/v1/persons")).status, 200, `${role}-persons-read`);
      equal((await auth.client.request("GET", "/api/v1/members")).status, expected.members, `${role}-members-manage`);
      equal((await auth.client.request("POST", "/api/v1/invitations", {}, await auth.client.csrf())).status,
        expected.invitations, `${role}-members-invite-gate`);
      equal((await auth.client.request("POST", "/api/v1/persons", {}, await auth.client.csrf())).status,
        expected.personsWrite, `${role}-persons-write-gate`);
      equal((await auth.client.request("GET", "/api/v1/platform/accounts")).status,
        expected.platform, `${role}-platform-manage`);
    }
  });

  await runCase("session revocation and logout reject old cookies", async () => {
    const first = await authenticate("admin");
    const current = await authenticate("admin");
    const revoked = await current.client.request("POST", "/api/v1/auth/revokeOthers", {}, await current.client.csrf());
    equal(revoked.status, 200, "revoke-other-sessions-status");
    equal((await first.client.request("GET", "/api/v1/me")).status, 401, "revoked-session-rejected");
    equal((await current.client.request("GET", "/api/v1/me")).status, 200, "current-session-remains-active");
    const logout = await current.client.request("POST", "/api/v1/auth/logout", {}, await current.client.csrf());
    equal(logout.status, 200, "logout-status");
    equal((await current.client.request("GET", "/api/v1/me")).status, 401, "logged-out-session-rejected");
  });

  await runCase("membership removal invalidates the member's active session", async () => {
    const registrar = await authenticate("registrar");
    const admin = await authenticate("admin");
    const listing = await admin.client.request("GET", "/api/v1/members");
    equal(listing.status, 200, "admin-members-list");
    const members = listing.data?.data?.items;
    assert(Array.isArray(members), "members-list-shape");
    const membership = members.find((item) => item.user_id === fixture.users.registrar.id);
    assert(membership?.id && Number.isInteger(membership.version), "registrar-membership-fixture");
    const removed = await admin.client.request("PATCH", `/api/v1/members/${membership.id}`, {
      role: "registrar",
      active: false,
      version: membership.version,
    }, await admin.client.csrf());
    equal(removed.status, 200, "membership-removal-status");
    equal((await registrar.client.request("GET", "/api/v1/me")).status, 401, "removed-membership-session-rejected");
  });

  await runCase("an authorized multi-organization admin can switch tenant context", async () => {
    const admin = await authenticate("admin");
    const switched = await admin.client.request("POST", "/api/v1/auth/switchOrganization", {
      organization_code: fixture.codeB || "srd-e2e-b",
      terms_version_id: fixture.termsB,
      accepted: true,
    }, await admin.client.csrf());
    equal(switched.status, 200, "authorized-tenant-switch-status");
    const principal = await admin.client.request("GET", "/api/v1/me");
    equal(principal.status, 200, "switched-session-status");
    equal(principal.data?.data?.organization?.id, fixture.orgB, "switched-session-tenant-b");
  });

  await runCase("Records hides and preserves a synthetic person across tenant A and B", async () => {
    const tenantA = await authenticate("admin", fixture.codeA || "srd-e2e-a", fixture.termsA);
    const tenantB = await authenticate("admin", fixture.codeB || "srd-e2e-b", fixture.termsB);
    equal(tenantB.principal?.role, "admin", "tenant-b-admin-role");
    equal(tenantB.principal?.organization?.id, fixture.orgB, "tenant-b-admin-context");

    const record = {
      document_type: "CC",
      document_number: `P11-${Date.now()}`,
      first_names: "Registro sintético P11",
      status: "pending",
      schema_version: 0,
      positions_version: 0,
      note: "P11 tenant boundary sentinel",
    };
    const created = await tenantA.client.request("POST", "/api/v1/persons", record, await tenantA.client.csrf());
    equal(created.status, 200, "tenant-a-record-create");
    const id = created.data?.data?.id;
    assert(typeof id === "string", "tenant-a-record-id");
    const ownRead = await tenantA.client.request("GET", `/api/v1/persons/${id}`);
    equal(ownRead.status, 200, "tenant-a-record-read");
    equal(ownRead.data?.data?.first_names, record.first_names, "tenant-a-record-contents");

    const foreignRead = await tenantB.client.request("GET", `/api/v1/persons/${id}`);
    equal(foreignRead.status, 404, "tenant-b-foreign-record-hidden");
    const foreignUpdate = await tenantB.client.request("PATCH", `/api/v1/persons/${id}`, {
      ...record,
      first_names: "Cambio no autorizado",
      version: 1,
    }, await tenantB.client.csrf());
    equal(foreignUpdate.status, 404, "tenant-b-foreign-record-update-hidden");
    const foreignPayload = JSON.stringify(foreignRead.data || {}) + JSON.stringify(foreignUpdate.data || {});
    assert(!foreignPayload.includes(record.first_names) && !foreignPayload.includes(record.document_number)
      && !foreignPayload.includes(record.note), "foreign-record-data-not-disclosed");

    const unchanged = await tenantA.client.request("GET", `/api/v1/persons/${id}`);
    equal(unchanged.status, 200, "tenant-a-record-remains-readable");
    equal(unchanged.data?.data?.first_names, record.first_names, "tenant-a-record-unchanged");
    equal(unchanged.data?.data?.version, 1, "tenant-a-record-version-unchanged");
  });
} finally {
  await writeJUnit();
}

if (cases.length !== 6 || cases.some((item) => !item.passed)) process.exitCode = 1;
