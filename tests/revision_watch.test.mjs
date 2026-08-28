import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addBlockedFeedbackState,
  addProcessedFeedbackState,
  feedbackAlreadyHandled,
  normalizeFeedbackText,
  selectPendingFeedbackItems
} from "../src/revision_watch.mjs";

const parsed = {
  feedback_items: [
    {
      message_id: "101",
      routing_status: "resolved",
      can_build_revision_prompt: true,
      resolved_variant_index: 1,
      resolved_variant_indexes: [1],
      feedback_text: "コピーの「生まれつき」を「最近」に修正。"
    },
    {
      message_id: "102",
      routing_status: "resolved_multi_variant",
      can_build_revision_prompt: false,
      resolved_variant_index: null,
      resolved_variant_indexes: [1, 2],
      feedback_text: "1と2を修正"
    },
    {
      message_id: "103",
      routing_status: "foreign_request",
      can_build_revision_prompt: false,
      resolved_variant_index: 1,
      resolved_variant_indexes: [1],
      feedback_text: "別request"
    }
  ]
};

test("selects only unresolved single-variant feedback", () => {
  assert.equal(normalizeFeedbackText(" コピー\n の 修正 "), "コピー の 修正");
  assert.deepEqual(selectPendingFeedbackItems(parsed).map((item) => item.message_id), ["101"]);
});

test("skips feedback already present in revision history", () => {
  const history = {
    revisions: [
      {
        variant_index: 1,
        feedback_text: "コピーの「生まれつき」を「最近」に修正。"
      }
    ]
  };
  assert.equal(feedbackAlreadyHandled(parsed.feedback_items[0], {}, history), true);
  assert.deepEqual(selectPendingFeedbackItems(parsed, {}, history), []);
});

test("records processed and blocked feedback state by message id", () => {
  const processed = addProcessedFeedbackState({}, parsed.feedback_items[0], {
    request_id: "aicr_20260706_b722375e16",
    status: "posted",
    image_paths: ["/tmp/out.png"],
    chatwork_message_id: "999"
  });
  assert.equal(feedbackAlreadyHandled(parsed.feedback_items[0], processed, {}), true);
  assert.equal(processed.processed_feedback_items[0].chatwork_message_id, "999");

  const blocked = addBlockedFeedbackState({}, parsed.feedback_items[0], new Error("policy_hold"));
  assert.equal(feedbackAlreadyHandled(parsed.feedback_items[0], blocked, {}), true);
  assert.equal(blocked.blocked_feedback_items[0].error, "policy_hold");
});
