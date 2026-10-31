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
const junitCases = [];
let activeCase = "";
let currentStage = "startup";
let lastUiLabels = [];
let lastUiDetails = [];
let lastEditableStates = [];
let freshMfaMailObserved = "not-checked";
const sessionObservations = {
  viewerCanConsultPeople: "not-checked",
  viewerRegisterAction: "not-checked",
  afterBackground: "not-run",
  afterForceStop: "not-run",
  afterServerRevocation: "not-run",
  afterUiLogout: "not-run",
  afterLogoutForceStop: "not-run",
};
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
      return `${type} ${node.bounds || "[no-bounds]"} clickable=${node.clickable || "false"} enabled=${node.enabled || "false"} focused=${node["focused"] || "false"} ${safeLabel}`;
    })
    .filter(Boolean))]
    .slice(0, 50);
}

function safeEditableStates(nodes) {
  return nodes
    .filter((node) => /EditText$/.test(node.class || ""))
    .map((node) => {
      const label = (node["content-desc"] || node["hint"] || "field")
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
        .replace(/\b\d{6}\b/g, "[CODE]")
        .slice(0, 60);
      return `${label}: hasText=${Boolean(node.text)} enabled=${node.enabled || "false"} focused=${node.focused || "false"}`;
    })
    .slice(0, 12);
}

function findNode(nodes, label, { editable = false } = {}) {
  return nodes.find((node) => {
    const named = node.text === label || node["content-desc"] === label;
    return named && (!editable || /EditText$/.test(node.class || ""));
  });
}

function authUiState(nodes) {
  if (findNode(nodes, "Hola, Prueba Android")) return "authenticated-home";
  if (findNode(nodes, "Correo electrónico", { editable: true })) return "login-required";
  if (findNode(nodes, "Código de junta", { editable: true })) return "organization-selection";
  if (findNode(nodes, "Revisa tu correo")) return "mfa-challenge";
  if (nodes.some((node) => (node.text || "").includes("No se pudo comprobar la sesión"))) return "session-restore-error";
  return undefined;
}

async function waitForAuthUiState(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    sampleAvailableMemory();
    const nodes = uiNodes();
    lastUiLabels = safeUiLabels(nodes);
    lastUiDetails = safeUiDetails(nodes);
    lastEditableStates = safeEditableStates(nodes);
    const state = authUiState(nodes);
    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new TestFailure("android-auth-ui-state-not-observed");
}

function launchQaApp() {
  adb(["shell", "monkey", "-p", "com.srd.mobile.qa", "-c", "android.intent.category.LAUNCHER", "1"]);
}

function tapNode(node) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node?.bounds || "");
  assert(match, "ui-element-bounds-unavailable");
  const left = Math.min(Number(match[1]), Number(match[3]));
  const top = Math.min(Number(match[2]), Number(match[4]));
  const right = Math.max(Number(match[1]), Number(match[3]));
  const bottom = Math.max(Number(match[2]), Number(match[4]));
  assert(right > left && bottom > top, "ui-element-bounds-empty");
  const x = Math.floor((left + right) / 2);
  const y = Math.floor((top + bottom) / 2);
  adb(["shell", "input", "tap", String(x), String(y)]);
}

function displaySize() {
  const output = adb(["shell", "wm", "size"]);
  const match = /(?:Physical|Override) size:\s*(\d+)x(\d+)/.exec(output);
  assert(match, "android-display-size-unavailable");
  return {width: Number(match[1]), height: Number(match[2])};
}

function nodeBounds(node) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node?.bounds || "");
  if (!match) return undefined;
  return {
    left: Math.min(Number(match[1]), Number(match[3])),
    top: Math.min(Number(match[2]), Number(match[4])),
    right: Math.max(Number(match[1]), Number(match[3])),
    bottom: Math.max(Number(match[2]), Number(match[4])),
  };
}

