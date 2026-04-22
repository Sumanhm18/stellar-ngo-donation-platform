import crypto from "node:crypto";
import path from "node:path";
import { StrKey } from "@stellar/stellar-sdk";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { config } from "./config.js";
import {
  encryptMetadataForNgo,
  hashIdentityFingerprint,
} from "./crypto.js";
import {
  buildDonationTransactionXdr,
  createDonationDestination,
  createDonationMemoHashHex,
  ensureAccountExists,
  stellarServer,
  submitSignedTransactionXdr,
} from "./stellar.js";
import { store } from "./store.js";
import { DonationAsset } from "./types.js";

const app = express();
const publicDir = path.resolve(process.cwd(), "public");
const freighterBundlePath = path.resolve(
  process.cwd(),
  "node_modules/@stellar/freighter-api/build/index.min.js",
);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/vendor/freighter-api.min.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(freighterBundlePath);
});

app.use(express.static(publicDir));

const stellarPublicKeySchema = z
  .string()
  .trim()
  .refine((value) => StrKey.isValidEd25519PublicKey(value), {
    message: "Must be a valid Stellar public key",
  });

const amountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,7})?$/, {
    message: "Amount must be a positive decimal with up to 7 decimals",
  })
  .refine((value) => Number(value) > 0, {
    message: "Amount must be greater than zero",
  });

const donationAssetSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("native"),
      code: z.literal("XLM").optional(),
    }),
    z.object({
      type: z.literal("credit_alphanum"),
      code: z.string().trim().min(1).max(12),
      issuer: stellarPublicKeySchema,
    }),
  ])
  .optional();

const registerNgoSchema = z.object({
  name: z.string().trim().min(2).max(120),
  stellarPublicKey: stellarPublicKeySchema,
  encryptionPublicKeyPem: z.string().trim().min(64),
});

const createIntentSchema = z
  .object({
    ngoId: z.string().uuid().optional(),
    recipientWalletPublicKey: stellarPublicKeySchema.optional(),
    amount: amountSchema,
    asset: donationAssetSchema,
    donorFingerprint: z.string().trim().min(3).max(256).optional(),
    donorFingerprintHash: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    donorMessage: z.string().trim().min(1).max(500).optional(),
    purpose: z.string().trim().min(1).max(120).optional(),
  })
  .refine(
    (value) => Boolean(value.ngoId) !== Boolean(value.recipientWalletPublicKey),
    {
      message: "Provide either ngoId or recipientWalletPublicKey",
      path: ["ngoId"],
    },
  )
  .refine(
    (value) => !(value.donorFingerprint && value.donorFingerprintHash),
    "Provide either donorFingerprint or donorFingerprintHash, not both",
  );

const buildTransactionSchema = z.object({
  donorPublicKey: stellarPublicKeySchema,
});

const submitTransactionSchema = z.object({
  signedXdr: z.string().trim().min(20),
});

const testnetFundWalletSchema = z.object({
  publicKey: stellarPublicKeySchema,
});

function sendValidationError(res: express.Response, error: z.ZodError): void {
  res.status(400).json({
    error: "Validation failed",
    details: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function toPublicNgo(ngo: {
  id: string;
  name: string;
  stellarPublicKey: string;
  createdAt: string;
}) {
  return {
    id: ngo.id,
    name: ngo.name,
    stellarPublicKey: ngo.stellarPublicKey,
    createdAt: ngo.createdAt,
  };
}

async function isNgoOnActiveNetwork(stellarPublicKey: string): Promise<boolean> {
  try {
    await ensureAccountExists(stellarPublicKey, "stellarPublicKey");
    return true;
  } catch (_error) {
    return false;
  }
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    network: config.stellarNetwork,
    isPublicNetwork: config.isPublicNetwork,
    networkPassphrase: config.stellarNetworkPassphrase,
    horizonUrl: config.stellarHorizonUrl,
  });
});

