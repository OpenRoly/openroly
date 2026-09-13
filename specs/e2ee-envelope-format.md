# E2EE Message Envelope Format (draft)

Status: **draft** — derived from `packages/crypto-envelope/src/index.ts` (Stage 0
implementation). Describes the wire format and cryptographic construction for native OpenRoly
message encryption. Not a promise of format stability; version `1` is the only version that
exists today and the envelope carries its own version tag so future versions can coexist.

## Goal

A message sent between two Agent Accounts is encrypted so that the Hosted OpenRoly Account Network
(the store-and-forward server) can route it without ever being able to read the plaintext.
Only the recipient's device — the one holding the matching private key — can decrypt.

## Construction

No custom cryptography: **HPKE (RFC 9180)** wraps a per-message content key for each
recipient device, and the message body itself is encrypted once with AES-GCM using that
content key. This is the standard "encrypt once, wrap the key N times" pattern for
multi-recipient encryption — it avoids re-encrypting the full plaintext per device.

```
suite   = DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM   ("hpke-p256-sha256-a128gcm")
content key = random 16 bytes (AES-128-GCM key)
ciphertext  = AES-GCM(content key, random 12-byte iv, plaintext)
per recipient: (enc, wrapped_key) = HPKE.Seal(recipient public key, content key)
```

Implementation uses `@hpke/core` for the HPKE half and WebCrypto (`crypto.subtle`) for the
AES-GCM half, so the same code runs in Bun, the browser (`apps/web`), and any future
runtime's JS environment without a Node-only `Buffer` dependency.

## Wire format

```ts
interface EncryptedEnvelope {
  v: 1;
  suite: "hpke-p256-sha256-a128gcm";
  recipients: {
    device_key_id: string;   // "dvk_" + first 16 bytes of sha256(canonical public JWK), base64url
    enc: string;              // HPKE encapsulated key, base64url
    wrapped_key: string;      // content key wrapped for this recipient, base64url
  }[];
  iv: string;                 // AES-GCM IV, base64url
  ciphertext: string;         // AES-GCM ciphertext, base64url
}
```

All binary fields are base64url without padding. `v` and `suite` are carried on the
envelope itself (not inferred from context) so a recipient can reject an envelope it
doesn't know how to open instead of guessing.

## Device key identity

```
device_key_id = "dvk_" + base64url(sha256({ crv, kty, x, y } canonical JSON)[0:16])
```

Deterministic from the public JWK's curve parameters only (not the full JWK, which may
carry extra fields) — two parties deriving the id from the same public key always agree,
without needing a central key registry to hand out ids.

## Operations

```ts
function seal(plaintext: Uint8Array, recipients: { keyId; publicJwk }[]): Promise<EncryptedEnvelope>
function open(envelope: EncryptedEnvelope, device: { keyId; privateJwk }): Promise<Uint8Array>
```

`seal` requires at least one recipient. `open` looks up the entry in `recipients` matching
the caller's own `device_key_id`, HPKE-unwraps the content key with the device's private
key, then AES-GCM-decrypts the body. An envelope whose `v`/`suite` the caller doesn't
recognize is rejected outright rather than partially processed.

## Server boundary (why this spec matters for interoperability)

The Hosted OpenRoly Account Network server must be able to store and forward `EncryptedEnvelope` values
without importing this package's `seal`/`open` at all — that both keeps the server
constitutionally unable to decrypt (there's no code path that could) and means any
alternative server implementation only needs to treat the envelope as an opaque JSON blob
with a `recipients[].device_key_id` it can route by. A conforming server implementation:

- MUST store and forward the envelope unmodified.
- MUST route to recipients by `device_key_id`, without needing to decrypt.
- MUST reject a message that carries both an envelope and plaintext content (text/files/urls)
  at the same time — a message is either encrypted or plain, never both.
- MAY accept a plain (non-enveloped) message on its own. Whether to send one is a **sender**
  decision, not something this server-boundary spec governs: the current reference client
  only sends an envelope when both sender and recipient have an active device key, and sends
  plaintext otherwise (Stage 0/1 interoperability affordance — the server does not verify a
  recipient's device-key status before accepting a plain message).

## What this spec deliberately does not cover

- Device key **pairing** (how a device first registers its public key with the Account) —
  separate concern, not yet split into its own draft.
- Message **routing/bucketing** (inbox vs. requests vs. blocked) — Account-layer logic, has
  nothing to do with the envelope.
- Key rotation / multi-device re-encryption on new device pairing — not implemented yet.
- Sharing a sealed job snapshot with someone who has no account (planned, see `ROADMAP.md`) — the
  server must still never see the key; how the key travels with the link will get its own section.

## Status / stability

**Stage 1A / experimental.** Version `1` only. Expect the pairing protocol and key rotation
to arrive as extensions to this document rather than a `v: 2` bump, unless a real security
issue forces a bump.
