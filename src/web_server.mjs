import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRequestRow } from "./request_schema.mjs";
import { buildPromptPack } from "./prompt_builder.mjs";
import { generateImage2File } from "./image2_api.mjs";
import {
  clearSessionCookie,
  createSessionCookie,
  isAuthenticated,
  isValidPassword
} from "./web_auth.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = path.join(PROJECT_ROOT, "web");
const OUTPUT_ROOT = path.join(PROJECT_ROOT, ".runtime", "generated");

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(path.join(PROJECT_ROOT, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const PORT = Number(process.env.PORT || 3000);
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const MAX_BODY_BYTES = 28 * 1024 * 1024;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;
const loginAttempts = new Map();

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"]
]);

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const text = await readBody(request);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("JSONの形式が不正です。"), { status: 400 });
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("送信データが大きすぎます。"), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

function sendRedirect(response, location, headers = {}) {
  response.writeHead(303, { Location: location, "Cache-Control": "no-store", ...headers });
  response.end();
}

function isSecureRequest(request) {
  return Boolean(request.socket.encrypted) || request.headers["x-forwarded-proto"] === "https";
}

function loginClientId(request) {
  return request.socket.remoteAddress || "unknown";
}

function loginAttemptState(clientId) {
  const now = Date.now();
  const current = loginAttempts.get(clientId);
  if (!current || now - current.startedAt > LOGIN_WINDOW_MS) {
    const fresh = { count: 0, startedAt: now };
    loginAttempts.set(clientId, fresh);
    return fresh;
  }
  return current;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

async function serveLogin(response, errorMessage = "", status = 200) {
  const template = await fs.readFile(path.join(WEB_ROOT, "login.html"), "utf8");
  const content = template.replace("{{ERROR}}", escapeHtml(errorMessage));
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  response.end(content);
}

async function handleLogin(request, response, pathname) {
  const secure = isSecureRequest(request);
  if (pathname === "/login" && request.method === "GET") {
    if (isAuthenticated(request.headers, SITE_PASSWORD)) sendRedirect(response, "/studio");
    else await serveLogin(response);
    return true;
  }

  if (pathname === "/login" && request.method === "POST") {
    const clientId = loginClientId(request);
    const attempts = loginAttemptState(clientId);
    if (attempts.count >= LOGIN_ATTEMPT_LIMIT) {
      await serveLogin(response, "入力回数が多すぎます。10分ほど待ってから再度お試しください。", 429);
      return true;
    }
    const form = new URLSearchParams(await readBody(request));
    if (!isValidPassword(form.get("password"), SITE_PASSWORD)) {
      attempts.count += 1;
      await serveLogin(response, "パスワードが違います。", 401);
      return true;
    }
    loginAttempts.delete(clientId);
    sendRedirect(response, "/studio", { "Set-Cookie": createSessionCookie(SITE_PASSWORD, { secure }) });
    return true;
  }

  if (pathname === "/logout" && request.method === "POST") {
    sendRedirect(response, "/login", { "Set-Cookie": clearSessionCookie({ secure }) });
    return true;
  }

  return false;
}

function requestRowFromWeb(body = {}) {
  return {
    タイムスタンプ: new Date().toISOString(),
    依頼者名: body.requester || "Webユーザー",
    案件名: body.projectName || body.articleTitle || "Web画像制作",
    商材: body.product || body.articleTitle || "記事内商材",
    媒体: body.media || "記事LP",
    ターゲット: body.targetAudience || "記事を閲覧する見込みユーザー",
    インサイト: body.problem || body.audienceInsight || "",
    訴求軸: body.appeal || body.direction || "依頼内容に沿った訴求",
    オファー: body.offer || "",
    必須コピー: body.requiredCopy || "",
    希望テイスト: body.tone || body.direction || "清潔感、信頼感、スマホで見やすい",
    入れたいビジュアル要素: body.visualElements || "",
    "LP URL": body.landingPageUrl || "",
    "NG表現": body.ngExpressions || "",
    備考: body.notes || "Web完結型CR Image Refinerからの依頼"
  };
}

async function buildWebPlan(body) {
  const request = normalizeRequestRow(requestRowFromWeb(body), { sourceKind: "web" });
  const promptPack = await buildPromptPack(request, { now: new Date() });
  return {
    requestId: request.request_id,
    warnings: request.validation.warnings,
    summary: promptPack.request_summary,
    variants: promptPack.variants.map((variant) => ({
      id: variant.variant_id,
      index: variant.variant_index,
      prompt: variant.prompt,
      tags: variant.generation_tags,
      textContract: variant.text_contract
    }))
  };
}

async function generateOne({ prompt, references, apiKey, index = 1 }) {
  const stamp = `${Date.now()}-${index}-${Math.random().toString(16).slice(2, 8)}`;
  const outputPath = path.join(OUTPUT_ROOT, `${stamp}.png`);
  await generateImage2File({
    apiKey,
    prompt,
    outputPath,
    inputImages: (references || []).slice(0, 4),
    config: { quality: "medium", size: "1088x1088", final_size: "1080x1080" }
  });
  const bytes = await fs.readFile(outputPath);
  return { id: stamp, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, app: "CR Image Refiner", mode: "standalone-web" });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/plan") {
    const body = await readJson(request);
    sendJson(response, 200, await buildWebPlan(body));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/generate") {
    const body = await readJson(request);
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) throw Object.assign(new Error(".env に OPENAI_API_KEY を設定してサーバーを再起動してください。"), { status: 401 });
    if (!body.prompt?.trim()) throw Object.assign(new Error("生成指示を入力してください。"), { status: 400 });
    const count = Math.min(4, Math.max(1, Number(body.count || 1)));
    const images = [];
    for (let index = 1; index <= count; index += 1) {
      const result = await generateOne({
        prompt: `${body.prompt}\n案${index}: 同じ要件を守りながら、構図・視線導線・背景表現を他案と明確に変える。`,
        references: body.references,
        apiKey,
        index
      });
      images.push(result);
    }
    sendJson(response, 200, { images });
    return true;
  }

  return false;
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" || pathname === "/studio" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(requested);
  const staticRoot = decoded === "/tokens.css" ? PROJECT_ROOT : WEB_ROOT;
  const filePath = path.resolve(staticRoot, `.${decoded}`);
  if (!filePath.startsWith(staticRoot + path.sep)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME.get(path.extname(filePath)) || "application/octet-stream",
      "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") sendJson(response, 404, { error: "Not found" });
    else throw error;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `localhost:${PORT}`}`);
    if (await handleLogin(request, response, url.pathname)) return;
    if (request.method === "GET" && ["/styles.css", "/tokens.css"].includes(url.pathname)) {
      await serveStatic(response, url.pathname);
      return;
    }
    if (!isAuthenticated(request.headers, SITE_PASSWORD)) {
      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 401, { error: "ログインが必要です。", loginRequired: true });
      } else {
        sendRedirect(response, "/login");
      }
      return;
    }
    if (await handleApi(request, response, url.pathname)) return;
    if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed" });
    await serveStatic(response, url.pathname);
  } catch (error) {
    console.error("[web]", error.message);
    sendJson(response, error.status || 500, { error: error.message || "サーバーエラーが発生しました。" });
  }
});

if (!SITE_PASSWORD) {
  throw new Error(".env に SITE_PASSWORD を設定してください。");
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`CR Image Refiner: http://localhost:${PORT}/studio`);
  console.log("Standalone web mode: Google Forms / Sheets / Chatwork / GitHub Actions are not used.");
});
