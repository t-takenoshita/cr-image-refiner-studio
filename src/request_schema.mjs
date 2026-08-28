import crypto from "node:crypto";

const FIELD_ALIASES = Object.freeze({
  request_id: ["request_id", "依頼ID"],
  submitted_at: ["submitted_at", "タイムスタンプ"],
  requester_name: ["requester_name", "依頼者名"],
  project_name: ["project_name", "案件名"],
  product_name: ["product_name", "商材"],
  media: ["media", "媒体"],
  creative_title: ["creative_title", "CR案の仮タイトル"],
  target_audience: ["target_audience", "ターゲット"],
  audience_insight: ["audience_insight", "インサイト"],
  appeal: ["appeal", "訴求軸"],
  offer: ["offer", "オファー"],
  required_copy: ["required_copy", "必須コピー"],
  tone: ["tone", "希望テイスト"],
  visual_elements: ["visual_elements", "入れたいビジュアル要素"],
  proof_copy: ["proof_copy", "入れたい文言・数字・権威付け"],
  performance_rationale: ["performance_rationale", "この案がCPA/CVRに効きそうな理由"],
  landing_page_url: ["landing_page_url", "LP URL"],
  reference_url: ["reference_url", "参考URL"],
  logo_selection: ["logo_selection", "ロゴ"],
  ng_expressions: ["ng_expressions", "NG表現"],
  notes: ["notes", "備考"]
});

export function normalizeRequestRow(row, options = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("request must be a plain object.");
  }

  const now = options.now ? new Date(options.now) : new Date();
  const submittedAt = readAlias(row, FIELD_ALIASES.submitted_at) || now.toISOString();
  const normalized = {
    schema_version: "aicr-web-request-v1",
    request_id: "",
    source: { kind: options.sourceKind || "web" },
    submitted_at: submittedAt,
    requester: { name: normalizeString(readAlias(row, FIELD_ALIASES.requester_name)) },
    project: {
      name: normalizeString(readAlias(row, FIELD_ALIASES.project_name)),
      product: normalizeString(readAlias(row, FIELD_ALIASES.product_name)),
      media: normalizeString(readAlias(row, FIELD_ALIASES.media))
    },
    creative_title: normalizeString(readAlias(row, FIELD_ALIASES.creative_title)),
    target_audience: normalizeString(readAlias(row, FIELD_ALIASES.target_audience)),
    audience_insight: normalizeString(readAlias(row, FIELD_ALIASES.audience_insight)),
    appeal: normalizeString(readAlias(row, FIELD_ALIASES.appeal)),
    offer: normalizeString(readAlias(row, FIELD_ALIASES.offer)),
    required_copy: normalizeString(readAlias(row, FIELD_ALIASES.required_copy)),
    tone: normalizeString(readAlias(row, FIELD_ALIASES.tone)),
    visual_elements: normalizeString(readAlias(row, FIELD_ALIASES.visual_elements)),
    proof_copy: normalizeString(readAlias(row, FIELD_ALIASES.proof_copy)),
    performance_rationale: normalizeString(readAlias(row, FIELD_ALIASES.performance_rationale)),
    logo_selection: normalizeString(readAlias(row, FIELD_ALIASES.logo_selection)),
    urls: {
      landing_page: normalizeString(readAlias(row, FIELD_ALIASES.landing_page_url)),
      reference: normalizeString(readAlias(row, FIELD_ALIASES.reference_url))
    },
    ng_expressions: splitList(readAlias(row, FIELD_ALIASES.ng_expressions)),
    notes: normalizeString(readAlias(row, FIELD_ALIASES.notes))
  };

  normalized.request_id = buildRequestId(row, normalized, now);
  normalized.validation = validateRequest(normalized);
  return normalized;
}

function validateRequest(request) {
  const warnings = [];
  if (!request.project.name) warnings.push("案件名が未入力です。");
  if (!request.target_audience) warnings.push("ターゲットが未入力です。");
  if (!request.required_copy) warnings.push("必須コピーが未入力のため、文字なし画像として設計します。");
  return { ok: true, errors: [], warnings };
}

function buildRequestId(row, normalized, now) {
  const existing = normalizeString(readAlias(row, FIELD_ALIASES.request_id));
  if (existing) return safeToken(existing);

  const seed = [
    normalized.submitted_at,
    normalized.requester.name,
    normalized.project.name,
    normalized.target_audience,
    normalized.offer,
    normalized.required_copy
  ].join("|");
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 10);
  return `aicr_${formatDateToken(normalized.submitted_at, now)}_${hash}`;
}

function readAlias(row, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) return row[alias];
  }
  return "";
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(normalizeString).filter(Boolean);
  return normalizeString(value)
    .split(/[\n,、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function safeToken(value) {
  return normalizeString(value)
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function formatDateToken(value, fallbackDate) {
  const parsed = new Date(value);
  const date = Number.isNaN(parsed.getTime()) ? fallbackDate : parsed;
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("");
}
