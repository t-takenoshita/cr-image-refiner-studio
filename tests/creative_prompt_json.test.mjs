import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCreativePromptJson,
  buildCreativePromptJsonPayload,
  buildCreativePromptJsonInstruction,
  generateCreativePromptJson,
  parseCreativePromptJson
} from "../src/creative_prompt_json.mjs";

function fixtureJson() {
  return {
    schema_version: "aicr-creative-prompt-json-v1",
    strategy_summary: "感情から納得へつなぐ",
    variants: Array.from({ length: 4 }, (_, index) => ({
      variant_index: index + 1,
      concept_name: `案${index + 1}`,
      emotional_trigger: "期待",
      stop_scroll: { hook: "悩み", visual_device: "強い対比" },
      read: { information_hierarchy: "見出しから根拠", message: "価値" },
      convince: { reason_to_believe: "依頼内の根拠", transition_motivation: "詳細確認" },
      image_prompt: `完成プロンプト${index + 1}`
    }))
  };
}

test("creative instruction requires the three conversion barriers and JSON", () => {
  const instruction = buildCreativePromptJsonInstruction({
    target_audience: "30代女性",
    required_copy: "訴求の原文",
    offer: "オファーの原文",
    appeal: "清潔感のある理想変化",
    visual_elements: "自然光の室内で横顔の人物",
    notes: "青を基調にする",
    assigned_palettes: [{ variant_index: 1, palette_name: "青×白", colors: "青 / 白", mood: "清潔感" }]
  });
  assert.match(instruction, /手を止める/);
  assert.match(instruction, /内容を読む/);
  assert.match(instruction, /納得して記事へ遷移/);
  assert.match(instruction, /JSONのみ/);
  assert.match(instruction, /可能な限り維持/);
  assert.match(instruction, /勝手に変更しない/);
  assert.match(instruction, /固定主コピー: "訴求の原文"/);
  assert.match(instruction, /固定オファーコピー: "オファーの原文"/);
  assert.match(instruction, /一字一句変更せず/);
  assert.match(instruction, /デザインは各案に合わせて調整できます/);
  assert.match(instruction, /4案すべてで依頼JSONのappeal/);
  assert.match(instruction, /案番号ごとにベネフィット、悩み共感、BA・施術、オファーへ固定しない/);
  assert.match(instruction, /visual_elementsに具体的な/);
  assert.match(instruction, /assigned_palettesを案番号ごとに必ず引き継ぎ/);
  assert.match(instruction, /補足メモの色指定を無視/);
  assert.match(instruction, /toneはデザインの雰囲気として扱い、色指定の根拠にはしない/);
  assert.match(instruction, /ピンク系・ローズ系・マゼンタ系へ変更しない/);
});

test("uses strict JSON schema output for the planning response", () => {
  const payload = buildCreativePromptJsonPayload({ request_id: "req", request_summary: {}, variants: [] });
  assert.equal(payload.text.format.type, "json_schema");
  assert.equal(payload.text.format.strict, true);
  assert.equal(payload.text.format.schema.properties.variants.minItems, 4);
  assert.equal(payload.text.format.schema.properties.variants.maxItems, 4);
});

test("validates four creative variants and applies image prompts", () => {
  const creative = parseCreativePromptJson(JSON.stringify(fixtureJson()));
  const promptPack = {
    request_summary: {
      required_copy: "訴求の原文",
      offer: "オファーの原文",
      appeal: "理想変化",
      visual_elements: "商品を手に持つ人物",
      tone: "クール",
      notes: "青を基調にする"
    },
    variants: Array.from({ length: 4 }, (_, index) => ({
      variant_index: index + 1,
      prompt: "old",
      generation_tags: {
        color_palette_name: `配色${index + 1}`,
        color_palette_colors: `色${index + 1} / 白`
      }
    }))
  };
  const applied = applyCreativePromptJson(promptPack, creative);
  assert.match(applied.variants[0].prompt, /^完成プロンプト1/);
  assert.match(applied.variants[0].prompt, /主コピー: "訴求の原文"/);
  assert.match(applied.variants[0].prompt, /オファーコピー: "オファーの原文"/);
  assert.match(applied.variants[0].prompt, /デザイン調整のみ許可/);
  assert.match(applied.variants[0].prompt, /フォームの訴求軸: "理想変化"/);
  assert.match(applied.variants[0].prompt, /フォームの入れたいビジュアル要素: "商品を手に持つ人物"/);
  assert.match(applied.variants[0].prompt, /画像1=ベネフィット、画像2=悩み共感、画像3=BA・施術、画像4=オファーという固定割り当てを行わない/);
  assert.match(applied.variants[0].prompt, /フォームの補足メモ: "青を基調にする"/);
  assert.match(applied.variants[0].prompt, /希望テイスト（雰囲気のみ・色固定には使わない）/);
  assert.match(applied.variants[0].prompt, /この案の指定パレット: "配色1" \/ "色1 \/ 白"/);
  assert.match(applied.variants[0].prompt, /補足メモに明示的な色指定がある場合だけ/);
  assert.match(applied.variants[0].prompt, /ピンク・ローズ・マゼンタを主色にしない/);
  assert.equal(applied.variants[3].creative_strategy.stop_scroll.hook, "悩み");
});

test("requests and parses creative JSON through injectable fetch", async () => {
  const result = await generateCreativePromptJson({
    apiKey: "sk-test",
    promptPack: { request_id: "req", request_summary: { target_audience: "30代女性" }, variants: [] },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "resp_1", output_text: JSON.stringify(fixtureJson()) }) })
  });
  assert.equal(result.variants.length, 4);
  assert.equal(result.response_id, "resp_1");
});
