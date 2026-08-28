import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_TEXT_QUALITY_GATE_CONFIG = Object.freeze({
  enabled: false,
  model: "gpt-4o-mini",
  max_retries: 2,
  max_output_tokens: 600
});

export function resolveTextQualityGateConfig(guardrails = {}, args = {}) {
  const rawConfig = guardrails.text_quality_gate || {};
  const argProvided = Object.prototype.hasOwnProperty.call(args, "qualityGate");
  const enabled = argProvided ? Boolean(args.qualityGate) : rawConfig.enabled === true;
  const maxRetries = Number.parseInt(rawConfig.max_retries ?? DEFAULT_TEXT_QUALITY_GATE_CONFIG.max_retries, 10);
  const maxOutputTokens = Number.parseInt(
    rawConfig.max_output_tokens ?? DEFAULT_TEXT_QUALITY_GATE_CONFIG.max_output_tokens,
    10
  );

  return {
    ...DEFAULT_TEXT_QUALITY_GATE_CONFIG,
    ...rawConfig,
    enabled,
    max_retries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : DEFAULT_TEXT_QUALITY_GATE_CONFIG.max_retries,
    max_output_tokens:
      Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? maxOutputTokens
        : DEFAULT_TEXT_QUALITY_GATE_CONFIG.max_output_tokens
  };
}

export async function evaluateTextQualityGate(options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing. Token value was not read or displayed.");
  }
  if (!options.imagePath) throw new Error("imagePath is required.");

  const config = {
    ...DEFAULT_TEXT_QUALITY_GATE_CONFIG,
    ...(options.config || {})
  };
  const expectedText = String(options.expectedText || "");
  const payload = await buildVisionPayload({
    imagePath: options.imagePath,
    expectedText,
    variantId: options.variantId,
    variantIndex: options.variantIndex,
    config
  });
  const response = await (options.fetchImpl || fetch)("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`OpenAI vision quality gate returned HTTP ${response.status}: ${safeErrorExcerpt(text, apiKey)}`);
  }

  const outputText = extractResponseText(body);
  const parsed = parseQualityGateJson(outputText);
  const ok = parsed.ok === true || normalizeStatus(parsed.status) === "ok";
  const extractedText = normalizeExtractedText(parsed.extracted_text ?? parsed.extracted_texts ?? "");

  return {
    schema_version: "aicr-text-quality-gate-result-v1",
    ok,
    status: ok ? "ok" : "ng",
    expected_text: expectedText,
    extracted_text: extractedText,
    reason: String(parsed.reason || parsed.reasons || (ok ? "text matched" : "text mismatch")).trim(),
    raw_model_output: outputText,
    model: payload.model,
    response_id: body.id || null,
    usage: body.usage || null
  };
}

export async function buildVisionPayload({ imagePath, expectedText, variantId, variantIndex, config }) {
  const bytes = await fs.readFile(imagePath);
  const mimeType = imageMimeType(imagePath);
  return {
    model: config.model || DEFAULT_TEXT_QUALITY_GATE_CONFIG.model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildQualityGatePrompt({ expectedText, variantId, variantIndex })
          },
          {
            type: "input_image",
            image_url: `data:${mimeType};base64,${bytes.toString("base64")}`
          }
        ]
      }
    ],
    max_output_tokens: config.max_output_tokens || DEFAULT_TEXT_QUALITY_GATE_CONFIG.max_output_tokens
  };
}

export function buildQualityGatePrompt({ expectedText, variantId, variantIndex } = {}) {
  const expected = String(expectedText || "");
  return [
    "あなたは広告バナーの日本語文字検品者です。",
    "画像内に描かれている全ての文字・数字・記号・英字を読み取り、指定文言と一字一句照合してください。",
    expected
      ? `指定文言: 「${expected}」`
      : "指定文言: なし。画像内に文字・数字・記号・英字が1つでもあればNGです。",
    "判定基準:",
    "- 指定文言と完全一致する文字だけが読める場合はOK。",
    "- 誤字、脱字、文字化け、読めない文字、指定外の文字・記号・英字、架空ロゴ文字があればNG。",
    "- 装飾として見えるだけでも文字に見えるものは全て抽出対象にする。",
    `variant_index: ${variantIndex ?? ""}`,
    `variant_id: ${variantId || ""}`,
    "必ず次のJSONだけを返してください。説明文やMarkdownは不要です。",
    '{"ok":true,"status":"ok","extracted_text":"読み取った全文","reason":"理由"}'
  ].join("\n");
}

export function extractResponseText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  const output = Array.isArray(body?.output) ? body.output : [];
  const texts = [];
  for (const item of output) {
    if (typeof item?.text === "string") texts.push(item.text);
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") texts.push(content.text);
      if (typeof content?.output_text === "string") texts.push(content.output_text);
    }
  }
  if (texts.length) return texts.join("\n");
  return typeof body?.raw === "string" ? body.raw : JSON.stringify(body || {});
}

export function parseQualityGateJson(value) {
  const text = stripMarkdownFence(String(value || "").trim());
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Text quality gate response was not JSON: ${text.slice(0, 240)}`);
  }
}

function stripMarkdownFence(value) {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeExtractedText(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean).join("\n");
  return String(value || "").trim();
}

function imageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function safeErrorExcerpt(text, token) {
  return String(text || "").replaceAll(token, "[redacted]").slice(0, 240);
}
