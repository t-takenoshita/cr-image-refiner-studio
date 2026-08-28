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
import { buildInitialDraftChatworkPayload, sendChatworkDelivery } from "../src/chatwork_delivery.mjs";
import { loadChatworkMentionDirectory, resolveChatworkMention } from "../src/chatwork_mention_directory.mjs";
import { applyCreativePromptJson, generateCreativePromptJson } from "../src/creative_prompt_json.mjs";
import { loadClientMasterContext, summarizeClientMasterContext } from "../src/client_master.mjs";
import { loadEnvFile } from "../src/env_file.mjs";
import { generateImage2File } from "../src/image2_api.mjs";
import { applyNoteBandToImage, overlayLogoOnImage, resizeImageToFinal } from "../src/image_postprocess.mjs";
import { loadLogoInputImage, summarizeLogoInputImage } from "../src/logo_asset.mjs";
import { writeJson } from "../src/manifest.mjs";
import { processRequestRow } from "../src/pipeline.mjs";
import { evaluateTextQualityGate, resolveTextQualityGateConfig } from "../src/text_quality_gate.mjs";
import { buildQueueEntries, summarizeQueueEntries } from "../src/queue_status.mjs";
import {
  loadGoogleSheetsConfig,
  loadRowsFromGoogleSheetSource,
  resolveGoogleCredentialPath
} from "../src/google_sheets_source.mjs";
import { loadRowsFromCsvPath, loadRowsFromPublicSheetSource } from "../src/sheet_source.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const { guardrails, guardrailsPath } = await loadGuardrails(projectRoot, args);
if (args.disablePolicyGate) guardrails.policy_gate_enabled = false;