app.get("/api/stellar/network", async (_req, res) => {
  try {
    const root = await stellarServer.root();

    res.json({
      network: config.stellarNetwork,
      isPublicNetwork: config.isPublicNetwork,
      networkPassphrase: config.stellarNetworkPassphrase,
      horizonUrl: config.stellarHorizonUrl,
      horizonVersion: root.horizon_version,
      coreVersion: root.core_version,
      coreLatestLedger: root.core_latest_ledger,
      historyLatestLedger: root.history_latest_ledger,
    });
  } catch (error) {
    res.status(502).json({
      error: "Failed to reach Stellar Horizon",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/testnet/fund-wallet", async (req, res) => {
  if (config.stellarNetwork !== "TESTNET") {
    res.status(400).json({
      error: "Testnet funding endpoint is available only when STELLAR_NETWORK=TESTNET",
    });
    return;
  }

  const parsed = testnetFundWalletSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  const friendbotUrl = `https://friendbot.stellar.org/?addr=${encodeURIComponent(parsed.data.publicKey)}`;

  try {
    const response = await fetch(friendbotUrl, { method: "POST" });
    const rawBody = await response.text();

    let body: unknown = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch (_error) {
      // Keep raw text response when not JSON.
    }

    if (!response.ok) {
      const detailText =
        typeof (body as { detail?: unknown })?.detail === "string"
          ? (body as { detail: string }).detail
          : "";

      if (
        response.status === 400 &&
        detailText.toLowerCase().includes("already funded")
      ) {
        res.json({
          funded: true,
          alreadyFunded: true,
          publicKey: parsed.data.publicKey,
          friendbotResponse: body,
        });
        return;
      }

      res.status(502).json({
        error: "Friendbot funding failed",
        details: body,
      });
      return;
    }

    const hash =
      typeof (body as { hash?: unknown })?.hash === "string"
        ? (body as { hash: string }).hash
        : undefined;

    res.json({
      funded: true,
      publicKey: parsed.data.publicKey,
      hash,
      friendbotResponse: body,
    });
  } catch (error) {
    res.status(502).json({
      error: "Friendbot request failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/ngos", async (req, res) => {
  const parsed = registerNgoSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  try {
    await ensureAccountExists(parsed.data.stellarPublicKey, "stellarPublicKey");
  } catch (error) {
    res.status(400).json({
      error: "Invalid NGO Stellar account",
      details: error instanceof Error ? error.message : "Unknown error",
    });
    return;
  }

  const ngo = await store.createNgo({
    id: crypto.randomUUID(),
    name: parsed.data.name,
    stellarPublicKey: parsed.data.stellarPublicKey,
    encryptionPublicKeyPem: parsed.data.encryptionPublicKeyPem,
    createdAt: new Date().toISOString(),
  });

  res.status(201).json({ ngo: toPublicNgo(ngo) });
});

app.get("/api/ngos", async (_req, res) => {
  const ngos = await store.listNgos();
  const networkAwareNgos = (
    await Promise.all(
      ngos.map(async (ngo) =>
        (await isNgoOnActiveNetwork(ngo.stellarPublicKey)) ? ngo : null,
      ),
    )
  ).filter((ngo): ngo is NonNullable<typeof ngo> => ngo !== null);

  const publicNgos = networkAwareNgos.map(toPublicNgo);
  res.json({ ngos: publicNgos });
});

app.get("/api/ngos/:ngoId/metrics", async (req, res) => {
  const ngo = await store.getNgo(req.params.ngoId);
  if (!ngo) {
    res.status(404).json({ error: "NGO not found" });
    return;
  }

  res.json({ metrics: await store.getNgoMetrics(ngo.id) });
});

app.get("/api/ngos/:ngoId/donations", async (req, res) => {
  const ngo = await store.getNgo(req.params.ngoId);
  if (!ngo) {
    res.status(404).json({ error: "NGO not found" });
    return;
  }

  res.json({ donations: await store.listDonationsForNgo(ngo.id) });
});

app.post("/api/donations/intents", async (req, res) => {
  const parsed = createIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  const isDirectWalletMode = Boolean(parsed.data.recipientWalletPublicKey);
  let ngo;
  let recipientWalletPublicKey = "";

  if (isDirectWalletMode) {
    recipientWalletPublicKey = parsed.data.recipientWalletPublicKey ?? "";

    try {
      await ensureAccountExists(
        recipientWalletPublicKey,
        "recipientWalletPublicKey",
      );
    } catch (error) {
      res.status(400).json({
        error: "Recipient wallet is not active on current Stellar network",
        details: error instanceof Error ? error.message : "Unknown error",
      });
      return;
    }

    if (parsed.data.donorMessage || parsed.data.purpose) {
      res.status(400).json({
        error:
          "donorMessage and purpose are supported only in NGO mode with encryption",
      });
      return;
    }

    ngo = await store.findNgoByPublicKey(recipientWalletPublicKey);
    if (!ngo) {
      ngo = await store.createNgo({
        id: crypto.randomUUID(),
        name: `Direct Wallet ${recipientWalletPublicKey.slice(0, 8)}`,
        stellarPublicKey: recipientWalletPublicKey,
        encryptionPublicKeyPem: "",
        createdAt: new Date().toISOString(),
      });
    }
  } else {
    ngo = await store.getNgo(parsed.data.ngoId ?? "");
    if (!ngo) {
      res.status(404).json({ error: "NGO not found" });
      return;
    }

    try {
      await ensureAccountExists(ngo.stellarPublicKey, "ngoPublicKey");
    } catch (error) {
      res.status(400).json({
        error: "Selected NGO wallet is not active on current Stellar network",
        details: error instanceof Error ? error.message : "Unknown error",
      });
      return;
    }

    recipientWalletPublicKey = ngo.stellarPublicKey;
  }

  const asset: DonationAsset = parsed.data.asset
    ? parsed.data.asset.type === "native"
      ? { type: "native", code: "XLM" }
      : {
          type: "credit_alphanum",
          code: parsed.data.asset.code.toUpperCase(),
          issuer: parsed.data.asset.issuer,
        }
    : { type: "native", code: "XLM" };

  const metadataPayload: Record<string, string> = {};
  if (!isDirectWalletMode && parsed.data.donorMessage) {
    metadataPayload.donorMessage = parsed.data.donorMessage;
  }
  if (!isDirectWalletMode && parsed.data.purpose) {
    metadataPayload.purpose = parsed.data.purpose;
  }

  let encryptedMetadata;
  if (!isDirectWalletMode) {
    try {
      encryptedMetadata =
        Object.keys(metadataPayload).length > 0
          ? encryptMetadataForNgo(metadataPayload, ngo.encryptionPublicKeyPem)
          : undefined;
    } catch (error) {
      res.status(400).json({
        error: "Invalid NGO encryption key",
        details: error instanceof Error ? error.message : "Unknown key error",
      });
      return;
    }
  }

  const { oneTimeAddress, muxedId } = createDonationDestination(
    recipientWalletPublicKey,
  );
  const donationId = crypto.randomUUID();
  const donation = await store.createDonation({
    id: donationId,
    ngoId: ngo.id,
    oneTimeAddress,
    muxedId,
    amount: parsed.data.amount,
    asset,
    memoHashHex: createDonationMemoHashHex(donationId),
    donorFingerprintHash:
      parsed.data.donorFingerprintHash ??
      (parsed.data.donorFingerprint
        ? hashIdentityFingerprint(parsed.data.donorFingerprint)
        : undefined),
    encryptedMetadata,
    status: "intent-created",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  res.status(201).json({
    donation: {
      id: donation.id,
      ngoId: donation.ngoId,
      amount: donation.amount,
      asset: donation.asset,
      targetType: isDirectWalletMode ? "wallet" : "ngo",
      recipientWalletPublicKey,
      oneTimeAddress: donation.oneTimeAddress,
      muxedId: donation.muxedId,
      memoHashHex: donation.memoHashHex,
      status: donation.status,
      createdAt: donation.createdAt,
    },
  });
});

app.post("/api/donations/:donationId/build-transaction", async (req, res) => {
  const donation = await store.getDonation(req.params.donationId);
  if (!donation) {
    res.status(404).json({ error: "Donation intent not found" });
    return;
  }

  const parsed = buildTransactionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  try {
    const tx = await buildDonationTransactionXdr({
      donorPublicKey: parsed.data.donorPublicKey,
      destination: donation.oneTimeAddress,
      amount: donation.amount,
      asset: donation.asset,
      memoHashHex: donation.memoHashHex,
    });

    await store.updateDonationStatus(donation.id, "tx-built", {
      donorSourcePublicKey: parsed.data.donorPublicKey,
    });

    res.json({
      donationId: donation.id,
      xdr: tx.xdr,
      baseFee: tx.baseFee,
      networkPassphrase: config.stellarNetworkPassphrase,
      horizonUrl: config.stellarHorizonUrl,
    });
  } catch (error) {
    res.status(400).json({
      error: "Failed to build transaction",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/donations/:donationId/submit", async (req, res) => {
  const donation = await store.getDonation(req.params.donationId);
  if (!donation) {
    res.status(404).json({ error: "Donation intent not found" });
    return;
  }

  const parsed = submitTransactionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  await store.updateDonationStatus(donation.id, "submitted");

  try {
    const submitted = await submitSignedTransactionXdr(parsed.data.signedXdr);

    const updated = await store.updateDonationStatus(donation.id, "confirmed", {
      txHash: submitted.hash,
      ledger: submitted.ledger,
      failureReason: undefined,
    });

    res.json({
      donationId: donation.id,
      status: updated?.status,
      txHash: submitted.hash,
      ledger: submitted.ledger,
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Failed to submit transaction";

    await store.updateDonationStatus(donation.id, "failed", {
      failureReason: reason,
    });

    res.status(400).json({
      error: "Transaction submission failed",
      details: reason,
    });
  }
});

app.get("/api/donations/:donationId", async (req, res) => {
  const donation = await store.getDonation(req.params.donationId);
  if (!donation) {
    res.status(404).json({ error: "Donation not found" });
    return;
  }

  res.json({ donation });
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const details = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: "Unhandled server error", details });
  },
);

async function startServer(): Promise<void> {
  await store.initialize();

  app.listen(config.port, () => {
    console.log(
      `Stellar NGO donation API running on http://localhost:${config.port}`,
    );
  });
}

startServer().catch((error: unknown) => {
  const details = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`Failed to start server: ${details}`);
  process.exit(1);
});
