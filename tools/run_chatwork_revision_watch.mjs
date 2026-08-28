#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseArgs,
  printJson,
  readJsonFile,
  resolveDataRoot,
  resolveProjectRoot
} from "../src/cli.mjs";
import {
  addBlockedFeedbackState,
  addProcessedFeedbackState,
  selectPendingFeedbackItems
} from "../src/revision_watch.mjs";
import { writeJson } from "../src/manifest.mjs";

const execFileAsync = promisify(execFile);
const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const requestRoot = path.join(dataRoot, "outputs", "requests");
const reportRoot = path.join(dataRoot, "outputs", "revision_watch");

try {
  const roomId = String(args.roomId || process.env.CHATWORK_ROOM_ID || "").trim();
  if (!roomId) throw new Error("Provide --room-id or CHATWORK_ROOM_ID.");

  await fs.mkdir(reportRoot, { recursive: true });
  const lock = await acquireLock(path.join(reportRoot, "revision_watch.lock"));
  if (!lock.acquired) {
    printJson({
      ok: true,
      status: "skipped_locked",
      lock_path: lock.path,
      note: "another revision watch run is still active"
    });
    process.exit(0);
  }

  try {
    const execute = Boolean(args.execute);
    const sendChatwork = Boolean(args.sendChatwork);
    const limitRequests = Number.parseInt(args.limitRequests || "20", 10);
    const limitFeedback = Number.parseInt(args.limitFeedback || "1", 10);
    const guardrailsPath = path.resolve(args.guardrails || path.join(projectRoot, "config", "guardrails.example.json"));
    const openaiEnvFile = path.resolve(args.openaiEnvFile || "");
    const chatworkEnvFile = path.resolve(args.chatworkEnvFile || args.envFile || "");
    const candidates = await listCandidateRequests({ limitRequests });
    const report = {
      schema_version: "aicr-revision-watch-report-v1",
      ok: true,
      created_at: new Date().toISOString(),
      mode: execute ? "execute" : "dry-run",
      send_chatwork: sendChatwork,
      room_id: roomId,
      limit_requests: limitRequests,
      limit_feedback: limitFeedback,
      checked_request_count: candidates.length,
      processed_count: 0,
      blocked_count: 0,
      skipped_count: 0,
      processed: [],
      blocked: [],
      skipped: []
    };

    for (const candidate of candidates) {
      const parsed = await parseFeedbackForRequest({ requestId: candidate.requestId, roomId, chatworkEnvFile });
      const requestDir = path.join(requestRoot, candidate.requestId);
      const statePath = path.join(requestDir, "feedback", "auto_revision_state.json");
      const state = await readJsonOptional(statePath, {});
      const history = await readJsonOptional(path.join(requestDir, "revision_history.json"), {});
      const pending = selectPendingFeedbackItems(parsed, state, history);

      if (!pending.length) {
        report.skipped_count += 1;
        report.skipped.push({
          request_id: candidate.requestId,
          reason: "no_unprocessed_resolved_feedback",
          feedback_count: parsed.feedback_count || 0
        });
        continue;
      }

      for (const item of pending) {
        if (report.processed_count + report.blocked_count >= limitFeedback) break;

        if (!execute) {
          report.skipped_count += 1;
          report.skipped.push({
            request_id: candidate.requestId,
            reason: "dry_run_pending_feedback",
            message_id: item.message_id,
            variant_index: item.resolved_variant_index,
            feedback_text: item.feedback_text
          });
          continue;
        }

        try {
          const result = await executeRevisionDelivery({
            requestId: candidate.requestId,
            item,
            roomId,
            sendChatwork,
            guardrailsPath,
            openaiEnvFile,
            chatworkEnvFile
          });
          await writeJson(statePath, addProcessedFeedbackState(state, item, result));
          report.processed_count += 1;
          report.processed.push({
            request_id: candidate.requestId,
            message_id: item.message_id,
            variant_index: item.resolved_variant_index,
            feedback_text: item.feedback_text,
            status: result.status,
            image_paths: result.image_paths || [],
            chatwork_message_id: result.chatwork_message_id || null
          });
        } catch (error) {
          await writeJson(statePath, addBlockedFeedbackState(state, item, error));
          report.blocked_count += 1;
          report.blocked.push({
            request_id: candidate.requestId,
            message_id: item.message_id,
            variant_index: item.resolved_variant_index,
            feedback_text: item.feedback_text,
            error: redactSecrets(error.message || error)
          });
        }
      }

      if (report.processed_count + report.blocked_count >= limitFeedback) break;
    }

    const stamp = report.created_at.replace(/[:.]/g, "-");
    const reportPath = path.join(reportRoot, `revision_watch_${stamp}.json`);
    await writeJson(reportPath, report);
    await writeJson(path.join(reportRoot, "revision_watch_latest.json"), {
      ...report,
      report_path: reportPath
    });
    printJson({
      ok: true,
      mode: report.mode,
      processed_count: report.processed_count,
      blocked_count: report.blocked_count,
      skipped_count: report.skipped_count,
      processed: report.processed,
      blocked: report.blocked,
      report_path: reportPath
    });
  } finally {
    await releaseLock(lock);
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: redactSecrets(error.message || error) }, null, 2));
  process.exitCode = 1;
}