try {
  loadEnvFile(args.envFile || process.env.AICR_FACTORY_ENV_FILE || "");
  loadEnvFile(args.chatworkEnvFile || process.env.CHATWORK_ENV_FILE || "");
  loadEnvFile(args.openaiEnvFile || process.env.OPENAI_ENV_FILE || "");

  const execute = Boolean(args.execute);
  const sendChatwork = Boolean(args.sendChatwork);
  const humanReviewed = Boolean(args.confirmHumanReviewed);
  const textQualityGate = resolveTextQualityGateConfig(guardrails, args);
  const limit = Number.parseInt(args.limit || guardrails.initial_draft?.max_requests_per_run || "1", 10);
  const clientMasterContext = await loadClientMasterContext({ projectRoot, args, guardrails });
  const loaded = await loadInitialDraftRows({ projectRoot, args });
  const mentionDirectory = await loadChatworkMentionDirectory({
    spreadsheetId: loaded.source_metadata?.spreadsheet_id,
    sheetName: guardrails.initial_draft?.mention_sheet_name || "API通知"
  }).catch((error) => ({
    ok: false,
    status: "fetch_failed",
    error: error.message,
    entries: []
  }));
  const entries = await buildQueueEntries(loaded.rows, {
    dataRoot,
    sourceKind: loaded.source_kind,
    sheetId: loaded.source_metadata?.spreadsheet_id || null,
    gid: loaded.source_metadata?.gid || null,
    fixturePath: loaded.fixture_path || null,
    now: args.now
  });
  const cursorPath = args.cursorFile ? path.resolve(projectRoot, args.cursorFile) : null;
  const cursorRowNumber = cursorPath ? await readCursorRowNumber(cursorPath) : null;
  const initialCursorRowNumber = parseOptionalInteger(args.initialCursorRow);
  const lastPostedRowNumber = args.afterLastPostedRow
    ? findLastPostedRowNumber(entries)
    : null;
  const effectiveAfterRowNumber =
    cursorRowNumber ?? initialCursorRowNumber ?? parseOptionalInteger(args.afterRow) ?? lastPostedRowNumber;
  const selectedEntries = selectInitialDraftEntries(entries, {
    onlyNew: args.onlyNew !== false,
    includePrompted: Boolean(args.includePrompted || execute),
    confirmHumanReviewed: humanReviewed,
    retryFailed: Boolean(args.retryFailed),
    targetRequestId: args.requestId,
    targetRowNumber: args.rowNumber,
    afterRowNumber: effectiveAfterRowNumber,
    statuses: args.status || "new",
    limit: Number.isFinite(limit) ? limit : 1
  });

  const results = [];
  for (const entry of selectedEntries) {
    const processed = await processRequestRow(entry.row, {
      dataRoot,
      guardrails,
      flags: {},
      dryRun: true,
      clientMasterContext,
      rowNumber: entry.row_number,
      sourceKind: loaded.source_kind,
      sheetId: loaded.source_metadata?.spreadsheet_id || null,
      gid: loaded.source_metadata?.gid || null,
      fixturePath: loaded.fixture_path || null,
      templatePath: path.join(projectRoot, "config", "prompt_templates", "banner_variants.json"),
      now: args.now
    });

    let promptPack = processed.promptPack;
    const requestDir = processed.paths.outputDir;
    let creativePromptJsonPath = null;
    if (execute && guardrails.creative_prompt_json?.enabled === true) {
      const creativePromptJson = await generateCreativePromptJson({
        promptPack,
        config: guardrails.creative_prompt_json
      });
      promptPack = applyCreativePromptJson(promptPack, creativePromptJson);
      creativePromptJsonPath = path.join(requestDir, "creative_prompt.json");
      await writeJson(creativePromptJsonPath, creativePromptJson);
      await writeJson(processed.paths.promptPackPath, promptPack);
    }
    const plan = buildPlan({
      promptPack,
      manifest: processed.manifest,
      execute,
      sendChatwork,
      guardrails,
      humanReviewed,
      textQualityGate
    });
    const planPath = path.join(requestDir, "initial_draft_plan.json");
    await writeJson(planPath, plan);

    if (!execute) {
      results.push({
        request_id: promptPack.request_id,
        mode: "dry-run",
        status: processed.manifest.status,
        policy_gate: processed.manifest.policy_gate_summary,
        client_master: processed.request.client_master || null,
        brand_assets: promptPack.brand_assets || null,
        plan_path: planPath,
        prompt_pack_path: processed.paths.promptPackPath,
        manifest_path: processed.paths.manifestPath
      });
      continue;
    }

    assertInitialDraftExecutionAllowed({ guardrails, sendChatwork });
    if (processed.manifest.policy_gate_summary?.status === "hold" && !humanReviewed) {
      const review = await markPolicyHoldReviewRequired({
        promptPack,
        manifestPath: processed.paths.manifestPath,
        requestDir,
        planPath
      });
      results.push({
        request_id: promptPack.request_id,
        mode: "execute-review-required",
        status: "review_required",
        policy_gate: processed.manifest.policy_gate_summary,
        blocker: review.review_required.reason,
        prompt_pack_path: processed.paths.promptPackPath,
        manifest_path: processed.paths.manifestPath,
        initial_draft_plan_path: planPath,
        review_required_path: review.path,
        generation_result_path: null,
        delivery_result_path: null,
        image_paths: [],
        chatwork_message_id: null
      });
      continue;
    }

    const generation = await generateInitialDraftImages({
      promptPack,
      requestDir,
      guardrails,
      textQualityGate
    });
    const manifest = await readJsonFile(processed.paths.manifestPath);
    manifest.status = "generated";
    manifest.run_status = "initial_draft_images_generated";
    manifest.generated_at = new Date().toISOString();
    manifest.artifacts.images = Object.fromEntries(
      generation.images.map((image) => [`image_${image.variant_index}`, image.final_local_path || image.local_path])
    );
    manifest.artifacts.generation_result_json = generation.result_path;
    if (generation.quality_gate_summary) {
      manifest.text_quality_gate_summary = generation.quality_gate_summary;
      manifest.steps = manifest.steps || {};
      manifest.steps.text_quality_gate = {
        status: generation.quality_gate_summary.status,
        checked_count: generation.quality_gate_summary.checked_count,
        ok_count: generation.quality_gate_summary.ok_count,
        ng_count: generation.quality_gate_summary.ng_count,
        error_count: generation.quality_gate_summary.error_count,
        retry_count: generation.quality_gate_summary.retry_count
      };
    }
    await writeJson(processed.paths.manifestPath, manifest);

    let delivery = null;
    if (sendChatwork) {
      const mention = resolveChatworkMention(mentionDirectory, promptPack.request_summary?.requester);
      const payload = buildInitialDraftChatworkPayload({
        promptPack,
        images: generation.images.map((image) => ({
          ...image,
          local_path: image.final_local_path || image.local_path
        })),
        mention,
        toAll: guardrails.initial_draft?.to_all !== false,
        policyStatus: manifest.policy_gate_summary?.status,
        humanReviewed
      });
      const dryRunPath = path.join(requestDir, "delivery", "initial_draft_chatwork_payload.json");
      await writeJson(dryRunPath, payload);
      const roomId = args.roomId || guardrails.initial_draft?.chatwork_room_id || process.env.CHATWORK_ROOM_ID;
      const result = await sendChatworkDelivery({
        roomId,
        token: process.env.CHATWORK_API_TOKEN,
        message: payload.message,
        files: payload.files
      });
      delivery = {
        schema_version: "aicr-initial-draft-delivery-result-v1",
        ok: true,
        request_id: promptPack.request_id,
        room_id: roomId,
        to_all: guardrails.initial_draft?.to_all !== false,
        mention_account_id: mention?.account_id || null,
        mention_name: mention?.name || null,
        mention_lookup_status: mention ? "matched" : mentionDirectory.status,
        sent_at: new Date().toISOString(),
        ...result,
        source_result_redacted: {
          ok: result.ok,
          postedMessage: result.postedMessage,
          postedFiles: result.postedFiles
        }
      };
      const deliveryPath = path.join(requestDir, "delivery_result.json");
      await writeJson(deliveryPath, delivery);
      manifest.status = "posted";
      manifest.run_status = "initial_draft_posted";
      manifest.chatwork_message_id = delivery.message_id;
      manifest.artifacts.delivery_result_json = deliveryPath;
      await writeJson(processed.paths.manifestPath, manifest);
    }

    results.push({
      request_id: promptPack.request_id,
      mode: "execute",
      status: delivery ? "posted" : "generated",
      prompt_pack_path: processed.paths.promptPackPath,
      manifest_path: processed.paths.manifestPath,
      client_master: promptPack.client_master || null,
      brand_assets: promptPack.brand_assets || null,
      generation_result_path: generation.result_path,
      creative_prompt_json_path: creativePromptJsonPath,
      delivery_result_path: delivery ? path.join(requestDir, "delivery_result.json") : null,
      image_paths: generation.images.map((image) => image.final_local_path || image.local_path),
      chatwork_message_id: delivery?.message_id || null,
      ...(generation.quality_gate_summary ? { quality_gate_summary: generation.quality_gate_summary } : {})
    });
  }

  if (cursorPath && execute) {
    const processedRows = selectedEntries.slice(0, results.length).map((entry) => entry.row_number);
    const lastProcessedRow = Math.max(effectiveAfterRowNumber || 0, ...processedRows);
    await writeJson(cursorPath, {
      schema_version: "aicr-initial-draft-cursor-v1",
      last_processed_row: lastProcessedRow,
      updated_at: new Date().toISOString()
    });
  }

  printJson({
    ok: true,
    execute,
    send_chatwork: sendChatwork,
    external_write_performed: execute,
    source: loaded.source_kind,
    data_root: dataRoot,
    guardrails_path: guardrailsPath,
    client_master: summarizeClientMasterContext(clientMasterContext),
    selection: {
      only_new: args.onlyNew !== false,
      include_prompted: Boolean(args.includePrompted || execute),
      target_request_id: normalizeOptionalString(args.requestId) || null,
      target_row_number: parseOptionalInteger(args.rowNumber),
      after_row_number: effectiveAfterRowNumber,
      after_last_posted_row: Boolean(args.afterLastPostedRow),
      cursor_file: cursorPath,
      scanned_count: entries.length,
      selected_count: selectedEntries.length,
      selected_rows: summarizeQueueEntries(selectedEntries)
    },
    processed_count: results.length,
    results
  });
} catch (error) {
  const redacted = redactSecrets(error?.message || String(error));
  console.error(JSON.stringify({ ok: false, error: redacted, code: error.code || null }, null, 2));
  process.exitCode = 1;
}

