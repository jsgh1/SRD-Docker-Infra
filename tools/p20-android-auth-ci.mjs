import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  decodeXml,
  editableValue,
  findNode,
  safeEditableStates,
  safeUiDetails,
  safeUiLabels,
} from "./mobile-android-ui.mjs";
import { startSanitizedAndroidProxy } from "./p20-android-sanitized-proxy.mjs";
import { resolveP20AndroidProfile } from "./p20-android-client-profile.mjs";
import { resolveP20OrganizationCodeA } from "./p20-android-fixture.mjs";

const profile = resolveP20AndroidProfile(process.env.SRD_ANDROID_CLIENT || "rn");
const apkPath = path.resolve(process.env.SRD_ANDROID_APK || "");
const fixturePath = path.resolve(process.env.SRD_FIXTURE_PATH || "");
const gateway = new URL(process.env.SRD_GATEWAY_URL || "http://127.0.0.1:8080");
const androidOrigin = process.env.SRD_ANDROID_GATEWAY_ORIGIN || "";
const mailpit = new URL(process.env.SRD_MAILPIT_URL || "http://127.0.0.1:8025");
const androidPackage = profile.androidPackage;
const junitPath = path.resolve(process.env.SRD_ANDROID_JUNIT_PATH || `test-results/p20-${profile.key}-mfa.junit.xml`);
const resourcesPath = path.resolve(process.env.SRD_ANDROID_RESOURCES_PATH || `test-results/p20-${profile.key}-runner-resources.txt`);
const tracePath = path.resolve(process.env.SRD_ANDROID_PROXY_TRACE_PATH || `test-results/p20-${profile.key}-http-trace.jsonl`);
const proxyPort = Number(process.env.SRD_ANDROID_PROXY_PORT || 8888);
const result = { passed: false, failure: "not-run" };
const cases = [];
let activeCase = `P20 ${profile.client} completes real Mailpit MFA`;
let stageName = "preflight";
let serial = "";
let proxy;
let freshMfaMailObserved = false;
let minimumAvailableKiB = Number.POSITIVE_INFINITY;
let memorySamples = 0;
let lastUiLabels = [];
let lastUiDetails = [];
let lastEditableStates = [];
let failureScreenshot = "not-captured";

class DiagnosticFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function failUnless(condition, code) {
  if (!condition) throw new DiagnosticFailure(code);
}

function sampleMemory() {
  const text = fs.readFileSync("/proc/meminfo", "utf8");
  const available = Number(text.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  failUnless(Number.isFinite(available), "runner-memory-unavailable");
  memorySamples += 1;
  minimumAvailableKiB = Math.min(minimumAvailableKiB, available);
  failUnless(available >= 2 * 1024 * 1024, "runner-memory-below-2gib-safe-floor");
}

function adb(args) {
  try {
    const targetArgs = serial ? ["-s", serial, ...args] : args;
    return execFileSync("adb", targetArgs, { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch {
    throw new DiagnosticFailure("adb-command-failed");
  }
}

function setStage(value) {
  stageName = value;
  console.log(`STEP P20 React Native: ${value}`);
}

function uiNodes() {
  const dumpPath = "/sdcard/srd-p20-window.xml";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      adb(["shell", "rm", "-f", dumpPath]);
      const output = adb(["shell", "uiautomator", "dump", dumpPath]);
      if (output.toLowerCase().includes("dumped to")) {
        const xml = adb(["exec-out", "cat", dumpPath]);
        if (xml.includes("<hierarchy") && xml.includes("</hierarchy>")) {
          return [...xml.matchAll(/<node\b([^>]*?)\/?\s*>/g)].map((match) => {
            const node = {};
            for (const attribute of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) node[attribute[1]] = decodeXml(attribute[2]);
            return node;
          });
        }
      }
    } catch {
      // Retry only the UI hierarchy read; command errors are sanitized below.
    }
    if (attempt < 2) adb(["shell", "sleep", "1"]);
  }
  throw new DiagnosticFailure("android-ui-hierarchy-unavailable");
}

function bounds(node) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node?.bounds || "");
  if (!match) return null;
  return { left: Number(match[1]), top: Number(match[2]), right: Number(match[3]), bottom: Number(match[4]) };
}

function tapNode(node) {
  const rect = bounds(node);
  failUnless(rect && rect.right > rect.left && rect.bottom > rect.top, "android-ui-bounds-invalid");
  adb(["shell", "input", "tap", String(Math.floor((rect.left + rect.right) / 2)), String(Math.floor((rect.top + rect.bottom) / 2))]);
}

