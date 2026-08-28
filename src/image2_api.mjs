import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_IMAGE2_API_CONFIG = Object.freeze({
  model: "gpt-image-2",
  size: "1088x1088",
  final_size: "1080x1080",
  quality: "medium",
  output_format: "png",
  moderation: "auto",
  max_transient_retries: 2
});

export function buildImage2ApiPayload(prompt, config = {}) {
  const merged = { ...DEFAULT_IMAGE2_API_CONFIG, ...config };
  return {
    model: merged.model,
    prompt: String(prompt || ""),
    n: 1,
    size: merged.size,
    quality: merged.quality,
    output_format: merged.output_format,
    moderation: merged.moderation
  };
}

export function buildImage2EditApiPayload(prompt, config = {}) {
  const merged = { ...DEFAULT_IMAGE2_API_CONFIG, ...config };
  const payload = buildImage2ApiPayload(prompt, merged);
  if (merged.background) payload.background = merged.background;
  if (merged.input_fidelity && merged.model !== "gpt-image-2") {
    payload.input_fidelity = merged.input_fidelity;
  }
  return payload;
}

export async function generateImage2File(options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing. Token value was not read or displayed.");
  if (!options.prompt) throw new Error("prompt is required.");
  if (!options.outputPath) throw new Error("outputPath is required.");

  const inputImages = (options.inputImages || []).filter(Boolean);
  const editMode = inputImages.length > 0;
  const payload = editMode
    ? buildImage2EditApiPayload(options.prompt, options.config)
    : buildImage2ApiPayload(options.prompt, options.config);
  const endpoint = editMode
    ? "https://api.openai.com/v1/images/edits"
    : "https://api.openai.com/v1/images/generations";
  const fetchImpl = options.fetchImpl || fetch;
  const maxTransientRetries = Number(
    options.config?.max_transient_retries ?? DEFAULT_IMAGE2_API_CONFIG.max_transient_retries
  );
  const sleepImpl = options.sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let response;
  let text = "";
  let transientRetryCount = 0;

  for (let attempt = 0; attempt <= maxTransientRetries; attempt += 1) {
    try {
      const request = editMode
        ? await buildEditRequest(payload, inputImages, fetchImpl)
        : {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          };
      if (editMode) request.headers.Authorization = `Bearer ${apiKey}`;
      response = await fetchImpl(endpoint, { method: "POST", ...request });
      text = await response.text();
      if (response.ok || !isTransientStatus(response.status) || attempt >= maxTransientRetries) break;
    } catch (error) {
      if (attempt >= maxTransientRetries) throw error;
      text = "";
    }
    transientRetryCount += 1;
    await sleepImpl(1000 * 2 ** attempt);
  }

  if (!response) throw new Error("OpenAI Images API did not return a response.");
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`OpenAI Images API returned HTTP ${response.status}: ${safeErrorExcerpt(text, apiKey)}`);
  }

  const bytes = Buffer.from(extractImageBase64(body), "base64");
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, bytes);

  return {
    ok: true,
    mode: editMode ? "image_edit" : "image_generation",
    endpoint,
    model: payload.model,
    size: payload.size,
    output_format: payload.output_format,
    input_image_count: inputImages.length,
    transient_retry_count: transientRetryCount,
    output_path: options.outputPath,
    bytes_written: bytes.length,
    usage: body.usage || null,
    created: body.created || null
  };
}

async function buildEditRequest(payload, inputImages, fetchImpl) {
  const form = new FormData();
  Object.entries(payload).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") form.append(key, String(value));
  });
  for (let index = 0; index < inputImages.length; index += 1) {
    const { blob, filename } = await imageInputToBlob(inputImages[index], index, fetchImpl);
    form.append("image[]", blob, filename);
  }
  return { headers: {}, body: form };
}

async function imageInputToBlob(input, index, fetchImpl) {
  const value = typeof input === "object"
    ? input.path || input.dataUrl || input.image_url || input.url
    : input;
  if (typeof value !== "string" || !value) throw new Error("reference image is invalid.");

  if (value.startsWith("data:")) {
    const match = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) throw new Error("reference image data URL is invalid.");
    const mime = match[1] || "image/png";
    const bytes = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]));
    return { blob: new Blob([bytes], { type: mime }), filename: `reference-${index + 1}.${extensionForMime(mime)}` };
  }

  if (/^https?:\/\//i.test(value)) {
    const response = await fetchImpl(value);
    if (!response.ok) throw new Error(`reference image download failed: HTTP ${response.status}`);
    const blob = await response.blob();
    return {
      blob,
      filename: path.basename(new URL(value).pathname) || `reference-${index + 1}.${extensionForMime(blob.type)}`
    };
  }

  const bytes = await fs.readFile(value);
  const mime = mimeForExtension(path.extname(value));
  return { blob: new Blob([bytes], { type: mime }), filename: path.basename(value) };
}

function isTransientStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function extractImageBase64(body) {
  const direct = body?.data?.[0]?.b64_json;
  if (direct) return direct;
  const outputItem = body?.output?.find?.((item) => item?.type === "image_generation_call");
  const nested = outputItem?.result || outputItem?.b64_json;
  if (nested) return nested;
  throw new Error("OpenAI Images API response did not include b64_json.");
}

function mimeForExtension(extension) {
  return new Map([
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".webp", "image/webp"],
    [".gif", "image/gif"]
  ]).get(extension.toLowerCase()) || "image/png";
}

function extensionForMime(mime) {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}

function safeErrorExcerpt(text, token) {
  return String(text || "").replaceAll(token, "[redacted]").slice(0, 400);
}