async function loadInitialDraftRows({ projectRoot, args }) {
  if (args.csv) {
    const loaded = await loadRowsFromCsvPath(path.resolve(args.csv));
    return {
      ...loaded,
      source_kind: "csv",
      fixture_path: path.resolve(args.csv),
      source_metadata: {}
    };
  }

  const { source } = await loadGoogleSheetsConfig(projectRoot, args);
  if (args.publicCsv || args.source === "public-csv") {
    const loaded = await loadRowsFromPublicSheetSource({ source, gid: args.gid, range: args.range });
    return {
      ...loaded,
      source_kind: "public_google_sheet"
    };
  }

  try {
    const credentialPath = resolveGoogleCredentialPath(projectRoot, source, args);
    const loaded = await loadRowsFromGoogleSheetSource({
      source,
      credentialPath,
      gid: args.gid,
      sheetName: args.sheetName,
      range: args.range
    });
    return {
      ...loaded,
      source_kind: "google_sheets"
    };
  } catch (error) {
    if (args.noPublicCsvFallback) throw error;
    const loaded = await loadRowsFromPublicSheetSource({ source, gid: args.gid, range: args.range });
    return {
      ...loaded,
      source_kind: "public_google_sheet_fallback"
    };
  }
}

function selectInitialDraftEntries(entries, options = {}) {
  const statuses = parseStatusFilter(options.statuses);
  const limit = Number.parseInt(options.limit || String(entries.length), 10);
  const onlyNew = Boolean(options.onlyNew);
  const includePrompted = Boolean(options.includePrompted);
  const confirmHumanReviewed = Boolean(options.confirmHumanReviewed);
  const retryFailed = Boolean(options.retryFailed);
  const targetRequestId = normalizeOptionalString(options.targetRequestId);
  const targetRowNumber = parseOptionalInteger(options.targetRowNumber);
  const afterRowNumber = parseOptionalInteger(options.afterRowNumber);
  const targetedSelection = Boolean(targetRequestId || targetRowNumber !== null);

  return entries
    .filter((entry) => {
      if (targetRequestId && entry.request.request_id !== targetRequestId) return false;
      if (targetRowNumber !== null && entry.row_number !== targetRowNumber) return false;
      if (targetRowNumber === null && afterRowNumber !== null && entry.row_number <= afterRowNumber) return false;
      if (statuses.length > 0 && !statuses.includes(String(entry.request.status || "").toLowerCase())) return false;
      if (entry.queue_status.already_posted) return false;
      if (entry.queue_status.already_generated) return false;
      if (entry.queue_status.failed && !retryFailed) return false;
      if (!onlyNew) return true;
      if (entry.queue_status.processing_state === "unseen") return true;
      if (includePrompted && entry.queue_status.processing_state === "prompted") {
        return !isPolicyHoldReviewRequired(entry) || confirmHumanReviewed || targetedSelection;
      }
      if (retryFailed && entry.queue_status.processing_state === "failed") return true;
      return false;
    })
    .slice(0, Number.isFinite(limit) ? limit : entries.length);
}

function findLastPostedRowNumber(entries) {
  const postedRows = entries
    .filter((entry) => entry.queue_status.already_posted)
    .map((entry) => entry.row_number)
    .filter(Number.isFinite);
  return postedRows.length > 0 ? Math.max(...postedRows) : null;
}

