import path from "node:path";
import { applyClientMasterToRequest } from "./client_master.mjs";
import { applyFormLogoToRequest } from "./form_logo.mjs";
import { normalizeRequestRow } from "./request_schema.mjs";
import { buildPromptPack } from "./prompt_builder.mjs";
import { buildSheetStatusUpdate } from "./sheet_status.mjs";
import {
  acquireLocalLock,
  appendLog,
  createManifest,
  ensureDataDirs,
  getRequestOutputDir,
  releaseLocalLock,
  safeError,
  writeJson
} from "./manifest.mjs";

export class ExternalActionBlockedError extends Error {
  constructor(message, code = "AICR_EXTERNAL_ACTION_BLOCKED") {
    super(message);
    this.name = "ExternalActionBlockedError";
    this.code = code;
  }
}

export async function processRequestRow(row, options = {}) {
  const startedAt = new Date().toISOString();
  const dryRun = options.dryRun !== false;
  const dataRoot = options.dataRoot;
  const guardrails = options.guardrails || {};
  const flags = options.flags || {};
  await ensureDataDirs(dataRoot);

  const request = applyFormLogoToRequest(applyClientMasterToRequest(
    normalizeRequestRow(row, {
      rowNumber: options.rowNumber,
      sourceKind: options.sourceKind || "fixture",
      fixturePath: options.fixturePath || null,
      sheetId: options.sheetId || null,
      gid: options.gid || null,
      now: options.now
    }),
    options.clientMasterContext,
    { guardrails }
  ));
  const outputDir = getRequestOutputDir(dataRoot, request.request_id);
  const promptPackPath = path.join(outputDir, "prompt_pack.json");
  const manifestPath = path.join(outputDir, "manifest.json");
  const sheetUpdatePreviewPath = path.join(outputDir, "sheet_update_preview.json");
  let lock = null;

  try {
    lock = await acquireLocalLock({
      dataRoot,
      requestId: request.request_id,
      lockedBy: options.lockedBy
    });

    const promptPack = await buildPromptPack(request, {
      guardrails,
      templatePath: options.templatePath,
      now: options.now
    });
    await writeJson(promptPackPath, promptPack);

    const policyHold = hasPolicyHold(promptPack);
    const status = policyHold ? "policy_hold" : request.status;
    const steps = buildBaseSteps({ request, promptPack, policyHold, dryRun, flags, guardrails });
    assertExternalFlagsAllowed({ flags, guardrails, policyHold });

    const sheetUpdatePreview = buildSheetStatusUpdate({
      request,
      status,
      dryRun,
      errorMessage: "",
      now: options.now
    });
    await writeJson(sheetUpdatePreviewPath, sheetUpdatePreview);

    const manifest = createManifest({
      request,
      promptPack,
      status,
      runStatus: dryRun ? "dry_run_complete" : "complete",
      runMode: dryRun ? "dry-run" : "external-enabled",
      dryRun,
      startedAt,
      flags,
      lock,
      steps,
      paths: {
        outputDir,
        promptPackPath,
        manifestPath,
        sheetUpdatePreviewPath
      },
      sheetUpdatePreview
    });
    await writeJson(manifestPath, manifest);
    const logPath = await appendLog(dataRoot, {
      event: "request_processed",
      request_id: request.request_id,
      status,
      dry_run: dryRun,
      warnings: request.validation?.warnings || [],
      client_master: request.client_master || null,
      manifest_path: manifestPath,
      created_at: new Date().toISOString()
    });

    return {
      request,
      promptPack,
      manifest,
      paths: {
        outputDir,
        promptPackPath,
        manifestPath,
        sheetUpdatePreviewPath,
        logPath
      }
    };
  } catch (error) {
    const safe = safeError(error);
    const errorStatus = error.code === "AICR_EXTERNAL_ACTION_BLOCKED" ? "error" : "error";
    const sheetUpdatePreview = buildSheetStatusUpdate({
      request,
      status: errorStatus,
      dryRun,
      errorMessage: safe.message,
      now: options.now
    });
    const manifest = createManifest({
      request,
      promptPack: null,
      status: errorStatus,
      runStatus: "failed",
      runMode: dryRun ? "dry-run" : "external-enabled",
      dryRun,
      startedAt,
      flags,
      lock,
      steps: {
        error: {
          status: "failed",
          message: safe.message
        }
      },
      paths: {
        outputDir,
        manifestPath,
        sheetUpdatePreviewPath
      },
      sheetUpdatePreview,
      error: safe
    });
    await writeJson(sheetUpdatePreviewPath, sheetUpdatePreview);
    await writeJson(manifestPath, manifest);
    await appendLog(dataRoot, {
      event: "request_failed",
      request_id: request.request_id,
      warnings: request.validation?.warnings || [],
      client_master: request.client_master || null,
      error: safe,
      manifest_path: manifestPath,
      created_at: new Date().toISOString()
    });
    throw error;
  } finally {
    await releaseLocalLock(lock);
  }
}

