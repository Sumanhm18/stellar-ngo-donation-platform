import crypto from "node:crypto";
import { config } from "./config.js";
import { EncryptedMetadataPackage } from "./types.js";

export function hashIdentityFingerprint(rawFingerprint: string): string {
  const normalized = rawFingerprint.trim().toLowerCase();

  return crypto
    .createHash("sha256")
    .update(`${config.identityPepper}:${normalized}`)
    .digest("hex");
}

export function encryptMetadataForNgo(
  metadata: Record<string, string>,
  ngoEncryptionPublicKeyPem: string,
): EncryptedMetadataPackage {
  const plaintext = Buffer.from(JSON.stringify(metadata), "utf8");
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: ngoEncryptionPublicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey,
  );

  return {
    algorithm: "aes-256-gcm",
    keyAlgorithm: "rsa-oaep-sha256",
    ciphertextBase64: ciphertext.toString("base64"),
    ivBase64: iv.toString("base64"),
    authTagBase64: authTag.toString("base64"),
    encryptedAesKeyBase64: encryptedAesKey.toString("base64"),
  };
}
