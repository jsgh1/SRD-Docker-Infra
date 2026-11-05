import assert from "node:assert/strict";
import test from "node:test";
import { resolveP20AndroidProfile } from "./p20-android-client-profile.mjs";

const canonicalProfile = {
  key: "rn",
  client: "react-native-android",
  accountKey: "mobile_user",
  expectedEmail: "android@srd-e2e.test",
  androidPackage: "com.srd.mobile.qa",
  homeLabel: "Hola, Prueba Android",
};

test("Android acceptance defaults to the canonical React Native client", () => {
  assert.deepEqual(resolveP20AndroidProfile(), canonicalProfile);
  assert.deepEqual(resolveP20AndroidProfile("RN"), canonicalProfile);
});

test("Android acceptance rejects retired or unknown clients", () => {
  for (const value of ["expo", "mobile-expo", "desktop"]) {
    assert.throws(() => resolveP20AndroidProfile(value), /unsupported-p20-android-client/);
  }
});
