# Stellar NGO Donation API

A backend starter for a privacy-aware NGO donation platform that uses the **Stellar blockchain** for transparent, low-cost donation transfers.

## What Is Implemented

- Stellar-powered donation transaction flow (intent -> unsigned XDR -> signed submit).
- Dynamic one-time donation destinations using Stellar muxed addresses (`M...`).
- NGO registration with verified Stellar account IDs.
- Network-aware NGO filtering so only active wallets on the current chain are listed.
- Encrypted off-chain donation metadata using AES-256-GCM + RSA-OAEP.
- Identity fingerprint hashing (salted with server-side pepper).
- NGO metrics endpoint with confirmed donation totals by asset.
- One-click testnet wallet funding via Friendbot.
- Recipient confirmation step before signing/submitting transactions.

## Tech Stack

- Node.js + TypeScript
- Express
- Zod (request validation)
- Stellar SDK (`@stellar/stellar-sdk`)
- MySQL (`mysql2` driver)

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Copy and edit environment config:

```bash
cp .env.example .env
```

3. Run in development mode:

```bash
npm run dev
```

4. Build for production:

```bash
npm run build
npm start
```

Server starts on `http://localhost:4000` by default.

Open `http://localhost:4000` to use the frontend donation page.

## MySQL Storage Setup

This project now uses MySQL for NGO and donation persistence.

1. Start MySQL (Docker Desktop must be running):

```bash
npm run mysql:up
```

2. Set `MYSQL_URL` in `.env`:

```bash
MYSQL_URL=mysql://stellar_app:stellar_app_pw@127.0.0.1:3307/stellar_donations
```

Tables are created automatically at server startup.

3. Stop MySQL when finished:

```bash
npm run mysql:down
```

## Run On Actual Stellar Public Network

The `.env.example` file is preconfigured for Stellar public network (mainnet).

Required variables:

- `STELLAR_NETWORK=PUBLIC`
- `STELLAR_ENABLE_PUBLIC_NETWORK=true`
- `STELLAR_HORIZON_URL=https://horizon.stellar.org`
- `STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015`

You can switch to testnet by setting:

- `STELLAR_NETWORK=TESTNET`
- `STELLAR_ENABLE_PUBLIC_NETWORK=false`
- `STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org`
- `STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015`

## Required Stellar Details

- Network selection via `STELLAR_NETWORK` (`PUBLIC` or `TESTNET`).
- Network passphrase for selected network.
- Horizon endpoint for selected network.
- Donor source account public key (`G...`) when building transactions.
- NGO recipient Stellar account public key (`G...`) during onboarding.
- NGO and donor Stellar accounts must already exist on the selected network.

## NGO Encryption Key Setup

Generate NGO RSA keys (for encrypted metadata):

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ngo-private.pem
openssl rsa -pubout -in ngo-private.pem -out ngo-public.pem
```

Use contents of `ngo-public.pem` in the NGO registration request.

## API Overview

### 1) Health Check

- `GET /health`

### 1.1) Verify Active Stellar Chain

- `GET /api/stellar/network`

Returns live Horizon and ledger details for the currently configured network.

### 1.2) Fund A Testnet Wallet (Friendbot)

- `POST /api/testnet/fund-wallet`

Request body:

```json
{
  "publicKey": "G..."
}
```

This endpoint is available only when `STELLAR_NETWORK=TESTNET`.

### 2) Register NGO

- `POST /api/ngos`

Request body:

```json
{
  "name": "Global Relief Trust",
  "stellarPublicKey": "G...",
  "encryptionPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

### 3) Create Donation Intent

- `POST /api/donations/intents`

Request body:

```json
{
  "ngoId": "<uuid>",
  "amount": "25.5000000",
  "asset": {
    "type": "native",
    "code": "XLM"
  },
  "donorFingerprint": "donor-reference-123",
  "donorMessage": "Stay strong",
  "purpose": "Medical kits"
}
```

Response includes:

- `oneTimeAddress` (`M...` muxed destination for this donation)
- `memoHashHex` (stable on-chain reference hash)
- `donationId`

### 4) Build Unsigned Stellar Transaction

- `POST /api/donations/:donationId/build-transaction`

Request body:

```json
{
  "donorPublicKey": "G..."
}
```

Response includes `xdr` to sign client-side with donor wallet.

### 5) Submit Signed Transaction

- `POST /api/donations/:donationId/submit`

Request body:

```json
{
  "signedXdr": "AAAAAgAAA..."
}
```

Response includes:

- Stellar transaction hash
- Ledger number
- Updated donation status

### 6) Read Donation and NGO Analytics

- `GET /api/donations/:donationId`
- `GET /api/ngos/:ngoId/donations`
- `GET /api/ngos/:ngoId/metrics`

## Frontend Donation Flow

The frontend is served directly by the backend at `http://localhost:4000`.

### Option A: Freighter Wallet (recommended)

1. Install Freighter extension and unlock your wallet.
2. Open the app page and click **Connect Freighter**.
3. Choose a target mode:
  - `Registered NGO` to send to a verified NGO wallet.
  - `Specific Wallet` to send directly to any active Stellar wallet.
4. Enter amount and click **Donate On Stellar**.
5. Review the recipient confirmation panel and click **Confirm And Continue**.
6. Approve signing in Freighter.
7. Transaction is submitted and appears with tx hash and explorer link.

### Option B: Manual Signed XDR

1. Switch to **Manual Public Key** mode.
2. Enter donor public key and create donation (NGO or specific wallet mode).
3. Confirm recipient details in the confirmation panel.
4. Copy unsigned XDR from UI and sign in your wallet tool.
5. Paste signed XDR and click **Submit Signed XDR**.

### Testnet Funding Button

When the app runs on TESTNET, the donor wallet section shows **Fund Wallet On Testnet**.
Use this button to fund the donor wallet quickly through Friendbot before sending test donations.

After successful submit, transaction details are visible in UI and on Stellar explorer.

## Important Security Notes

- Never send or store donor secret keys on this backend.
- Metadata is encrypted before storage; only NGOs with private key can decrypt.
- Donation and NGO records are persisted in MySQL.
- Add authN/authZ, rate limiting, and audit logs before public deployment.

## Suggested Next Build Steps

- Add wallet-based auth (SEP-10) for NGO and donor sessions.
- Add encrypted backups and migration tooling for MySQL data.
- Add webhook/indexer to reconcile transaction status from Horizon stream.
- Add multisig treasury and NGO withdrawal approval workflow.
