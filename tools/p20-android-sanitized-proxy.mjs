import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const allowedOrigin = "http://10.0.2.2:8080";
const safeRoutes = new Map([
  ["GET /api/v1/csrf", "csrf-bootstrap"],
  ["GET /api/v1/me", "session-read"],
  ["POST /api/v1/auth/login", "login"],
  ["POST /api/v1/auth/verify", "mfa-verification"],
  ["POST /api/v1/auth/logout", "logout"],
]);
const hopByHopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

export function isAllowedQaTarget(target) {
  return target instanceof URL && target.origin === allowedOrigin;
}

function normalizedRoute(method, pathname) {
  const known = safeRoutes.get(`${method} ${pathname}`);
  if (known) return { name: known, path: pathname };
  if (method === "GET" && /^\/api\/v1\/organizations\/[^/]+$/.test(pathname)) {
    return { name: "organization-context", path: "/api/v1/organizations/:code" };
  }
  return { name: "other-api-request", path: "/api/v1/:unclassified" };
}

function parsedJson(chunks, oversized) {
  if (oversized || chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function jsonValues(value, entries = [], depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return entries;
  if (Array.isArray(value)) {
    for (const item of value) jsonValues(item, entries, depth + 1);
    return entries;
  }
  for (const [key, child] of Object.entries(value)) {
    entries.push([key.toLowerCase(), child]);
    jsonValues(child, entries, depth + 1);
  }
  return entries;
}

function bodyFlags(json) {
  const entries = jsonValues(json);
  const has = (pattern) => entries.some(([key]) => pattern.test(key));
  const truthy = (pattern) => entries.some(([key, value]) => pattern.test(key) && [true, 1, "1", "true", "yes"].includes(value));
  return {
    requestHasEmail: has(/^(email|email_address)$/),
    requestHasPassword: has(/^(password|current_password)$/),
    requestHasOrganizationContext: has(/^(organization|organization_id|organization_code|organizationcode|council_code|code)$/),
    requestTermsAccepted: truthy(/^(terms_accepted|termsaccepted|accepted_terms|accept_terms)$/),
    requestHasMfaCode: has(/^(code|mfa_code|mfacode|verification_code|verificationcode)$/),
  };
}

function sessionCookiePresent(value) {
  return typeof value === "string" && /(?:^|;\s*)srd_session=/i.test(value);
}

function requestUrl(request) {
  try {
    if (/^https?:\/\//i.test(request.url || "")) return new URL(request.url);
    const host = String(request.headers.host || "");
    return new URL(request.url || "/", `http://${host}`);
  } catch {
    return null;
  }
}

export async function startSanitizedAndroidProxy({ tracePath, port = 8888, upstream = "http://127.0.0.1:8080" }) {
  if (!tracePath) throw new Error("proxy-trace-path-required");
  const upstreamUrl = new URL(upstream);
  if (upstreamUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(upstreamUrl.hostname)) {
    throw new Error("proxy-upstream-must-be-loopback-http");
  }
  const correlationId = randomUUID();
  const events = [];
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  fs.writeFileSync(tracePath, "", "utf8");
  const append = (event) => {
    const record = { correlationId, ...event };
    events.push(record);
    fs.appendFileSync(tracePath, `${JSON.stringify(record)}\n`, "utf8");
  };

  const server = http.createServer((clientRequest, clientResponse) => {
    const target = requestUrl(clientRequest);
    const targetAllowed = isAllowedQaTarget(target);
    const route = target ? normalizedRoute(clientRequest.method || "GET", target.pathname) : { name: "invalid-target", path: "/invalid" };
    if (!targetAllowed) {
      append({ service: "android-proxy", event: "target-rejected", method: clientRequest.method || "GET", path: route.path, status: 403, targetAllowed: false });
      const respondDenied = () => {
        clientResponse.writeHead(403, { "content-length": "0", "cache-control": "no-store", connection: "close" });
        clientResponse.end();
      };
      if (clientRequest.complete || clientRequest.readableEnded) respondDenied();
      else {
        clientRequest.once("end", respondDenied);
        clientRequest.resume();
      }
      return;
    }

    const sequence = events.filter((event) => event.event === "http_exchange").length + 1;
    const requestChunks = [];
    let requestBytes = 0;
    let requestOversized = false;
    clientRequest.on("data", (chunk) => {
      requestBytes += chunk.length;
      if (requestBytes <= 65536) requestChunks.push(Buffer.from(chunk));
      else requestOversized = true;
    });

    const headers = {};
    for (const [key, value] of Object.entries(clientRequest.headers)) {
      if (!hopByHopHeaders.has(key.toLowerCase()) && key.toLowerCase() !== "host" && key.toLowerCase() !== "x-correlation-id") headers[key] = value;
    }
    headers.host = upstreamUrl.host;
    headers["x-correlation-id"] = correlationId;

    const upstreamRequest = http.request({
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 80,
      method: clientRequest.method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: 20000,
    }, (upstreamResponse) => {
      const responseHeaders = {};
      for (const [key, value] of Object.entries(upstreamResponse.headers)) {
        if (!hopByHopHeaders.has(key.toLowerCase())) responseHeaders[key] = value;
      }
      clientResponse.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      const responseChunks = [];
      let responseBytes = 0;
      let responseOversized = false;
      upstreamResponse.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes <= 65536) responseChunks.push(Buffer.from(chunk));
        else responseOversized = true;
        clientResponse.write(chunk);
      });
      upstreamResponse.on("end", () => {
        const requestJson = parsedJson(requestChunks, requestOversized);
        const responseJson = parsedJson(responseChunks, responseOversized);
        const responseEntries = jsonValues(responseJson);
        const hasResponseKey = (pattern) => responseEntries.some(([key]) => pattern.test(key));
        append({
          service: "android-proxy",
          event: "http_exchange",
          sequence,
          stage: route.name,
          method: clientRequest.method || "GET",
          path: route.path,
          status: upstreamResponse.statusCode || 502,
          requestBytes,
          responseBytes,
          requestHasSessionCookie: sessionCookiePresent(clientRequest.headers.cookie),
          requestHasCsrfToken: Boolean(clientRequest.headers["x-csrf-token"] || clientRequest.headers["x-xsrf-token"]),
          requestHasCorrelationId: true,
          responseSetsSessionCookie: Object.entries(upstreamResponse.headers).some(([key, value]) => key.toLowerCase() === "set-cookie" && (Array.isArray(value) ? value : [value]).some((item) => /(?:^|;\s*)srd_session=/i.test(String(item)))),
          responseCorrelationIdMatches: String(upstreamResponse.headers["x-correlation-id"] || "") === correlationId,
          ...bodyFlags(requestJson),
          responseHasMfaChallenge: hasResponseKey(/^(challenge_id|challengeid|requires_mfa|requiresmfa|mfa_required|mfarequired)$/),
          responseHasErrorField: hasResponseKey(/^(error|error_code|errorcode)$/),
        });
        requestChunks.length = 0;
        responseChunks.length = 0;
        clientResponse.end();
      });
      upstreamResponse.on("error", () => {
        append({ service: "android-proxy", event: "upstream-error", sequence, stage: route.name, method: clientRequest.method || "GET", path: route.path, status: 502, errorCode: "upstream_response_failed" });
        if (!clientResponse.headersSent) clientResponse.writeHead(502, { "cache-control": "no-store" });
        clientResponse.end();
      });
    });

    upstreamRequest.on("timeout", () => upstreamRequest.destroy());
    upstreamRequest.on("error", () => {
      append({ service: "android-proxy", event: "upstream-error", sequence, stage: route.name, method: clientRequest.method || "GET", path: route.path, status: 502, errorCode: "upstream_unavailable" });
      if (!clientResponse.headersSent) clientResponse.writeHead(502, { "cache-control": "no-store" });
      clientResponse.end();
    });
    clientRequest.on("data", (chunk) => upstreamRequest.write(chunk));
    clientRequest.on("end", () => upstreamRequest.end());
    clientRequest.on("error", () => upstreamRequest.destroy());
  });

  server.on("connect", (_request, socket) => {
    append({ service: "android-proxy", event: "connect-rejected", method: "CONNECT", path: "/connect", status: 403, targetAllowed: false });
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  server.on("clientError", (error, socket) => {
    const safeCode = /^HPE_[A-Z0-9_]+$/.test(String(error.code || "")) ? error.code : "malformed_client_request";
    append({ service: "android-proxy", event: "malformed-client-request", method: "UNKNOWN", path: "/invalid", status: 400, errorCode: safeCode });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  append({ service: "android-proxy", event: "proxy_started", status: 200, listeningPort: actualPort, onlyQaOriginAllowed: true });

  return {
    correlationId,
    port: actualPort,
    events,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