async function readCursorRowNumber(cursorPath) {
  try {
    const cursor = await readJsonFile(cursorPath);
    return parseOptionalInteger(cursor.last_processed_row);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isPolicyHoldReviewRequired(entry) {
  return entry.artifacts?.manifest_status === "policy_hold" || entry.artifacts?.manifest_run_status === "review_required";
}

function parseStatusFilter(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return raw.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
}

function normalizeOptionalString(value) {
  return String(value || "").trim();
}

function parseOptionalInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildPlan({ promptPack, manifest, execute, sendChatwork, guardrails, humanReviewed, textQualityGate }) {
  const policyHold = manifest.policy_gate_summary?.status === "hold";
  const blockedByPolicyReview = policyHold && !humanReviewed;
  const brandAssets = promptPack.brand_assets || {};
  const imageWillExecute =
    execute &&
    guardrails.initial_draft_auto_enabled === true &&
    guardrails.image2_generation_enabled === true &&
    !blockedByPolicyReview;
  const externalActions = {
    image_generation: {
      will_execute: imageWillExecute,
      blocked_reason: blockedByPolicyReview ? "policy_hold requires --confirm-human-reviewed" : null,
      required: [
        "--execute",
        "guardrails.initial_draft_auto_enabled=true",
        "guardrails.image2_generation_enabled=true",
        "OPENAI_API_KEY"
      ]
    },
    logo_input_image: {
      will_execute: imageWillExecute && brandAssets.logo?.enabled === true && brandAssets.logo?.api_input_required === true,
      blocked_reason:
        brandAssets.logo?.available && brandAssets.logo?.enabled !== true
          ? "brand_assets.logo_insertion_enabled is false"
          : blockedByPolicyReview
            ? "policy_hold requires --confirm-human-reviewed"
            : null,
      source_type: brandAssets.logo?.source_type || null,
      placement: brandAssets.logo?.placement || null
    },
    logo_note_band_avoidance: {
      will_execute:
        imageWillExecute &&
        brandAssets.logo?.enabled === true &&
        brandAssets.logo?.adjusted_for_note_band === true &&
        brandAssets.required_note?.enabled === true,
      blocked_reason:
        brandAssets.logo?.enabled === true &&
        brandAssets.required_note?.enabled === true &&
        brandAssets.logo?.adjusted_for_note_band !== true
          ? "brand_assets.logo_avoid_note_band_enabled is false"
          : null,
      effective_placement: brandAssets.logo?.effective_placement || brandAssets.logo?.placement || null
    },
    bottom_safe_area_prompt: {
      applied: brandAssets.bottom_safe_area?.prompt_enabled === true,
      bottom_percent: brandAssets.bottom_safe_area?.bottom_percent || null,
      band_height: brandAssets.bottom_safe_area?.band_height || null
    },
    required_note_band: {
      will_execute: imageWillExecute && brandAssets.required_note?.enabled === true && Boolean(brandAssets.required_note?.text),
      blocked_reason:
        brandAssets.required_note?.available && brandAssets.required_note?.enabled !== true
          ? "brand_assets.required_note_band_enabled is false"
          : blockedByPolicyReview
            ? "policy_hold requires --confirm-human-reviewed"
            : null,
      text_exact_match_source: brandAssets.required_note?.enabled === true ? "client_master.required_note" : null,
      uses_brand_color: Boolean(brandAssets.brand_color?.use_for_note_band)
    },
    chatwork_post: {
      will_execute:
        execute &&
        sendChatwork &&
        guardrails.initial_draft_chatwork_send_enabled === true &&
        guardrails.chatwork_send_enabled === true &&
        !blockedByPolicyReview,
      blocked_reason: blockedByPolicyReview ? "policy_hold requires --confirm-human-reviewed" : null,
      required: [
        "--execute",
        "--send-chatwork",
        "guardrails.initial_draft_chatwork_send_enabled=true",
        "guardrails.chatwork_send_enabled=true",
        "CHATWORK_API_TOKEN"
      ]
    },
    drive_upload: { will_execute: false },
    sheet_write: { will_execute: false },
    revision_auto_generation: { will_execute: false }
  };
  if (textQualityGate?.enabled) {
    externalActions.text_quality_gate = {
      will_execute:
        execute &&
        guardrails.initial_draft_auto_enabled === true &&
        guardrails.image2_generation_enabled === true &&
        !blockedByPolicyReview,
      max_retries: textQualityGate.max_retries,
      model: textQualityGate.model,
      required: ["--quality-gate or guardrails.text_quality_gate.enabled=true", "OPENAI_API_KEY"]
    };
  }

  return {
    schema_version: "aicr-initial-draft-plan-v1",
    request_id: promptPack.request_id,
    created_at: new Date().toISOString(),
    execute_requested: execute,
    send_chatwork_requested: sendChatwork,
    human_reviewed: Boolean(humanReviewed),
    review_required: blockedByPolicyReview,
    client_master: promptPack.client_master || null,
    brand_assets: promptPack.brand_assets || null,
    policy_gate_summary: manifest.policy_gate_summary,
    external_actions: externalActions,
    notes: [
      "FB修正は自動再生成しません。",
      "policy_holdの場合はrunnerを失敗終了せず、review_requiredとして記録して次の依頼へ進みます。",
      "policy_holdの画像生成・Chatwork投稿は --confirm-human-reviewed が明示された場合のみ人間確認済みとして進みます。",
      "Drive保存とSheets書き戻しはこのrunnerでは行いません。"
    ]
  };
}

async function markPolicyHoldReviewRequired({ promptPack, manifestPath, requestDir, planPath }) {
  const manifest = await readJsonFile(manifestPath);
  const reviewRequired = {
    schema_version: "aicr-review-required-v1",
    request_id: promptPack.request_id,
    status: "review_required",
    reason: "policy_hold: human review is required before image generation or Chatwork posting.",
    created_at: new Date().toISOString(),
    human_reviewed: false,
    next_action: "Review prompt_pack.json and rerun with --confirm-human-reviewed only if the policy_hold risk is accepted.",
    policy_gate_summary: manifest.policy_gate_summary,
    findings: collectPolicyFindings(promptPack)
  };
  const reviewPath = path.join(requestDir, "review_required.json");
  await writeJson(reviewPath, reviewRequired);

  manifest.status = "policy_hold";
  manifest.run_status = "review_required";
  manifest.run_mode = "execute-review-required";
  manifest.review_required = reviewRequired;
  manifest.steps = manifest.steps || {};
  manifest.steps.image2_generation = {
    status: "blocked",
    reason: "policy_hold",
    next_action: "--confirm-human-reviewed is required after human review"
  };
  manifest.steps.chatwork_post = {
    status: "blocked",
    reason: "policy_hold",
    next_action: "--confirm-human-reviewed is required before posting policy_hold output"
  };
  manifest.artifacts = manifest.artifacts || {};
  manifest.artifacts.review_required_json = reviewPath;
  manifest.artifacts.initial_draft_plan_json = planPath;
  await writeJson(manifestPath, manifest);

  return {
    path: reviewPath,
    review_required: reviewRequired
  };
}

function collectPolicyFindings(promptPack) {
  const findings = [];
  if (promptPack.request_policy_gate_result?.findings?.length) {
    findings.push(
      ...promptPack.request_policy_gate_result.findings.map((finding) => ({
        scope: "request",
        variant_id: null,
        ...finding
      }))
    );
  }
  for (const variant of promptPack.variants || []) {
    for (const finding of variant.policy_gate_result?.findings || []) {
      findings.push({
        scope: "variant",
        variant_id: variant.variant_id,
        variant_index: variant.variant_index,
        ...finding
      });
    }
  }
  return findings;
}

async function generateInitialDraftImages({ promptPack, requestDir, guardrails, textQualityGate }) {
  const imagesDir = path.join(requestDir, "images");
  const images = [];
  const concurrency = normalizeImageGenerationConcurrency(
    guardrails.initial_draft?.image_generation_concurrency
  );
  const qualityGateEnabled = textQualityGate?.enabled === true;
  let logoInput = null;
  try {
    logoInput = await prepareLogoInputForGeneration({ promptPack, guardrails });
  } catch (error) {
    const failure = buildLogoAssetFailure({ error, promptPack });
    const failurePath = path.join(requestDir, "generation_failure.json");
    await writeJson(failurePath, {
      schema_version: "aicr-image2-generation-failure-v1",
      request_id: promptPack.request_id,
      failed_at: failure.failed_at,
      failure,
      partial_images: []
    });
    await markManifestGenerationFailure({
      requestDir,
      failure,
      failurePath,
      partialImages: []
    });
    throw error;
  }

  const variants = promptPack.variants || [];
  for (let offset = 0; offset < variants.length; offset += concurrency) {
    const batch = variants.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (variant) => {
        const fileName = `variant_${variant.variant_index}_${variant.generation_tags?.appeal_axis || variant.variant_id}_api.png`;
        const rawPath = path.join(imagesDir, fileName);
        return generateVariantWithOptionalQualityGate({
          variant,
          rawPath,
          guardrails,
          textQualityGate,
          qualityGateEnabled,
          logoInput,
          promptPack
        });
      })
    );

    for (const result of settled) {
      if (result.status === "fulfilled") images.push(result.value);
    }
    images.sort((left, right) => left.variant_index - right.variant_index);

    const failedIndex = settled.findIndex((result) => result.status === "rejected");
    if (failedIndex !== -1) {
      const error = settled[failedIndex].reason;
      const variant = batch[failedIndex];
      const failure = buildGenerationFailure({
        error,
        promptPack,
        variant,
        generatedImages: images
      });
      const failurePath = path.join(requestDir, "generation_failure.json");
      await writeJson(failurePath, {
        schema_version: "aicr-image2-generation-failure-v1",
        request_id: promptPack.request_id,
        failed_at: failure.failed_at,
        failure,
        partial_images: images
      });
      await markManifestGenerationFailure({
        requestDir,
        failure,
        failurePath,
        partialImages: images
      });
      throw error;
    }
  }

  const resultPath = path.join(requestDir, "generation_result.json");
  const qualityGateSummary = qualityGateEnabled ? summarizeTextQualityGate(images) : null;
  await writeJson(resultPath, {
    schema_version: "aicr-image2-generation-result-v1",
    request_id: promptPack.request_id,
    generated_at: new Date().toISOString(),
    mode: "openai_images_api",
    image_generation_concurrency: concurrency,
    image_count: images.length,
    external_actions: {
      chatwork_post_executed: false,
      drive_upload_executed: false,
      sheet_write_executed: false,
      logo_input_image_executed: Boolean(logoInput),
      required_note_band_applied: images.some((image) => image.postprocess?.required_note_band?.status === "applied"),
      logo_overlay_applied: images.some((image) => image.postprocess?.logo_overlay?.status === "applied"),
      ...(qualityGateEnabled ? { text_quality_gate_executed: true } : {})
    },
    brand_assets: promptPack.brand_assets || null,
    logo_input_image: summarizeLogoInputImage(logoInput),
    ...(qualityGateSummary ? { text_quality_gate_summary: qualityGateSummary } : {}),
    images
  });
  await writeJson(path.join(requestDir, "generated_assets.json"), {
    schema_version: "aicr-generated-assets-v1",
    request_id: promptPack.request_id,
    images
  });
  return { result_path: resultPath, images, quality_gate_summary: qualityGateSummary };
}

