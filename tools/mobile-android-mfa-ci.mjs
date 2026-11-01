import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  authUiState,
  decodeXml,
  editableValue,
  findNode,
  findNodeContaining,
  safeEditableStates,
  safeUiDetails,
  safeUiLabels,
} from "./mobile-android-ui.mjs";

const apkPath = path.resolve(process.env.SRD_ANDROID_APK || "");
const fixturePath = path.resolve(process.env.SRD_FIXTURE_PATH || "");
const gateway = new URL(process.env.SRD_GATEWAY_URL || "http://127.0.0.1:8080");
const androidOrigin = process.env.SRD_ANDROID_GATEWAY_ORIGIN || "";
const androidPackage = process.env.SRD_ANDROID_PACKAGE || "com.srd.mobile.qa";
const rejectedLoginMessage = process.env.SRD_ANDROID_REJECTED_LOGIN_MESSAGE || "Debes iniciar sesi\u00f3n.";
const isExpoClient = androidPackage === "com.srd.mobileexpo";
const junitSuiteName = isExpoClient ? "SRD Expo Android QA E2E" : "SRD Android QA E2E";
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
let failureScreenshot = "not-captured";
const sessionObservations = {
  viewerCanConsultPeople: "not-checked",
  viewerRegisterAction: "not-checked",
  afterBackground: "not-run",
  afterForceStop: "not-run",
  afterServerRevocation: "not-run",
  afterUiLogout: "not-run",
  afterLogoutForceStop: "not-run",
  expoAfterBackground: "not-run",
  expoAfterForceStop: "not-run",
  expoAfterServerRevocation: "not-run",
  expoAfterLogoutForceStop: "not-run",
  registrarRegistrationAction: "not-run",
  registrarPendingPersonCreated: "not-run",
  networkProbeMode: "ephemeral-qa-web-unavailable",
  networkWebStoppedForProbe: "not-run",
  networkWebRecoveredAfterProbe: "not-run",
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

function uiNodes() {
  const dumpPath = "/sdcard/srd-window.xml";
  let lastFailure = "android-ui-hierarchy-dump-unavailable";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      adb(["shell", "rm", "-f", dumpPath]);
      const dumpResult = adb(["shell", "uiautomator", "dump", dumpPath]);
      if (!dumpResult.toLowerCase().includes("dumped to")) {
        lastFailure = "android-ui-hierarchy-dump-unavailable";
      } else {
        const xml = adb(["exec-out", "cat", dumpPath]);
        if (xml.includes("<hierarchy") && xml.includes("</hierarchy>")) {
          return [...xml.matchAll(/<node\b([^>]*?)\/?\s*>/g)].map((match) => {
            const node = {};
            for (const attribute of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) node[attribute[1]] = decodeXml(attribute[2]);
            return node;
          });
        }
        lastFailure = "android-ui-hierarchy-dump-invalid";
      }
    } catch (error) {
      lastFailure = error instanceof TestFailure ? "android-ui-hierarchy-dump-unavailable" : "android-ui-hierarchy-dump-invalid";
    }
    if (attempt < 2) {
      try {
        adb(["shell", "sleep", "1"]);
      } catch {
        // Retry the dump once more; a persistent transport error remains a test failure.
      }
    }
  }
  throw new TestFailure(lastFailure);
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
  adb(["shell", "monkey", "-p", androidPackage, "-c", "android.intent.category.LAUNCHER", "1"]);
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
    const node = options.contains ? findNodeContaining(nodes, label) : findNode(nodes, label, options);
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

async function waitForEditableFieldOnScreen(label) {
  const {height} = displaySize();
  const safeBottom = height - 110;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nodes = uiNodes();
    lastUiLabels = safeUiLabels(nodes);
    lastUiDetails = safeUiDetails(nodes);
    lastEditableStates = safeEditableStates(nodes);
    const field = findNode(nodes, label, { editable: true });
    const bounds = nodeBounds(field);
    if (bounds && bounds.top >= 0 && bounds.bottom <= safeBottom && bounds.bottom > bounds.top) return field;
    scrollDownOnePage();
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new TestFailure("android-editable-field-not-visible");
}

