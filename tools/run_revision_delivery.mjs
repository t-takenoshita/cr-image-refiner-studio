#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  loadGuardrails,
  parseArgs,
  printJson,
  readJsonFile,
  resolveDataRoot,
  resolveProjectRoot
} from "../src/cli.mjs";
import { sendChatworkDelivery } from "../src/chatwork_delivery.mjs";
import { loadEnvFile } from "../src/env_file.mjs";
import { generateImage2File } from "../src/image2_api.mjs";
import { resizeImageToFinal } from "../src/image_postprocess.mjs";
import { writeJson } from "../src/manifest.mjs";
import { buildRevisionFromFeedback } from "../src/revision_builder.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const { guardrails, guardrailsPath } = await loadGuardrails(projectRoot, args);

try {
  loadEnvFile(args.envFile || process.env.AICR_FACTORY_ENV_FILE || "");
  loadEnvFile(args.chatworkEnvFile || process.env.CHATWORK_ENV_FILE || "");
  loadEnvFile(args.openaiEnvFile || process.env.OPENAI_ENV_FILE || "");

  const requestId = String(args.requestId || "").trim();
  if (!requestId) throw new Error("Provide --request-id.");
  const requestDir = path.join(dataRoot, "outputs", "requests", requestId);
  const execute = Boolean(args.execute);
  const sendChatwork = Boolean(args.sendChatwork);
  const feedback = await resolveFeedback({ requestDir, args });
  const variantIndexes = resolveVariantIndexes(feedback, args);
  const revisions = [];

  for (const variantIndex of variantIndexes) {
    const result = await buildRevisionFromFeedback({
      requestDir,
      feedback: feedback.feedback_text
        ? `request_id: ${requestId}\n画像${variantIndex}\n${feedback.feedback_text}`
        : feedback.raw_feedback || feedback.feedback || String(args.feedback || ""),
      variantIndex,
      guardrails,
      dryRun: !execute,
      generate: execute,
      confirmHumanReviewed: Boolean(args.confirmHumanReviewed),
      extraPrompt: args.extraPrompt || ""
    });
    revisions.push(result);
  }

  const plan = buildPlan({ requestId, execute, sendChatwork, feedback, variantIndexes, guardrails, guardrailsPath });
  const planPath = path.join(requestDir, "revisions", "revision_delivery_plan_latest.json");
  await writeJson(planPath, plan);

  if (!execute) {
    const output = {
      ok: true,
      mode: "dry-run",
      request_id: requestId,
      feedback_text: feedback.feedback_text || feedback.raw_feedback || "",
      variant_indexes: variantIndexes,
      revision_prompt_paths: revisions.map((result) => result.paths.revisionPromptPath),
      plan_path: planPath,
      note: "dry-run only; no image generation, Chatwork send, Drive upload, or Sheet write."
    };
    printJson(output);
    process.exit(0);
  }

  assertRevisionExecutionAllowed({ guardrails, sendChatwork });
  const generated = [];
  for (const result of revisions) {
    generated.push(await generateRevisionImage({ result, guardrails }));
  }

  const batchResult = {
    schema_version: "aicr-revision-delivery-result-v1",
    request_id: requestId,
    generated_at: new Date().toISOString(),
    feedback_text: feedback.feedback_text || feedback.raw_feedback || "",
    mode: "openai_images_api",
    image_count: generated.length,
    external_actions: {
      image2_generation_executed: true,
      chatwork_post_executed: false,
      drive_upload_executed: false,
      sheet_write_executed: false
    },
    revisions: generated
  };
  const batchResultPath = path.join(requestDir, "revisions", "revision_generation_result_latest.json");
  await writeJson(batchResultPath, batchResult);

  let delivery = null;
  if (sendChatwork) {
    const promptPack = await readJsonFile(path.join(requestDir, "prompt_pack.json"));
    const payload = buildRevisionDeliveryPayload({
      promptPack,
      feedback,
      generated,
      toAll: args.toAll !== false
    });
    const payloadPath = path.join(requestDir, "revisions", "revision_chatwork_payload_latest.json");
    await writeJson(payloadPath, payload);

    const result = await sendChatworkDelivery({
      roomId: args.roomId || guardrails.initial_draft?.chatwork_room_id || process.env.CHATWORK_ROOM_ID,
      message: payload.message,
      files: payload.files
    });
    delivery = {
      ok: result.ok,
      request_id: requestId,
      room_id: String(args.roomId || guardrails.initial_draft?.chatwork_room_id || process.env.CHATWORK_ROOM_ID || ""),
      to_all: args.toAll !== false,
      sent_at: new Date().toISOString(),
      message_id: result.message_id,
      file_ids: result.file_ids,
      payload_path: payloadPath,
      source_result_redacted: result
    };
    delivery.source_result_redacted = {
      ok: result.ok,
      postedMessage: result.postedMessage,
      postedFiles: (result.postedFiles || []).map((file) => ({ file_id: file.file_id }))
    };
    batchResult.external_actions.chatwork_post_executed = true;
    batchResult.chatwork_delivery = delivery;
    await writeJson(batchResultPath, batchResult);
    await writeJson(path.join(requestDir, "revisions", "revision_chatwork_delivery_latest.json"), delivery);
  }

  const manifest = await readJsonFile(path.join(requestDir, "manifest.json")).catch(() => null);
  if (manifest) {
    manifest.status = delivery ? "posted" : "generated";
    manifest.run_status = delivery ? "revision_posted" : "revision_images_generated";
    manifest.last_revision_delivery_result = batchResultPath;
    if (delivery?.message_id) manifest.last_revision_chatwork_message_id = delivery.message_id;
    await writeJson(path.join(requestDir, "manifest.json"), manifest);
  }

  printJson({
    ok: true,
    request_id: requestId,
    status: delivery ? "posted" : "generated",
    feedback_text: batchResult.feedback_text,
    image_paths: generated.map((item) => item.final_local_path || item.local_path),
    generation_result_path: batchResultPath,
    chatwork_message_id: delivery?.message_id || null,
    chatwork_file_ids: delivery?.file_ids || []
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: redactSecrets(error?.message || error) }, null, 2));
  process.exitCode = 1;
}

