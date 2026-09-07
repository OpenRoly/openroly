#!/bin/bash
# PBI-0115 AC-1 の interop check。Android collector(Crypto.kt)の seal 手順を Java+BouncyCastle
# で実行し、作った envelope を bun 側の @openroly/crypto-envelope で開ける事を機械検証する。
# Android SDK / gradle の無い開発環境で「byte 互換が壊れていない」を守る為の物 — app の
# build・実機確認は Android Studio 側(G2 の user 確認項目)。
set -euo pipefail
cd "$(dirname "$0")/../../.." # repo root

jar=/tmp/bcprov-jdk18on-1.78.1.jar
if [ ! -f "$jar" ]; then
  curl -fsSL -o "$jar" \
    https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/1.78.1/bcprov-jdk18on-1.78.1.jar
fi

out=/tmp/openroly-interop-check
rm -rf "$out"
mkdir -p "$out"
javac -cp "$jar" -d "$out" apps/android-collector/interop/CheckEnvelope.java
java -cp "$jar:$out" CheckEnvelope > "$out/envelope.json"
bun apps/android-collector/interop/check-open.ts "$out/envelope.json"
