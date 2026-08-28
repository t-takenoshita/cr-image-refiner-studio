import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFeedback,
  parseRequestIdHint,
  parseVariantIndex,
  parseVariantIndexes
} from "../src/feedback_parser.mjs";

test("parses circled image number and feedback directives", () => {
  const parsed = parseFeedback("修正 request: dd6e98770a\n画像①、無料訴求が強すぎるので自然見え寄せ。BA感も少し弱める");

  assert.equal(parsed.request_id_hint, "dd6e98770a");
  assert.equal(parsed.variant_index, 1);
  assert.equal(parsed.directives.weaken_offer, true);
  assert.equal(parsed.directives.reduce_ba, true);
  assert.equal(parsed.needs_manual_routing, false);
});

test("parses plain variant expressions", () => {
  assert.equal(parseVariantIndex("画像4をもっとCTA強めで"), 4);
  assert.equal(parseVariantIndex("画像12をもっとCTA強めで"), 12);
  assert.equal(parseVariantIndex("3案目の文字が小さい"), 3);
  assert.equal(parseVariantIndex("variant_2 copy修正"), 2);
  assert.equal(parseVariantIndex("variant_12 copy修正"), 12);
  assert.deepEqual(parseVariantIndexes("画像1.2.3.4\n期間限定訴求NG"), [1, 2, 3, 4]);
  assert.deepEqual(parseVariantIndexes("画像10-12\n色味変更"), [10, 11, 12]);
});

test("detects information density feedback", () => {
  const parsed = parseFeedback("画像2 FB: 情報量が多すぎるので、半分くらいにしたい");
  assert.equal(parsed.directives.reduce_information_density, true);
});

test("parses full and short request hints", () => {
  assert.equal(parseRequestIdHint("aicr_20260612_dd6e98770a 画像1"), "aicr_20260612_dd6e98770a");
  assert.equal(parseRequestIdHint("修正: dd6e98770a 画像1"), "dd6e98770a");
});

test("detects limited-time offer removal feedback", () => {
  const parsed = parseFeedback("request_id: aicr_20260616_ba6053b9c8\n画像1.2.3.4\n期間限定訴求NG");
  assert.equal(parsed.feedback_text, "期間限定訴求NG");
  assert.equal(parsed.directives.remove_limited_time_offer, true);
});

test("detects requested offer copy replacement", () => {
  const parsed = parseFeedback("画像4：オファーを\n『切らない鼻整形クーポン適用で0円〜』\nっていう文言にして欲しい");
  assert.equal(parsed.variant_index, 4);
  assert.equal(parsed.directives.change_copy, true);
});

test("detects step-flow removal feedback", () => {
  const parsed = parseFeedback("request_id: aicr_20260616_3790efeb36\n画像3\n3STEPを無くして再生成して");
  assert.equal(parsed.request_id_hint, "aicr_20260616_3790efeb36");
  assert.equal(parsed.variant_index, 3);
  assert.equal(parsed.feedback_text, "3STEPを無くして再生成して");
  assert.equal(parsed.directives.remove_step_flow, true);
});