function tapTargetForLabel(nodes, labelNode) {
  if (labelNode.clickable !== "false" && labelNode.enabled !== "false") return labelNode;
  const bounds = nodeBounds(labelNode);
  if (!bounds) return undefined;
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  return nodes
    .filter((node) => node.clickable === "true" && node.enabled !== "false")
    .filter((node) => {
      const candidate = nodeBounds(node);
      return candidate
        && centerX >= candidate.left && centerX <= candidate.right
        && centerY >= candidate.top && centerY <= candidate.bottom;
    })
    .sort((a, b) => {
      const first = nodeBounds(a);
      const second = nodeBounds(b);
      return (first.right - first.left) * (first.bottom - first.top)
        - (second.right - second.left) * (second.bottom - second.top);
    })[0];
}

function scrollDownOnePage() {
  const nodes = uiNodes();
  lastUiLabels = safeUiLabels(nodes);
  lastUiDetails = safeUiDetails(nodes);
  lastEditableStates = safeEditableStates(nodes);
  const scrollView = nodes.find((item) => item.class === "android.widget.ScrollView");
  const bounds = nodeBounds(scrollView);
  assert(bounds && bounds.right > bounds.left && bounds.bottom > bounds.top, "android-scroll-view-unavailable");
  const x = Math.floor((bounds.left + bounds.right) / 2);
  const startY = Math.floor(bounds.top + (bounds.bottom - bounds.top) * 0.78);
  const endY = Math.floor(bounds.top + (bounds.bottom - bounds.top) * 0.32);
  adb(["shell", "input", "swipe", String(x), String(startY), String(x), String(endY), "350"]);
}

async function tapVisibleLabel(label) {
  const {height} = displaySize();
  const safeBottom = height - 110;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const nodes = uiNodes();
    lastUiLabels = safeUiLabels(nodes);
    lastUiDetails = safeUiDetails(nodes);
    lastEditableStates = safeEditableStates(nodes);
    const labelNode = findNode(nodes, label);
    const node = labelNode && tapTargetForLabel(nodes, labelNode);
    if (labelNode && !node) throw new TestFailure("ui-action-parent-unavailable");
    if (node) {
      const bounds = nodeBounds(node);
      if (bounds && bounds.bottom > bounds.top && bounds.top >= 0 && bounds.bottom <= safeBottom) {
        assert(node.enabled !== "false", "ui-element-disabled");
        tapNode(node);
        await new Promise((resolve) => setTimeout(resolve, 400));
        return;
      }
    }
    scrollDownOnePage();
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new TestFailure("ui-element-not-visible-after-scroll");
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
  await waitForNode(label, { scroll: true });
  await tapVisibleLabel(label);
}

