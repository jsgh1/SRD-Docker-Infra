import assert from "node:assert/strict";
import test from "node:test";
import { resolveP20AndroidProfile } from "./p20-android-client-profile.mjs";

test("P20 React Native profile uses only the viewer fixture", () => {
  assert.deepEqual(resolveP20AndroidProfile("rn"), {
    key: "rn",
    client: "react-native-android",
    accountKey: "mobile_user",
    expectedEmail: "android@srd-e2e.test",
    androidPackage: "com.srd.mobile.qa",
    homeLabel: "Hola, Prueba Android",
    requiresServerField: false,
  });
});

test("P20 Expo profile uses the independent registrar fixture and visible server field", () => {
  assert.deepEqual(resolveP20AndroidProfile("EXPO"), {
    key: "expo",
    client: "expo-android",
    accountKey: "mobile_registrar_user",
    expectedEmail: "android-registrar@srd-e2e.test",
    androidPackage: "com.srd.mobileexpo",
    homeLabel: "Hola, Prueba Android Registrador",
    requiresServerField: true,
  });
});

test("P20 Android client selection fails closed", () => {
  assert.throws(() => resolveP20AndroidProfile("desktop"), /unsupported-p20-android-client/);
});