async function resolveFeedback({ requestDir, args }) {
  if (args.feedback) {
    return {
      feedback_text: String(args.feedback),
      resolved_variant_indexes: parseVariantList(args.variants || args.variant || "1,2,3,4")
    };
  }

  const feedbackPath = path.resolve(
    args.feedbackFile || path.join(requestDir, "feedback", "parsed_feedback_latest.json")
  );
  const parsed = await readJsonFile(feedbackPath);
  const items = parsed.feedback_items || [];
  if (!items.length) throw new Error(`No feedback items found in ${feedbackPath}.`);
  const item = items[items.length - 1];
  return {
    ...item,
    feedback_path: feedbackPath
  };
}

function resolveVariantIndexes(feedback, args) {
  if (args.variants || args.variant) return parseVariantList(args.variants || args.variant);
  const indexes = feedback.resolved_variant_indexes?.length
    ? feedback.resolved_variant_indexes
    : feedback.resolved_variant_index
      ? [feedback.resolved_variant_index]
      : [];
  const normalized = [...new Set(indexes.map(Number).filter((value) => value >= 1 && value <= 99))].sort((a, b) => a - b);
  if (!normalized.length) throw new Error("No resolved variants. Pass --variants 1,2,3,4 or explicit variant numbers after human routing.");
  return normalized;
}

function parseVariantList(value) {
  return [...new Set(String(value).match(/\d{1,2}/g)?.map(Number) || [])].sort((a, b) => a - b);
}

function buildPlan({ requestId, execute, sendChatwork, feedback, variantIndexes, guardrails, guardrailsPath }) {
  return {
    schema_version: "aicr-revision-delivery-plan-v1",
    request_id: requestId,
    created_at: new Date().toISOString(),
    guardrails_path: guardrailsPath,
    feedback_text: feedback.feedback_text || feedback.raw_feedback || "",
    variant_indexes: variantIndexes,
    requested: {
      execute,
      send_chatwork: sendChatwork
    },
    external_actions: {
      image_generation: {
        will_execute: execute && guardrails.image2_generation_enabled === true,
        required: ["--execute", "guardrails.image2_generation_enabled=true", "OPENAI_API_KEY", "policy_hold時は--confirm-human-reviewed"]
      },
      chatwork_post: {
        will_execute: execute && sendChatwork && guardrails.chatwork_send_enabled === true,
        required: ["--send-chatwork", "guardrails.chatwork_send_enabled=true", "CHATWORK_API_TOKEN"]
      },
      drive_upload: { will_execute: false },
      sheet_write: { will_execute: false }
    },
    automation_boundaries: {
      revision_auto_generation_enabled: guardrails.revision_auto_generation_enabled === true,
      chatwork_feedback_auto_regenerate_enabled: guardrails.chatwork_feedback_auto_regenerate_enabled === true,
      human_review_confirmed: Boolean(args.confirmHumanReviewed),
      note: "This runner is manual-only. It does not poll Chatwork or auto-regenerate from feedback."
    }
  };
}

