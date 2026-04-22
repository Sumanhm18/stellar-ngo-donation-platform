import crypto from "node:crypto";
import {
  Account,
  Asset,
  Horizon,
  Memo,
  MuxedAccount,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { config } from "./config.js";
import { DonationAsset } from "./types.js";

const allowHttp = config.stellarHorizonUrl.startsWith("http://");

export const stellarServer = new Horizon.Server(config.stellarHorizonUrl, {
  allowHttp,
});

export function assertValidPublicKey(publicKey: string, field: string): void {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new Error(`${field} must be a valid Stellar public key`);
  }
}

export async function ensureAccountExists(
  publicKey: string,
  fieldName: string,
) {
  assertValidPublicKey(publicKey, fieldName);

  try {
    return await stellarServer.loadAccount(publicKey);
  } catch (error) {
    const statusCode = (error as { response?: { status?: number } }).response
      ?.status;

    if (statusCode === 404) {
      throw new Error(
        `${fieldName} does not exist on the selected Stellar network. The account may be on another network or not funded yet.`,
      );
    }

    throw error;
  }
}

export function createDonationDestination(ngoPublicKey: string): {
  oneTimeAddress: string;
  muxedId: string;
} {
  assertValidPublicKey(ngoPublicKey, "ngoPublicKey");

  const baseAccount = new Account(ngoPublicKey, "0");
  const randomId = crypto.randomBytes(8).readBigUInt64BE(0) || 1n;
  const muxedId = randomId.toString();
  const muxedAccount = new MuxedAccount(baseAccount, muxedId);

  return {
    oneTimeAddress: muxedAccount.accountId(),
    muxedId,
  };
}

export function createDonationMemoHashHex(donationId: string): string {
  return crypto.createHash("sha256").update(donationId).digest("hex");
}

function toStellarAsset(asset: DonationAsset): Asset {
  if (asset.type === "native") {
    return Asset.native();
  }

  return new Asset(asset.code, asset.issuer);
}

export async function buildDonationTransactionXdr(params: {
  donorPublicKey: string;
  destination: string;
  amount: string;
  asset: DonationAsset;
  memoHashHex: string;
}): Promise<{ xdr: string; baseFee: string }> {
  const sourceAccount = await ensureAccountExists(
    params.donorPublicKey,
    "donorPublicKey",
  );
  const baseFee = await stellarServer.fetchBaseFee();
  const memoHash = Buffer.from(params.memoHashHex, "hex");

  if (memoHash.length !== 32) {
    throw new Error("memo hash must be exactly 32 bytes");
  }

  const tx = new TransactionBuilder(sourceAccount, {
    fee: String(baseFee),
    networkPassphrase: config.stellarNetworkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: params.destination,
        amount: params.amount,
        asset: toStellarAsset(params.asset),
      }),
    )
    .addMemo(Memo.hash(memoHash))
    .setTimeout(180)
    .build();

  return {
    xdr: tx.toXDR(),
    baseFee: String(baseFee),
  };
}

export async function submitSignedTransactionXdr(signedXdr: string): Promise<{
  hash: string;
  ledger: number;
}> {
  const tx = TransactionBuilder.fromXDR(
    signedXdr,
    config.stellarNetworkPassphrase,
  );

  const response = await stellarServer.submitTransaction(tx);

  return {
    hash: response.hash,
    ledger: response.ledger,
  };
}
