const PROFILES = Object.freeze({
  rn: Object.freeze({
    key: "rn",
    client: "react-native-android",
    accountKey: "mobile_user",
    expectedEmail: "android@srd-e2e.test",
    androidPackage: "com.srd.mobile.qa",
    homeLabel: "Hola, Prueba Android",
    requiresServerField: false,
  }),
  expo: Object.freeze({
    key: "expo",
    client: "expo-android",
    accountKey: "mobile_registrar_user",
    expectedEmail: "android-registrar@srd-e2e.test",
    androidPackage: "com.srd.mobileexpo",
    homeLabel: "Hola, Prueba Android Registrador",
    requiresServerField: true,
  }),
});

export function resolveP20AndroidProfile(value = "rn") {
  const profile = PROFILES[String(value).trim().toLowerCase()];
  if (!profile) throw new Error("unsupported-p20-android-client");
  return profile;
}
