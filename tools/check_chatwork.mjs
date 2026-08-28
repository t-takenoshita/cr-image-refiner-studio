import { parseArgs, printJson } from "../src/cli.mjs";
import { loadEnvFile } from "../src/env_file.mjs";
import { sendChatworkDelivery } from "../src/chatwork_delivery.mjs";

const args = parseArgs();
loadEnvFile(args.envFile || process.env.CHATWORK_ENV_FILE || "");

const roomId = String(args.roomId || process.env.CHATWORK_ROOM_ID || "").trim();
const token = String(process.env.CHATWORK_API_TOKEN || "").trim();

if (!roomId) throw new Error("CHATWORK_ROOM_ID is missing.");
if (!token) throw new Error("CHATWORK_API_TOKEN is missing. Token value was not read or displayed.");

if (args.send) {
  const result = await sendChatworkDelivery({
    roomId,
    token,
    message: String(args.message || "テスト")
  });
  printJson({
    connected: true,
    sent: true,
    room_id: roomId,
    message_id: result.message_id
  });
} else {
  const response = await fetch(`https://api.chatwork.com/v2/rooms/${encodeURIComponent(roomId)}`, {
    headers: { "X-ChatWorkToken": token }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Chatwork room check failed ${response.status}: ${text.replaceAll(token, "[redacted]").slice(0, 240)}`
    );
  }
  const room = text ? JSON.parse(text) : {};
  printJson({
    connected: true,
    sent: false,
    room_id: String(room.room_id || roomId),
    name: room.name || ""
  });
}
