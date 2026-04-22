import mysql, { Pool, RowDataPacket } from "mysql2/promise";
import { config } from "./config.js";
import {
  DonationAsset,
  DonationMetrics,
  DonationRecord,
  DonationStatus,
  NGORecord,
} from "./types.js";

interface NgoRow extends RowDataPacket {
  id: string;
  name: string;
  stellar_public_key: string;
  encryption_public_key_pem: string;
  created_at: string | Date;
}

interface DonationRow extends RowDataPacket {
  id: string;
  ngo_id: string;
  one_time_address: string;
  muxed_id: string;
  amount: string;
  asset_type: "native" | "credit_alphanum";
  asset_code: string;
  asset_issuer: string | null;
  memo_hash_hex: string;
  donor_fingerprint_hash: string | null;
  donor_source_public_key: string | null;
  encrypted_metadata_json: unknown | null;
  status: DonationStatus;
  tx_hash: string | null;
  ledger: number | null;
  failure_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function parseEncryptedMetadata(
  value: unknown,
): DonationRecord["encryptedMetadata"] | undefined {
  if (value === null || typeof value === "undefined") {
    return undefined;
  }

  if (typeof value === "string") {
    return JSON.parse(value) as DonationRecord["encryptedMetadata"];
  }

  if (typeof value === "object") {
    return value as DonationRecord["encryptedMetadata"];
  }

  throw new Error("Unsupported encrypted_metadata_json format from MySQL");
}

interface CountRow extends RowDataPacket {
  donationCount: number;
  confirmedCount: number;
}

interface TotalsRow extends RowDataPacket {
  asset_type: "native" | "credit_alphanum";
  asset_code: string;
  asset_issuer: string | null;
  totalAmount: string;
}

function normalizeMysqlDate(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value.replace(" ", "T") + "Z").toISOString();
}

function toNgoRecord(row: NgoRow): NGORecord {
  return {
    id: row.id,
    name: row.name,
    stellarPublicKey: row.stellar_public_key,
    encryptionPublicKeyPem: row.encryption_public_key_pem,
    createdAt: normalizeMysqlDate(row.created_at),
  };
}

function toDonationAsset(
  assetType: "native" | "credit_alphanum",
  assetCode: string,
  assetIssuer: string | null,
): DonationAsset {
  if (assetType === "native") {
    return { type: "native", code: "XLM" };
  }

  if (!assetIssuer) {
    throw new Error("credit_alphanum asset requires issuer");
  }

  return {
    type: "credit_alphanum",
    code: assetCode,
    issuer: assetIssuer,
  };
}

function toDonationRecord(row: DonationRow): DonationRecord {
  return {
    id: row.id,
    ngoId: row.ngo_id,
    oneTimeAddress: row.one_time_address,
    muxedId: row.muxed_id,
    amount: row.amount,
    asset: toDonationAsset(row.asset_type, row.asset_code, row.asset_issuer),
    memoHashHex: row.memo_hash_hex,
    donorFingerprintHash: row.donor_fingerprint_hash ?? undefined,
    donorSourcePublicKey: row.donor_source_public_key ?? undefined,
    encryptedMetadata: parseEncryptedMetadata(row.encrypted_metadata_json),
    status: row.status,
    txHash: row.tx_hash ?? undefined,
    ledger: row.ledger ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    createdAt: normalizeMysqlDate(row.created_at),
    updatedAt: normalizeMysqlDate(row.updated_at),
  };
}

function amountToStroops(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const normalizedFraction = `${fraction}0000000`.slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(normalizedFraction);
}

function stroopsToAmount(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const fraction = stroops % 10_000_000n;
  const fractionText = fraction.toString().padStart(7, "0").replace(/0+$/, "");
  return fractionText.length > 0 ? `${whole}.${fractionText}` : whole.toString();
}

class MySqlStore {
  private readonly pool: Pool;

