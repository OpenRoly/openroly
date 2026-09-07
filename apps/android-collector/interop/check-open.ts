// PBI-0115 AC-1 の TS 側検査: Java+BouncyCastle が作った envelope を @openroly/crypto-envelope の
// open で開け、deriveKeyId も一致する事を確かめる。apps/android-collector/interop/check-interop.sh
// から呼ばれる(単体では: bun apps/android-collector/interop/check-open.ts <envelope.json>)。
// workspace link が無い app dir からでも動く様に、source を直接 import する
import { deriveKeyId, open } from "../../../packages/crypto-envelope/src/index.ts";

const file = Bun.argv[2];
if (!file) throw new Error("usage: bun check-open.ts <envelope.json>");
const data = await Bun.file(file).json();

const keyId = await deriveKeyId(data.publicJwk);
if (keyId !== data.keyId) {
  console.error(`NG: deriveKeyId mismatch ts=${keyId} java=${data.keyId}`);
  process.exit(1);
}
const plain = new TextDecoder().decode(
  await open(data.envelope, { keyId: data.keyId, privateJwk: data.privateJwk }),
);
if (plain !== data.plaintext) {
  console.error(`NG: plaintext mismatch decrypted="${plain}" expected="${data.plaintext}"`);
  process.exit(1);
}
console.log(
  "OK: BC-sealed envelope opened by @openroly/crypto-envelope (deriveKeyId + plaintext match)",
);