async function generateRevisionImage({ result, guardrails }) {
  const revision = result.revision;
  if (!revision.next_actions?.can_generate) {
    throw new Error(`${revision.revision_id} cannot generate: ${revision.next_actions?.reason || "unknown"}`);
  }
  const imageDir = path.join(result.paths.revisionDir, "images");
  const rawPath = path.join(imageDir, `${revision.revision_id}_api.png`);
  const generated = await generateImage2File({
    prompt: revision.revised_prompt,
    outputPath: rawPath,
    config: guardrails.image2_api || {}
  });
  const resizeResult = await resizeImageToFinal(rawPath, guardrails.image2_api?.final_size);
  const finalPath = resizeResult.output_path || rawPath;
  const output = {
    revision_id: revision.revision_id,
    revision_number: revision.revision_number,
    variant_index: revision.source.variant_index,
    source_variant_id: revision.source.variant_id,
    feedback_text: revision.feedback.feedback_text || revision.feedback.raw_feedback,
    policy_gate_result: revision.policy_gate_result,
    local_path: rawPath,
    final_local_path: finalPath || rawPath,
    api_result: {
      model: generated.model,
      size: generated.size,
      output_format: generated.output_format,
      bytes_written: generated.bytes_written,
      usage: generated.usage
    },
    postprocess: {
      resize: resizeResult
    },
    revision_prompt_path: result.paths.revisionPromptPath
  };
  await writeJson(path.join(result.paths.revisionDir, "revision_generation_result.json"), output);
  return output;
}

function buildRevisionDeliveryPayload({ promptPack, feedback, generated, toAll }) {
  const summary = promptPack.request_summary || {};
  const policyStatuses = [...new Set(generated.map((item) => item.policy_gate_result?.status || "unknown"))];
  const feedbackText = feedback.feedback_text || feedback.raw_feedback || "";
  const lines = [
    toAll ? "[toall]" : "",
    `AICR Factory 修正版生成完了 / ${summary.project_name || promptPack.request_id || ""}`,
    `request_id: ${promptPack.request_id || ""}`,
    `FB: 画像${generated.map((item) => item.variant_index).join(".")} / ${feedbackText}`,
    "修正内容: 期間限定・今だけ・締切などの期限訴求を外した修正版です。",
    `policy_gate: ${policyStatuses.join(", ")}`,
    "",
    "画像対応:",
    ...generated.map((item) => `画像${item.variant_index}修正: ${item.revision_id}`),
    "",
    "Drive保存: なし",
    "Sheets書き戻し: なし"
  ];
  return {
    schema_version: "aicr-revision-delivery-chatwork-payload-v1",
    request_id: promptPack.request_id || "",
    message: lines.filter((line, index) => line || index === 0).join("\n").trim(),
    files: generated.map((item) => item.final_local_path || item.local_path).filter(Boolean)
  };
}

function assertRevisionExecutionAllowed({ guardrails, sendChatwork }) {
  if (guardrails.image2_generation_enabled !== true) {
    throw new Error("--execute requires guardrails.image2_generation_enabled=true.");
  }
  if (sendChatwork && guardrails.chatwork_send_enabled !== true) {
    throw new Error("--send-chatwork requires guardrails.chatwork_send_enabled=true.");
  }
  if (guardrails.revision_auto_generation_enabled === true || guardrails.chatwork_feedback_auto_regenerate_enabled === true) {
    throw new Error("Revision auto generation must stay disabled for this phase.");
  }
}

function redactSecrets(message) {
  let result = String(message || "");
  for (const secret of [process.env.OPENAI_API_KEY, process.env.CHATWORK_API_TOKEN].filter(Boolean)) {
    result = result.replaceAll(secret, "[redacted]");
  }
  return result;
}
