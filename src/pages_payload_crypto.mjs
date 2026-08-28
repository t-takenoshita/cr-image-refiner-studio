import crypto from "node:crypto";

export function decryptPagesPayload(value, password) {
  if (!password) throw new Error("SITE_PASSWORD repository secret is missing.");
  const envelope = parseJson(value);
  if (
    envelope?.v !== 1
    || envelope.alg !== "A256GCM"
    || envelope.kdf !== "PBKDF2-SHA256"
  ) {
    throw new Error("workflow payload encryption format is invalid.");
  }
  const iterations = Number(envelope.iterations);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) {
    throw new Error("workflow payload KDF settings are invalid.");
  }
  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const encrypted = Buffer.from(envelope.data, "base64");
    if (salt.length !== 16 || iv.length !== 12 || encrypted.length <= 16) throw new Error("invalid envelope");
    const ciphertext = encrypted.subarray(0, -16);
    const authTag = encrypted.subarray(-16);
    const key = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext);
  } catch {
    throw new Error("サイトパスワードが違うか、暗号化された依頼内容が壊れています。");
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value || "");
  } catch {
    throw new Error("workflow input JSON is invalid.");
  }
}
