import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRevisionFromFeedback } from "../src/revision_builder.mjs";

const promptPack = {
  schema_version: "aicr-prompt-pack-v1",
  request_id: "aicr_20260612_dd6e98770a",
  request_summary: {
    project_name: "TCB鼻",
    creative_title: "BAのCR",
    target_audience: "20代前半",
    appeal: "理想変化",
    offer: "クーポン適用で最大無料",
    required_copy: "忘れ鼻アプデ術"
  },
  variants: [
    {
      variant_id: "aicr_20260612_dd6e98770a_v1_offer_value",
      variant_index: 1,
      prompt: "Image2で日本語の正方形広告バナーを1枚生成してください。\n案件: TCB鼻\n画像内に含める主コピー: 忘れ鼻アプデ術",
      generation_tags: {
        appeal_axis: "offer_value",
        composition: "large_offer",
        color: "blue_white",
        copy_type: "direct_offer_headline",
        offer: "クーポン適用で最大無料"
      },
      policy_gate_result: { status: "warn" }
    }
  ]
};

test("builds revision prompt artifacts for one variant", async () => {
  const requestDir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-revision-"));
  await fs.writeFile(path.join(requestDir, "prompt_pack.json"), `${JSON.stringify(promptPack, null, 2)}\n`);
  await fs.writeFile(
    path.join(requestDir, "manifest.json"),
    `${JSON.stringify({ request_id: promptPack.request_id, status: "posted" }, null, 2)}\n`
  );

  const result = await buildRevisionFromFeedback({
    requestDir,
    feedback: "画像①、無料訴求が強すぎるので自然見え寄せ。BA感も少し弱める",
    dryRun: true
  });

  assert.equal(result.revision.revision_number, 1);
  assert.equal(result.revision.source.variant_index, 1);
  assert.equal(result.revision.prompt_contract.source_prompt_preserved, true);
  assert.equal(result.revision.prompt_contract.ai_safety_omission_performed, false);
  assert.ok(result.revision.revised_prompt.includes("FBに従って、オファー/無料訴求の見せ方を調整する"));
  assert.ok(result.revision.revised_prompt.includes("FBに従って、BA/比較感の強さを調整する"));
  assert.ok(result.revision.revised_prompt.includes("画像内に含める主コピー: 忘れ鼻アプデ術"));
  assert.ok(result.revision.revised_prompt.includes("簡単3STEP、3ステップ、予約→相談→来院→施術"));
  assert.ok(result.revision.revised_prompt.includes("元prompt参考に手順系構成、次回行動、CTA、3STEP系の古い共通指示が含まれていても"));
  assert.ok(!result.revision.revised_prompt.includes("治療効果の断定、強い結果約束"));
  assert.equal(result.revision.next_actions.can_generate, true);

  const written = JSON.parse(await fs.readFile(result.paths.revisionPromptPath, "utf8"));
  assert.equal(written.revision_id, "aicr_20260612_dd6e98770a_r1_v1");
});

test("does not block revisions on legacy policy labels", async () => {
  const requestDir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-revision-hold-"));
  const holdPack = {
    ...promptPack,
    variants: [
      {
        ...promptPack.variants[0],
        policy_gate_result: { status: "hold" },
        prompt: `${promptPack.variants[0].prompt}\n確実にCVしそう`
      }
    ]
  };
  await fs.writeFile(path.join(requestDir, "prompt_pack.json"), `${JSON.stringify(holdPack, null, 2)}\n`);
  await fs.writeFile(
    path.join(requestDir, "manifest.json"),
    `${JSON.stringify({ request_id: holdPack.request_id, status: "posted" }, null, 2)}\n`
  );

  const blocked = await buildRevisionFromFeedback({
    requestDir,
    feedback: "画像1：文言を差し替えたい",
    dryRun: true
  });
  assert.equal(blocked.revision.policy_gate_result.status, "pass");
  assert.equal(blocked.revision.next_actions.can_generate, true);

  const confirmed = await buildRevisionFromFeedback({
    requestDir,
    feedback: "画像1：文言を差し替えたい",
    dryRun: true,
    confirmHumanReviewed: true
  });
  assert.equal(confirmed.revision.policy_gate_result.status, "pass");
  assert.equal(confirmed.revision.next_actions.can_generate, true);
});
