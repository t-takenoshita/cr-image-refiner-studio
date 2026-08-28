import { normalizeRequestRow } from "./request_schema.mjs";
import { buildPromptPack } from "./prompt_builder.mjs";

export function requestRowFromWeb(body = {}) {
  return {
    タイムスタンプ: body.submittedAt || new Date().toISOString(),
    依頼者名: body.requester || "Webユーザー",
    案件名: body.projectName || body.articleTitle || "Web画像制作",
    商材: body.product || body.articleTitle || "記事内商材",
    媒体: body.media || "記事LP",
    ターゲット: body.targetAudience || "記事を閲覧する見込みユーザー",
    インサイト: body.problem || body.audienceInsight || "",
    訴求軸: body.appeal || body.direction || "依頼内容に沿った訴求",
    オファー: body.offer || "",
    必須コピー: body.requiredCopy || "",
    希望テイスト: body.tone || body.direction || "清潔感、信頼感、スマホで見やすい",
    入れたいビジュアル要素: body.visualElements || "",
    "LP URL": body.landingPageUrl || "",
    "NG表現": body.ngExpressions || "",
    備考: body.notes || "CR Image Refinerからの依頼"
  };
}

export async function buildWebPlan(body = {}, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const request = normalizeRequestRow(requestRowFromWeb(body), { sourceKind: options.sourceKind || "web", now });
  const promptPack = await buildPromptPack(request, { now });
  return {
    requestId: request.request_id,
    warnings: request.validation.warnings,
    summary: promptPack.request_summary,
    variants: promptPack.variants.map((variant) => ({
      id: variant.variant_id,
      index: variant.variant_index,
      prompt: variant.prompt,
      tags: variant.generation_tags,
      textContract: variant.text_contract
    }))
  };
}