function scrollDown() {
  const nodes = uiNodes();
  lastUiLabels = safeUiLabels(nodes);
  lastUiDetails = safeUiDetails(nodes);
  lastEditableStates = safeEditableStates(nodes);
  const container = nodes.find((node) => node.class === "android.widget.ScrollView");
  const rect = bounds(container);
  failUnless(rect && rect.bottom > rect.top, "android-scroll-container-unavailable");
  const x = Math.floor((rect.left + rect.right) / 2);
  adb(["shell", "input", "swipe", String(x), String(Math.floor(rect.top + (rect.bottom - rect.top) * 0.8)), String(x), String(Math.floor(rect.top + (rect.bottom - rect.top) * 0.3)), "300"]);
}

async function waitForNode(label, { editable = false, scroll = false, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    sampleMemory();
    const nodes = uiNodes();
    lastUiLabels = safeUiLabels(nodes);
    lastUiDetails = safeUiDetails(nodes);
    lastEditableStates = safeEditableStates(nodes);
    const found = findNode(nodes, label, editable ? { editable: true } : {});
    if (found) return found;
    attempts += 1;
    if (scroll && attempts % 4 === 0) scrollDown();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new DiagnosticFailure(`ui-state-not-reached:${stageName}`);
}

async function tapLabel(label) {
  await waitForNode(label, { scroll: true });
  const { height } = (() => {
    const output = adb(["shell", "wm", "size"]);
    const match = /(?:Physical|Override) size:\s*(\d+)x(\d+)/.exec(output);
    failUnless(match, "android-screen-size-unavailable");
    return { height: Number(match[2]) };
  })();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const node = findNode(uiNodes(), label);
    const rect = bounds(node);
    if (rect && rect.top >= 0 && rect.bottom <= height - 110) {
      tapNode(node);
      await new Promise((resolve) => setTimeout(resolve, 350));
      return;
    }
    scrollDown();
  }
  throw new DiagnosticFailure("android-ui-action-not-visible");
}

async function typeField(label, value) {
  let field;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    field = findNode(uiNodes(), label, { editable: true });
    const rect = bounds(field);
    const sizeOutput = adb(["shell", "wm", "size"]);
    const size = /(?:Physical|Override) size:\s*(\d+)x(\d+)/.exec(sizeOutput);
    if (rect && size && rect.top >= 0 && rect.bottom <= Number(size[2]) - 110) break;
    scrollDown();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  failUnless(field && bounds(field), "android-editable-field-not-visible");
  tapNode(field);
  const previousLength = editableValue(field, label).length;
  if (previousLength > 0) adb(["shell", "input", "keyevent", "123", ...Array(previousLength).fill("67")]);
  if (value) adb(["shell", "input", "text", value]);
  adb(["shell", "input", "keyevent", "111"]);
  const verifyDeadline = Date.now() + 5000;
  while (Date.now() < verifyDeadline) {
    const current = findNode(uiNodes(), label, { editable: true });
    const actual = editableValue(current, label);
    const isPassword = /contrase(?:ña|Ã±a)|password/i.test(label);
    const masked = isPassword && [...actual].every((character) => ["\u2022", "\u25cf", "*"].includes(character));
    if (isPassword ? actual.length === value.length && (masked || actual === value) : actual === value) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new DiagnosticFailure("android-field-value-not-confirmed");
}

function mailpitMessages() {
  return fetch(new URL("/api/v1/messages", mailpit), { signal: AbortSignal.timeout(10000) })
    .then(async (response) => {
      failUnless(response.status === 200, "mailpit-unavailable");
      return (await response.json()).messages || [];
    });
}

async function waitForFreshMfa(email, previousIds) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    sampleMemory();
    const messages = await mailpitMessages();
    const message = messages.find((item) => !previousIds.has(item.ID)
      && item.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase()));
    if (message) {
      const response = await fetch(new URL(`/api/v1/message/${encodeURIComponent(message.ID)}`, mailpit), { signal: AbortSignal.timeout(10000) });
      failUnless(response.status === 200, "mailpit-message-unavailable");
      const detail = await response.json();
      const code = String(detail.Text || "").match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new DiagnosticFailure("fresh-mailpit-mfa-not-observed");
}

