#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  loadGuardrails,
  parseArgs,
  printJson,
  resolveDataRoot,
  resolveProjectRoot
} from "../src/cli.mjs";
import { parseFeedbackFile } from "../src/feedback_parser.mjs";
import { buildRevisionFromFeedback } from "../src/revision_builder.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const { guardrails } = await loadGuardrails(projectRoot, args);

try {
  const feedback = await resolveFeedback(args);
  const parsedFileFeedback = args.feedbackFile ? await parseFeedbackFile(path.resolve(args.feedbackFile)) : null;
  const requestId = await resolveRequestId({
    dataRoot,
    requestId: args.requestId,
    hint: parsedFileFeedback?.request_id_hint || ""
  });
  const requestDir = path.join(dataRoot, "outputs", "requests", requestId);
  const variantIndex = args.variant ? Number.parseInt(args.variant, 10) : parsedFileFeedback?.variant_index || null;

  const result = await buildRevisionFromFeedback({
    requestDir,
    feedback,
    variantIndex,
    guardrails,
    dryRun: args.dryRun !== false,
    generate: Boolean(args.generate),
    extraPrompt: args.extraPrompt || ""
  });

  printJson({
    ok: true,
    dry_run: args.dryRun !== false,
    request_id: requestId,
    revision_id: result.revision.revision_id,
    variant_index: result.revision.source.variant_index,
    policy_gate_status: result.revision.policy_gate_result.status,
    can_generate: result.revision.next_actions.can_generate,
    revision_prompt_path: result.paths.revisionPromptPath,
    chatwork_reply_dry_run_path: result.paths.chatworkReplyDryRunPath,
    revision_history_path: result.paths.revisionHistoryPath,
    note: args.generate
      ? "revised_prompt is ready. Built-in image_gen execution is performed by Codex, not this Node CLI."
      : "dry-run only; no image generation, Chatwork send, Drive upload, or Sheet write."
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || null }, null, 2));
  process.exitCode = 1;
}

async function resolveFeedback(args) {
  if (args.feedback) return String(args.feedback);
  if (args.feedbackFile) return fs.readFile(path.resolve(args.feedbackFile), "utf8");
  throw new Error("Provide --feedback or --feedback-file.");
}

async function resolveRequestId({ dataRoot, requestId, hint }) {
  if (requestId) return requestId;
  if (!hint) throw new Error("Provide --request-id or include request hint in feedback.");

  const root = path.join(dataRoot, "outputs", "requests");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const matches = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === hint || name.endsWith(hint));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`request hint is ambiguous: ${hint}`);
  throw new Error(`request was not found for hint: ${hint}`);
}
