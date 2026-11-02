import test from "node:test";
import assert from "node:assert/strict";
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

test("decodes Android hierarchy entities before accessible-node matching", () => {
  assert.equal(decodeXml("Correo &amp; contrase\u00f1a &quot;ok&quot;"), 'Correo & contrase\u00f1a "ok"');
});

test("normalizes visible labels and redacts email and six-digit MFA codes", () => {
  const nodes = [
    {class: "android.widget.TextView", text: "Cuenta ana@example.test · código 123456"},
    {class: "android.widget.TextView", text: " Cuenta ana@example.test · código 123456 "},
    {class: "android.widget.EditText", text: "secret@example.test", hint: "Correo electrónico"},
    {class: "android.view.View", "content-desc": "Acciones"},
  ];

  assert.deepEqual(safeUiLabels(nodes), ["Cuenta [EMAIL] · código [CODE]", "Acciones"]);
  const details = safeUiDetails(nodes).join("\n");
  assert.match(details, /TextView .*Cuenta \[EMAIL\] · código \[CODE\]/);
  assert.match(details, /View .*Acciones/);
  assert.doesNotMatch(details, /ana@example\.test|123456|secret@example\.test/);
});

test("treats native placeholders as empty while preserving non-sensitive typed length", () => {
  const nodes = [
    {class: "android.widget.EditText", text: "tu@correo.com", hint: "tu@correo.com", "content-desc": "Correo electrónico"},
    {class: "android.widget.EditText", text: "Contraseña", hint: "Contraseña", "content-desc": "Contraseña"},
    {class: "android.widget.EditText", text: "viewer", hint: "Correo electrónico", "content-desc": "Correo electrónico"},
  ];

  assert.equal(editableValue(nodes[0], "Correo electrónico"), "");
  assert.equal(editableValue(nodes[1], "Contraseña"), "");
  assert.equal(editableValue(nodes[2], "Correo electrónico"), "viewer");
  assert.deepEqual(safeEditableStates(nodes), [
    "Correo electrónico: hasText=false textLength=0 enabled=false focused=false",
    "Contraseña: hasText=false textLength=0 enabled=false focused=false",
    "Correo electrónico: hasText=true textLength=6 enabled=false focused=false",
  ]);
  assert.doesNotMatch(safeEditableStates(nodes).join("\n"), /viewer/);
});

test("matches editable controls and classifies the authentication screen", () => {
  const email = {class: "android.widget.EditText", "content-desc": "Correo electrónico"};
  const nodes = [email, {class: "android.widget.TextView", text: "Correo electrónico"}];
  assert.equal(findNode(nodes, "Correo electrónico", {editable: true}), email);
  assert.equal(findNodeContaining(nodes, "Correo electrónico"), email);
  assert.equal(authUiState(nodes), "login-required");
  assert.equal(authUiState([{class: "android.widget.EditText", "content-desc": "Código de junta"}]), "organization-selection");
  assert.equal(authUiState([{class: "android.widget.TextView", text: "Revisa tu correo"}]), "mfa-challenge");
  assert.equal(authUiState([{class: "android.widget.TextView", text: "Hola, Prueba Android"}]), "authenticated-home");
  assert.equal(authUiState([{class: "android.widget.TextView", text: "No se pudo comprobar la sesión"}]), "session-restore-error");
  assert.equal(authUiState([]), undefined);
});
