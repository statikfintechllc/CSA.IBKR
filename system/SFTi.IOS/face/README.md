# SFTi.IOS/face — Face ID Integration

WebAuthn-based biometric authentication for CSA.IBKR.

Uses the W3C Web Authentication API (WebAuthn) to:
1. **Register** — create a platform credential bound to Face ID / Touch ID.
2. **Authenticate** — assert the credential and decrypt stored IBKR credentials.
3. **Encrypt at rest** — IBKR passwords are AES-GCM encrypted using a key
   derived from the WebAuthn PRF extension output (or credential raw ID).

See `faceid.js` for the full API.
