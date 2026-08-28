const CONFIG = Object.freeze({
  owner: "t-takenoshitatakumi",
  repo: "cr-image-refiner-studio",
  workflow: "generate-pages.yml",
  releaseTag: "cr-image-refiner-runtime",
  apiVersion: "2022-11-28"
});

const TOKEN_KEY = "crir_github_token";
const PASSWORD_KEY = "crir_site_password";

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
  const referenceAssets = [];
  try {
    for (let index = 0; index < references.length; index += 1) {
      const blob = dataUrlToBlob(references[index]);
      const extension = extensionForMime(blob.type);
      const name = `crir-${requestId}-reference-${index + 1}.${extension}`;
      await uploadReleaseAsset({ token, releaseId: release.id, name, blob });
      referenceAssets.push(name);
    }

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
            reference_assets: JSON.stringify(referenceAssets)
          }
        },
        allowEmpty: true
      }
    );
  } catch (error) {
    await deleteNamedAssets(token, release.id, referenceAssets).catch(() => {});
    throw error;
  }

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
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function waitForPagesGeneration({ token, job, signal, onStatus = () => {} }) {
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
        result = await waitForResultAsset({ token, job, signal, deadline: resultDeadline });
      } catch (error) {
        if (run.conclusion !== "success") {
          throw new Error(`GitHub Actionsが${run.conclusion || "失敗"}で終了しました。Actions画面でログを確認してください。`);
        }
        throw error;
      }
      if (result.status !== "completed") throw new Error(result.error || "画像生成に失敗しました。");
      const images = [];
      for (const image of result.images || []) {
        const dataUrl = await downloadAssetAsDataUrl(token, image.apiUrl, signal);
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

async function waitForResultAsset({ token, job, signal, deadline }) {
  const name = `crir-${job.requestId}-result.json`;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const assets = await listReleaseAssets(token, job.releaseId, signal);
    const asset = assets.find((item) => item.name === name);
    if (asset) {
      const response = await githubFetch(asset.url, {
        token,
        signal,
        headers: { Accept: "application/octet-stream" }
      });
      return response.json();
    }
    await delay(3000, signal);
  }
  throw new Error("生成結果を取得できませんでした。");
}

async function uploadReleaseAsset({ token, releaseId, name, blob }) {
  return githubJson(
    `https://uploads.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      token,
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
      rawBody: true
    }
  );
}

async function deleteNamedAssets(token, releaseId, names) {
  const assets = await listReleaseAssets(token, releaseId);
  for (const asset of assets.filter((item) => names.includes(item.name))) {
    await githubJson(
      `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/releases/assets/${asset.id}`,
      { method: "DELETE", token, allowEmpty: true }
    );
  }
}

async function listReleaseAssets(token, releaseId, signal) {
  return githubJson(
    `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/releases/${releaseId}/assets?per_page=100`,
    { token, signal }
  );
}

async function downloadAssetAsDataUrl(token, apiUrl, signal) {
  const response = await githubFetch(apiUrl, {
    token,
    signal,
    headers: { Accept: "application/octet-stream" }
  });
  return blobToDataUrl(await response.blob());
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

function extensionForMime(mime) {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
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
