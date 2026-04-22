import { Networks } from "@stellar/stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

type StellarNetwork = "TESTNET" | "PUBLIC";

function resolveStellarNetwork(rawValue: string | undefined): StellarNetwork {
  const normalized = rawValue?.trim().toUpperCase() ?? "TESTNET";

  if (normalized === "PUBLIC" || normalized === "MAINNET") {
    return "PUBLIC";
  }

  if (normalized === "TESTNET") {
    return "TESTNET";
  }

  throw new Error(
    "STELLAR_NETWORK must be TESTNET, PUBLIC, or MAINNET",
  );
}

const stellarNetwork = resolveStellarNetwork(process.env.STELLAR_NETWORK);
const isPublicNetwork = stellarNetwork === "PUBLIC";
const mysqlUrl = process.env.MYSQL_URL?.trim();

if (isPublicNetwork && process.env.STELLAR_ENABLE_PUBLIC_NETWORK !== "true") {
  throw new Error(
    "Set STELLAR_ENABLE_PUBLIC_NETWORK=true to confirm use of Stellar public network",
  );
}

if (!mysqlUrl) {
  throw new Error("Set MYSQL_URL for MySQL storage (example: mysql://user:pass@localhost:3306/stellar_donations)");
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mysqlUrl,
  stellarNetwork,
  isPublicNetwork,
  stellarHorizonUrl:
    process.env.STELLAR_HORIZON_URL ??
    (isPublicNetwork
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org"),
  stellarNetworkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE ??
    (isPublicNetwork ? Networks.PUBLIC : Networks.TESTNET),
  identityPepper: process.env.IDENTITY_PEPPER ?? "replace-me-in-production",
};