function normalizeImageGenerationConcurrency(value) {
  const parsed = Number.parseInt(String(value ?? "2"), 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(4, Math.max(1, parsed));
}

async function generateVariantWithOptionalQualityGate({
  variant,
  rawPath,
  guardrails,
  textQualityGate,
  qualityGateEnabled,
  logoInput,
  promptPack
}) {
  const maxRetries = qualityGateEnabled ? textQualityGate.max_retries : 0;
  const attempts = [];
  let lastImage = null;

  if (!qualityGateEnabled && canReuseExistingImage({ promptPack, guardrails, logoInput })) {
    const existing = await buildExistingGeneratedImageRecord({ variant, rawPath, guardrails, logoInput });
    if (existing) {
      return applyRequiredNoteBandToRecord({ imageRecord: existing, promptPack, guardrails, logoInput });
    }
  }

  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
    const generated = await generateImage2File({
      prompt: variant.prompt,
      outputPath: rawPath,
      config: guardrails.image2_api || {},
      inputImages: logoInput && promptPack.brand_assets?.logo?.api_input_required === true
        ? [{ image_url: logoInput.image_url }]
        : []
    });
    const resizeResult = await resizeImageToFinal(rawPath, guardrails.image2_api?.final_size);
    const baseFinalPath = resizeResult.output_path || rawPath;
    lastImage = buildGeneratedImageRecord({
      variant,
      rawPath,
      finalPath: baseFinalPath,
      generated,
      postprocess: {
        resize: resizeResult
      },
      logoInput
    });

    if (!qualityGateEnabled) {
      return applyRequiredNoteBandToRecord({ imageRecord: lastImage, promptPack, guardrails, logoInput });
    }

    const gateResult = await evaluateVariantTextQuality({
      variant,
      imagePath: lastImage.final_local_path || lastImage.local_path,
      textQualityGate,
      attemptIndex
    });
    attempts.push(gateResult);

    if (gateResult.status === "ok") {
      return {
        ...(await applyRequiredNoteBandToRecord({ imageRecord: lastImage, promptPack, guardrails, logoInput })),
        text_quality_gate: {
          status: "ok",
          ok: true,
          expected_text: gateResult.expected_text,
          retry_count: attemptIndex,
          attempts
        }
      };
    }

    if (gateResult.status === "error") {
      return {
        ...(await applyRequiredNoteBandToRecord({ imageRecord: lastImage, promptPack, guardrails, logoInput })),
        text_quality_gate: {
          status: "error",
          ok: false,
          expected_text: gateResult.expected_text,
          retry_count: attemptIndex,
          attempts,
          reason: gateResult.reason
        }
      };
    }
  }

  const lastAttempt = attempts[attempts.length - 1] || {};
  return {
    ...(await applyRequiredNoteBandToRecord({ imageRecord: lastImage, promptPack, guardrails, logoInput })),
    text_quality_gate: {
      status: "ng",
      ok: false,
      expected_text: lastAttempt.expected_text || variant.text_contract?.expected_text || "",
      retry_count: attempts.length ? attempts.length - 1 : 0,
      retry_exhausted: true,
      attempts,
      reason: lastAttempt.reason || "text quality gate did not pass"
    }
  };
}

