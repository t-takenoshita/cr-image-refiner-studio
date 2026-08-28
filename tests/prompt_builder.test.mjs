import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRequestRow } from "../src/request_schema.mjs";
import { buildPromptPack } from "../src/prompt_builder.mjs";

const fixture = JSON.parse(
  await fs.readFile(new URL("./fixtures/google_form_row.json", import.meta.url), "utf8")
);
const guardrails = JSON.parse(
  await fs.readFile(new URL("../config/guardrails.example.json", import.meta.url), "utf8")
);

test("builds four Image2 prompt variants with shuffled color palettes", async () => {
  const request = normalizeRequestRow(fixture, {
    rowNumber: 2,
    now: "2026-06-15T12:00:00+09:00"
  });
  const promptPack = await buildPromptPack(request, {
    guardrails,
    templatePath: path.resolve("config/prompt_templates/banner_variants.json"),
    now: "2026-06-15T12:00:00+09:00"
  });

  assert.equal(promptPack.variants.length, 4);
  assert.equal(promptPack.prompt_contract.prompt_mode, "verbatim_by_default");
  assert.equal(promptPack.prompt_contract.ai_rewrite_performed, false);
  assert.equal(promptPack.prompt_contract.ai_safety_omission_performed, false);
  assert.equal(
    promptPack.creative_prompt_principles.source,
    "user_provided_image_cr_prompt_learning_2026-06-16"
  );
  assert.ok(promptPack.creative_prompt_principles.design_requirements.includes("適度な余白を取り、情報を詰め込みすぎない"));
  assert.ok(promptPack.creative_prompt_principles.avoid.includes("過度なあしらい"));
  const variantIds = new Set(promptPack.variants.map((variant) => variant.variant_id));
  assert.equal(variantIds.size, 4);
  assert.equal(new Set(promptPack.variants.map((variant) => variant.generation_tags.appeal_variant)).size, 4);
  assert.equal(new Set(promptPack.variants.map((variant) => variant.generation_tags.color_palette_id)).size, 4);
  assert.equal(new Set(promptPack.variants.map((variant) => variant.generation_tags.color_palette_name)).size, 4);
  assert.equal(new Set(promptPack.variants.map((variant) => variant.generation_tags.design_tone_hint)).size, 1);
  assert.equal(promptPack.variants[0].generation_tags.design_tone_hint, "清潔感、信頼感、スマホで見やすい、過度に医療っぽくしない");
  const selectedPaletteIds = promptPack.variants.map((variant) => variant.generation_tags.color_palette_id);
  assert.equal(selectedPaletteIds.includes("red_yellow_black_white"), false);
  assert.equal(selectedPaletteIds.includes("lemon_cyan_white"), false);
  assert.equal(selectedPaletteIds.includes("aqua_lime_navy"), false);

  for (const variant of promptPack.variants) {
    assert.ok(variant.prompt.includes("Image2"));
    assert.equal(variant.prompt_source_policy.ai_rewrite_performed, false);
    assert.equal(variant.prompt_source_policy.ai_safety_omission_performed, false);
    assert.ok(variant.prompt.includes("必ず生える"));
    assert.ok(variant.prompt.includes("効果保証"));
    assert.ok(variant.prompt.includes("Before/After"));
    assert.ok(variant.prompt.includes("あなたはプロの広告デザイナーです。"));
    assert.ok(variant.prompt.includes("LPファーストビュー設計"));
    assert.ok(variant.prompt.includes("適度な余白"));
    assert.ok(variant.prompt.includes("視線導線"));
    assert.ok(variant.prompt.includes("文字のジャンプ率"));
    assert.ok(variant.prompt.includes("画像内に含める主コピー: 「ひとりで悩む前に、まずはオンライン相談」"));
    assert.ok(variant.prompt.includes("画像内に含めるオファーコピー:"));
    assert.ok(variant.prompt.includes("文字厳密指定"));
    assert.ok(variant.prompt.includes("この文言以外の文字"));
    assert.ok(variant.prompt.includes("太い日本語ゴシック体"));
    assert.ok(variant.prompt.includes("85mmレンズ"));
    assert.equal(variant.text_contract.expected_text, "ひとりで悩む前に、まずはオンライン相談");
    assert.equal(variant.text_contract.offer_text, "初回相談をわかりやすく見せる。価格訴求は強くしすぎず、まず相談の導線を押す。");
    assert.ok(variant.text_contract.strict_text_instruction.includes("「ひとりで悩む前に、まずはオンライン相談」"));
    assert.ok(variant.prompt.includes("今後何をするかの手順説明は入れない"));
    assert.ok(variant.prompt.includes("簡単3STEPや3ステップなどの手順説明"));
    assert.ok(variant.prompt.includes("NGデザイン: 過度なあしらい / 過度な文章"));
    assert.ok(!variant.prompt.includes("次回行動"));
    assert.ok(!variant.prompt.includes("three_step_flow_and_cta"));
    assert.ok(!variant.prompt.includes("簡単3STEPで"));
    assert.ok(!variant.prompt.includes("医療/美容広告の審査を意識し"));
    assert.ok(!variant.prompt.includes("治療効果の断定、成果保証、最上級表現"));
    assert.ok(variant.prompt.includes("希望テイスト/デザインヒント: 清潔感、信頼感、スマホで見やすい、過度に医療っぽくしない"));
    assert.ok(variant.prompt.includes("配色パターン"));
    assert.ok(variant.prompt.includes("4案で同じ固定配色を繰り返さない"));
    assert.ok(variant.prompt.includes("蛍光色、虹色、多色使い、原色同士の衝突"));
    assert.ok(variant.prompt.includes("白、黒、薄グレー以外の追加色を勝手に足さない"));
    assert.ok(variant.prompt.includes("レイアウト処理"));
    assert.ok(variant.prompt.includes("文字処理"));
    assert.ok(variant.generation_tags.appeal_axis);
    assert.ok(variant.generation_tags.appeal_variant);
    assert.ok(variant.generation_tags.design_style);
    assert.equal(variant.generation_tags.color_policy, "palette_pool_deterministic_shuffle");
    assert.ok(variant.generation_tags.color_palette_id);
    assert.ok(variant.generation_tags.color_palette_colors);
    assert.ok(variant.generation_tags.color_palette_mood);
    assert.ok(variant.generation_tags.composition);
    assert.ok(variant.generation_tags.color);
    assert.ok(variant.generation_tags.copy_type);
    assert.ok(variant.generation_tags.offer);
    assert.ok(["pass", "warn", "hold"].includes(variant.policy_gate_result.status));
  }
});
