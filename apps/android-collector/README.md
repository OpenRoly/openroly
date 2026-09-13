# openroly-collector (Android)

An Android app that captures notifications on the device, seals them, and sends them to the server.

- Plain text is encrypted once, on the device (an AEAD envelope). The server only passes it through.
- Capture is set per app, in 3 levels: Off (default) / Title only / Full text. Only apps you choose are captured.
- If the server is unreachable, the sealed envelopes wait in an on-device queue and are sent later.

## Build

Open this directory in [Android Studio](https://developer.android.com/studio) (Ladybug or later) and
press Run. AGP 8.5.2 / Kotlin 2.0.20 / compileSdk 34 / minSdk 26.

The repo does not include a Gradle wrapper. To build from the command line, use the Gradle bundled
with Android Studio, or run `gradle wrapper --gradle-version 8.7` once to generate the wrapper.

The only dependency is `org.bouncycastle:bcprov-jdk18on:1.78.1` (HPKE). No androidx.

## Checking byte compatibility

Even without the Android SDK, you can check that the envelope format is byte-compatible with the
interop harness:

```sh
apps/android-collector/interop/check-interop.sh
```

It seals an envelope with Java + BouncyCastle, opens it with `open` from `packages/crypto-envelope`
(TypeScript), and checks that `deriveKeyId` matches too. The Java code follows the same steps as `Crypto.kt`.

## Setup (on a device)

1. Open the app and allow OpenRoly Collector under **Open notification access settings**.
2. Paste your **Source token** (`pso_…`) and tap **Save & connect**. The device public key is fetched and cached.
3. Under **Apps**, set the apps you want to capture to Title only or Full text (Off by default).

The default server URL is `https://atn.shibubu.ai`.