function buildGeneratedImageRecord({ variant, rawPath, finalPath, generated, postprocess, logoInput }) {
  return {
    variant_id: variant.variant_id,
    variant_index: variant.variant_index,
    generation_tags: variant.generation_tags,
    policy_gate_result: variant.policy_gate_result,
    local_path: rawPath,
    final_local_path: finalPath || rawPath,
    api_result: {
      mode: generated.mode,
      endpoint: generated.endpoint,
      model: generated.model,
      size: generated.size,
      output_format: generated.output_format,
      input_image_count: generated.input_image_count,
      bytes_written: generated.bytes_written,
      usage: generated.usage
    },
    logo_input_image: summarizeLogoInputImage(logoInput),
    postprocess: postprocess || null
  };
}

function canReuseExistingImage({ promptPack, guardrails, logoInput }) {
  const requiredNote = promptPack.brand_assets?.required_note;
  const logo = promptPack.brand_assets?.logo;
  if (requiredNote?.enabled === true && requiredNote.text) return false;
  if (
    logoInput &&
    logo?.enabled === true &&
    logo?.postprocess_overlay_enabled === true &&
    logo?.adjusted_for_note_band === true &&
    guardrails.brand_assets?.logo_avoid_note_band_enabled !== false
  ) {
    return false;
  }
  return true;
}

