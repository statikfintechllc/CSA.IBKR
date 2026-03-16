# SFTi.IOS/storage — Encrypted Persistent Vault

AES-GCM encrypted key-value store backed by IndexedDB with OPFS support
for large binary blobs.  All values are JSON-serialisable.

> **Security model:** The master AES-GCM key is generated once and stored as
> an exportable JWK in the same IndexedDB database.  This protects data from
> casual inspection (the raw values are ciphertext) but does not protect
> against an attacker with full device/browser storage access.  Sensitive
> secrets (e.g. IBKR credentials) should always be stored via `FaceID.register()`
> which derives the encryption key from a WebAuthn PRF assertion, providing
> hardware-backed protection.

See `vault.js` for the full API.
