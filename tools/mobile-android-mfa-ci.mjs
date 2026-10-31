import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const apkPath = path.resolve(process.env.SRD_ANDROID_APK || "");
const fixturePath = path.resolve(process.env.SRD_FIXTURE_PATH || "");
const gateway = new URL(process.env.SRD_GATEWAY_URL || "http://127.0.0.1:8080");
const androidOrigin = process.env.SRD_ANDROID_GATEWAY_ORIGIN || "";
const mailpit = new URL(process.env.SRD_MAILPIT_URL || "http://127.0.0.1:8025");
const junitPath = path.resolve(process.env.SRD_ANDROID_JUNIT_PATH || "test-results/android-qa-e2e.junit.xml");
const resourcesPath = path.resolve(process.env.SRD_ANDROID_RESOURCES_PATH || "test-results/android-runner-resources.txt");
const result = { name: "Android QA app completes real Gateway login and Mailpit MFA", passed: false, message: "not-run" };
let currentStage = "startup";
let lastUiLabels = [];
let lastUiDetails = [];
let freshMfaMailObserved = "not-checked";
let selectedSerial = "";
let minimumAvailableKiB = Number.POSITIVE_INFINITY;
let memorySampleCount = 0;
let memoryInterval;

function sampleAvailableMemory() {
  const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
  const available = Number(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  assert(Number.isFinite(available), "runner-memory-measurement-unavailable");
  memorySampleCount += 1;
  minimumAvailableKiB = Math.min(minimumAvailableKiB, available);
  if (available < 2 * 1024 * 1024) throw new TestFailure("runner-memory-below-2gib-safe-floor");
}

class TestFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function assert(condition, code) {
  if (!condition) throw new TestFailure(code);
}

function stage(name) {
  currentStage = name;
  console.log(`STEP Android QA: ${name}`);
}

function adb(args) {
  try {
    const targetArgs = selectedSerial ? ["-s", selectedSerial, ...args] : args;
    return execFileSync("adb", targetArgs, { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch {
    throw new TestFailure("adb-command-failed");
  }
}

function decodeXml(value) {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function uiNodes() {
  adb(["shell", "uiautomator", "dump", "/sdcard/srd-window.xml"]);
  const xml = adb(["exec-out", "cat", "/sdcard/srd-window.xml"]);
  return [...xml.matchAll(/<node\b([^>]*?)\/?\s*>/g)].map((match) => {
    const node = {};
    for (const attribute of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) node[attribute[1]] = decodeXml(attribute[2]);
    return node;
  });
}

function safeUiLabels(nodes) {
  return [...new Set(nodes
    .filter((node) => !/EditText$/.test(node.class || ""))
    .map((node) => (node.text || node["content-desc"] || "").trim())
    .filter(Boolean)
    .map((label) => label
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
      .replace(/\b\d{6}\b/g, "[CODE]")
      .slice(0, 100)))]
    .slice(0, 40);
}

function safeUiDetails(nodes) {
  return [...new Set(nodes
    .filter((node) => !/EditText$/.test(node.class || ""))
    .map((node) => {
      const label = (node.text || node["content-desc"] || "").trim();
      if (!label) return "";
      const safeLabel = label
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
        .replace(/\b\d{6}\b/g, "[CODE]")
        .slice(0, 80);
      const type = (node.class || "node").split(".").at(-1);
      return `${type} ${node.bounds || "[no-bounds]"} ${safeLabel}`;
    })
    .filter(Boolean))]
    .slice(0, 50);
}

function findNode(nodes, label, { editable = false } = {}) {
  return nodes.find((node) => {
    const named = node.text === label || node["content-desc"] === label;
    return named && (!editable || /EditText$/.test(node.class || ""));
  });
}

function tapNode(node) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node?.bounds || "");
  assert(match, "ui-element-bounds-unavailable");
  const x = Math.floor((Number(match[1]) + Number(match[3])) / 2);
  const y = Math.floor((Number(match[2]) + Number(match[4])) / 2);
  adb(["shell", "input", "tap", String(x), String(y)]);
}

async function waitForNode(label, options = {}) {
  const deadline = Date.now() + 30000;
  let attempts = 0;
  while (Date.now() < deadline) {
    sampleAvailableMemory();
    const nodes = uiNodes();
    lastUiLabels = safeUiLabels(nodes);
    lastUiDetails = safeUiDetails(nodes);
    const node = findNode(nodes, label, options);
    if (node) return node;
    attempts += 1;
    if (options.scroll && attempts % 4 === 0) {
      const scrollView = nodes.find((item) => item.class === "android.widget.ScrollView");
      const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(scrollView?.bounds || "");
      if (bounds) {
        const x = Math.floor((Number(bounds[1]) + Number(bounds[3])) / 2);
        const top = Number(bounds[2]);
        const bottom = Number(bounds[4]);
        adb(["shell", "input", "swipe", String(x), String(Math.floor(top + (bottom - top) * 0.78)), String(x), String(Math.floor(top + (bottom - top) * 0.28)), "300"]);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new TestFailure("expected-ui-state-not-reached");
}

async function tapLabel(label) {
  tapNode(await waitForNode(label, { scroll: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function typeField(label, value) {
  tapNode(await waitForNode(label, { editable: true, scroll: true }));
  adb(["shell", "input", "text", value]);
  adb(["shell", "input", "keyevent", "111"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function writeJUnit() {
  fs.mkdirSync(path.dirname(junitPath), { recursive: true });
  const failure = result.passed ? "" : `  <failure message="${xmlEscape(result.message)}"/>`;
  fs.writeFileSync(junitPath,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="SRD Android QA E2E" tests="1" failures="${result.passed ? 0 : 1}" errors="0" skipped="0">\n  <testcase classname="srd.android" name="${xmlEscape(result.name)}">${failure}</testcase>\n</testsuite>\n`,
    { encoding: "utf8" });
}

async function getMailpitMessages() {
  const response = await fetch(new URL("/api/v1/messages", mailpit), { signal: AbortSignal.timeout(10000) });
  assert(response.status === 200, "mailpit-unavailable");
  return (await response.json()).messages || [];
}

async function waitForMfaCode(email, previousIds) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    sampleAvailableMemory();
    const messages = await getMailpitMessages();
    const message = messages.find((item) => !previousIds.has(item.ID) && item.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase()));
    if (message) {
      const response = await fetch(new URL(`/api/v1/message/${encodeURIComponent(message.ID)}`, mailpit), { signal: AbortSignal.timeout(10000) });
      assert(response.status === 200, "mailpit-message-unavailable");
      const detail = await response.json();
      const code = String(detail.Text || "").match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new TestFailure("mfa-message-timeout");
}

async function run() {
  assert(fs.existsSync(apkPath), "qa-apk-missing");
  assert(fs.existsSync(fixturePath), "synthetic-fixture-missing");
  assert(gateway.protocol === "http:" && ["127.0.0.1", "localhost"].includes(gateway.hostname), "host-gateway-must-be-loopback");
  assert(androidOrigin === "http://10.0.2.2:8080", "android-origin-must-target-qa-host-alias");
  assert(mailpit.protocol === "http:" && ["127.0.0.1", "localhost"].includes(mailpit.hostname), "mailpit-must-be-loopback");

  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const email = fixture.mobile_user?.email;
  const password = fixture.password;
  const organizationCode = fixture.codeA || "srd-e2e-a";
  assert(email === "android@srd-e2e.test" && typeof password === "string" && password.length >= 32, "synthetic-mobile-account-invalid");

  const [csrfResponse, sessionResponse, mailpitMessages] = await Promise.all([
    fetch(new URL("/api/v1/csrf", gateway), { signal: AbortSignal.timeout(10000) }),
    fetch(new URL("/api/v1/me", gateway), { redirect: "manual", signal: AbortSignal.timeout(10000) }),
    getMailpitMessages(),
  ]);
  assert(csrfResponse.status === 200, "host-gateway-csrf-failed");
  assert(sessionResponse.status === 401, "host-gateway-session-precondition-failed");
  const previousIds = new Set(mailpitMessages.map((item) => item.ID));
  sampleAvailableMemory();
  memoryInterval = setInterval(() => {
    try {
      sampleAvailableMemory();
    } catch {
      // The polling calls fail the test with the stable threshold code.
    }
  }, 1000);

  const deviceLines = adb(["devices"]).split(/\r?\n/).filter((line) => /^emulator-\d+\s+device\b/.test(line));
  assert(deviceLines.length === 1, "expected-one-android-emulator");
  selectedSerial = deviceLines[0].split(/\s+/)[0];
  stage("install-and-launch-apk");
  adb(["install", "-t", apkPath]);
  adb(["shell", "monkey", "-p", "com.srd.mobile.qa", "-c", "android.intent.category.LAUNCHER", "1"]);
  stage("locate-join-code-field");
  await waitForNode("C\u00f3digo de junta", { editable: true });
  console.log("PASS Android QA APK installed and launched");

  stage("enter-join-code");
  await typeField("C\u00f3digo de junta", organizationCode);
  stage("tap-continue-after-join-code");
  await tapLabel("Continuar");
  stage("wait-for-organization-card");
  await waitForNode("Junta de prueba A");
  stage("enter-account-email");
  await typeField("Correo electr\u00f3nico", email);
  stage("enter-account-password");
  await typeField("Contrase\u00f1a", password);
  stage("accept-organization-terms");
  await tapLabel("Acepto los t\u00e9rminos vigentes de mi junta");
  stage("confirm-terms-checkbox");
  await waitForNode("\u2611");
  stage("submit-login");
  await tapLabel("Ingresar");
  stage("wait-for-real-mfa-challenge");
  try {
    await waitForNode("Revisa tu correo");
  } catch (error) {
    try {
      const currentMessages = await getMailpitMessages();
      freshMfaMailObserved = String(currentMessages.some((item) => !previousIds.has(item.ID)
        && item.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase())));
    } catch {
      freshMfaMailObserved = "mailpit-unavailable";
    }
    throw error;
  }
  console.log("PASS Android QA reached the real MFA challenge");

  stage("wait-for-mailpit-mfa");
  const code = await waitForMfaCode(email, previousIds);
  stage("enter-mfa-code");
  await typeField("C\u00f3digo de verificaci\u00f3n", code);
  stage("submit-mfa-code");
  await tapLabel("Verificar y entrar");
  stage("wait-for-authenticated-home");
  await waitForNode("Hola, Prueba Android");
  stage("verify-people-section");
  await waitForNode("PERSONAS");
  result.passed = true;
  result.message = "";
  console.log("PASS Android QA authenticated through MySQL Identity, Mailpit MFA and the isolated Gateway");
}

try {
  await run();
} catch (error) {
  result.message = `${error instanceof TestFailure ? error.code : "unexpected-test-error"}:${currentStage}`;
  console.error(`FAIL Android QA E2E: ${result.message}`);
  process.exitCode = 1;
} finally {
  if (memoryInterval) clearInterval(memoryInterval);
  fs.mkdirSync(path.dirname(resourcesPath), { recursive: true });
  const minGiB = Number.isFinite(minimumAvailableKiB) ? (minimumAvailableKiB / 1024 / 1024).toFixed(2) : "unavailable";
  const uiDiagnostics = result.passed ? "" : `FailureStage: ${currentStage}\nFreshMfaMailObserved: ${freshMfaMailObserved}\nVisibleLabels:\n${lastUiLabels.map((label) => `- ${label}`).join("\n")}\nVisibleNodeDetails:\n${lastUiDetails.map((detail) => `- ${detail}`).join("\n")}\n`;
  fs.writeFileSync(resourcesPath, `Samples: ${memorySampleCount}\nMinimumMemAvailableGiB: ${minGiB}\nSafeFloorGiB: 2.00\n${uiDiagnostics}`);
  writeJUnit();
}
