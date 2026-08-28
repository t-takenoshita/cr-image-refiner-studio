import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function ensureDataDirs(dataRoot) {
  await Promise.all([
    fs.mkdir(path.join(dataRoot, "outputs", "requests"), { recursive: true }),
    fs.mkdir(path.join(dataRoot, "logs"), { recursive: true }),
    fs.mkdir(path.join(dataRoot, "cache", "locks"), { recursive: true })
  ]);
}

export function getRequestOutputDir(dataRoot, requestId) {
  return path.join(dataRoot, "outputs", "requests", requestId);
}

export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function appendLog(dataRoot, event) {
  const date = new Date().toISOString().slice(0, 10);
  const logPath = path.join(dataRoot, "logs", `${date}.jsonl`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(event)}\n`, "utf8");
  return logPath;
}

export function createManifest(options = {}) {
  const request = options.request;
  const promptPack = options.promptPack;
  const steps = options.steps || {};
  const paths = options.paths || {};
  const flags = options.flags || {};
  const policyHold = hasPolicyHold(promptPack);
  const status = options.status || (policyHold ? "policy_hold" : request.status);

  return {
    schema_version: "aicr-manifest-v1",
    request_id: request.request_id,
    status,
    run_status: options.runStatus || "dry_run_complete",
    run_mode: options.runMode || "dry-run",
    dry_run: options.dryRun !== false,
    started_at: options.startedAt,
    finished_at: options.finishedAt || new Date().toISOString(),
    source: request.source,
    request_summary: promptPack?.request_summary || null,
    client_master: request.client_master || promptPack?.client_master || null,
    brand_assets: promptPack?.brand_assets || request.brand_assets || null,
    policy_gate_summary: summarizePolicy(promptPack),
    external_flags: flags,
    lock: options.lock || null,
    steps,
    artifacts: {
      output_dir: paths.outputDir || null,
      prompt_pack_json: paths.promptPackPath || null,
      manifest_json: paths.manifestPath || null,
      chatwork_dry_run_json: paths.chatworkDryRunPath || null,
      sheet_update_preview_json: paths.sheetUpdatePreviewPath || null
    },
    sheet_update_preview: options.sheetUpdatePreview || null,
    learning_boundary: promptPack?.learning_boundary || {
      auto_register_learning: false,
      reason: "AICR Factoryは制作オペレーション。成果が明確な案件だけ将来の学習候補にする。"
    },
    error: options.error || null
  };
}

export async function acquireLocalLock(options = {}) {
  const dataRoot = options.dataRoot;
  const requestId = options.requestId;
  const lockedBy = options.lockedBy || `${os.hostname()}:${process.pid}`;
  const lockDir = path.join(dataRoot, "cache", "locks");
  const lockPath = path.join(lockDir, `${requestId}.lock.json`);
  const lock = {
    schema_version: "aicr-local-lock-v1",
    request_id: requestId,
    locked_at: new Date().toISOString(),
    locked_by: lockedBy,
    path: lockPath,
    strategy: "local_atomic_file_for_dry_run_plus_sheet_locked_at_locked_by_for_real_queue",
    sheet_lock_columns: ["locked_at", "locked_by", "status"],
    acquired: false
  };

  await fs.mkdir(lockDir, { recursive: true });
  let handle;
  try {
    handle = await fs.open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
    lock.acquired = true;
    return lock;
  } catch (error) {
    if (error.code === "EEXIST") {
      const existingRaw = await fs.readFile(lockPath, "utf8").catch(() => "{}");
      const existing = JSON.parse(existingRaw || "{}");
      const lockError = new Error(`request is already locked: ${requestId}`);
      lockError.code = "AICR_LOCKED";
      lockError.existingLock = existing;
      throw lockError;
    }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

export async function releaseLocalLock(lock) {
  if (!lock?.acquired || !lock.path) return;
  await fs.rm(lock.path, { force: true });
}

export function safeError(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || null,
    message: error?.message || String(error)
  };
}

function hasPolicyHold(promptPack) {
  if (!promptPack) return false;
  if (promptPack.request_policy_gate_result?.status === "hold") return true;
  return promptPack.variants?.some((variant) => variant.policy_gate_result?.status === "hold") || false;
}

function summarizePolicy(promptPack) {
  if (!promptPack) return null;
  const results = [
    promptPack.request_policy_gate_result,
    ...(promptPack.variants || []).map((variant) => variant.policy_gate_result)
  ].filter(Boolean);
  const holdCount = results.filter((result) => result.status === "hold").length;
  const warnCount = results.filter((result) => result.status === "warn").length;
  return {
    status: holdCount > 0 ? "hold" : warnCount > 0 ? "warn" : "pass",
    hold_count: holdCount,
    warn_count: warnCount,
    variant_count: promptPack.variants?.length || 0
  };
}
