# Receiver verification

Copy [src/verify.ts](../src/verify.ts) into a TypeScript application, or use the built `dist/verify.js` ES module. It uses only Node's crypto module. This repository is not published as an npm package.

```ts
import { verify } from './verify.js';

const valid = verify(rawBodyBuffer, timestampHeader, signatureHeader, [
  signingSecret,
]);
if (!valid) throw new Error('Invalid webhook');
```

`rawBodyBuffer` must contain the original HTTP bytes. Do not parse and reserialize JSON before verifying. The API key and the signing secret are different credentials.

## Language-independent algorithm

1. Read `Webhook-Timestamp` as a decimal integer Unix timestamp in seconds (1–12 digits). Reject malformed values.
2. Compare it with your UTC clock. Reject timestamps more than 300 seconds old **or in the future**. Synchronize your server clock. The tolerance is configurable in the helper.
3. Form bytes: UTF-8 encoding of the exact timestamp header, one ASCII period (`0x2e`), then the raw request body.
4. Calculate HMAC-SHA256 using the **UTF-8 bytes of the secret string** as the key. The secret happens to look hexadecimal; **do not hex-decode it**.
5. `Webhook-Signature` is a comma-separated list such as `v1=<64 lowercase hex characters>,v1=<64 lowercase hex characters>`. Decode well-formed `v1` values and compare with your digest using constant-time byte comparison. Accept if one matches an accepted secret. Ignore unknown versions; reject if nothing valid matches. Bound header parsing (the helper permits 1024 characters).
6. Parse the verified JSON, use its `id` as the durable deduplication key, and save that ID and your business change in one database transaction. A duplicate already processed event should receive a 2xx response without repeating side effects.

`Webhook-Id` mirrors the event ID and `Webhook-Delivery-Id` identifies the endpoint-specific delivery, but these convenience headers are not included in the signature. Trust the event ID inside the signed body. Timestamp verification alone does not prevent replay within the allowed clock window.

Any 2xx response is accepted. Acknowledging before your own durable commit can lose a business action. Respond promptly: the sender's total deadline is 10 seconds. Non-2xx statuses and transport failures retry, including 3xx (never followed). Oversized responses also fail; send a small acknowledgement.

## Secret rotation

An admin calls the endpoint's rotation API, then installs the returned secret at the receiver. For 24 hours, the sender includes both new and old signatures, so a receiver configured with either key can verify. Deploy the new secret before `previous_expires_at`; afterward only the new secret is used. Receivers should remove retired secrets. Rotation during an active overlap returns 409 to avoid invalidating a still-promised key.

## Run the fictional receiver

PowerShell:

```powershell
$env:WEBHOOK_SECRET = 'paste-the-endpoint-signing-secret'
pnpm receiver
```

Bash:

```sh
WEBHOOK_SECRET='paste-the-endpoint-signing-secret' pnpm receiver
```

The example binds `127.0.0.1:4000`, caps inbound bytes and prints only event ID/type. Its in-memory set demonstrates deduplication, but disappears on restart and grows without bound; replace it with transactional persistent storage for actual integrations.

For Docker Desktop, register `http://host.docker.internal:4000` and set `$env:RECEIVER_HOST = '0.0.0.0'` in PowerShell before `pnpm receiver` (Bash: `RECEIVER_HOST=0.0.0.0 WEBHOOK_SECRET='paste-the-endpoint-signing-secret' pnpm receiver`). This deliberately listens on all host interfaces; use a trusted development network and restrict host firewall access. Native Linux needs a reachable host address configured separately. Leave `RECEIVER_HOST` unset for native loopback-only use.