async function listCandidateRequests({ limitRequests }) {
  const entries = await fs.readdir(requestRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const requestId = entry.name;
    const requestDir = path.join(requestRoot, requestId);
    const promptPackPath = path.join(requestDir, "prompt_pack.json");
    const deliveryPath = path.join(requestDir, "delivery_result.json");
    const manifestPath = path.join(requestDir, "manifest.json");
    const hasPromptPack = await exists(promptPackPath);
    const hasDelivery = await exists(deliveryPath);
    if (!hasPromptPack || !hasDelivery) continue;
    const delivery = await readJsonOptional(deliveryPath, {});
    const manifest = await readJsonOptional(manifestPath, {});
    const roomId = delivery.room_id || manifest.chatwork_room_id || "";
    const mtimeMs = Math.max(await mtime(deliveryPath), await mtime(manifestPath));
    candidates.push({ requestId, roomId, mtimeMs });
  }
  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Number.isFinite(limitRequests) ? limitRequests : 20);
}

async function parseFeedbackForRequest({ requestId, roomId, chatworkEnvFile }) {
  const script = path.join(projectRoot, "tools", "parse_chatwork_feedback.mjs");
  const childArgs = [script, "--request-id", requestId, "--room-id", roomId];
  if (chatworkEnvFile) childArgs.push("--env-file", chatworkEnvFile);
  const { stdout } = await execFileAsync(process.execPath, childArgs, {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024 * 8
  });
  const output = JSON.parse(stdout);
  return readJsonFile(output.latest_feedback_path);
}

async function executeRevisionDelivery({
  requestId,
  item,
  roomId,
  sendChatwork,
  guardrailsPath,
  openaiEnvFile,
  chatworkEnvFile
}) {
  const script = path.join(projectRoot, "tools", "run_revision_delivery.mjs");
  const childArgs = [
    script,
    "--request-id",
    requestId,
    "--feedback",
    item.feedback_text,
    "--variants",
    String(item.resolved_variant_index),
    "--guardrails",
    guardrailsPath,
    "--execute"
  ];
  if (openaiEnvFile) childArgs.push("--openai-env-file", openaiEnvFile);
  if (chatworkEnvFile) childArgs.push("--chatwork-env-file", chatworkEnvFile);
  if (sendChatwork) childArgs.push("--send-chatwork", "--room-id", roomId);
  const { stdout } = await execFileAsync(process.execPath, childArgs, {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024 * 8
  });
  return JSON.parse(stdout);
}

async function acquireLock(lockPath) {
  const staleMs = Number.parseInt(args.lockStaleMs || String(15 * 60 * 1000), 10);
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) await fs.unlink(lockPath);
  } catch {
    // No lock or inaccessible stale check; creating the lock below is authoritative.
  }
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await handle.close();
    return { acquired: true, path: lockPath };
  } catch {
    return { acquired: false, path: lockPath };
  }
}

async function releaseLock(lock) {
  if (!lock?.acquired) return;
  await fs.unlink(lock.path).catch(() => {});
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

async function mtime(filePath) {
  return fs.stat(filePath).then((stat) => stat.mtimeMs, () => 0);
}

async function readJsonOptional(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function redactSecrets(message) {
  let result = String(message || "");
  for (const secret of [process.env.OPENAI_API_KEY, process.env.CHATWORK_API_TOKEN].filter(Boolean)) {
    result = result.replaceAll(secret, "[redacted]");
  }
  return result;
}
