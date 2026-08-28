import crypto from "node:crypto";

export const STATUS_VALUES = Object.freeze([
  "new",
  "generating",
  "generated",
  "posted",
  "needs_revision",
  "done",
  "error",
  "policy_hold"
]);

export const MANAGEMENT_COLUMNS = Object.freeze([
  "request_id",
  "status",
  "priority",
  "locked_at",
  "locked_by",
  "generated_at",
  "drive_folder_url",
  "image_1_url",
  "image_2_url",
  "image_3_url",
  "image_4_url",
  "chatwork_message_id",
  "error_message",
  "retry_count",
  "revision_count",
  "adoption_status",
  "feedback"
]);

export const FIELD_ALIASES = Object.freeze({
  request_id: ["request_id", "依頼ID", "リクエストID"],
  status: ["status", "ステータス"],
  priority: ["priority", "優先度"],
  submitted_at: ["submitted_at", "timestamp", "タイムスタンプ", "フォーム送信日時", "回答日時"],
  requester_name: ["requester_name", "requester", "依頼者", "依頼者名", "記入者名", "担当者", "社内担当者"],
  requester_team: ["requester_team", "team", "部署", "チーム"],
  project_id: ["project_id", "案件ID", "案件id", "client_id"],
  project_name: ["project_name", "案件名", "案件", "クライアント名", "商材名", "client_name", "client"],
  product_name: ["product_name", "商材", "商品名", "サービス名"],
  media: ["media", "媒体", "配信媒体"],
  creative_title: ["creative_title", "CR案の仮タイトル", "仮タイトル", "CRタイトル"],
  target_audience: ["target_audience", "target", "ターゲット", "狙うターゲット", "対象ユーザー", "誰に向けた施策か"],
  audience_insight: [
    "audience_insight",
    "インサイト",
    "悩み",
    "欲求・不安",
    "比較軸",
    "刺したい欲求・不安・比較軸"
  ],
  appeal: ["appeal", "appeal_axis", "訴求", "訴求軸", "コンセプト"],
  offer: ["offer", "オファー", "キャンペーン", "訴求オファー", "オファーの見せ方"],
  required_copy: ["required_copy", "必須コピー", "入れたい文言", "訴求文言", "訴求の一言コピー", "キャッチコピー"],
  tone: ["tone", "希望テイスト", "テイスト", "デザインテイスト", "デザインイメージ"],
  visual_elements: ["visual_elements", "入れたいビジュアル要素", "ビジュアル要素", "画像要素"],
  proof_copy: ["proof_copy", "入れたい文言・数字・権威付け", "数字・権威付け", "権威付け"],
  performance_rationale: ["performance_rationale", "この案がCPA/CVRに効きそうな理由", "CPA/CVRに効きそうな理由"],
  landing_page_url: ["landing_page_url", "lp_url", "LP URL", "LP", "記事LP URL"],
  reference_url: ["reference_url", "参考URL", "参考画像", "参考"],
  logo_selection: ["logo_selection", "ロゴ", "選択ロゴ"],
  drive_folder_url: ["drive_folder_url", "Driveフォルダ", "Google Driveフォルダ", "保存先フォルダ"],
  chatwork_room_id: ["chatwork_room_id", "ChatworkルームID", "Chatwork room id"],
  ng_expressions: ["ng_expressions", "NG表現", "NGワード", "禁止表現"],
  notes: ["notes", "備考", "依頼詳細", "詳細"],
  retry_count: ["retry_count"],
  revision_count: ["revision_count"],
  adoption_status: ["adoption_status", "採用状況"],
  feedback: ["feedback", "FB", "フィードバック"]
});

const DEFAULT_PRIORITY = "normal";

