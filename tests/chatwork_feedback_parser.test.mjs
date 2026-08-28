import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanChatworkBody,
  parseChatworkFeedbackMessages
} from "../src/chatwork_feedback_parser.mjs";

test("parses resolved Chatwork feedback and detects image filename conflicts", () => {
  const parsed = parseChatworkFeedbackMessages(
    [
      {
        message_id: "1",
        account: { account_id: 10, name: "reviewer" },
        send_time: 1781506080,
        body: "修正 request: aicr_20260615_11f89d18af\n画像: 2\nFB: 情報量が多すぎるので、半分くらいにしたい"
      },
      {
        message_id: "2",
        account: { account_id: 11, name: "reviewer2" },
        send_time: 1781506285,
        body: "修正 request: variant_2_pain_empathy.png\n画像: 1\nFB: 下部のアクション誘導文を「LINE追加して案内を確認」に変更"
      }
    ],
    { requestId: "aicr_20260615_11f89d18af" }
  );

  assert.equal(parsed.feedback_count, 2);
  assert.equal(parsed.feedback_items[0].resolved_variant_index, 2);
  assert.deepEqual(parsed.feedback_items[0].resolved_variant_indexes, [2]);
  assert.equal(parsed.feedback_items[0].routing_status, "resolved");
  assert.equal(parsed.feedback_items[0].directives.reduce_information_density, true);
  assert.equal(parsed.feedback_items[0].can_build_revision_prompt, true);
  assert.equal(parsed.feedback_items[1].resolved_variant_index, null);
  assert.deepEqual(parsed.feedback_items[1].resolved_variant_indexes, []);
  assert.deepEqual(parsed.feedback_items[1].candidate_variant_indexes, [1, 2]);
  assert.equal(parsed.feedback_items[1].routing_status, "conflict_needs_human_confirmation");
  assert.equal(parsed.feedback_items[1].can_build_revision_prompt, false);
});

test("cleans Chatwork reply and info markup before parsing", () => {
  const body = "[rp aid=1 to=2]name\n[info][title]x[/title]noise[/info]\n画像: 3\nFB: コピー変更";
  assert.equal(cleanChatworkBody(body), "画像: 3\nFB: コピー変更");
});

test("ignores initial delivery posts and parses shorthand multi-image feedback", () => {
  const parsed = parseChatworkFeedbackMessages(
    [
      {
        message_id: "10",
        account: { account_id: 10, name: "factory" },
        send_time: 1781506000,
        body: `[toall]
AICR Factory 初稿生成完了 / FINクリニック
request_id: aicr_20260616_ba6053b9c8
画像対応:
画像1: aicr_20260616_ba6053b9c8_v1_offer_value
画像2: aicr_20260616_ba6053b9c8_v2_pain_empathy
画像3: aicr_20260616_ba6053b9c8_v3_trust_comparison
画像4: aicr_20260616_ba6053b9c8_v4_easy_next_step
FBは「画像1: 〜」の形で返してください。`
      },
      {
        message_id: "10.5",
        account: { account_id: 10, name: "factory" },
        send_time: 1781506100,
        body: "添付: variant_1_offer_value_api_1080x1080.png"
      },
      {
        message_id: "11",
        account: { account_id: 11, name: "reviewer" },
        send_time: 1781506200,
        body: "request_id: aicr_20260616_ba6053b9c8\n画像1.2.3.4\n期間限定訴求NG"
      },
      {
        message_id: "12",
        account: { account_id: 12, name: "reviewer2" },
        send_time: 1781506300,
        body: "request_id: aicr_20260616_ba6053b9c8\n画像10-12\n色味を少し落ち着かせたい"
      }
    ],
    { requestId: "aicr_20260616_ba6053b9c8" }
  );

  assert.equal(parsed.feedback_count, 2);
  assert.equal(parsed.skipped_count, 2);
  assert.equal(parsed.feedback_items[0].feedback_text, "期間限定訴求NG");
  assert.deepEqual(parsed.feedback_items[0].image_line_variant_indexes, [1, 2, 3, 4]);
  assert.deepEqual(parsed.feedback_items[0].resolved_variant_indexes, [1, 2, 3, 4]);
  assert.equal(parsed.feedback_items[0].resolved_variant_index, null);
  assert.equal(parsed.feedback_items[0].routing_status, "resolved_multi_variant");
  assert.equal(parsed.feedback_items[0].directives.remove_limited_time_offer, true);
  assert.equal(parsed.feedback_items[0].can_build_revision_prompt, false);
  assert.deepEqual(parsed.feedback_items[1].image_line_variant_indexes, [10, 11, 12]);
  assert.deepEqual(parsed.feedback_items[1].resolved_variant_indexes, [10, 11, 12]);
  assert.equal(parsed.feedback_items[1].routing_status, "resolved_multi_variant");
  assert.equal(parsed.feedback_items[1].directives.change_color, true);
});