function writeJUnit() {
  fs.mkdirSync(path.dirname(junitPath), { recursive: true });
  const entries = [...cases];
  if (activeCase) entries.push({ name: activeCase, passed: result.passed, message: result.failure });
  if (!entries.length) entries.push({ name: `P20 ${profile.client} MFA diagnostic`, passed: result.passed, message: result.failure });
  const failures = entries.filter((entry) => !entry.passed).length;
  const casesXml = entries.map((entry) => `  <testcase classname="srd.p20.${profile.key}" name="${entry.name}">${entry.passed ? "" : `<failure message="${entry.message}"/>`}</testcase>`).join("\n");
  fs.writeFileSync(junitPath, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="SRD P20 ${profile.client} MFA diagnostic" tests="${entries.length}" failures="${failures}" errors="0" skipped="0">\n${casesXml}\n</testsuite>\n`, "utf8");
}

async function run() {
  failUnless(fs.existsSync(apkPath), "qa-apk-missing");
  failUnless(fs.existsSync(fixturePath), "synthetic-fixture-missing");
  failUnless(gateway.protocol === "http:" && ["127.0.0.1", "localhost"].includes(gateway.hostname), "qa-gateway-must-be-loopback");
  failUnless(androidOrigin === "http://10.0.2.2:8888", "android-origin-not-qa-proxy-alias");
  failUnless(mailpit.protocol === "http:" && ["127.0.0.1", "localhost"].includes(mailpit.hostname), "mailpit-must-be-loopback");
  failUnless(Number.isInteger(proxyPort) && proxyPort > 0 && proxyPort < 65536, "android-proxy-port-invalid");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const account = fixture[profile.accountKey];
  const organizationCodeA = resolveP20OrganizationCodeA(fixture);
  failUnless(account?.email === profile.expectedEmail && /^[0-9a-f-]{36}$/i.test(account.id || "")
    && typeof fixture.password === "string" && fixture.password.length >= 32
    && typeof organizationCodeA === "string", "synthetic-viewer-fixture-invalid");

  setStage("host-prelogin-precondition");
  const [csrf, me, existingMessages] = await Promise.all([
    fetch(new URL("/api/v1/csrf", gateway), { signal: AbortSignal.timeout(10000) }),
    fetch(new URL("/api/v1/me", gateway), { redirect: "manual", signal: AbortSignal.timeout(10000) }),
    mailpitMessages(),
  ]);
  failUnless(csrf.status === 200, "qa-host-csrf-precondition-failed");
  failUnless(me.status === 401, "qa-host-anonymous-session-precondition-failed");
  const previousIds = new Set(existingMessages.map((message) => message.ID));

  setStage("emulator-selection");
  const devices = execFileSync("adb", ["devices"], { encoding: "utf8", timeout: 30000 });
  const emulators = devices.split(/\r?\n/).filter((line) => /^emulator-\d+\s+device\b/.test(line));
  failUnless(emulators.length === 1, "expected-one-android-emulator");
  serial = emulators[0].split(/\s+/)[0];
  proxy = await startSanitizedAndroidProxy({ tracePath, port: proxyPort });
  setStage("install-and-launch-qa-apk");
  adb(["install", "-t", apkPath]);
  adb(["shell", "monkey", "-p", androidPackage, "-c", "android.intent.category.LAUNCHER", "1"]);
  await waitForNode("Código de junta", { editable: true });

  setStage("organization-selection");
  if (profile.requiresServerField) await typeField("Dirección del servidor", androidOrigin);
  await typeField("Código de junta", organizationCodeA);
  await tapLabel("Continuar");
  await waitForNode("Junta de prueba A");
  await tapLabel("Acepto los términos vigentes de mi junta");
  await waitForNode("☑");
  await typeField("Correo electrónico", account.email);
  await typeField("Contraseña", fixture.password);

  setStage("submit-real-android-login");
  const caseStarted = Date.now();
  await tapLabel("Ingresar");
  setStage("wait-for-real-mailpit-mfa-challenge");
  await waitForNode("Revisa tu correo", { timeoutMs: 30000 });
  freshMfaMailObserved = true;
  const otp = await waitForFreshMfa(account.email, previousIds);
  setStage("submit-real-mfa-code-in-android");
  await typeField("Código de verificación", otp);
  await tapLabel("Verificar y entrar");
  setStage("wait-for-authenticated-home");
  await waitForNode(profile.homeLabel);
  cases.push({ name: `${profile.key.toUpperCase()} reaches the real MFA challenge, receives new Mailpit mail and establishes a session`, passed: true });

  setStage("assert-sanitized-android-request-trace");
  const exchanges = proxy.events.filter((event) => event.event === "http_exchange");
  const login = exchanges.find((event) => event.method === "POST" && event.path === "/api/v1/auth/login");
  const verify = exchanges.find((event) => event.method === "POST" && event.path === "/api/v1/auth/verify");
  failUnless(Boolean(login), "android-login-request-not-captured-by-proxy");
  failUnless(login.status === 200, `android-login-http-${login.status}`);
  failUnless(login.requestHasSessionCookie && login.requestHasCsrfToken, "android-login-session-or-csrf-not-observed");
  failUnless(login.requestHasEmail && login.requestHasPassword, "android-login-fields-not-observed");
  failUnless(Boolean(verify) && verify.status === 200, "android-mfa-verification-not-captured-or-not-200");
  cases.push({ name: `Sanitized proxy correlates ${profile.key.toUpperCase()} CSRF, login, MFA and session HTTP exchanges`, passed: true });
  result.passed = true;
  result.failure = "";
  activeCase = "";
  console.log(`PASS P20 ${profile.client} real MFA; sanitized exchanges=${exchanges.length}; elapsedSeconds=${Math.round((Date.now() - caseStarted) / 1000)}`);
}

try {
  await run();
} catch (error) {
  result.failure = `${error instanceof DiagnosticFailure ? error.code : "unexpected-error"}:${stageName}`;
  console.error(`FAIL P20 React Native MFA: ${result.failure}`);
} finally {
  if (proxy) {
    try { await proxy.close(); } catch { /* The GitHub runner is discarded after this job. */ }
  }
  const screenshotMayContainMfaCode = [
    "submit-real-mfa-code-in-android",
    "wait-for-authenticated-home",
    "assert-sanitized-android-request-trace",
  ].includes(stageName);
  if (!result.passed && serial && !screenshotMayContainMfaCode) {
    try {
      const screenshot = execFileSync("adb", ["-s", serial, "exec-out", "screencap", "-p"], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
      if (screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        fs.mkdirSync(path.dirname(resourcesPath), { recursive: true });
        failureScreenshot = `p20-${profile.key}-failure.png`;
        fs.writeFileSync(path.join(path.dirname(resourcesPath), failureScreenshot), screenshot);
      }
    } catch { failureScreenshot = "capture-unavailable"; }
  } else if (!result.passed && serial && screenshotMayContainMfaCode) {
    failureScreenshot = "suppressed-sensitive-auth-state";
  }
  fs.mkdirSync(path.dirname(resourcesPath), { recursive: true });
  const minMemGiB = Number.isFinite(minimumAvailableKiB) ? (minimumAvailableKiB / 1024 / 1024).toFixed(2) : "unavailable";
  const traceEvents = proxy?.events || [];
  const loginEvent = traceEvents.find((event) => event.event === "http_exchange" && event.path === "/api/v1/auth/login");
  const verifyEvent = traceEvents.find((event) => event.event === "http_exchange" && event.path === "/api/v1/auth/verify");
  const summary = {
    client: profile.client,
    passed: result.passed,
    failure: result.failure || null,
    failureStage: stageName,
    freshMfaMailObserved,
    correlationId: proxy?.correlationId || null,
    proxyListeningPort: proxy?.port || null,
    deviceSystemProxyModified: false,
    exchangeCount: traceEvents.filter((event) => event.event === "http_exchange").length,
    loginStatus: loginEvent?.status ?? null,
    loginHasSessionCookie: loginEvent?.requestHasSessionCookie ?? false,
    loginHasCsrfToken: loginEvent?.requestHasCsrfToken ?? false,
    loginHasOrganizationContext: loginEvent?.requestHasOrganizationContext ?? false,
    loginTermsAccepted: loginEvent?.requestTermsAccepted ?? false,
    preloginMe401Observed: traceEvents.some((event) => event.event === "http_exchange" && event.method === "GET" && event.path === "/api/v1/me" && event.status === 401),
    authenticatedMeStatus: traceEvents.find((event) => event.event === "http_exchange" && event.method === "GET" && event.path === "/api/v1/me" && event.status === 200)?.status ?? null,
    loginMfaChallengeObserved: loginEvent?.responseHasMfaChallenge ?? false,
    mfaVerificationStatus: verifyEvent?.status ?? null,
    containsCredentialOtpCookieOrTokenValues: false,
  };
  fs.writeFileSync(path.join(path.dirname(tracePath), `p20-${profile.key}-mfa-summary.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(resourcesPath, `MemorySamples: ${memorySamples}\nMinimumMemAvailableGiB: ${minMemGiB}\nSafeFloorGiB: 2.00\nFailureScreenshot: ${failureScreenshot}\nDeviceSystemProxyModified: ${summary.deviceSystemProxyModified}\n`, "utf8");
  writeJUnit();
}

if (!result.passed) process.exitCode = 1;