export function normalizeRequestRow(row, options = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("row must be a plain object keyed by sheet header.");
  }

  const now = options.now ? new Date(options.now) : new Date();
  const submittedAt = readAlias(row, FIELD_ALIASES.submitted_at) || now.toISOString();
  const status = normalizeStatus(readAlias(row, FIELD_ALIASES.status) || "new");
  const normalized = {
    schema_version: "aicr-request-v1",
    request_id: "",
    status,
    priority: normalizeString(readAlias(row, FIELD_ALIASES.priority)) || DEFAULT_PRIORITY,
    source: {
      kind: options.sourceKind || "fixture",
      row_number: options.rowNumber ?? null,
      sheet_id: options.sheetId ?? null,
      gid: options.gid ?? null,
      fixture_path: options.fixturePath ?? null
    },
    submitted_at: submittedAt,
    requester: {
      name: normalizeString(readAlias(row, FIELD_ALIASES.requester_name)),
      team: normalizeString(readAlias(row, FIELD_ALIASES.requester_team))
    },
    project: {
      id: normalizeString(readAlias(row, FIELD_ALIASES.project_id)),
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
      reference: normalizeString(readAlias(row, FIELD_ALIASES.reference_url)),
      drive_folder: normalizeString(readAlias(row, FIELD_ALIASES.drive_folder_url))
    },
    chatwork: {
      room_id: normalizeString(readAlias(row, FIELD_ALIASES.chatwork_room_id))
    },
    ng_expressions: splitList(readAlias(row, FIELD_ALIASES.ng_expressions)),
    notes: normalizeString(readAlias(row, FIELD_ALIASES.notes)),
    counters: {
      retry_count: toInteger(readAlias(row, FIELD_ALIASES.retry_count), 0),
      revision_count: toInteger(readAlias(row, FIELD_ALIASES.revision_count), 0)
    },
    learning_feedback: {
      adoption_status: normalizeString(readAlias(row, FIELD_ALIASES.adoption_status)),
      feedback: normalizeString(readAlias(row, FIELD_ALIASES.feedback)),
      auto_register_learning: false
    },
    raw: row
  };

  normalized.request_id = buildRequestId(row, normalized, now);
  normalized.validation = validateRequest(normalized);
  return normalized;
}

export function validateRequest(request) {
  const warnings = [];
  const errors = [];

  if (!request.project.name) warnings.push("project.name is empty; prompt will use a generic project label.");
  if (!request.target_audience) warnings.push("target_audience is empty; prompt quality may drop.");
  if (!request.offer) warnings.push("offer is empty; variants will use a generic offer framing.");
  if (!request.required_copy) warnings.push("required_copy is empty; prompt will create copy direction only.");
  if (!STATUS_VALUES.includes(request.status)) errors.push(`unsupported status: ${request.status}`);

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}

export function isProcessableStatus(status) {
  return ["new", "error", "needs_revision"].includes(normalizeStatus(status));
}

export function normalizeStatus(status) {
  const value = normalizeString(status).toLowerCase();
  if (!value) return "new";
  if (STATUS_VALUES.includes(value)) return value;
  return value;
}

export function buildRequestId(row, normalized, now = new Date()) {
  const existing = normalizeString(readAlias(row, FIELD_ALIASES.request_id));
  if (existing) return safeToken(existing);

  const submittedDate = formatDateToken(normalized?.submitted_at, now);
  const seed = [
    normalized?.submitted_at,
    normalized?.source?.row_number,
    normalized?.requester?.name,
    normalized?.project?.id,
    normalized?.project?.name,
    normalized?.target_audience,
    normalized?.offer,
    normalized?.required_copy
  ].join("|");
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 10);
  return `aicr_${submittedDate}_${hash}`;
}

export function readAlias(row, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) return row[alias];
  }

  const normalizedKeyMap = new Map(
    Object.keys(row).map((key) => [normalizeHeader(key), key])
  );
  for (const alias of aliases) {
    const actualKey = normalizedKeyMap.get(normalizeHeader(alias));
    if (actualKey) return row[actualKey];
  }
  return "";
}

export function splitList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeString).filter(Boolean);
  }
  return normalizeString(value)
    .split(/[\n,、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function toInteger(value, fallback = 0) {
  const parsed = Number.parseInt(normalizeString(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function normalizeHeader(value) {
  return normalizeString(value).toLowerCase().replace(/\s+/g, "");
}
