import fs from "node:fs/promises";
import path from "node:path";

export function buildInitialDraftChatworkPayload(options = {}) {
  const promptPack = options.promptPack || {};
  const summary = promptPack.request_summary || {};
  const images = options.images || [];
  const toAll = options.toAll !== false;
  const mention = options.mention?.tag || "";
  const policy = options.policyStatus || promptPack.request_policy_gate_result?.status || "unknown";
  const humanReviewed = Boolean(options.humanReviewed);
  const policyNote =
    policy === "hold" && humanReviewed
      ? "審査注意: policy_holdを人間確認済みとして初稿送信しています。"
      : "";

  const lines = [
    mention || (toAll ? "[toall]" : ""),
    `AICR Factory 初稿生成完了 / ${summary.project_name || promptPack.request_id || ""}`,
    `request_id: ${promptPack.request_id || ""}`,
    `CR案: ${summary.creative_title || ""}`,
    `ターゲット: ${summary.target_audience || ""}`,
    `訴求: ${summary.appeal || ""}`,
    `オファー: ${summary.offer || ""}`,
    `選択ロゴ: ${summary.logo_selection || "なし"}`,
    `policy_gate: ${policy}`,
    policyNote,
    "",
    "画像対応:",
    ...images.map((image) => `画像${image.variant_index}: ${image.variant_id || image.revision_id || path.basename(image.local_path || "")}`),
    "",
    "FBは「画像1: 〜」の形で返してください。",
    "修正対応は自動再生成せず、パース後に人間確認で止めます。"
  ];

  return {
    schema_version: "aicr-initial-draft-chatwork-payload-v1",
    request_id: promptPack.request_id || "",
    message: lines.filter((line, index) => line || index === 0).join("\n").trim(),
    files: images.map((image) => image.local_path).filter(Boolean)
  };
}

export async function sendChatworkDelivery(options = {}) {
  const roomId = options.roomId || process.env.CHATWORK_ROOM_ID || "";
  const token = options.token || process.env.CHATWORK_API_TOKEN || "";
  if (!roomId) throw new Error("CHATWORK_ROOM_ID is missing.");
  if (!token) throw new Error("CHATWORK_API_TOKEN is missing. Token value was not read or displayed.");
  if (!options.message?.trim()) throw new Error("Chatwork message is required.");

  const fetchImpl = options.fetchImpl || fetch;
  const postedMessage = await postMessage({
    roomId,
    token,
    body: options.message,
    fetchImpl
  });
  const postedFiles = [];
  for (const file of options.files || []) {
    postedFiles.push(await postFile({
      roomId,
      token,
      file,
      message: `添付: ${path.basename(file)}`,
      fetchImpl
    }));
  }

  return {
    ok: true,
    postedMessage,
    postedFiles,
    message_id: String(postedMessage.message_id || ""),
    file_ids: postedFiles.map((file) => file.file_id).filter((value) => value !== undefined)
  };
}

async function postMessage({ roomId, token, body, fetchImpl }) {
  const response = await fetchImpl(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
    method: "POST",
    headers: {
      "X-ChatWorkToken": token,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ body })
  });
  return parseChatworkResponse(response, token, "message post");
}

async function postFile({ roomId, token, file, message, fetchImpl }) {
  const bytes = await fs.readFile(file);
  const form = new FormData();
  form.set("file", new Blob([bytes]), path.basename(file));
  if (message) form.set("message", message);
  const response = await fetchImpl(`https://api.chatwork.com/v2/rooms/${roomId}/files`, {
    method: "POST",
    headers: {
      "X-ChatWorkToken": token
    },
    body: form
  });
  return parseChatworkResponse(response, token, "file post");
}

async function parseChatworkResponse(response, token, label) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Chatwork ${label} failed ${response.status}: ${String(text).replaceAll(token, "[redacted]").slice(0, 240)}`);
  }
  return payload;
}
