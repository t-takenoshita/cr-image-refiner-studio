import {
  deleteSecureSetting,
  readSecureSetting,
  saveSecureSetting
} from "./image-history-db.js";

const CONFIG = Object.freeze({
  owner: "t-takenoshita",
  repo: "cr-image-refiner-studio",
  workflow: "generate-pages.yml",
  releaseTag: "cr-image-refiner-runtime",
  apiVersion: "2022-11-28"
});

const TOKEN_KEY = "crir_github_token";
const PASSWORD_KEY = "crir_site_password";
const TOKEN_VAULT_ID = "github-token-v1";
const TOKEN_VAULT_ITERATIONS = 310_000;
const BINARY_ITERATIONS = 210_000;
const BINARY_MAGIC = new TextEncoder().encode("CRIR1");

export function isPagesMode() {
  return window.location.hostname.endsWith(".github.io")
    || new URLSearchParams(window.location.search).get("pages-mode") === "1";
}

export function readGithubToken() {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

export function saveGithubToken(token) {
  sessionStorage.setItem(TOKEN_KEY, String(token || "").trim());
}

export function clearGithubToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function saveEncryptedGithubToken(token, password) {
  const normalized = String(token || "").trim();
  if (!normalized) throw new Error("GitHub tokenを入力してください。");
  if (!password) throw new Error("サイトパスワードが必要です。");
  const vault = await encryptSecret(normalized, password);
  await saveSecureSetting({ id: TOKEN_VAULT_ID, vault, updatedAt: Date.now() });
  saveGithubToken(normalized);
  return vault;
}

export async function restoreEncryptedGithubToken(password) {
  const current = readGithubToken();
  if (current) return current;
  if (!password) return "";
  const entry = await readSecureSetting(TOKEN_VAULT_ID);
  if (!entry?.vault) return "";
  const token = await decryptSecret(entry.vault, password);
  saveGithubToken(token);
  return token;
}

export async function deleteEncryptedGithubToken() {
  clearGithubToken();
  await deleteSecureSetting(TOKEN_VAULT_ID);
}

export async function exportEncryptedGithubToken() {
  const entry = await readSecureSetting(TOKEN_VAULT_ID);
  if (!entry?.vault) throw new Error("保存済みのGitHub tokenがありません。");
  return {
    format: "crir-github-connection",
    version: 1,
    exportedAt: new Date().toISOString(),
    vault: entry.vault
  };
}

export async function importEncryptedGithubToken(payload, password) {
  if (payload?.format !== "crir-github-connection" || payload?.version !== 1 || !payload?.vault) {
    throw new Error("CR Image Refinerの接続ファイルではありません。");
  }
  const token = await decryptSecret(payload.vault, password);
  await validateGithubToken(token);
  await saveSecureSetting({ id: TOKEN_VAULT_ID, vault: payload.vault, updatedAt: Date.now() });
  saveGithubToken(token);
  return token;
}

export function readSitePassword() {
  return sessionStorage.getItem(PASSWORD_KEY) || "";
}

export function saveSitePassword(password) {
  sessionStorage.setItem(PASSWORD_KEY, String(password || ""));
}

export function clearSitePassword() {
  sessionStorage.removeItem(PASSWORD_KEY);
}

export async function validateGithubToken(token) {
  const user = await githubJson("https://api.github.com/user", { token });
  if (user.login?.toLowerCase() !== CONFIG.owner.toLowerCase()) {
    throw new Error(`${CONFIG.owner}のGitHubトークンを入力してください。`);
  }
  await githubJson(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}`, { token });
  return user;
}

export async function dispatchPagesGeneration({ token, sitePassword, mode, payload, references = [] }) {
  if (!sitePassword) throw new Error("サイトパスワードを入力してください。");
  const requestId = crypto.randomUUID();
  const release = await ensureRuntimeRelease(token);
  const referenceBlobs = [];
  for (let index = 0; index < references.length; index += 1) {
    const blob = dataUrlToBlob(references[index]);
    referenceBlobs.push(await uploadEncryptedGitBlob({ token, password: sitePassword, blob }));
  }

  try {
    await githubJson(
      `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/actions/workflows/${CONFIG.workflow}/dispatches`,
      {
        method: "POST",
        token,
        body: {
          ref: "main",
          inputs: {
            request_id: requestId,
            mode,
            payload: await encryptPayload(payload, sitePassword),
            release_id: String(release.id),
            reference_blobs: JSON.stringify(referenceBlobs)
          }
        },
        allowEmpty: true
      }
    );
  } catch (error) { throw error; }

  return { requestId, releaseId: release.id, startedAt: Date.now() };
}

async function encryptPayload(payload, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 210_000;
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(payload))
  ));
  return JSON.stringify({
    v: 1,
    alg: "A256GCM",
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(encrypted)
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function encryptBinaryBytes(bytes, password, mime = "application/octet-stream") {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const mimeBytes = new TextEncoder().encode(String(mime || "application/octet-stream"));
  if (mimeBytes.length > 255) throw new Error("画像形式が不正です。");
  const key = await deriveBinaryKey(password, salt, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const envelope = new Uint8Array(5 + 16 + 12 + 1 + mimeBytes.length + encrypted.length);
  let offset = 0;
  envelope.set(BINARY_MAGIC, offset); offset += 5;
  envelope.set(salt, offset); offset += 16;
  envelope.set(iv, offset); offset += 12;
  envelope[offset] = mimeBytes.length; offset += 1;
  envelope.set(mimeBytes, offset); offset += mimeBytes.length;
  envelope.set(encrypted, offset);
  return envelope;
}

async function decryptBinaryBytes(envelope, password) {
  try {
    if (envelope.length < 50 || !BINARY_MAGIC.every((byte, index) => envelope[index] === byte)) {
      throw new Error("invalid binary envelope");
    }
    const salt = envelope.slice(5, 21);
    const iv = envelope.slice(21, 33);
    const mimeLength = envelope[33];
    const dataOffset = 34 + mimeLength;
    if (dataOffset + 16 > envelope.length) throw new Error("truncated binary envelope");
    const mime = new TextDecoder().decode(envelope.slice(34, dataOffset)) || "application/octet-stream";
    const key = await deriveBinaryKey(password, salt, ["decrypt"]);
    const bytes = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      envelope.slice(dataOffset)
    ));
    return { bytes, mime };
  } catch {
    throw new Error("生成画像を復号できません。再ログインしてからもう一度お試しください。");
  }
}

async function deriveBinaryKey(password, salt, usages) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: BINARY_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

async function encryptSecret(secret, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(password, salt, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secret)
  ));
  return {
    version: 1,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: TOKEN_VAULT_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(encrypted)
  };
}

async function decryptSecret(vault, password) {
  try {
    if (
      vault?.version !== 1
      || vault.algorithm !== "AES-GCM"
      || vault.kdf !== "PBKDF2-SHA256"
      || vault.iterations !== TOKEN_VAULT_ITERATIONS
    ) throw new Error("invalid vault");
    const salt = base64ToBytes(vault.salt);
    const iv = base64ToBytes(vault.iv);
    const key = await deriveVaultKey(password, salt, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      base64ToBytes(vault.data)
    );
    const token = new TextDecoder().decode(decrypted).trim();
    if (!token) throw new Error("empty token");
    return token;
  } catch {
    throw new Error("接続情報を復号できません。サイトパスワードまたは接続ファイルを確認してください。");
  }
}

async function deriveVaultKey(password, salt, usages) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: TOKEN_VAULT_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function waitForPagesGeneration({ token, sitePassword, job, signal, onStatus = () => {} }) {
  const deadline = Date.now() + 30 * 60 * 1000;
  let run = null;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const runs = await githubJson(
      `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/actions/workflows/${CONFIG.workflow}/runs?event=workflow_dispatch&per_page=30`,
      { token, signal }
    );
    run = runs.workflow_runs?.find((item) =>
      item.display_title?.includes(job.requestId)
      && new Date(item.created_at).getTime() >= job.startedAt - 60_000
    ) || null;

    if (!run) onStatus({ phase: "queued", message: "GitHub Actionsの開始を待っています…", progress: 18 });
    else if (run.status !== "completed") onStatus({ phase: run.status, message: "GitHub Actionsで画像を生成しています…", progress: 52 });
    else {
      onStatus({ phase: run.conclusion, message: "生成結果を受け取っています…", progress: 86 });
      const resultDeadline = run.conclusion === "success"
        ? deadline
        : Math.min(deadline, Date.now() + 20_000);
      let result;
      try {
        result = await waitForResultAsset({ token, sitePassword, job, signal, deadline: resultDeadline });
      } catch (error) {
        if (run.conclusion !== "success") {
          throw new Error(`GitHub Actionsが${run.conclusion || "失敗"}で終了しました。Actions画面でログを確認してください。`);
        }
        throw error;
      }
      if (result.status !== "completed") throw new Error(result.error || "画像生成に失敗しました。");
      const images = [];
      for (const image of result.images || []) {
        const decrypted = await downloadEncryptedGitBlob(token, image.blobSha, sitePassword, signal);
        const dataUrl = await blobToDataUrl(new Blob([decrypted.bytes], { type: decrypted.mime || image.mime || "image/png" }));
        images.push({ id: image.name, dataUrl, expiresAt: result.expiresAt });
      }
      onStatus({ phase: "completed", message: "生成が完了しました。", progress: 100 });
      return { ...result, images };
    }
    await delay(5000, signal);
  }
  throw new Error("生成結果の待機が30分を超えました。Actions画面で状態を確認してください。");
}

async function ensureRuntimeRelease(token) {
  const releases = await githubJson(
    `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/releases?per_page=100`,
    { token }
  );
  const existing = releases.find((release) => release.tag_name === CONFIG.releaseTag);
  if (existing) return existing;

  try {
    return await githubJson(
      `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/releases`,
      {
        method: "POST",
        token,
        body: {
          tag_name: CONFIG.releaseTag,
          target_commitish: "main",
          name: "CR Image Refiner temporary runtime",
          body: "Temporary reference images and generated results. Assets expire after 12 hours.",
          draft: true,
          prerelease: false
        }
      }
    );
  } catch (error) {
    const retry = await githubJson(
      `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/releases?per_page=100`,
      { token }
    );
    const created = retry.find((release) => release.tag_name === CONFIG.releaseTag);
    if (created) return created;
    throw error;
  }
}

async function waitForResultAsset({ token, sitePassword, job, signal, deadline }) {
  const markerPattern = new RegExp(`^crir-${job.requestId}-result-([a-f0-9]{40,64})\\.marker$`);
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const assets = await listReleaseAssets(token, job.releaseId, signal);
    const marker = assets.find((item) => markerPattern.test(item.name));
    if (marker) {
      const sha = marker.name.match(markerPattern)?.[1];
      const decrypted = await downloadEncryptedGitBlob(token, sha, sitePassword, signal);
      return JSON.parse(new TextDecoder().decode(decrypted.bytes));
    }
    await delay(3000, signal);
  }
  throw new Error("生成結果を取得できませんでした。");
}

async function uploadEncryptedGitBlob({ token, password, blob }) {
  const encrypted = await encryptBinaryBytes(new Uint8Array(await blob.arrayBuffer()), password, blob.type);
  const result = await githubJson(
    `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/git/blobs`,
    {
      method: "POST",
      token,
      body: { content: bytesToBase64(encrypted), encoding: "base64" }
    }
  );
  return result.sha;
}

async function listReleaseAssets(token, releaseId, signal) {
  return githubJson(
    `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/releases/${releaseId}/assets?per_page=100`,
    { token, signal }
  );
}

async function downloadEncryptedGitBlob(token, sha, password, signal) {
  if (!/^[a-f0-9]{40,64}$/i.test(String(sha || ""))) throw new Error("生成画像の識別子が不正です。");
  const result = await githubJson(
    `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/git/blobs/${encodeURIComponent(sha)}`,
    { token, signal }
  );
  if (result.encoding !== "base64" || !result.content) throw new Error("生成画像データを取得できませんでした。");
  return decryptBinaryBytes(base64ToBytes(String(result.content).replace(/\s+/g, "")), password);
}

async function githubJson(url, options = {}) {
  const response = await githubFetch(url, options);
  if (options.allowEmpty || response.status === 204) return null;
  return response.json();
}

async function githubFetch(url, options = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "X-GitHub-Api-Version": CONFIG.apiVersion,
    ...options.headers
  };
  if (options.body !== undefined && !options.rawBody) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined
      ? undefined
      : options.rawBody ? options.body : JSON.stringify(options.body),
    signal: options.signal
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text).message || text; } catch {}
    throw new Error(`GitHub API: ${message || `HTTP ${response.status}`}`);
  }
  return response;
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) throw new Error("参考画像の形式が不正です。");
  const mime = match[1] || "image/png";
  const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
