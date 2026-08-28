#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { loadGuardrails, parseArgs, printJson, readJsonFile, resolveDataRoot, resolveProjectRoot } from "../src/cli.mjs";
import { writeJson } from "../src/manifest.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const { guardrails } = await loadGuardrails(projectRoot, args);

try {
  const manifestPath = args.manifest ? path.resolve(args.manifest) : await findLatestManifest(dataRoot);
  const manifest = await readJsonFile(manifestPath);
  const payload = buildChatworkPayload(manifest);
  const dryRunPath = path.join(path.dirname(manifestPath), "chatwork_dry_run.json");
  await writeJson(dryRunPath, payload);

  if (!args.send) {
    printJson({
      ok: true,
      dry_run: true,
      message: "Chatwork投稿は実行していません。--send と guardrails.chatwork_send_enabled=true と人間確認が必要です。",
      chatwork_dry_run_path: dryRunPath,
      payload
    });
  } else {
    assertChatworkSendAllowed({ args, guardrails });
    const result = await sendChatworkMessage(payload);
    printJson({
      ok: true,
      dry_run: false,
      chatwork_message_id: result.message_id,
      chatwork_dry_run_path: dryRunPath
    });
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || null }, null, 2));
  process.exitCode = 1;
}

export function buildChatworkPayload(manifest) {
  const summary = manifest.request_summary || {};
  const variantCount = manifest.policy_gate_summary?.variant_count || 0;
  return {
    schema_version: "aicr-chatwork-payload-v1",
    request_id: manifest.request_id,
    room_id_present: Boolean(summary.chatwork_room_id_present),
    message: [
      "[AICR Factory dry-run]",
      `request_id: ${manifest.request_id}`,
      `案件: ${summary.project_name || ""}`,
      `商材: ${summary.product || ""}`,
      `媒体: ${summary.media || ""}`,
      `ターゲット: ${summary.target_audience || ""}`,
      `訴求: ${summary.appeal || ""}`,
      `オファー: ${summary.offer || ""}`,
      `policy_gate: ${manifest.policy_gate_summary?.status || "unknown"}`,
      `variants: ${variantCount}`,
      `manifest: ${manifest.artifacts?.manifest_json || ""}`,
      "実投稿前に、画像・コピー・policy gate・保存先を人間確認してください。"
    ].join("\n"),
    files: []
  };
}

function assertChatworkSendAllowed({ args, guardrails }) {
  if (!guardrails.chatwork_send_enabled) {
    throw new Error("--send requires guardrails.chatwork_send_enabled=true.");
  }
  if (guardrails.require_human_review_before_chatwork_send && !args.confirmHumanReviewed) {
    throw new Error("--send requires --confirm-human-reviewed.");
  }
  if (!process.env.CHATWORK_API_TOKEN) {
    throw new Error("CHATWORK_API_TOKEN is not available. Token value was not read or displayed.");
  }
}

async function sendChatworkMessage(payload) {
  const roomId = process.env.CHATWORK_ROOM_ID;
  if (!roomId) throw new Error("CHATWORK_ROOM_ID is not available.");
  const response = await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
    method: "POST",
    headers: {
      "X-ChatWorkToken": process.env.CHATWORK_API_TOKEN,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ body: payload.message })
  });
  if (!response.ok) {
    throw new Error(`Chatwork API returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function findLatestManifest(dataRoot) {
  const root = path.join(dataRoot, "outputs", "requests");
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const manifestPaths = [];
  for (const dir of dirs.filter((entry) => entry.isDirectory())) {
    const candidate = path.join(root, dir.name, "manifest.json");
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat) manifestPaths.push({ path: candidate, mtimeMs: stat.mtimeMs });
  }
  manifestPaths.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!manifestPaths[0]) throw new Error("manifest not found. Run npm run queue:dry-run first or pass --manifest.");
  return manifestPaths[0].path;
}