async function buildExistingGeneratedImageRecord({ variant, rawPath, guardrails, logoInput }) {
  const rawStat = await statIfExists(rawPath);
  if (!rawStat) return null;

  const finalSize = guardrails.image2_api?.final_size;
  const finalPath = buildSizedImagePath(rawPath, finalSize);
  let finalStat = finalPath === rawPath ? rawStat : await statIfExists(finalPath);
  let resizeResult = null;

  if (finalPath !== rawPath && finalStat) {
    const size = parseImageSize(finalSize);
    resizeResult = {
      schema_version: "aicr-image-postprocess-resize-v1",
      status: "reused",
      reason: "existing final image found",
      input_path: rawPath,
      output_path: finalPath,
      width: size?.width || null,
      height: size?.height || null,
      engine: "sharp"
    };
  } else if (finalPath !== rawPath) {
    resizeResult = await resizeImageToFinal(rawPath, finalSize);
    finalStat = await statIfExists(resizeResult.output_path);
  } else {
    resizeResult = {
      schema_version: "aicr-image-postprocess-resize-v1",
      status: "skipped",
      reason: "final_size is not configured",
      input_path: rawPath,
      output_path: ""
    };
  }

  return buildGeneratedImageRecord({
    variant,
    rawPath,
    finalPath: finalStat ? finalPath : rawPath,
    generated: {
      mode: "existing_file_reused",
      endpoint: null,
      model: null,
      size: finalSize || null,
      output_format: path.extname(rawPath).replace(".", "") || null,
      input_image_count: 0,
      bytes_written: rawStat.size,
      usage: null
    },
    postprocess: {
      resize: resizeResult,
      existing_file_reuse: {
        schema_version: "aicr-existing-image-reuse-v1",
        status: "reused",
        raw_path: rawPath,
        final_path: finalStat ? finalPath : rawPath,
        raw_bytes: rawStat.size,
        final_bytes: finalStat?.size || rawStat.size
      }
    },
    logoInput
  });
}

async function statIfExists(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function buildSizedImagePath(filePath, size) {
  const parsed = parseImageSize(size);
  if (!parsed) return filePath;
  const ext = path.extname(filePath);
  const base = ext ? filePath.slice(0, -ext.length) : filePath;
  return `${base}_${parsed.width}x${parsed.height}${ext}`;
}

function parseImageSize(value) {
  const match = String(value || "").match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10)
  };
}

async function prepareLogoInputForGeneration({ promptPack, guardrails }) {
  const logo = promptPack.brand_assets?.logo;
  if (logo?.enabled !== true || !logo.reference) return null;
  if (logo.source !== "google_form" && guardrails.brand_assets?.logo_insertion_enabled !== true) return null;
  return loadLogoInputImage(logo.reference);
}

async function applyRequiredNoteBandToRecord({ imageRecord, promptPack, guardrails, logoInput }) {
  const requiredNote = promptPack.brand_assets?.required_note;
  if (requiredNote?.enabled !== true || !requiredNote.text) {
    const recordWithoutNote = {
      ...imageRecord,
      postprocess: {
        ...(imageRecord.postprocess || {}),
        required_note_band: {
          schema_version: "aicr-note-band-postprocess-v1",
          status: "skipped",
          reason: requiredNote?.available ? "brand_assets.required_note_band_enabled is false" : "required_note is empty",
          input_path: imageRecord.final_local_path || imageRecord.local_path,
          output_path: ""
        }
      }
    };
    return applyLogoOverlayToRecord({ imageRecord: recordWithoutNote, promptPack, guardrails, logoInput, noteResult: null });
  }

  const noteResult = await applyNoteBandToImage(
    imageRecord.final_local_path || imageRecord.local_path,
    requiredNote.text,
    {
      config: guardrails.brand_assets?.note_band || {},
      brandColorHex: promptPack.brand_assets?.brand_color?.hex || ""
    }
  );

  const recordWithNote = {
    ...imageRecord,
    final_local_path: noteResult.output_path || imageRecord.final_local_path || imageRecord.local_path,
    postprocess: {
      ...(imageRecord.postprocess || {}),
      required_note_band: noteResult
    }
  };

  return applyLogoOverlayToRecord({
    imageRecord: recordWithNote,
    promptPack,
    guardrails,
    logoInput,
    noteResult
  });
}

async function applyLogoOverlayToRecord({ imageRecord, promptPack, guardrails, logoInput, noteResult }) {
  const logo = promptPack.brand_assets?.logo;
  if (
    !logoInput ||
    logo?.enabled !== true ||
    logo?.postprocess_overlay_enabled !== true
  ) {
    return {
      ...imageRecord,
      postprocess: {
        ...(imageRecord.postprocess || {}),
        logo_overlay: {
          schema_version: "aicr-logo-overlay-postprocess-v1",
          status: "skipped",
          reason: "logo overlay is disabled or logo input is empty",
          input_path: imageRecord.final_local_path || imageRecord.local_path,
          output_path: ""
        }
      }
    };
  }

  const logoOverlay = await overlayLogoOnImage(
    imageRecord.final_local_path || imageRecord.local_path,
    logoInput,
    {
      placement: logo.placement || "bottom_right",
      noteBandHeight: noteResult?.band_height || 0,
      avoidNoteBand: logo.adjusted_for_note_band === true,
      config: {
        ...(guardrails.brand_assets?.logo_overlay || {}),
        background_color: logo.plate_background_color || "",
        padding: logo.plate_padding || 0,
        max_width_ratio: logo.max_width_ratio || guardrails.brand_assets?.logo_overlay?.max_width_ratio,
        max_height_ratio: logo.max_height_ratio || guardrails.brand_assets?.logo_overlay?.max_height_ratio,
        margin: logo.margin || guardrails.brand_assets?.logo_overlay?.margin,
        alignment: logo.alignment || "auto"
      }
    }
  );

  return {
    ...imageRecord,
    final_local_path: logoOverlay.output_path || imageRecord.final_local_path || imageRecord.local_path,
    postprocess: {
      ...(imageRecord.postprocess || {}),
      logo_overlay: logoOverlay
    }
  };
}

