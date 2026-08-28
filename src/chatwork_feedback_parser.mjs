import { parseFeedback, parseVariantIndexes } from "./feedback_parser.mjs";

const CHATWORK_REPLY_RE = /^\[rp [^\]]+\][^\n]*\n?/gm;
const CHATWORK_TO_RE = /\[To:\d+\][^\n]*\n?/gm;
const CHATWORK_INFO_RE = /\[info\][\s\S]*?\[\/info\]/g;

export function parseChatworkFeedbackMessages(messages = [], options = {}) {
  const requestId = String(options.requestId || "").trim();
  const feedbackItems = [];
  const skipped = [];

  for (const message of messages) {
    const parsed = parseChatworkFeedbackBody(message.body, { requestId });
    if (!parsed.is_feedback) {
      skipped.push({
        message_id: stringValue(message.message_id),
        reason: parsed.skip_reason
      });
      continue;
    }

    feedbackItems.push({
      message_id: stringValue(message.message_id),
      account_id: message.account?.account_id ?? message.account_id ?? "",
      account_name: message.account?.name ?? message.account_name ?? "",
      send_time: toIsoTime(message.send_time),
      ...parsed.item
    });
  }

  return {
    schema_version: "aicr-chatwork-feedback-parse-v1",
    parsed_at: new Date().toISOString(),
    request_id: requestId,
    feedback_count: feedbackItems.length,
    feedback_items: feedbackItems,
    skipped_count: skipped.length,
    skipped
  };
}

export function parseChatworkFeedbackBody(body, options = {}) {
  const cleanBody = cleanChatworkBody(body);
  if (!cleanBody) return { is_feedback: false, skip_reason: "empty_body" };
  if (!isFeedbackLike(cleanBody)) return { is_feedback: false, skip_reason: "not_feedback" };

  const requestId = String(options.requestId || "").trim();
  const requestField = extractField(cleanBody, ["(?:修正\\s*)?request", "req", "id"]);
  const parsedFeedback = parseFeedback(cleanBody);
  const feedbackText = extractField(cleanBody, ["FB", "feedback"]) || parsedFeedback.feedback_text || cleanBody;
  const requestIdHint = fullRequestId(requestField || cleanBody);
  const imageLineVariantIndexes = explicitImageIndexes(cleanBody);
  const imageLineVariantIndex = imageLineVariantIndexes.length === 1 ? imageLineVariantIndexes[0] : null;
  const filenameVariantIndex = variantIndexFromFilename(requestField || cleanBody);
  const parserVariantIndex = parsedFeedback.variant_index;

  const hasVariantConflict = Boolean(
    filenameVariantIndex && imageLineVariantIndexes.length && !imageLineVariantIndexes.includes(filenameVariantIndex)
  );
  const candidateVariantIndexes = [
    ...new Set([...imageLineVariantIndexes, filenameVariantIndex, parserVariantIndex].filter(Boolean))
  ];
  const resolvedVariantIndexes = hasVariantConflict
    ? []
    : imageLineVariantIndexes.length
      ? imageLineVariantIndexes
      : candidateVariantIndexes;
  const resolvedVariantIndex =
    !hasVariantConflict && resolvedVariantIndexes.length === 1 ? resolvedVariantIndexes[0] : null;
  const requestIdMatches = Boolean(requestId && requestIdHint && requestIdHint === requestId);
  const isForeignRequest = Boolean(requestId && requestIdHint && requestIdHint !== requestId);
  const routingStatus = routeStatus({
    hasVariantConflict,
    isForeignRequest,
    resolvedVariantIndexes
  });

  return {
    is_feedback: true,
    item: {
      raw_body: cleanBody,
      request_field: requestField,
      request_id_hint: requestIdHint || parsedFeedback.request_id_hint || "",
      request_id_match: requestIdMatches,
      image_line_variant_index: imageLineVariantIndex,
      image_line_variant_indexes: imageLineVariantIndexes,
      filename_variant_index: filenameVariantIndex,
      parser_variant_index: parserVariantIndex,
      candidate_variant_indexes: candidateVariantIndexes,
      resolved_variant_index: resolvedVariantIndex,
      resolved_variant_indexes: resolvedVariantIndexes,
      feedback_text: feedbackText,
      directives: parsedFeedback.directives,
      routing_status: routingStatus,
      can_build_revision_prompt:
        routingStatus === "resolved" && Boolean(resolvedVariantIndex) && !isForeignRequest
    }
  };
}