function buildBaseSteps({ request, promptPack, policyHold, dryRun, flags, guardrails }) {
  return {
    normalize_request: {
      status: request.validation.ok ? "done" : "failed",
      warnings: request.validation.warnings,
      errors: request.validation.errors
    },
    policy_gate: {
      status: policyHold ? "hold" : "done",
      request_policy_status: promptPack.request_policy_gate_result.status,
      variant_statuses: promptPack.variants.map((variant) => ({
        variant_id: variant.variant_id,
        status: variant.policy_gate_result.status,
        risk_level: variant.policy_gate_result.risk_level
      }))
    },
    prompt_pack: {
      status: "done",
      variant_count: promptPack.variants.length
    },
    image2_generation: planExternalStep({
      enabled: flags.generateImages,
      guardrailEnabled: guardrails.image2_generation_enabled,
      blockedByPolicy: policyHold,
      dryRun,
      requiredFlag: "--generate-images"
    }),
    drive_save: planExternalStep({
      enabled: flags.uploadDrive,
      guardrailEnabled: guardrails.drive_upload_enabled,
      blockedByPolicy: policyHold,
      dryRun,
      requiredFlag: "--upload-drive"
    }),
    chatwork_post: planExternalStep({
      enabled: flags.sendChatwork,
      guardrailEnabled: guardrails.chatwork_send_enabled,
      blockedByPolicy: policyHold,
      dryRun,
      requiredFlag: "--send"
    }),
    sheet_write: planExternalStep({
      enabled: flags.writeSheet,
      guardrailEnabled: guardrails.sheet_write_enabled,
      blockedByPolicy: false,
      dryRun,
      requiredFlag: "--write-sheet"
    })
  };
}

function planExternalStep({ enabled, guardrailEnabled, blockedByPolicy, dryRun, requiredFlag }) {
  if (blockedByPolicy) {
    return {
      status: "blocked",
      reason: "policy_hold"
    };
  }
  if (!enabled) {
    return {
      status: "skipped",
      reason: `dry-run default; ${requiredFlag} is required`
    };
  }
  if (!guardrailEnabled) {
    return {
      status: "blocked",
      reason: "guardrails flag is false"
    };
  }
  if (dryRun) {
    return {
      status: "skipped",
      reason: "dry-run mode"
    };
  }
  return {
    status: "blocked",
    reason: "external adapter is intentionally not executed in the scaffold milestone"
  };
}

function assertExternalFlagsAllowed({ flags, guardrails, policyHold }) {
  if (policyHold && (flags.generateImages || flags.uploadDrive || flags.sendChatwork)) {
    throw new ExternalActionBlockedError("policy_holdのため、画像生成・Drive保存・Chatwork投稿を止めました。");
  }
  if (flags.generateImages && !guardrails.image2_generation_enabled) {
    throw new ExternalActionBlockedError("--generate-images requires guardrails.image2_generation_enabled=true.");
  }
  if (flags.uploadDrive && !guardrails.drive_upload_enabled) {
    throw new ExternalActionBlockedError("--upload-drive requires guardrails.drive_upload_enabled=true.");
  }
  if (flags.sendChatwork && !guardrails.chatwork_send_enabled) {
    throw new ExternalActionBlockedError("--send requires guardrails.chatwork_send_enabled=true.");
  }
  if (flags.writeSheet && !guardrails.sheet_write_enabled) {
    throw new ExternalActionBlockedError("--write-sheet requires guardrails.sheet_write_enabled=true.");
  }
  if (flags.sendChatwork && guardrails.require_human_review_before_chatwork_send && !flags.confirmHumanReviewed) {
    throw new ExternalActionBlockedError("--send requires --confirm-human-reviewed when human review is required.");
  }
  if (flags.writeSheet && guardrails.require_human_review_before_sheet_write && !flags.confirmHumanReviewed) {
    throw new ExternalActionBlockedError("--write-sheet requires --confirm-human-reviewed when human review is required.");
  }
}

function hasPolicyHold(promptPack) {
  if (promptPack.request_policy_gate_result.status === "hold") return true;
  return promptPack.variants.some((variant) => variant.policy_gate_result.status === "hold");
}
