const defaultOrganizationCodeA = "srd-e2e-a";

export function resolveP20OrganizationCodeA(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) return null;
  if (!Object.hasOwn(fixture, "codeA")) return defaultOrganizationCodeA;
  const code = fixture.codeA;
  return typeof code === "string" && /^srd-e2e-[a-z0-9-]{1,40}$/i.test(code)
    ? code
    : null;
}
