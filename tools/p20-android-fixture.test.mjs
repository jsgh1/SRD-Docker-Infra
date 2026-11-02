import assert from "node:assert/strict";
import test from "node:test";
import { resolveP20OrganizationCodeA } from "./p20-android-fixture.mjs";

test("P20 uses the fixture seeder's default organization code when codeA is omitted", () => {
  assert.equal(resolveP20OrganizationCodeA({ orgA: "synthetic-id" }), "srd-e2e-a");
});

test("P20 preserves an explicit synthetic organization code", () => {
  assert.equal(resolveP20OrganizationCodeA({ codeA: "srd-e2e-demo-a" }), "srd-e2e-demo-a");
});

test("P20 refuses malformed or non-synthetic organization codes", () => {
  assert.equal(resolveP20OrganizationCodeA({ codeA: "production" }), null);
  assert.equal(resolveP20OrganizationCodeA({ codeA: 42 }), null);
  assert.equal(resolveP20OrganizationCodeA(null), null);
});
