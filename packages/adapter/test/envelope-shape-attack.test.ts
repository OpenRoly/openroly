// PBI-0265 AC-X2(adapter 面)。PBI-0265 より前の send は recipients の中身を見なかったので、
// `[null]` / `[{}]` の行が DB に残り得る。`openIfEnvelope` は「例外を投げず undecryptable に落とす」が
// 契約(図9)だが、宛先 id の走査 `recipients.map((r) => r.device_key_id)` は try の **外** に居て、
// `[null]` で TypeError を投げた —— CLI agent の履歴読み・inbox_read が 1 行で丸ごと落ちる。
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal } from "@openroly/crypto-envelope";
import { getOrCreateDeviceKey } from "../src/devicekeys.ts";
import { openIfEnvelope } from "../src/e2ee.ts";

let openrolyHomeBefore: string | undefined;
let tmpHome = "";
beforeAll(async () => {
  openrolyHomeBefore = process.env.OPENROLY_HOME;
  tmpHome = await mkdtemp(join(tmpdir(), "openroly-0265-"));
  process.env.OPENROLY_HOME = tmpHome;
});
afterAll(async () => {
  process.env.OPENROLY_HOME = openrolyHomeBefore;
  await rm(tmpHome, { recursive: true, force: true });
});

const base = { v: 1, suite: "hpke-p256-sha256-a128gcm", iv: "aXY", ciphertext: "eA" };

test("AC-X2: 壊れた recipients の envelope でも openIfEnvelope は投げず undecryptable に落とす", async () => {
  const shapes: unknown[] = [
    [null],
    [{}],
    [{ device_key_id: 5 }],
    "x",
    null,
    [null, { device_key_id: "dvk_a", enc: "eA", wrapped_key: "wA" }],
  ];
  for (const recipients of shapes) {
    const message = { id: "m", content: { envelope: { ...base, recipients } } };
    const out = await openIfEnvelope("t-0265", message);
    expect(out.content).toMatchObject({ undecryptable: true });
  }
});

test("負の対照: envelope が無い message はそのまま返る(門が「常に undecryptable」ではない)", async () => {
  const message = { id: "m", content: { text: "plain" } };
  expect((await openIfEnvelope("t-0265", message)).content).toEqual({ text: "plain" });
});

// 有界レビュー 2026-09-05: 「投げない」だけでは足りない。壊れた entry の**隣に自分の鍵が居る**行は
// web(`recipientsOf` が壊れた entry を落としてから `open`)では読めるのに、adapter は原本をそのまま
// `open` に渡して `find` が null で投げ → catch → undecryptable にしていた(同じ行が client で読めたり
// 読めなかったりする)。残った entry だけを `open` に渡す事を、実物の seal + 自分の device 鍵で凍結する
test("壊れた entry の隣に自分の device 鍵が居れば開ける(web の recipientsOf と同じ守り)", async () => {
  const dev = await getOrCreateDeviceKey("t-0265");
  const real = await seal(new TextEncoder().encode(JSON.stringify({ text: "hi" })), [
    { keyId: dev.keyId, publicJwk: dev.publicJwk },
  ]);
  const envelope = { ...real, recipients: [null, {}, { device_key_id: 5 }, ...real.recipients] };
  const out = await openIfEnvelope("t-0265", { id: "m", content: { envelope } });
  expect(out.content).toEqual({ text: "hi" });
});