async function evaluateVariantTextQuality({ variant, imagePath, textQualityGate, attemptIndex }) {
  try {
    const result = await evaluateTextQualityGate({
      imagePath,
      expectedText: variant.text_contract?.expected_text || "",
      variantId: variant.variant_id,
      variantIndex: variant.variant_index,
      config: textQualityGate
    });
    return {
      attempt: attemptIndex + 1,
      image_path: imagePath,
      ...result
    };
  } catch (error) {
    return {
      schema_version: "aicr-text-quality-gate-result-v1",
      attempt: attemptIndex + 1,
      image_path: imagePath,
      ok: false,
      status: "error",
      expected_text: variant.text_contract?.expected_text || "",
      extracted_text: "",
      reason: redactSecrets(error?.message || String(error)),
      model: textQualityGate.model || null,
      usage: null
    };
  }
}

function summarizeTextQualityGate(images) {
  const gateResults = images.map((image) => image.text_quality_gate).filter(Boolean);
  const okCount = gateResults.filter((result) => result.status === "ok").length;
  const ngCount = gateResults.filter((result) => result.status === "ng").length;
  const errorCount = gateResults.filter((result) => result.status === "error").length;
  const retryCount = gateResults.reduce((sum, result) => sum + (Number(result.retry_count) || 0), 0);
  return {
    schema_version: "aicr-text-quality-gate-summary-v1",
    enabled: true,
    status: errorCount > 0 ? "error" : ngCount > 0 ? "ng" : "ok",
    checked_count: gateResults.length,
    ok_count: okCount,
    ng_count: ngCount,
    error_count: errorCount,
    retry_count: retryCount
  };
}

function buildGenerationFailure({ error, promptPack, variant, generatedImages }) {
  const message = redactSecrets(error?.message || String(error));
  const lowerMessage = message.toLowerCase();
  const safetyRejected =
    lowerMessage.includes("safety_violations") ||
    lowerMessage.includes("safety violation") ||
    lowerMessage.includes("sexual");
  const category = safetyRejected ? "image2_safety_rejection" : "image2_generation_error";

  return {
    category,
    stage: "image2_generation",
    external_service: "openai_images_api",
    request_id: promptPack.request_id,
    variant_id: variant.variant_id,
    variant_index: variant.variant_index,
    generated_count_before_failure: generatedImages.length,
    failed_at: new Date().toISOString(),
    message,
    retry: {
      auto_retry: false,
      reason: safetyRejected
        ? "OpenAI Images API safety rejection; prompt needs human-reviewed adjustment before retry."
        : "Initial draft generation failed; retry must be explicitly requested.",
      manual_retry_flag: "--retry-failed"
    }
  };
}

function buildLogoAssetFailure({ error, promptPack }) {
  const message = redactSecrets(error?.message || String(error));
  return {
    category: "logo_asset_fetch_error",
    stage: "logo_asset_fetch",
    external_service: "logo_reference_fetch",
    request_id: promptPack.request_id,
    variant_id: null,
    variant_index: null,
    generated_count_before_failure: 0,
    failed_at: new Date().toISOString(),
    message,
    retry: {
      auto_retry: false,
      reason: "Logo input image could not be fetched. Check the client master logo reference and public readability.",
      manual_retry_flag: "--retry-failed"
    }
  };
}

async function markManifestGenerationFailure({ requestDir, failure, failurePath, partialImages }) {
  const manifestPath = path.join(requestDir, "manifest.json");
  const manifest = await readJsonFile(manifestPath).catch(() => null);
  if (!manifest) return;

  manifest.status = "error";
  manifest.run_status =
    failure.category === "image2_safety_rejection"
      ? "initial_draft_image2_safety_rejected"
      : "initial_draft_image2_failed";
  manifest.run_mode = "execute";
  manifest.dry_run = false;
  manifest.failed_at = failure.failed_at;
  manifest.error_message = failure.message;
  manifest.error = failure;
  manifest.steps = manifest.steps || {};
  manifest.steps.image2_generation = {
    status: "failed",
    category: failure.category,
    failed_variant_id: failure.variant_id,
    failed_variant_index: failure.variant_index,
    generated_count_before_failure: failure.generated_count_before_failure,
    reason: failure.message
  };
  manifest.artifacts = manifest.artifacts || {};
  manifest.artifacts.generation_failure_json = failurePath;
  manifest.artifacts.partial_images = partialImages.map((image) => image.final_local_path || image.local_path);
  await writeJson(manifestPath, manifest);
}

function assertInitialDraftExecutionAllowed({ guardrails, sendChatwork }) {
  if (guardrails.initial_draft_auto_enabled !== true) {
    throw new Error("--execute requires guardrails.initial_draft_auto_enabled=true.");
  }
  if (guardrails.image2_generation_enabled !== true) {
    throw new Error("--execute requires guardrails.image2_generation_enabled=true.");
  }
  if (sendChatwork && guardrails.initial_draft_chatwork_send_enabled !== true) {
    throw new Error("--send-chatwork requires guardrails.initial_draft_chatwork_send_enabled=true.");
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