async function waitForFieldValue(label, expected) {
  const deadline = Date.now() + 5000;
  const isSensitive = /contraseña|password/i.test(label);
  while (Date.now() < deadline) {
    const field = findNode(uiNodes(), label, { editable: true });
    const actual = editableValue(field, label);
    const masked = isSensitive && actual.length > 0 && [...actual].every((character) => ["\u2022", "\u25cf", "*"].includes(character));
    const matches = isSensitive
      ? (expected ? actual.length === expected.length && (masked || actual === expected) : actual.length === 0)
      : actual === expected;
    if (matches) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new TestFailure("android-field-value-not-confirmed");
}

async function typeField(label, value) {
  tapNode(await waitForEditableFieldOnScreen(label));
  adb(["shell", "input", "text", value]);
  adb(["shell", "input", "keyevent", "111"]);
  await waitForFieldValue(label, value);
}

async function replaceField(label, previousLength, value) {
  tapNode(await waitForEditableFieldOnScreen(label));
  adb(["shell", "input", "keyevent", "123", ...Array(previousLength).fill("67")]);
  if (value) adb(["shell", "input", "text", value]);
  adb(["shell", "input", "keyevent", "111"]);
  await waitForFieldValue(label, value);
}

async function replaceFieldWithCurrentValue(label, value) {
  const field = await waitForEditableFieldOnScreen(label);
  const previousLength = editableValue(field, label).length;
  tapNode(field);
  if (previousLength) adb(["shell", "input", "keyevent", "123", ...Array(previousLength).fill("67")]);
  if (value) adb(["shell", "input", "text", value]);
  adb(["shell", "input", "keyevent", "111"]);
  await waitForFieldValue(label, value);
}

async function ensureOrganizationTermsAccepted() {
  if (findNode(uiNodes(), "\u2611")) return;
  await tapLabel("Acepto los t\u00e9rminos vigentes de mi junta");
  await waitForNode("\u2611");
}

async function verifyEmptyLoginForm(fixtureUserId, organizationCode) {
  stage("reject-empty-login-fields");
  stage("clear-local-state-before-empty-login");
  const clearResult = adb(["shell", "pm", "clear", androidPackage]);
  assert(/success/i.test(clearResult), "android-empty-form-state-clear-failed");
  launchQaApp();
  stage("open-join-code-after-empty-login-reset");
  await waitForNode("Código de junta", { editable: true });
  if (isExpoClient && findNode(uiNodes(), "Dirección del servidor", {editable: true})) {
    stage("restore-qa-gateway-origin-after-empty-login-reset");
    await typeField("Dirección del servidor", androidOrigin);
  }
  stage("enter-synthetic-organization-after-empty-login-reset");
  await typeField("Código de junta", organizationCode);
  stage("submit-synthetic-organization-after-empty-login-reset");
  await tapLabel("Continuar");
  stage("wait-for-organization-after-empty-login-reset");
  await waitForNode("Junta de prueba A");
  stage("accept-organization-terms-after-empty-login-reset");
  await tapLabel("Acepto los términos vigentes de mi junta");
  await waitForNode("\u2611");
  stage("verify-empty-login-form");
  const loginState = await waitForAuthUiState();
  assert(loginState === "login-required", "empty-login-form-did-not-start-anonymous");
  await waitForEditableFieldOnScreen("Correo electr\u00f3nico");
  await waitForEditableFieldOnScreen("Contrase\u00f1a");
  await waitForFieldValue("Correo electr\u00f3nico", "");
  await waitForFieldValue("Contrase\u00f1a", "");
  await ensureOrganizationTermsAccepted();
  await tapLabel("Ingresar");
  await waitForNode("Ingresa correo y contrase\u00f1a.");
  assert(authUiState(uiNodes()) === "login-required", "empty-login-left-login-screen");
  assertSyntheticActiveSessions(fixtureUserId, 0);
  passCase();
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

async function waitWithMemorySampling(durationMs) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    sampleAvailableMemory();
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
  }
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

function manageSyntheticLoginChallenge(action, fixtureUserId, challengeId = "") {
  const project = process.env.SRD_COMPOSE_PROJECT;
  assert(Boolean(project), "qa-compose-project-unavailable-for-challenge-fixture");
  try {
    return execFileSync("docker", [
      "compose", "--project-name", project,
      "--env-file", process.env.SRD_COMPOSE_ENV_FILE || "assembled/.env",
      "-f", process.env.SRD_COMPOSE_FILE || "assembled/compose.yaml",
      "exec", "-T", "-e", "SRD_ALLOW_MYSQL_FIXTURES=1", "identity", "php", "/tmp/srd-p14-mobile-challenge.php",
      action, fixtureUserId, challengeId,
    ], { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 }).trim();
  } catch {
    throw new TestFailure("synthetic-login-challenge-fixture-failed");
  }
}

function expireSyntheticPendingLoginChallenge(fixtureUserId) {
  const output = manageSyntheticLoginChallenge("expire", fixtureUserId);
  const challengeId = output.match(/^[0-9a-f-]{36}$/i)?.[0];
  assert(Boolean(challengeId), "synthetic-pending-login-challenge-unavailable");
  return challengeId;
}

function assertSyntheticLoginChallengeConsumed(fixtureUserId, challengeId) {
  manageSyntheticLoginChallenge("assert-consumed", fixtureUserId, challengeId);
}

function qaCompose(args) {
  const project = process.env.SRD_COMPOSE_PROJECT;
  assert(Boolean(project), "qa-compose-project-unavailable-for-endpoint-outage-probe");
  const envFile = process.env.SRD_COMPOSE_ENV_FILE || "assembled/.env";
  const composeFile = process.env.SRD_COMPOSE_FILE || "assembled/compose.yaml";
  try {
    return execFileSync("docker", [
      "compose", "--project-name", project, "--env-file", envFile,
      "-f", composeFile, ...args,
    ], { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 }).trim();
  } catch {
    throw new TestFailure("ephemeral-qa-web-endpoint-outage-control-failed");
  }
}

async function waitForQaWebApi() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/api/v1/csrf", gateway), { signal: AbortSignal.timeout(2500) });
      if (response.status === 200) {
        sessionObservations.networkWebRecoveredAfterProbe = "yes";
        return;
      }
    } catch {
      // The host-published web service may need a few seconds to restart.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new TestFailure("ephemeral-qa-web-api-not-ready-after-endpoint-outage-probe");
}

