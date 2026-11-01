function isEditable(node) {
  return /EditText$/.test(node.class || "");
}

function safeLabel(value, limit) {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
    .replace(/\b\d{6}\b/g, "[CODE]")
    .slice(0, limit);
}

export function decodeXml(value) {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

export function safeUiLabels(nodes) {
  return [...new Set(nodes
    .filter((node) => !isEditable(node))
    .map((node) => (node.text || node["content-desc"] || "").trim())
    .filter(Boolean)
    .map((label) => safeLabel(label, 100)))]
    .slice(0, 40);
}

export function safeUiDetails(nodes) {
  return [...new Set(nodes
    .filter((node) => !isEditable(node))
    .map((node) => {
      const label = (node.text || node["content-desc"] || "").trim();
      if (!label) return "";
      const type = (node.class || "node").split(".").at(-1);
      return `${type} ${node.bounds || "[no-bounds]"} clickable=${node.clickable || "false"} enabled=${node.enabled || "false"} focused=${node.focused || "false"} ${safeLabel(label, 80)}`;
    })
    .filter(Boolean))]
    .slice(0, 50);
}

export function editableValue(node, label = "") {
  const value = node?.text || "";
  const hint = node?.hint || "";
  if (!value || (hint && value === hint)) return "";
  if (label === "Correo electr\u00f3nico" && value === "tu@correo.com") return "";
  if (label === "Contrase\u00f1a" && value === "Contrase\u00f1a") return "";
  return value;
}

export function safeEditableStates(nodes) {
  return nodes
    .filter(isEditable)
    .map((node) => {
      const rawLabel = node["content-desc"] || node.hint || "field";
      const label = safeLabel(rawLabel, 60);
      const textLength = editableValue(node, rawLabel).length;
      return `${label}: hasText=${textLength > 0} textLength=${textLength} enabled=${node.enabled || "false"} focused=${node.focused || "false"}`;
    })
    .slice(0, 12);
}

export function findNode(nodes, label, { editable = false } = {}) {
  return nodes.find((node) => {
    const named = node.text === label || node["content-desc"] === label;
    return named && (!editable || isEditable(node));
  });
}

export function findNodeContaining(nodes, label) {
  return nodes.find((node) => (node.text || node["content-desc"] || "").includes(label));
}

export function authUiState(nodes) {
  if (findNode(nodes, "Hola, Prueba Android")) return "authenticated-home";
  if (findNode(nodes, "Correo electr\u00f3nico", { editable: true })) return "login-required";
  if (findNode(nodes, "C\u00f3digo de junta", { editable: true })) return "organization-selection";
  if (findNode(nodes, "Revisa tu correo")) return "mfa-challenge";
  if (nodes.some((node) => (node.text || "").includes("No se pudo comprobar la sesi\u00f3n"))) return "session-restore-error";
  return undefined;
}
