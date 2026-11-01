import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isAllowedQaTarget, startSanitizedAndroidProxy } from "./p20-android-sanitized-proxy.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function requestThroughProxy(port, { target, body = "", method = body ? "POST" : "GET", headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      agent: false,
      method,
      path: target,
      headers: { host: "10.0.2.2:8888", "content-type": "application/json", ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("P20 Android proxy forwards QA HTTP and writes only redacted metadata", async () => {
  const passwordValue = "synthetic-password-never-log-this";
  const otpValue = "654321";
  const tokenValue = "synthetic-token-never-log-this";
  let upstreamBody = "";
  let upstreamCorrelationId = "";
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      upstreamBody = Buffer.concat(chunks).toString("utf8");
      upstreamCorrelationId = String(request.headers["x-correlation-id"] || "");
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "srd_session=opaque; Path=/; HttpOnly", "x-correlation-id": upstreamCorrelationId });
      response.end(JSON.stringify({ challenge_id: "opaque-challenge", access_token: tokenValue, code: otpValue }));
    });
  });
  const upstreamPort = await listen(upstream);
  const tracePath = path.join(os.tmpdir(), `srd-p20-proxy-${process.pid}-${Date.now()}.jsonl`);
  const proxy = await startSanitizedAndroidProxy({ tracePath, upstream: `http://127.0.0.1:${upstreamPort}` });
  try {
    const loginBody = JSON.stringify({ email: "android@srd-e2e.test", password: passwordValue, organization_code: "srd-e2e-a", terms_accepted: true });
    const login = await requestThroughProxy(proxy.port, {
      target: "/api/v1/auth/login?ignored=private",
      body: loginBody,
      headers: { cookie: "srd_session=opaque-client-cookie", "x-csrf-token": "opaque-csrf" },
    });
    assert.equal(login.status, 200);
    assert.equal(JSON.parse(login.body).code, otpValue, "proxy must preserve the HTTP response for the app");
    assert.match(upstreamBody, new RegExp(passwordValue));
    assert.equal(upstreamCorrelationId, proxy.correlationId);

    const trace = fs.readFileSync(tracePath, "utf8");
    assert.equal(trace.includes(passwordValue), false);
    assert.equal(trace.includes(otpValue), false);
    assert.equal(trace.includes(tokenValue), false);
    assert.equal(trace.includes("android@srd-e2e.test"), false);
    assert.equal(trace.includes("srd-e2e-a"), false);
    assert.equal(trace.includes("opaque-client-cookie"), false);
    assert.equal(trace.includes("opaque-csrf"), false);
    assert.equal(trace.includes("ignored=private"), false);
    const exchange = JSON.parse(trace.split(/\r?\n/).find((line) => line.includes('"event":"http_exchange"')));
    assert.equal(exchange.stage, "login");
    assert.equal(exchange.path, "/api/v1/auth/login");
    assert.equal(exchange.status, 200);
    assert.equal(exchange.requestHasSessionCookie, true);
    assert.equal(exchange.requestHasCsrfToken, true);
    assert.equal(exchange.requestHasEmail, true);
    assert.equal(exchange.requestHasPassword, true);
    assert.equal(exchange.requestHasOrganizationContext, true);
    assert.equal(exchange.requestTermsAccepted, true);
    assert.equal(exchange.responseSetsSessionCookie, true);
    assert.equal(exchange.responseCorrelationIdMatches, true);
    assert.equal(exchange.responseHasMfaChallenge, true);
  } finally {
    await proxy.close();
    await close(upstream);
    fs.rmSync(tracePath, { force: true });
  }
});

test("P20 Android reverse proxy accepts only the emulator-to-proxy QA origin", () => {
  assert.equal(isAllowedQaTarget(new URL("http://10.0.2.2:8888/api/v1/me")), true);
  assert.equal(isAllowedQaTarget(new URL("http://10.0.2.2:8888/")), false);
  assert.equal(isAllowedQaTarget(new URL("http://10.0.2.2:8080/api/v1/me")), false);
  assert.equal(isAllowedQaTarget(new URL("https://10.0.2.2:8888/api/v1/me")), false);
  assert.equal(isAllowedQaTarget(new URL("http://10.0.2.2:443/api/v1/me")), false);
  assert.equal(isAllowedQaTarget(new URL("https://srd-jsgh1.duckdns.org/api/v1/me")), false);
});

test("P20 Android proxy assigns unique sequence numbers to concurrent exchanges", async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      upstreamRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      setTimeout(() => response.end(JSON.stringify({ ok: true })), 100);
    });
  });
  const upstreamPort = await listen(upstream);
  const tracePath = path.join(os.tmpdir(), `srd-p20-concurrent-${process.pid}-${Date.now()}.jsonl`);
  const proxy = await startSanitizedAndroidProxy({ tracePath, upstream: `http://127.0.0.1:${upstreamPort}` });
  try {
    const outcomes = await Promise.allSettled([
      requestThroughProxy(proxy.port, { target: "/api/v1/me?request=first" }),
      requestThroughProxy(proxy.port, { target: "/api/v1/me?request=second" }),
    ]);
    assert.equal(upstreamRequests, 2, JSON.stringify(proxy.events));
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled"], JSON.stringify({ events: proxy.events, upstreamRequests }));
    const results = outcomes.map((outcome) => outcome.value);
    assert.deepEqual(results.map((result) => result.status), [200, 200]);

    const exchanges = proxy.events.filter((event) => event.event === "http_exchange");
    assert.equal(exchanges.length, 2);
    assert.deepEqual(exchanges.map((event) => event.sequence).sort((left, right) => left - right), [1, 2]);
    assert.equal(new Set(exchanges.map((event) => event.sequence)).size, 2);
    const traceExchanges = fs.readFileSync(tracePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes('"event":"http_exchange"'))
      .map((line) => JSON.parse(line));
    assert.deepEqual(traceExchanges.map((event) => event.sequence).sort((left, right) => left - right), [1, 2]);
  } finally {
    await proxy.close();
    await close(upstream);
    fs.rmSync(tracePath, { force: true });
  }
});