async function setQaWebAvailable(available) {
  if (available) {
    qaCompose(["start", "web"]);
    await waitForQaWebApi();
    return;
  }
  qaCompose(["stop", "web"]);
  sessionObservations.networkWebStoppedForProbe = "yes";
}

async function verifyQaWebEndpointRecovery(openPeopleListLabel, fixtureUserId, searchQuery = "") {
  stage("open-people-list-before-qa-web-endpoint-outage");
  await tapLabel(openPeopleListLabel);
  await waitForNode("Busca por nombre, apellido o número de documento.");
  if (searchQuery) await typeField("Buscar personas", searchQuery);
  stage("verify-people-read-before-qa-web-endpoint-outage");
  await tapLabel("Buscar");
  await waitForEnabledLabel("Buscar");
  await waitForNode("resultado(s)", {contains: true});
  if (searchQuery) await waitForNode("1 resultado(s)");

  let webEndpointStopAttempted = false;
  let probeError;
  let probeFailureStage = "";
  try {
    stage("stop-ephemeral-qa-web-endpoint-for-outage-probe");
    webEndpointStopAttempted = true;
    await setQaWebAvailable(false);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    stage("repeat-people-search-while-qa-web-endpoint-unavailable");
    await tapLabel("Buscar");
    await waitForNode("No hay conexión con el servidor. Comprueba su dirección y tu red.", {scroll: true});
    assertSyntheticActiveSessions(fixtureUserId, 1);
  } catch (error) {
    probeError = error;
    probeFailureStage = currentStage;
  } finally {
    if (webEndpointStopAttempted) {
      stage("restore-ephemeral-qa-web-endpoint-in-finally");
      try {
        await setQaWebAvailable(true);
      } catch (error) {
        if (!probeError) {
          probeError = error;
          probeFailureStage = currentStage;
        }
      }
    }
  }
  if (probeError) {
    currentStage = probeFailureStage;
    throw probeError;
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));
  stage("retry-idempotent-people-read-after-qa-web-endpoint-restoration");
  await tapLabel("Buscar");
  await waitForEnabledLabel("Buscar");
  await waitForNode("resultado(s)", {contains: true});
  if (searchQuery) await waitForNode("1 resultado(s)");
  assert(!findNode(uiNodes(), "No hay conexión con el servidor. Comprueba su dirección y tu red."), "network-error-remained-after-restoration");
  assertSyntheticActiveSessions(fixtureUserId, 1);
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
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${junitSuiteName}" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">\n${testXml}\n</testsuite>\n`,
    { encoding: "utf8" });
}

async function getMailpitMessages() {
  const response = await fetch(new URL("/api/v1/messages", mailpit), { signal: AbortSignal.timeout(10000) });
  assert(response.status === 200, "mailpit-unavailable");
  return (await response.json()).messages || [];
}

async function observeFreshMfaMessage(email, previousIds) {
  try {
    const messages = await getMailpitMessages();
    return String(messages.some((item) => !previousIds.has(item.ID)
      && item.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase())));
  } catch {
    return "mailpit-unavailable";
  }
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
  const registrarEmail = fixture.mobile_registrar_user?.email;
  const registrarUserId = fixture.mobile_registrar_user?.id;
  const password = fixture.password;
  const organizationCode = fixture.codeA || "srd-e2e-a";
  assert(email === "android@srd-e2e.test" && /^[0-9a-f-]{36}$/i.test(mobileUserId || "")
    && registrarEmail === "android-registrar@srd-e2e.test" && /^[0-9a-f-]{36}$/i.test(registrarUserId || "")
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
  launchQaApp();
  assertSyntheticActiveSessions(mobileUserId, 0);
  stage("locate-join-code-field");
  await waitForNode("C\u00f3digo de junta", { editable: true });
  console.log("PASS Android QA APK installed and launched");

  if (isExpoClient && findNode(uiNodes(), "Direcci\u00f3n del servidor", {editable: true})) {
    stage("enter-qa-gateway-origin");
    await typeField("Direcci\u00f3n del servidor", androidOrigin);
  }

  stage("enter-join-code");
  await typeField("C\u00f3digo de junta", organizationCode);
  stage("tap-continue-after-join-code");
  await tapLabel("Continuar");
  stage("wait-for-organization-card");
  await waitForNode("Junta de prueba A");
  stage("accept-organization-terms");
  await tapLabel("Acepto los t\u00e9rminos vigentes de mi junta");
  await waitForNode("\u2611");

  await replaceFieldWithCurrentValue("Correo electr\u00f3nico", email);
  await replaceFieldWithCurrentValue("Contrase\u00f1a", password);
  stage("submit-login");
  await tapLabel("Ingresar");
  stage("wait-for-real-mfa-challenge");
  try {
    await waitForNode("Revisa tu correo");
  } catch (error) {
    freshMfaMailObserved = await observeFreshMfaMessage(email, previousIds);
    throw error;
  }
  const mfaNodes = uiNodes();
  const resendControl = findNode(mfaNodes, "Reenviar código");
  assert(resendControl?.enabled === "false", "mfa-resend-control-not-accessibly-disabled");
  assert(!findNodeContaining(mfaNodes, "Reenviar en"), "mfa-countdown-remains-in-accessibility-tree");
  await waitForNode("Código de verificación", {editable: true});
  console.log("PASS Android QA reached the real MFA challenge with a stable accessible resend control");

  stage("wait-for-mailpit-mfa");
  const code = await waitForMfaCode(email, previousIds);
  if (isExpoClient) {
    beginCase("Expo SDK 58 rejects an incorrect MFA code without creating a session");
    stage("reject-incorrect-expo-mfa-code");
    const wrongExpoCode = `${code[0] === "9" ? "0" : String(Number(code[0]) + 1)}${code.slice(1)}`;
    await typeField("C\u00f3digo de verificaci\u00f3n", wrongExpoCode);
    await tapLabel("Verificar y entrar");
    await waitForNode("Revisa los datos del formulario.");
    const rejectedExpoMfaNodes = await waitForEnabledLabel("Verificar y entrar");
    assert(authUiState(rejectedExpoMfaNodes) === "mfa-challenge", "expo-invalid-mfa-left-challenge-screen-unverified");
    assert(!findNode(rejectedExpoMfaNodes, "Hola, Prueba Android"), "expo-invalid-mfa-opened-authenticated-home");
    assertSyntheticActiveSessions(mobileUserId, 0);
    passCase();

    beginCase("Expo SDK 58 completes real Gateway and Mailpit MFA and renders viewer permissions");
    stage("submit-valid-expo-mfa-code");
    await replaceField("C\u00f3digo de verificaci\u00f3n", wrongExpoCode.length, code);
    await tapLabel("Verificar y entrar");
    await waitForNode("Hola, Prueba Android");
    assertSyntheticActiveSessions(mobileUserId, 1);
    const viewerHomeNodes = uiNodes();
    sessionObservations.viewerCanConsultPeople = String(Boolean(findNodeContaining(viewerHomeNodes, "Personas")));
    sessionObservations.viewerRegisterAction = findNodeContaining(viewerHomeNodes, "Registrar persona") ? "visible" : "not-visible";
    assert(sessionObservations.viewerCanConsultPeople === "true", "expo-viewer-people-action-not-visible");
    assert(sessionObservations.viewerRegisterAction === "not-visible", "expo-viewer-register-action-visible");
    passCase();

    beginCase("Expo SDK 58 restores its authenticated session after background and process death");
    stage("expo-background-and-resume-session-observation");
    adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    launchQaApp();
    sessionObservations.expoAfterBackground = await waitForAuthUiState();
    assert(sessionObservations.expoAfterBackground === "authenticated-home", "expo-session-not-restored-after-background");

    stage("expo-force-stop-and-relaunch-session-observation");
    adb(["shell", "am", "force-stop", androidPackage]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    launchQaApp();
    sessionObservations.expoAfterForceStop = await waitForAuthUiState();
    assert(sessionObservations.expoAfterForceStop === "authenticated-home", "expo-session-not-restored-after-force-stop");
    assertSyntheticActiveSessions(mobileUserId, 1);
    passCase();

    beginCase("Expo SDK 58 rejects a persisted session revoked by the server");
    stage("expo-revoke-active-synthetic-session-on-server");
    revokeSyntheticActiveSession(mobileUserId);
    assertSyntheticActiveSessions(mobileUserId, 0);
    stage("expo-verify-server-revocation-after-process-restart");
    adb(["shell", "am", "force-stop", androidPackage]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    launchQaApp();
    sessionObservations.expoAfterServerRevocation = await waitForAuthUiState();
    assert(["login-required", "organization-selection"].includes(sessionObservations.expoAfterServerRevocation), "expo-server-revoked-session-restored");
    assertSyntheticActiveSessions(mobileUserId, 0);
    passCase();

    beginCase("Expo SDK 58 reauthenticates after server revocation with one new session");
    stage("expo-reauthenticate-after-server-revocation");
    const beforeExpoReauthentication = new Set((await getMailpitMessages()).map((item) => item.ID));
    await ensureOrganizationTermsAccepted();
    await replaceField("Correo electr\u00f3nico", email.length, email);
    await replaceField("Contrase\u00f1a", password.length + 1, password);
    await tapLabel("Ingresar");
    await waitForNode("Revisa tu correo");
    const expoReauthenticationCode = await waitForMfaCode(email, beforeExpoReauthentication);
    stage("wait-for-server-defined-expo-mfa-resend-cooldown-before-reauthentication");
    await waitForEnabledLabel("Reenviar c\u00f3digo", 70000);
    await typeField("C\u00f3digo de verificaci\u00f3n", expoReauthenticationCode);
    await tapLabel("Verificar y entrar");
    await waitForNode("Hola, Prueba Android");
    assertSyntheticActiveSessions(mobileUserId, 1);
    passCase();

    beginCase("Expo SDK 58 handles QA Web endpoint outage and recovers a safe read after restoration");
    await verifyQaWebEndpointRecovery("Personas", mobileUserId);
    passCase();

    beginCase("Expo SDK 58 logout revokes its session across process restart");
    stage("return-to-home-before-expo-logout");
    await tapLabel("Volver al resumen");
    await waitForNode("Hola, Prueba Android");
    stage("logout-from-expo-ui");
    await tapLabel("Cerrar sesi\u00f3n");
    sessionObservations.afterUiLogout = await waitForAuthUiState();
    assert(["login-required", "organization-selection"].includes(sessionObservations.afterUiLogout), "expo-logout-did-not-return-to-anonymous-ui");
    assertSyntheticActiveSessions(mobileUserId, 0);
    stage("expo-verify-logout-after-process-restart");
    adb(["shell", "am", "force-stop", androidPackage]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    launchQaApp();
    sessionObservations.expoAfterLogoutForceStop = await waitForAuthUiState();
    assert(["login-required", "organization-selection"].includes(sessionObservations.expoAfterLogoutForceStop), "expo-session-survived-logout-and-restart");
    assertSyntheticActiveSessions(mobileUserId, 0);
    passCase();

    beginCase("Expo SDK 58 keeps empty login credentials on the login form");
    await verifyEmptyLoginForm(mobileUserId, organizationCode);

    result.passed = true;
    result.message = "";
    console.log("PASS Expo SDK 58 authenticated through isolated Gateway and real Mailpit MFA; viewer scope and logout verified");
    return;
  }

  beginCase("Android rejects an expired real MFA challenge without creating a session");
  stage("expire-only-the-pending-synthetic-login-challenge");
  const expiredChallengeId = expireSyntheticPendingLoginChallenge(mobileUserId);
  stage("submit-the-expired-mfa-code-through-android");
  await typeField("C\u00f3digo de verificaci\u00f3n", code);
  await tapLabel("Verificar y entrar");
  await waitForNode("Revisa los datos del formulario.");
  assert(authUiState(uiNodes()) === "mfa-challenge", "expired-mfa-left-challenge-screen-unverified");
  assertSyntheticActiveSessions(mobileUserId, 0);
  passCase();

  beginCase("Android respects the MFA resend cooldown and receives a replacement challenge");
  stage("observe-server-defined-mfa-resend-cooldown");
  await waitWithMemorySampling(30000);
  const resendNodesAfterThirtySeconds = uiNodes();
  assert(findNode(resendNodesAfterThirtySeconds, "Reenviar c\u00f3digo")?.enabled === "false", "mfa-resend-enabled-before-cooldown");
  await waitWithMemorySampling(31000);
  await waitForEnabledLabel("Reenviar c\u00f3digo", 10000);
  const messagesBeforeResend = new Set((await getMailpitMessages()).map((item) => item.ID));
  stage("request-server-approved-mfa-resend-from-android");
  await tapLabel("Reenviar c\u00f3digo");
  await waitForNode("Enviamos un nuevo c\u00f3digo. El anterior ya no funciona.");
  const replacementCode = await waitForMfaCode(email, messagesBeforeResend);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const resendMessages = (await getMailpitMessages()).filter((item) => !messagesBeforeResend.has(item.ID)
    && item.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase()));
  assert(resendMessages.length === 1, "mfa-resend-created-duplicate-messages");
  assertSyntheticLoginChallengeConsumed(mobileUserId, expiredChallengeId);
  assertSyntheticActiveSessions(mobileUserId, 0);
  passCase();

  beginCase("Android rejects an incorrect MFA code and leaves the fixture session anonymous");
  stage("reject-incorrect-mfa-code");
  const wrongCode = `${replacementCode[0] === "9" ? "0" : String(Number(replacementCode[0]) + 1)}${replacementCode.slice(1)}`;
  await typeField("C\u00f3digo de verificaci\u00f3n", wrongCode);
  await tapLabel("Verificar y entrar");
  await waitForNode("Revisa los datos del formulario.");
  const invalidMfaNodes = await waitForEnabledLabel("Verificar y entrar");
  assert(authUiState(invalidMfaNodes) === "mfa-challenge", "invalid-mfa-left-challenge-screen-unverified");
  assert(!findNode(invalidMfaNodes, "Hola, Prueba Android"), "invalid-mfa-opened-authenticated-home");
  assertSyntheticActiveSessions(mobileUserId, 0);
  passCase();

  stage("enter-valid-mfa-code");
  await replaceField("C\u00f3digo de verificaci\u00f3n", 6, replacementCode);
  stage("submit-mfa-code");
  await tapLabel("Verificar y entrar");
  stage("wait-for-authenticated-home");
  await waitForNode("Hola, Prueba Android");
  assertSyntheticActiveSessions(mobileUserId, 1);
  stage("verify-people-section");
  const viewerHomeNodes = uiNodes();
  const peopleAction = isExpoClient
    ? findNodeContaining(viewerHomeNodes, "Personas")
    : findNode(viewerHomeNodes, "Consultar personas");
  sessionObservations.viewerCanConsultPeople = String(Boolean(peopleAction));
  sessionObservations.viewerRegisterAction = findNodeContaining(viewerHomeNodes, "Registrar persona") ? "visible" : "not-visible";
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
  adb(["shell", "am", "force-stop", androidPackage]);
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
  adb(["shell", "am", "force-stop", androidPackage]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  launchQaApp();
  sessionObservations.afterServerRevocation = await waitForAuthUiState();
  assert(["login-required", "organization-selection"].includes(sessionObservations.afterServerRevocation), "server-revoked-session-restored-on-android");
  assertSyntheticActiveSessions(mobileUserId, 0);
  passCase();

  beginCase("Android reauthenticates the revoked viewer after server revocation with one new session");
  stage("reauthenticate-after-server-revocation");
  const beforeReauthentication = new Set((await getMailpitMessages()).map((item) => item.ID));
  await ensureOrganizationTermsAccepted();
  await replaceField("Correo electr\u00f3nico", email.length, email);
  await replaceField("Contrase\u00f1a", password.length, password);
  await tapLabel("Ingresar");
  stage("wait-for-reauthentication-mfa-challenge");
  try {
    await waitForNode("Revisa tu correo");
  } catch (error) {
    freshMfaMailObserved = await observeFreshMfaMessage(email, beforeReauthentication);
    throw error;
  }
  const reauthenticationCode = await waitForMfaCode(email, beforeReauthentication);
  await typeField("C\u00f3digo de verificaci\u00f3n", reauthenticationCode);
  await tapLabel("Verificar y entrar");
  await waitForNode("Hola, Prueba Android");
  assertSyntheticActiveSessions(mobileUserId, 1);
  passCase();

  beginCase("Android registrar account completes real MFA and receives registrar permissions");
  stage("logout-reauthenticated-viewer-before-registrar-login");
  await tapLabel("Cerrar sesi\u00f3n");
  const viewerAfterLogout = await waitForAuthUiState();
  assert(["login-required", "organization-selection"].includes(viewerAfterLogout), "viewer-logout-did-not-return-to-anonymous-ui");
  assertSyntheticActiveSessions(mobileUserId, 0);

  stage("clear-local-auth-state-before-registrar-fixture-login");
  const clearResult = adb(["shell", "pm", "clear", androidPackage]);
  assert(/success/i.test(clearResult), "android-local-state-clear-failed");
  launchQaApp();
  await waitForNode("C\u00f3digo de junta", { editable: true });
  await typeField("C\u00f3digo de junta", organizationCode);
  await tapLabel("Continuar");
  await waitForNode("Junta de prueba A");
  await tapLabel("Acepto los t\u00e9rminos vigentes de mi junta");
  await waitForNode("\u2611");
  assertSyntheticActiveSessions(registrarUserId, 0);

  const beforeRegistrarLogin = new Set((await getMailpitMessages()).map((item) => item.ID));
  let activeLoginEmail = registrarEmail;
  await typeField("Correo electr\u00f3nico", registrarEmail);
  await typeField("Contrase\u00f1a", password);
  stage("submit-registrar-login-after-clean-app-state");
  await tapLabel("Ingresar");
  stage("wait-for-registrar-mfa-challenge");
  try {
    await waitForNode("Revisa tu correo");
  } catch (error) {
    freshMfaMailObserved = await observeFreshMfaMessage(registrarEmail, beforeRegistrarLogin);
    throw error;
  }
  const registrarLoginCode = await waitForMfaCode(registrarEmail, beforeRegistrarLogin);
  await typeField("C\u00f3digo de verificaci\u00f3n", registrarLoginCode);
  await tapLabel("Verificar y entrar");
  await waitForNode("Hola, Prueba Android Registrador");
  assertSyntheticActiveSessions(registrarUserId, 1);

  stage("verify-registrar-person-create-permission-after-reauthentication");
  const registrarCreateAction = await waitForNode("Registrar persona", {contains: true, scroll: true});
  sessionObservations.registrarRegistrationAction = String(Boolean(registrarCreateAction));
  assert(sessionObservations.registrarRegistrationAction === "true", "registrar-person-create-action-not-visible");
  passCase();

  beginCase("Android registrar creates and reopens a pending person through the real Gateway");
  stage("open-registrar-person-form");
  const syntheticDocumentNumber = `P15-${Date.now()}`;
  await tapLabel("Registrar persona");
  await waitForNode("N\u00famero de documento *", { editable: true, scroll: true });
  await typeField("N\u00famero de documento *", syntheticDocumentNumber);
  await typeField("Nombres *", "PruebaP15");
  await typeField("Apellidos", "RegistrarAndroid");
  await typeField("Fundamento o referencia del soporte *", "AutorizacionSinteticaP15");
  await typeField("Finalidad de la captura *", "ValidarAltaMovilP15");
  stage("submit-synthetic-pending-person-from-android");
  await tapLabel("Guardar como pendiente");
  await waitForNode("Persona registrada");
  sessionObservations.registrarPendingPersonCreated = "true";
  assertSyntheticActiveSessions(registrarUserId, 1);
  await tapLabel("Ver ficha");
  await waitForNode(syntheticDocumentNumber, { contains: true });
  await tapLabel("Volver al registro guardado");
  await waitForNode("Persona registrada");
  await tapLabel("Volver al resumen");
  await waitForNode("Hola, Prueba Android Registrador");
  passCase();

  beginCase("React Native handles QA Web endpoint outage and recovers a safe read after restoration");
  await verifyQaWebEndpointRecovery("Consultar personas", registrarUserId, syntheticDocumentNumber);
  passCase();

  beginCase("Android logout revokes the active session and remains anonymous after restart");
  if (sessionObservations.afterForceStop === "authenticated-home") {
    stage("logout-from-android-ui");
    await tapLabel("Volver al resumen");
    await waitForNode("Hola, Prueba Android Registrador");
    await tapLabel("Cerrar sesión");
    sessionObservations.afterUiLogout = await waitForAuthUiState();
    assert(["login-required", "organization-selection"].includes(sessionObservations.afterUiLogout), "android-logout-did-not-return-to-anonymous-ui");
    assertSyntheticActiveSessions(registrarUserId, 0);

    stage("verify-logout-after-process-restart");
    adb(["shell", "am", "force-stop", androidPackage]);
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
  await ensureOrganizationTermsAccepted();
  const beforeWrongPassword = new Set((await getMailpitMessages()).map((item) => item.ID));
  await replaceField("Correo electr\u00f3nico", activeLoginEmail.length, activeLoginEmail);
  await typeField("Contrase\u00f1a", `${password}x`);
  await tapLabel("Ingresar");
  await waitForNode(rejectedLoginMessage, {contains: isExpoClient});
  assert(authUiState(uiNodes()) === "login-required", "incorrect-password-opened-authenticated-flow");
  assertSyntheticActiveSessions(registrarUserId, 0);
  await assertNoFreshMfaMessage(activeLoginEmail, beforeWrongPassword);
  passCase();

  beginCase("Android does not disclose whether an account exists");
  stage("reject-nonexistent-account");
  const beforeMissingAccount = new Set((await getMailpitMessages()).map((item) => item.ID));
  const missingEmail = "missing-account@srd-e2e.test";
  await replaceField("Correo electr\u00f3nico", activeLoginEmail.length, missingEmail);
  await replaceField("Contrase\u00f1a", password.length + 1, password);
  await tapLabel("Ingresar");
  await waitForNode(rejectedLoginMessage, {contains: isExpoClient});
  assert(authUiState(uiNodes()) === "login-required", "nonexistent-account-opened-authenticated-flow");
  assertSyntheticActiveSessions(registrarUserId, 0);
  await assertNoFreshMfaMessage(activeLoginEmail, beforeMissingAccount);
  passCase();

  beginCase("Android form validation rejects empty credentials");
  await verifyEmptyLoginForm(registrarUserId, organizationCode);

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
  if (!result.passed && selectedSerial) {
    try {
      const png = execFileSync("adb", ["-s", selectedSerial, "exec-out", "screencap", "-p"], {
        timeout: 15000, maxBuffer: 16 * 1024 * 1024,
      });
      if (png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        fs.writeFileSync(path.join(path.dirname(resourcesPath), "android-qa-failure.png"), png);
        failureScreenshot = "android-qa-failure.png";
      } else {
        failureScreenshot = "invalid-image-data";
      }
    } catch {
      failureScreenshot = "capture-unavailable";
    }
  }
  fs.mkdirSync(path.dirname(resourcesPath), { recursive: true });
  const minGiB = Number.isFinite(minimumAvailableKiB) ? (minimumAvailableKiB / 1024 / 1024).toFixed(2) : "unavailable";
  const uiDiagnostics = result.passed ? "" : `FailureStage: ${currentStage}\nFreshMfaMailObserved: ${freshMfaMailObserved}\nFailureScreenshot: ${failureScreenshot}\nVisibleLabels:\n${lastUiLabels.map((label) => `- ${label}`).join("\n")}\nVisibleNodeDetails:\n${lastUiDetails.map((detail) => `- ${detail}`).join("\n")}\nEditableStates:\n${lastEditableStates.map((state) => `- ${state}`).join("\n")}\n`;
  const sessionDiagnostics = Object.entries(sessionObservations).map(([key, value]) => `${key}: ${value}`).join("\n");
  fs.writeFileSync(resourcesPath, `Samples: ${memorySampleCount}\nMinimumMemAvailableGiB: ${minGiB}\nSafeFloorGiB: 2.00\n${sessionDiagnostics}\n${uiDiagnostics}`);
  writeJUnit();
}