async function typeField(label, value) {
  tapNode(await waitForNode(label, { editable: true, scroll: true }));
  adb(["shell", "input", "text", value]);
  adb(["shell", "input", "keyevent", "111"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function replaceField(label, previousLength, value) {
  tapNode(await waitForNode(label, { editable: true, scroll: true }));
  adb(["shell", "input", "keyevent", "123", ...Array(previousLength).fill("67")]);
  if (value) adb(["shell", "input", "text", value]);
  adb(["shell", "input", "keyevent", "111"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function waitForEnabledLabel(label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    sampleAvailableMemory();
    const nodes = uiNodes();
    lastUiLabels = safeUiLabels(nodes);
    lastUiDetails = safeUiDetails(nodes);
    lastEditableStates = safeEditableStates(nodes);
    const node = findNode(nodes, label);
    if (node && node.enabled !== "false") return nodes;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new TestFailure("android-control-did-not-become-enabled");
}

function beginCase(name) {
  activeCase = name;
}

function passCase() {
  assert(activeCase, "android-junit-case-not-started");
  junitCases.push({ name: activeCase, passed: true });
  activeCase = "";
}

function assertSyntheticActiveSessions(fixtureUserId, expected) {
  if (process.env.SRD_ASSERT_FIXTURE_SESSIONS !== "1") return;
  const project = process.env.SRD_COMPOSE_PROJECT;
  assert(Boolean(project), "qa-compose-project-unavailable-for-session-probe");
  try {
    execFileSync("docker", [
      "compose", "--project-name", project,
      "--env-file", process.env.SRD_COMPOSE_ENV_FILE || "assembled/.env",
      "-f", process.env.SRD_COMPOSE_FILE || "assembled/compose.yaml",
      "exec", "-T", "-e", "SRD_ALLOW_MYSQL_FIXTURES=1", "identity", "php", "/tmp/srd-p14-session-state.php",
      fixtureUserId, String(expected),
    ], { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new TestFailure("synthetic-session-state-mismatch");
  }
}

function revokeSyntheticActiveSession(fixtureUserId) {
  const project = process.env.SRD_COMPOSE_PROJECT;
  assert(Boolean(project), "qa-compose-project-unavailable-for-session-revocation");
  try {
    execFileSync("docker", [
      "compose", "--project-name", project,
      "--env-file", process.env.SRD_COMPOSE_ENV_FILE || "assembled/.env",
      "-f", process.env.SRD_COMPOSE_FILE || "assembled/compose.yaml",
      "exec", "-T", "-e", "SRD_ALLOW_MYSQL_FIXTURES=1", "identity", "php", "/tmp/srd-p14-revoke-mobile-session.php",
      fixtureUserId,
    ], { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new TestFailure("synthetic-session-revocation-failed");
  }
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function writeJUnit() {
  fs.mkdirSync(path.dirname(junitPath), { recursive: true });
  const cases = [...junitCases];
  if (activeCase || !result.passed) {
    cases.push({ name: activeCase || result.name, passed: false, message: result.message });
  }
  if (cases.length === 0) cases.push({ name: result.name, passed: result.passed, message: result.message });
  const failures = cases.filter((testCase) => !testCase.passed).length;
  const testXml = cases.map((testCase) => {
    const failure = testCase.passed ? "" : `\n    <failure message="${xmlEscape(testCase.message || result.message)}"/>\n  `;
    return `  <testcase classname="srd.android" name="${xmlEscape(testCase.name)}">${failure}</testcase>`;
  }).join("\n");
  fs.writeFileSync(junitPath,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="SRD Android QA E2E" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">\n${testXml}\n</testsuite>\n`,
    { encoding: "utf8" });
}

async function getMailpitMessages() {
  const response = await fetch(new URL("/api/v1/messages", mailpit), { signal: AbortSignal.timeout(10000) });
  assert(response.status === 200, "mailpit-unavailable");
  return (await response.json()).messages || [];
}

async function assertNoFreshMfaMessage(email, previousIds) {
  const messages = await getMailpitMessages();
  const delivered = messages.some((item) => !previousIds.has(item.ID)
    && item.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase()));
  assert(!delivered, "unexpected-mfa-email-after-rejected-login");
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
  const mobileUserId = fixture.mobile_user?.id;
  const password = fixture.password;
  const organizationCode = fixture.codeA || "srd-e2e-a";
  assert(email === "android@srd-e2e.test" && /^[0-9a-f-]{36}$/i.test(mobileUserId || "")
    && typeof password === "string" && password.length >= 32, "synthetic-mobile-account-invalid");

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
  assertSyntheticActiveSessions(mobileUserId, 0);
  stage("locate-join-code-field");
  await waitForNode("C\u00f3digo de junta", { editable: true });
  console.log("PASS Android QA APK installed and launched");

  stage("enter-join-code");
  await typeField("C\u00f3digo de junta", organizationCode);
  stage("tap-continue-after-join-code");
  await tapLabel("Continuar");
  stage("wait-for-organization-card");
  await waitForNode("Junta de prueba A");
  stage("accept-organization-terms");
  await tapLabel("Acepto los t\u00e9rminos vigentes de mi junta");
  await waitForNode("\u2611");

  beginCase("Android form validation rejects empty credentials");
  stage("reject-empty-login-fields");
  await tapLabel("Ingresar");
  await waitForNode("Ingresa correo y contrase\u00f1a.");
  assert(authUiState(uiNodes()) === "login-required", "empty-login-left-login-screen");
  assertSyntheticActiveSessions(mobileUserId, 0);
  passCase();

  await typeField("Correo electr\u00f3nico", email);
  await typeField("Contrase\u00f1a", password);
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
  beginCase("Android rejects an incorrect MFA code and leaves the fixture session anonymous");
  stage("reject-incorrect-mfa-code");
  const wrongCode = `${code[0] === "9" ? "0" : String(Number(code[0]) + 1)}${code.slice(1)}`;
  await typeField("C\u00f3digo de verificaci\u00f3n", wrongCode);
  await tapLabel("Verificar y entrar");
  await waitForNode("Revisa los datos del formulario.");
  const invalidMfaNodes = await waitForEnabledLabel("Verificar y entrar");
  assert(authUiState(invalidMfaNodes) === "mfa-challenge", "invalid-mfa-left-challenge-screen-unverified");
  assert(!findNode(invalidMfaNodes, "Hola, Prueba Android"), "invalid-mfa-opened-authenticated-home");
  assertSyntheticActiveSessions(mobileUserId, 0);
  passCase();

  stage("enter-valid-mfa-code");
  await replaceField("C\u00f3digo de verificaci\u00f3n", 6, code);
  stage("submit-mfa-code");
  await tapLabel("Verificar y entrar");
  stage("wait-for-authenticated-home");
  await waitForNode("Hola, Prueba Android");
  assertSyntheticActiveSessions(mobileUserId, 1);
  stage("verify-people-section");
  await waitForNode("PERSONAS");
  const viewerHomeNodes = uiNodes();
  sessionObservations.viewerCanConsultPeople = String(Boolean(findNode(viewerHomeNodes, "Consultar personas")));
  sessionObservations.viewerRegisterAction = findNode(viewerHomeNodes, "Registrar persona") ? "visible" : "not-visible";
  assert(sessionObservations.viewerCanConsultPeople === "true", "viewer-people-read-action-not-visible");
  assert(sessionObservations.viewerRegisterAction === "not-visible", "viewer-register-action-visible");
  beginCase("Android completes real Mailpit MFA and shows viewer permissions in the native UI");
  passCase();

  stage("background-and-resume-session-observation");
  adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  launchQaApp();
  sessionObservations.afterBackground = await waitForAuthUiState();
  console.log(`OBS Android session after background: ${sessionObservations.afterBackground}`);

  stage("force-stop-and-relaunch-session-observation");
  adb(["shell", "am", "force-stop", "com.srd.mobile.qa"]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  launchQaApp();
  sessionObservations.afterForceStop = await waitForAuthUiState();
  console.log(`OBS Android session after force-stop: ${sessionObservations.afterForceStop}`);
  assert(sessionObservations.afterForceStop === "authenticated-home", "android-session-not-retained-before-revocation");

  beginCase("Android rejects a persisted session revoked directly by the server");
  stage("revoke-active-synthetic-session-on-server");
  revokeSyntheticActiveSession(mobileUserId);
  assertSyntheticActiveSessions(mobileUserId, 0);
  stage("verify-server-revocation-after-process-restart");
  adb(["shell", "am", "force-stop", "com.srd.mobile.qa"]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  launchQaApp();
  sessionObservations.afterServerRevocation = await waitForAuthUiState();
  assert(["login-required", "organization-selection"].includes(sessionObservations.afterServerRevocation), "server-revoked-session-restored-on-android");
  assertSyntheticActiveSessions(mobileUserId, 0);
  passCase();

  beginCase("Android reauthenticates after server revocation with one new session");
  const beforeReauthentication = new Set((await getMailpitMessages()).map((item) => item.ID));
  if (!findNode(uiNodes(), "\u2611")) {
    await tapLabel("Acepto los t\u00e9rminos vigentes de mi junta");
    await waitForNode("\u2611");
  }
  await typeField("Correo electr\u00f3nico", email);
  await typeField("Contrase\u00f1a", password);
  await tapLabel("Ingresar");
  await waitForNode("Revisa tu correo");
  const reauthenticationCode = await waitForMfaCode(email, beforeReauthentication);
  await typeField("C\u00f3digo de verificaci\u00f3n", reauthenticationCode);
  await tapLabel("Verificar y entrar");
  await waitForNode("Hola, Prueba Android");
  assertSyntheticActiveSessions(mobileUserId, 1);
  passCase();

  beginCase("Android logout revokes the active session and remains anonymous after restart");
  if (sessionObservations.afterForceStop === "authenticated-home") {
    stage("logout-from-android-ui");
    await tapLabel("Cerrar sesión");
    sessionObservations.afterUiLogout = await waitForAuthUiState();
    assert(["login-required", "organization-selection"].includes(sessionObservations.afterUiLogout), "android-logout-did-not-return-to-anonymous-ui");
    assertSyntheticActiveSessions(mobileUserId, 0);

    stage("verify-logout-after-process-restart");
    adb(["shell", "am", "force-stop", "com.srd.mobile.qa"]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    launchQaApp();
    sessionObservations.afterLogoutForceStop = await waitForAuthUiState();
    assert(sessionObservations.afterLogoutForceStop !== "authenticated-home", "android-session-survived-ui-logout-and-restart");
  } else {
    sessionObservations.afterUiLogout = "not-run-session-not-retained";
    sessionObservations.afterLogoutForceStop = "not-run-session-not-retained";
  }
  passCase();

  beginCase("Android rejects an incorrect password without opening MFA or creating a session");
  stage("reject-incorrect-password-after-valid-session-lifecycle");
  const beforeWrongPassword = new Set((await getMailpitMessages()).map((item) => item.ID));
  await replaceField("Correo electr\u00f3nico", email.length, email);
  await typeField("Contrase\u00f1a", `${password}x`);
  await tapLabel("Ingresar");
  await waitForNode("Debes iniciar sesi\u00f3n.");
  assert(authUiState(uiNodes()) === "login-required", "incorrect-password-opened-authenticated-flow");
  assertSyntheticActiveSessions(mobileUserId, 0);
  await assertNoFreshMfaMessage(email, beforeWrongPassword);
  passCase();

  beginCase("Android does not disclose whether an account exists");
  stage("reject-nonexistent-account");
  const beforeMissingAccount = new Set((await getMailpitMessages()).map((item) => item.ID));
  const missingEmail = "missing-account@srd-e2e.test";
  await replaceField("Correo electr\u00f3nico", email.length, missingEmail);
  await replaceField("Contrase\u00f1a", password.length + 1, password);
  await tapLabel("Ingresar");
  await waitForNode("Debes iniciar sesi\u00f3n.");
  assert(authUiState(uiNodes()) === "login-required", "nonexistent-account-opened-authenticated-flow");
  assertSyntheticActiveSessions(mobileUserId, 0);
  await assertNoFreshMfaMessage(email, beforeMissingAccount);
  passCase();

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
  const uiDiagnostics = result.passed ? "" : `FailureStage: ${currentStage}\nFreshMfaMailObserved: ${freshMfaMailObserved}\nVisibleLabels:\n${lastUiLabels.map((label) => `- ${label}`).join("\n")}\nVisibleNodeDetails:\n${lastUiDetails.map((detail) => `- ${detail}`).join("\n")}\nEditableStates:\n${lastEditableStates.map((state) => `- ${state}`).join("\n")}\n`;
  const sessionDiagnostics = Object.entries(sessionObservations).map(([key, value]) => `${key}: ${value}`).join("\n");
  fs.writeFileSync(resourcesPath, `Samples: ${memorySampleCount}\nMinimumMemAvailableGiB: ${minGiB}\nSafeFloorGiB: 2.00\n${sessionDiagnostics}\n${uiDiagnostics}`);
  writeJUnit();
}
