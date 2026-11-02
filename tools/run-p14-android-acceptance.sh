#!/usr/bin/env bash
set -euo pipefail

node sources/SRD-Docker-Infra/tools/mobile-android-mfa-ci.mjs

SRD_ANDROID_APK='sources/SRD-Frontend-Expo/apps/mobile-expo/android/app/build/outputs/apk/release/app-release.apk' \
SRD_ANDROID_PACKAGE='com.srd.mobileexpo' \
SRD_ANDROID_REJECTED_LOGIN_MESSAGE='incorrectos. Revisa' \
SRD_ANDROID_JUNIT_PATH='test-results/android-expo-e2e.junit.xml' \
SRD_ANDROID_RESOURCES_PATH='test-results/android-expo-runner-resources.txt' \
node sources/SRD-Docker-Infra/tools/mobile-android-mfa-ci.mjs