export function cleanChatworkBody(body) {
  return String(body || "")
    .replace(CHATWORK_REPLY_RE, "")
    .replace(CHATWORK_TO_RE, "")
    .replace(CHATWORK_INFO_RE, "")
    .trim();
}

export function messageIdAfter(value, since) {
  if (!since) return true;
  try {
    return BigInt(value) > BigInt(since);
  } catch {
    return String(value) > String(since);
  }
}

function isFeedbackLike(text) {
  if (isSystemDeliveryPost(text)) return false;
  if (isFileUploadNotice(text)) return false;
  if (/(^|\n)\s*(?:FB|feedback)\s*[:：]/i.test(text)) return true;

  const variantIndexes = parseVariantIndexes(text);
  if (!variantIndexes.length) return false;

  const hasCorrectionSignal = /(修正|変更|差し替|NG|不可|なし|無し|外|削|消|やめ|弱|強|直|調整|フィードバック|小さ|大き|読みにく|読みづら|多すぎ|少な|目立|色|文言|コピー|構図|期間限定)/i.test(text);
  if (!hasCorrectionSignal && !fullRequestId(text)) return false;
  return hasActionableFeedbackText(text);
}

function routeStatus({ hasVariantConflict, isForeignRequest, resolvedVariantIndexes }) {
  if (isForeignRequest) return "foreign_request";
  if (hasVariantConflict) return "conflict_needs_human_confirmation";
  if (!resolvedVariantIndexes.length) return "needs_manual_routing";
  if (resolvedVariantIndexes.length > 1) return "resolved_multi_variant";
  return "resolved";
}

function extractField(text, names) {
  for (const name of names) {
    const pattern = new RegExp(`(?:^|\\n)\\s*${name}\\s*[:：]\\s*([^\\n]+)`, "i");
    const match = String(text || "").match(pattern);
    if (match) return match[1].trim();
  }
  return "";
}

function explicitImageIndexes(text) {
  const indexes = new Set();
  for (const line of String(text || "").split("\n")) {
    if (!/^\s*(?:画像|image)\s*[:：#_-]?\s*(?:[①②③④❶❷❸❹]|\d{1,2})/i.test(line)) continue;
    for (const index of parseVariantIndexes(line)) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}

function variantIndexFromFilename(text) {
  const match = String(text || "").match(/variant[_-](\d{1,2})/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function fullRequestId(text) {
  const match = String(text || "").match(/\baicr_\d{8}_[a-f0-9]{10}\b/i);
  return match ? match[0] : "";
}

function isSystemDeliveryPost(text) {
  return /AICR Factory\s+(?:初稿|修正).{0,24}完了/.test(text) || /FBは「画像1/.test(text);
}

function isFileUploadNotice(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return Boolean(lines.length) && lines.every((line) => /^添付:\s*.+\.(?:png|jpe?g|webp|gif)$/i.test(line));
}

function hasActionableFeedbackText(text) {
  const contentLines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[toall\]$/i.test(line))
    .filter((line) => !/^(?:request_id|request|req|id)\s*[:：]\s*\S+/i.test(line))
    .filter((line) => !isVariantSelectorOnlyLine(line));
  return contentLines.length > 0;
}

function isVariantSelectorOnlyLine(line) {
  const stripped = String(line || "")
    .replace(/^(?:画像|image|案|variant|v)\s*[:：#_-]?/i, "")
    .trim();
  if (!stripped) return false;
  return /^(?:(?:[①②③④❶❷❸❹]|\d{1,2})\s*(?:[.．,、，・/／&＆+＋]|と|and|〜|~|-)?\s*)+$/i.test(stripped);
}

function stringValue(value) {
  return value == null ? "" : String(value);
}

function toIsoTime(value) {
  if (!value) return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return stringValue(value);
  return new Date(number * 1000).toISOString();
}
