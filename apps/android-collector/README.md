# paa-collector (Android)

EP-0013 W2b — 端末の通知を capture し、seal して server に送る collector app(図44)。

- 平文は端末で 1 回だけ AEAD 暗号化(envelope)され、server は素通しするだけ。
- capture は per-app 3 段階(既定 Off / Title only / Full text)。user が選んだ app のみ。
- server が unreachable でも端末内 queue に envelope だけ溜め、後で送る。

## Build

[Android Studio](https://developer.android.com/studio)(Ladybug 以降)でこの directory を
開いて Run を押す。AGP 8.5.2 / Kotlin 2.0.20 / compileSdk 34 / minSdk 26。

repo には gradle wrapper を同梱していない。CLI で build する場合は Android Studio 付属の
gradle を使うか、`gradle wrapper --gradle-version 8.7` を 1 回実行して wrapper を生成する。

依存は `org.bouncycastle:bcprov-jdk18on:1.78.1`(HPKE)のみ。androidx 無し。

## byte 互換の検証(AC-1)

Android SDK が無い環境でも、envelope 形式の byte 互換は interop harness で検証出来る:

```sh
apps/android-collector/interop/check-interop.sh
```

Java + BouncyCastle で seal した envelope を `packages/crypto-envelope`(TS)の `open` で
復号し、`deriveKeyId` も一致することを機械検査する。`Crypto.kt` と同じ手順の Java 実装。

## Setup(実機)

1. アプリを開き **Open notification access settings** で PAA Collector を許可。
2. **Source token**(`pso_…`)を paste して **Save & connect**。device 公開鍵を取得して cache。
3. **Apps** で capture したい app を Title only / Full text にする(既定 Off)。

Server URL の既定は `https://atn.shibubu.ai`。
