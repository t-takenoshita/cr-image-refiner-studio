#!/usr/bin/env node
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  parseArgs,
  printJson,
  resolveDataRoot,
  resolveProjectRoot
} from "../src/cli.mjs";
import {
  messageIdAfter,
  parseChatworkFeedbackMessages
} from "../src/chatwork_feedback_parser.mjs";
import { writeJson } from "../src/manifest.mjs";

const DEFAULT_CHATWORK_API_BASE = "https://api.chatwork.com/v2";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);

try {
  const requestId = String(args.requestId || "").trim();
  if (!requestId) throw new Error("Provide --request-id.");

  const requestDir = path.join(dataRoot, "outputs", "requests", requestId);
  const feedbackDir = path.join(requestDir, "feedback");
  const sinceMessageId = String(args.sinceMessageId || (await defaultSinceMessageId(requestDir)) || "").trim();
  const roomId = String(args.roomId || process.env.CHATWORK_ROOM_ID || "").trim();
  const capturedAt = new Date().toISOString();
  const safeStamp = capturedAt.replace(/[:.]/g, "-");
  const rawOutPath = path.resolve(args.rawOut || path.join(feedbackDir, `raw_chatwork_messages_${safeStamp}.json`));
  const parsedOutPath = path.resolve(args.out || path.join(feedbackDir, `parsed_feedback_${safeStamp}.json`));
  const latestOutPath = path.join(feedbackDir, "parsed_feedback_latest.json");

  loadEnvFile(args.envFile || process.env.CHATWORK_ENV_FILE || "");
  const token = process.env.CHATWORK_API_TOKEN || "";
  const messages = args.fixtureJson
    ? await readFixtureMessages(path.resolve(args.fixtureJson))
    : await fetchChatworkMessages({
        roomId,
        token,
        force: args.force !== false,
        baseUrl: String(args.apiBase || DEFAULT_CHATWORK_API_BASE)
      });
  const filteredMessages = messages
    .filter((message) => messageIdAfter(message.message_id, sinceMessageId))
    .slice(-Number(args.limit || 100));
  const parsed = parseChatworkFeedbackMessages(filteredMessages, { requestId });
  const raw = {
    schema_version: "aicr-chatwork-feedback-raw-v1",
    captured_at: capturedAt,
    source: args.fixtureJson ? "fixture_json" : "chatwork_api_readonly",
    room_id_present: Boolean(roomId),
    request_id: requestId,
    since_message_id: sinceMessageId,
    message_count: filteredMessages.length,
    messages: filteredMessages
  };

  await writeJson(rawOutPath, raw);
  await writeJson(parsedOutPath, {
    ...parsed,
    source: {
      room_id_present: Boolean(roomId),
      raw_messages_path: rawOutPath,
      source_type: raw.source,
      captured_at: capturedAt,
      messages_checked: filteredMessages.length,
      since_message_id: sinceMessageId
    }
  });
  await writeJson(latestOutPath, {
    ...parsed,
    source: {
      room_id_present: Boolean(roomId),
      raw_messages_path: rawOutPath,
      source_type: raw.source,
      captured_at: capturedAt,
      messages_checked: filteredMessages.length,
      since_message_id: sinceMessageId
    }
  });

  printJson({
    ok: true,
    request_id: requestId,
    source: raw.source,
    messages_checked: filteredMessages.length,
    feedback_count: parsed.feedback_count,
    raw_messages_path: rawOutPath,
    parsed_feedback_path: parsedOutPath,
    latest_feedback_path: latestOutPath,
    routing: parsed.feedback_items.map((item) => ({
      message_id: item.message_id,
      feedback_text: item.feedback_text,
      resolved_variant_index: item.resolved_variant_index,
      resolved_variant_indexes: item.resolved_variant_indexes,
      candidate_variant_indexes: item.candidate_variant_indexes,
      routing_status: item.routing_status,
      can_build_revision_prompt: item.can_build_revision_prompt
    }))
  });
} catch (error) {
  const token = process.env.CHATWORK_API_TOKEN || "";
  const message = token ? String(error?.message || error).replaceAll(token, "[redacted]") : String(error?.message || error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
}

async function defaultSinceMessageId(requestDir) {
  const delivery = await readJson(path.join(requestDir, "delivery_result.json")).catch(() => null);
  if (delivery?.message_id) return String(delivery.message_id);
  const manifest = await readJson(path.join(requestDir, "manifest.json")).catch(() => null);
  return manifest?.chatwork_message_id ? String(manifest.chatwork_message_id) : "";
}

async function fetchChatworkMessages({ roomId, token, force, baseUrl }) {
  if (!roomId) throw new Error("CHATWORK_ROOM_ID is missing. Pass --room-id or set it in a local env file.");
  if (!token) throw new Error("CHATWORK_API_TOKEN is missing. Pass --env-file or set it locally. Do not paste it in chat.");

  const url = new URL(`${baseUrl}/rooms/${encodeURIComponent(roomId)}/messages`);
  url.searchParams.set("force", force ? "1" : "0");
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-ChatWorkToken": token
    }
  });
  if (response.status === 204) return [];
  const text = await response.text();
  if (!response.ok) throw new Error(`Chatwork messages fetch failed ${response.status}: ${text.slice(0, 240)}`);
  const payload = text ? JSON.parse(text) : [];
  if (!Array.isArray(payload)) throw new Error("Chatwork messages response was not an array.");
  return payload.map(sanitizeMessage);
}

async function readFixtureMessages(filePath) {
  const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
  const rows = Array.isArray(payload) ? payload : payload.messages;
  if (!Array.isArray(rows)) throw new Error("Fixture must be an array or { messages: [...] }.");
  return rows.map(sanitizeMessage);
}

function sanitizeMessage(message) {
  return {
    message_id: String(message.message_id || ""),
    account_id: message.account?.account_id ?? message.account_id ?? "",
    account_name: message.account?.name ?? message.account_name ?? "",
    send_time: message.send_time ?? "",
    update_time: message.update_time ?? "",
    body: String(message.body || ""),
    account: message.account || undefined
  };
}

function loadEnvFile(filePath) {
  if (!filePath) return false;
  if (!fsSync.existsSync(filePath)) return false;
  const text = fsSync.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