  constructor() {
    this.pool = mysql.createPool({
      uri: config.mysqlUrl,
      waitForConnections: true,
      connectionLimit: 10,
      timezone: "Z",
      dateStrings: true,
      decimalNumbers: false,
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ngos (
        id CHAR(36) PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        stellar_public_key VARCHAR(80) NOT NULL,
        encryption_public_key_pem TEXT NOT NULL,
        created_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS donations (
        id CHAR(36) PRIMARY KEY,
        ngo_id CHAR(36) NOT NULL,
        one_time_address VARCHAR(120) NOT NULL,
        muxed_id VARCHAR(40) NOT NULL,
        amount DECIMAL(30,7) NOT NULL,
        asset_type ENUM('native','credit_alphanum') NOT NULL,
        asset_code VARCHAR(12) NOT NULL,
        asset_issuer VARCHAR(80) NULL,
        memo_hash_hex CHAR(64) NOT NULL,
        donor_fingerprint_hash CHAR(64) NULL,
        donor_source_public_key VARCHAR(80) NULL,
        encrypted_metadata_json JSON NULL,
        status ENUM('intent-created','tx-built','submitted','confirmed','failed') NOT NULL,
        tx_hash VARCHAR(128) NULL,
        ledger BIGINT UNSIGNED NULL,
        failure_reason TEXT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        INDEX idx_donations_ngo_id (ngo_id),
        INDEX idx_donations_status (status),
        CONSTRAINT fk_donations_ngo FOREIGN KEY (ngo_id) REFERENCES ngos(id)
          ON DELETE RESTRICT ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }

  async createNgo(ngo: NGORecord): Promise<NGORecord> {
    await this.pool.execute(
      `INSERT INTO ngos (id, name, stellar_public_key, encryption_public_key_pem, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        ngo.id,
        ngo.name,
        ngo.stellarPublicKey,
        ngo.encryptionPublicKeyPem,
        new Date(ngo.createdAt),
      ],
    );

    return ngo;
  }

  async getNgo(ngoId: string): Promise<NGORecord | undefined> {
    const [rows] = await this.pool.execute<NgoRow[]>(
      `SELECT id, name, stellar_public_key, encryption_public_key_pem, created_at
       FROM ngos WHERE id = ? LIMIT 1`,
      [ngoId],
    );

    if (rows.length === 0) {
      return undefined;
    }

    return toNgoRecord(rows[0]);
  }

  async findNgoByPublicKey(publicKey: string): Promise<NGORecord | undefined> {
    const [rows] = await this.pool.execute<NgoRow[]>(
      `SELECT id, name, stellar_public_key, encryption_public_key_pem, created_at
       FROM ngos
       WHERE stellar_public_key = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [publicKey],
    );

    if (rows.length === 0) {
      return undefined;
    }

    return toNgoRecord(rows[0]);
  }

  async listNgos(): Promise<NGORecord[]> {
    const [rows] = await this.pool.execute<NgoRow[]>(
      `SELECT id, name, stellar_public_key, encryption_public_key_pem, created_at
       FROM ngos ORDER BY created_at DESC`,
    );

    return rows.map(toNgoRecord);
  }

  async createDonation(donation: DonationRecord): Promise<DonationRecord> {
    await this.pool.execute(
      `INSERT INTO donations (
        id, ngo_id, one_time_address, muxed_id, amount,
        asset_type, asset_code, asset_issuer, memo_hash_hex,
        donor_fingerprint_hash, donor_source_public_key, encrypted_metadata_json,
        status, tx_hash, ledger, failure_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        donation.id,
        donation.ngoId,
        donation.oneTimeAddress,
        donation.muxedId,
        donation.amount,
        donation.asset.type,
        donation.asset.code,
        donation.asset.type === "credit_alphanum" ? donation.asset.issuer : null,
        donation.memoHashHex,
        donation.donorFingerprintHash ?? null,
        donation.donorSourcePublicKey ?? null,
        donation.encryptedMetadata ? JSON.stringify(donation.encryptedMetadata) : null,
        donation.status,
        donation.txHash ?? null,
        donation.ledger ?? null,
        donation.failureReason ?? null,
        new Date(donation.createdAt),
        new Date(donation.updatedAt),
      ],
    );

    return donation;
  }

  async getDonation(donationId: string): Promise<DonationRecord | undefined> {
    const [rows] = await this.pool.execute<DonationRow[]>(
      `SELECT
        id, ngo_id, one_time_address, muxed_id, amount,
        asset_type, asset_code, asset_issuer, memo_hash_hex,
        donor_fingerprint_hash, donor_source_public_key, encrypted_metadata_json,
        status, tx_hash, ledger, failure_reason, created_at, updated_at
       FROM donations WHERE id = ? LIMIT 1`,
      [donationId],
    );

    if (rows.length === 0) {
      return undefined;
    }

    return toDonationRecord(rows[0]);
  }

  async listDonationsForNgo(ngoId: string): Promise<DonationRecord[]> {
    const [rows] = await this.pool.execute<DonationRow[]>(
      `SELECT
        id, ngo_id, one_time_address, muxed_id, amount,
        asset_type, asset_code, asset_issuer, memo_hash_hex,
        donor_fingerprint_hash, donor_source_public_key, encrypted_metadata_json,
        status, tx_hash, ledger, failure_reason, created_at, updated_at
       FROM donations
       WHERE ngo_id = ?
       ORDER BY created_at DESC`,
      [ngoId],
    );

    return rows.map(toDonationRecord);
  }

  async updateDonationStatus(
    donationId: string,
    status: DonationStatus,
    patch: Partial<DonationRecord> = {},
  ): Promise<DonationRecord | undefined> {
    const current = await this.getDonation(donationId);
    if (!current) {
      return undefined;
    }

    const updated: DonationRecord = {
      ...current,
      ...patch,
      status,
      updatedAt: new Date().toISOString(),
    };

    await this.pool.execute(
      `UPDATE donations
       SET
         donor_source_public_key = ?,
         encrypted_metadata_json = ?,
         status = ?,
         tx_hash = ?,
         ledger = ?,
         failure_reason = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        updated.donorSourcePublicKey ?? null,
        updated.encryptedMetadata ? JSON.stringify(updated.encryptedMetadata) : null,
        updated.status,
        updated.txHash ?? null,
        updated.ledger ?? null,
        updated.failureReason ?? null,
        new Date(updated.updatedAt),
        donationId,
      ],
    );

    return updated;
  }

  async getNgoMetrics(ngoId: string): Promise<DonationMetrics> {
    const [countsRows] = await this.pool.execute<CountRow[]>(
      `SELECT
         COUNT(*) AS donationCount,
         SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmedCount
       FROM donations
       WHERE ngo_id = ?`,
      [ngoId],
    );

    const [totalsRows] = await this.pool.execute<TotalsRow[]>(
      `SELECT
         asset_type,
         asset_code,
         asset_issuer,
         SUM(amount) AS totalAmount
       FROM donations
       WHERE ngo_id = ? AND status = 'confirmed'
       GROUP BY asset_type, asset_code, asset_issuer`,
      [ngoId],
    );

    const totalByAsset: Record<string, string> = {};

    for (const row of totalsRows) {
      const key =
        row.asset_type === "native"
          ? "XLM"
          : `${row.asset_code}:${row.asset_issuer ?? ""}`;
      totalByAsset[key] = stroopsToAmount(amountToStroops(String(row.totalAmount)));
    }

    const counts = countsRows[0] ?? {
      donationCount: 0,
      confirmedCount: 0,
    };

    return {
      ngoId,
      donationCount: Number(counts.donationCount ?? 0),
      confirmedCount: Number(counts.confirmedCount ?? 0),
      totalByAsset,
    };
  }
}

export const store = new MySqlStore();
