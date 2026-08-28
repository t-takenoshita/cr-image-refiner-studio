import crypto from "node:crypto";

const BINARY_MAGIC = Buffer.from("CRIR1", "ascii");
const BINARY_ITERATIONS = 210_000;

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

export function encryptPagesBytes(value, password, mime = "application/octet-stream") {
  if (!password) throw new Error("SITE_PASSWORD repository secret is missing.");
  const bytes = Buffer.from(value);
  const mimeBytes = Buffer.from(String(mime || "application/octet-stream"), "utf8");
  if (mimeBytes.length > 255) throw new Error("binary payload MIME type is too long.");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, BINARY_ITERATIONS, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([
    BINARY_MAGIC,
    salt,
    iv,
    Buffer.from([mimeBytes.length]),
    mimeBytes,
    ciphertext
  ]);
}

export function decryptPagesBytes(value, password) {
  if (!password) throw new Error("SITE_PASSWORD repository secret is missing.");
  try {
    const envelope = Buffer.from(value);
    if (envelope.length < 5 + 16 + 12 + 1 + 16) throw new Error("binary envelope is too small");
    if (!envelope.subarray(0, 5).equals(BINARY_MAGIC)) throw new Error("binary envelope magic is invalid");
    const salt = envelope.subarray(5, 21);
    const iv = envelope.subarray(21, 33);
    const mimeLength = envelope[33];
    const dataOffset = 34 + mimeLength;
    if (dataOffset + 16 > envelope.length) throw new Error("binary envelope is truncated");
    const mime = envelope.subarray(34, dataOffset).toString("utf8") || "application/octet-stream";
    const encrypted = envelope.subarray(dataOffset);
    const ciphertext = encrypted.subarray(0, -16);
    const authTag = encrypted.subarray(-16);
    const key = crypto.pbkdf2Sync(password, salt, BINARY_ITERATIONS, 32, "sha256");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return { bytes: Buffer.concat([decipher.update(ciphertext), decipher.final()]), mime };
  } catch {
    throw new Error("サイトパスワードが違うか、暗号化された画像が壊れています。");
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value || "");
  } catch {
    throw new Error("workflow input JSON is invalid.");
  }
}
