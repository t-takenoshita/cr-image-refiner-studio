import fs from "node:fs/promises";

const CIRCLED_NUMBER_MAP = Object.freeze({
  "①": 1,
  "②": 2,
  "③": 3,
  "④": 4,
  "❶": 1,
  "❷": 2,
  "❸": 3,
  "❹": 4
});
const VARIANT_TOKEN_PATTERN = "(?:[①②③④❶❷❸❹]|\\d{1,2})";
const VARIANT_SELECTOR_PATTERN = `${VARIANT_TOKEN_PATTERN}(?:\\s*(?:[.．,、，・/／&＆+＋]|と|and|〜|~|-)\\s*${VARIANT_TOKEN_PATTERN})*`;
const MAX_VARIANT_INDEX = 99;

const INTENT_RULES = Object.freeze([
  {
    key: "weaken_offer",
    pattern: /(無料|最大無料|クーポン|オファー).{0,16}(強すぎ|弱め|控え|自然|抑え)|強すぎ.{0,16}(無料|最大無料|クーポン|オファー)/
  },
  {
    key: "remove_limited_time_offer",
    pattern: /(期間限定|今だけ|限定|締切|タイムセール|期限).{0,16}(NG|不可|なし|無し|外|削|消|やめ|入れない|使わない)|(?:NG|不可|なし|無し|外|削|消|やめ|入れない|使わない).{0,16}(期間限定|今だけ|限定|締切|タイムセール|期限)/
  },
  {
    key: "remove_step_flow",
    pattern: /(3STEP|３STEP|3ステップ|３ステップ|簡単3|簡単３|ステップ|手順|流れ|予約.{0,4}相談|相談.{0,4}来院|来院.{0,4}施術).{0,24}(無く|なく|消|削|外|入れない|使わない|NG|不要)|(?:無く|なく|消|削|外|入れない|使わない|NG|不要).{0,24}(3STEP|３STEP|3ステップ|３ステップ|簡単3|簡単３|ステップ|手順|流れ|予約.{0,4}相談|相談.{0,4}来院|来院.{0,4}施術)/
  },
  {
    key: "reduce_ba",
    pattern: /(BA|ビフォーアフター|before|after|比較).{0,16}(弱め|控え|抑え|自然|やりすぎ|強すぎ)|強すぎ.{0,16}(BA|ビフォーアフター|比較)/
  },
  {
    key: "increase_ba",
    pattern: /(BA|ビフォーアフター|before|after|比較).{0,16}(強め|もっと|推し|分かりやす)/
  },
  {
    key: "improve_readability",
    pattern: /(文字|コピー|テキスト|可読|読みにく|読みづら|小さい|潰れ)/
  },
  {
    key: "reduce_information_density",
    pattern: /(情報量|要素|文字量|詰め込み|ごちゃごちゃ).{0,20}(多すぎ|多い|減ら|半分|絞|少な|シンプル)|半分くらい/
  },
  {
    key: "change_copy",
    pattern: /(コピー|文言|テキスト|見出し|タイトル|オファー).{0,24}(変え|修正|差し替え|変更|して欲しい|してほしい|したい|入れ|使)/
  },
  {
    key: "change_color",
    pattern: /(色|カラー|青|ピンク|白|黒|トーン|雰囲気).{0,16}(変え|修正|寄せ|弱め|強め|落ち着)/
  },
  {
    key: "change_composition",
    pattern: /(構図|レイアウト|配置|写真|UI|カード|余白).{0,16}(変え|修正|寄せ|大き|小さ|減ら|増や)/
  },
  {
    key: "policy_safer",
    pattern: /(審査|薬機|医療広告|ポリシー|媒体).{0,16}(危な|安全|弱め|通り|リスク)/
  }
]);

export async function parseFeedbackFile(filePath, options = {}) {
  const text = await fs.readFile(filePath, "utf8");
  return parseFeedback(text, options);
}

