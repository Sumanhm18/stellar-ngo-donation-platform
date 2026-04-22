export type DonationStatus =
  | "intent-created"
  | "tx-built"
  | "submitted"
  | "confirmed"
  | "failed";

export type DonationAsset =
  | {
      type: "native";
      code: "XLM";
    }
  | {
      type: "credit_alphanum";
      code: string;
      issuer: string;
    };

export interface NGORecord {
  id: string;
  name: string;
  stellarPublicKey: string;
  encryptionPublicKeyPem: string;
  createdAt: string;
}

export interface EncryptedMetadataPackage {
  algorithm: "aes-256-gcm";
  keyAlgorithm: "rsa-oaep-sha256";
  ciphertextBase64: string;
  ivBase64: string;
  authTagBase64: string;
  encryptedAesKeyBase64: string;
}

export interface DonationRecord {
  id: string;
  ngoId: string;
  oneTimeAddress: string;
  muxedId: string;
  amount: string;
  asset: DonationAsset;
  memoHashHex: string;
  donorFingerprintHash?: string;
  donorSourcePublicKey?: string;
  encryptedMetadata?: EncryptedMetadataPackage;
  status: DonationStatus;
  txHash?: string;
  ledger?: number;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DonationMetrics {
  ngoId: string;
  donationCount: number;
  confirmedCount: number;
  totalByAsset: Record<string, string>;
}
