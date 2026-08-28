import fs from "node:fs/promises";
import path from "node:path";

const MAX_IMAGE_INPUT_BYTES = 20_971_520;

export async function loadLogoInputImage(reference, options = {}) {
  const raw = String(reference || "").trim();
  if (!raw) throw new Error("logo reference is empty.");
  if (/^data:image\//i.test(raw)) {
    return {
      schema_version: "aicr-logo-input-image-v1",
      input_type: "data_url",
      source_type: "data_url",
      source_reference: "[data-url]",
      image_url: raw,
      mime_type: raw.match(/^data:([^;,]+)/i)?.[1] || "image/png",
      bytes: null
    };
  }

  if (path.isAbsolute(raw)) {
    const bytes = await fs.readFile(raw);
    if (bytes.length > MAX_IMAGE_INPUT_BYTES) throw new Error(`Logo image is too large for image input (${bytes.length} bytes).`);
    const mimeType = sniffImageMime(bytes, `file://${raw}`);
    if (!mimeType) throw new Error(`Local logo file is not a supported image: ${raw}`);
    return {
      schema_version: "aicr-logo-input-image-v1",
      input_type: "data_url",
      source_type: "local_file",
      source_reference: raw,
      image_url: `data:${mimeType};base64,${bytes.toString("base64")}`,
      mime_type: mimeType,
      bytes: bytes.length
    };
  }

  const driveFileId = extractDriveFileId(raw);
  const sourceType = driveFileId ? "drive_file_id" : classifyLogoReference(raw);
  const url = sourceType === "drive_file_id" ? buildDriveDownloadUrl(driveFileId) : raw;
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Unsupported logo reference. Use Drive file ID or http(s) URL: ${raw}`);
  }

  const response = await (options.fetchImpl || fetch)(url, {
    method: "GET",
    redirect: "follow"
  });
  const contentType = response.headers?.get?.("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`Logo image fetch failed with HTTP ${response.status}.`);
  }
  if (bytes.length > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`Logo image is too large for image input (${bytes.length} bytes).`);
  }

  const mimeType = contentType
    ? (contentType.startsWith("image/") ? contentType : "")
    : sniffImageMime(bytes, url);
  if (!mimeType) {
    throw new Error("Logo fetch did not return image content. Check that the Drive file or URL is publicly readable.");
  }

  return {
    schema_version: "aicr-logo-input-image-v1",
    input_type: "data_url",
    source_type: sourceType,
    source_reference: raw,
    resolved_url: sourceType === "drive_file_id" ? url : null,
    image_url: `data:${mimeType};base64,${bytes.toString("base64")}`,
    mime_type: mimeType,
    bytes: bytes.length
  };
}

export function summarizeLogoInputImage(logoInput) {
  if (!logoInput) return null;
  return {
    schema_version: "aicr-logo-input-image-summary-v1",
    input_type: logoInput.input_type,
    source_type: logoInput.source_type,
    source_reference: logoInput.source_reference,
    mime_type: logoInput.mime_type,
    bytes: logoInput.bytes
  };
}

export function buildDriveDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

export function extractDriveFileId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[a-zA-Z0-9_-]{20,}$/.test(raw)) return raw;
  const filePathMatch = raw.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (filePathMatch) return filePathMatch[1];
  const queryMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch) return queryMatch[1];
  return "";
}

export function classifyLogoReference(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:image\//i.test(raw)) return "data_url";
  if (extractDriveFileId(raw)) return "drive_file_id";
  if (/^https?:\/\//i.test(raw)) return "url";
  return "unknown";
}

function sniffImageMime(bytes, url = "") {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }

  const ext = path.extname(new URL(url).pathname || "").toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "";
}