export function parseFeedback(text, options = {}) {
  const raw = String(text || "").trim();
  const requestIdHint = parseRequestIdHint(raw);
  const variantIndex = options.variantIndex || parseVariantIndex(raw);
  const feedbackText = stripRoutingHints(raw);
  const directives = inferDirectives(raw);

  return {
    schema_version: "aicr-feedback-parse-v1",
    ok: Boolean(raw),
    raw_feedback: raw,
    request_id_hint: requestIdHint,
    variant_index: variantIndex,
    feedback_text: feedbackText,
    directives,
    needs_manual_routing: !variantIndex,
    parsed_at: new Date().toISOString()
  };
}

export function parseVariantIndex(text) {
  return parseVariantIndexes(text)[0] || null;
}

export function parseVariantIndexes(text) {
  const raw = String(text || "");
  const indexes = new Set();
  for (const [symbol, value] of Object.entries(CIRCLED_NUMBER_MAP)) {
    if (raw.includes(symbol)) indexes.add(value);
  }

  const patterns = [
    new RegExp(`(?:画像|image|案|variant|v)\\s*[:：#_-]?\\s*(${VARIANT_SELECTOR_PATTERN})`, "gi"),
    new RegExp(`(${VARIANT_TOKEN_PATTERN})\\s*(?:枚目|案目|番|つ目)`, "gi"),
    /(?:variant_|variant-)(\d{1,2})/gi
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      for (const index of indexesFromSelector(match[1])) indexes.add(index);
    }
  }
  return [...indexes].sort((a, b) => a - b);
}

export function parseRequestIdHint(text) {
  const raw = String(text || "");
  const full = raw.match(/\baicr_\d{8}_[a-f0-9]{10}\b/i);
  if (full) return full[0];
  const explicitShort = raw.match(/(?:request|req|id|修正)\s*[:：]?\s*([a-f0-9]{8,12})\b/i);
  if (explicitShort) return explicitShort[1];
  const bareShort = raw.match(/\b([a-f0-9]{8,12})\b/i);
  return bareShort ? bareShort[1] : "";
}

export function inferDirectives(text) {
  const raw = String(text || "");
  return Object.fromEntries(INTENT_RULES.map((rule) => [rule.key, rule.pattern.test(raw)]));
}

function stripRoutingHints(text) {
  return String(text || "")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (isVariantSelectorOnlyLine(trimmed)) return "";
      return trimmed
        .replace(/^\s*(?:修正\s*)?request(?:_id)?\s*[:：]\s*\S+\s*/i, "")
        .replace(/^\s*(?:画像|image|案|variant|v)\s*[:：#_-]?\s*(?:[①②③④❶❷❸❹]|\d{1,2})\s*[、,。:：\s]*/i, "")
        .trim();
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function indexesFromSelector(selector) {
  const normalized = normalizeSelectorSymbols(selector);
  const range = normalized.match(/(\d{1,2})\s*[〜~-]\s*(\d{1,2})/);
  if (range) {
    const start = Number.parseInt(range[1], 10);
    const end = Number.parseInt(range[2], 10);
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    return sanitizeVariantIndexes(Array.from({ length: max - min + 1 }, (_, index) => min + index));
  }
  return sanitizeVariantIndexes((normalized.match(/\d{1,2}/g) || []).map((value) => Number.parseInt(value, 10)));
}

function normalizeSelectorSymbols(value) {
  return String(value || "")
    .replace(/[①❶]/g, "1")
    .replace(/[②❷]/g, "2")
    .replace(/[③❸]/g, "3")
    .replace(/[④❹]/g, "4");
}

function sanitizeVariantIndexes(values) {
  return values.filter((value) => Number.isInteger(value) && value >= 1 && value <= MAX_VARIANT_INDEX);
}

function isVariantSelectorOnlyLine(line) {
  const stripped = String(line || "")
    .replace(/^(?:画像|image|案|variant|v)\s*[:：#_-]?/i, "")
    .trim();
  if (!stripped) return false;
  return /^(?:(?:[①②③④❶❷❸❹]|\d{1,2})\s*(?:[.．,、，・/／&＆+＋]|と|and|〜|~|-)?\s*)+$/i.test(stripped);
}
