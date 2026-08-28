import fs from "node:fs/promises";
import path from "node:path";
import { buildWebPlan } from "../src/web_plan.mjs";
import { generateImage2File } from "../src/image2_api.mjs";
import {
  decryptPagesBytes,
  decryptPagesPayload,
  encryptPagesBytes
} from "../src/pages_payload_crypto.mjs";
import {
  createGitBlob,
  downloadGitBlob,
  githubRepository,
  replaceReleaseAsset
} from "../src/github_release_runtime.mjs";

const token = process.env.GITHUB_TOKEN || "";
const apiKey = process.env.OPENAI_API_KEY || "";
const sitePassword = process.env.SITE_PASSWORD || "";
const releaseId = Number(process.env.INPUT_RELEASE_ID || 0);
const requestId = safeRequestId(process.env.INPUT_REQUEST_ID || "");
const mode = process.env.INPUT_MODE === "free" ? "free" : "article";
const payload = decryptPagesPayload(process.env.INPUT_PAYLOAD, sitePassword);
const referenceBlobs = parseJson(process.env.INPUT_REFERENCE_BLOBS, []);
const { owner, repo } = githubRepository();
const workRoot = path.resolve(".runtime", "github-pages", requestId);
if (!token) throw new Error("GITHUB_TOKEN is missing.");
if (!apiKey) throw new Error("OPENAI_API_KEY repository secret is missing.");
if (!sitePassword) throw new Error("SITE_PASSWORD repository secret is missing.");
if (!releaseId) throw new Error("release_id is missing.");

await fs.mkdir(workRoot, { recursive: true });

try {
  const referencePaths = [];
  for (let index = 0; index < referenceBlobs.length; index += 1) {
    const encrypted = await downloadGitBlob({ owner, repo, sha: safeBlobSha(referenceBlobs[index]), token });
    const { bytes, mime } = decryptPagesBytes(encrypted, sitePassword);
    const localPath = path.join(workRoot, `reference-${index + 1}.${extensionForMime(mime)}`);
    await fs.writeFile(localPath, bytes);
    referencePaths.push(localPath);
  }

  const prompts = await promptsForJob(mode, payload);
  const generatedAssets = [];
  for (let index = 0; index < prompts.length; index += 1) {
    const outputPath = path.join(workRoot, `image-${index + 1}.png`);
    await generateImage2File({
      apiKey,
      prompt: prompts[index],
      outputPath,
      inputImages: referencePaths,
      config: { quality: "medium", size: "1088x1088", final_size: "1080x1080" }
    });
    const name = `crir-${requestId}-image-${index + 1}.png`;
    const blob = await createGitBlob({
      owner,
      repo,
      bytes: encryptPagesBytes(await fs.readFile(outputPath), sitePassword, "image/png"),
      token
    });
    generatedAssets.push({ id: name, name, blobSha: blob.sha, mime: "image/png" });
  }

  const createdAt = new Date();
  const result = {
    requestId,
    mode,
    status: "completed",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    images: generatedAssets
  };
  const manifest = await createGitBlob({
    owner,
    repo,
    bytes: encryptPagesBytes(Buffer.from(JSON.stringify(result)), sitePassword, "application/json"),
    token
  });
  await uploadResultMarker(manifest.sha);
  console.log(`Generated ${generatedAssets.length} image(s) for ${requestId}.`);
} catch (error) {
  const failed = {
    requestId,
    mode,
    status: "failed",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    error: safeError(error)
  };
  try {
    const manifest = await createGitBlob({
      owner,
      repo,
      bytes: encryptPagesBytes(Buffer.from(JSON.stringify(failed)), sitePassword, "application/json"),
      token
    });
    await uploadResultMarker(manifest.sha);
  } catch (uploadError) {
    console.error(`Could not upload failure result: ${safeError(uploadError)}`);
  }
  throw error;
} finally {
  await fs.rm(workRoot, { recursive: true, force: true });
}

async function uploadResultMarker(manifestSha) {
  await replaceReleaseAsset({
    owner,
    repo,
    releaseId,
    name: `crir-${requestId}-result-${safeBlobSha(manifestSha)}.marker`,
    bytes: Buffer.from("CRIR"),
    contentType: "application/octet-stream",
    token
  });
}

async function promptsForJob(jobMode, jobPayload) {
  if (jobMode === "free") {
    const prompt = String(jobPayload.prompt || "").trim();
    if (!prompt) throw new Error("prompt is required.");
    const count = Math.min(4, Math.max(1, Number(jobPayload.count || 1)));
    return Array.from({ length: count }, (_, index) =>
      `${prompt}\n案${index + 1}: 同じ要件を守りながら、構図・視線導線・背景表現を他案と明確に変える。`
    );
  }

  const plan = await buildWebPlan(jobPayload.form || {}, { sourceKind: "github-pages" });
  const comment = String(jobPayload.comment || "").trim();
  return plan.variants.map((variant) =>
    `${variant.prompt}${comment ? `\n追加コメント: ${comment}` : ""}`
  );
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("workflow input JSON is invalid.");
  }
}

function safeRequestId(value) {
  const normalized = String(value).trim();
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(normalized)) throw new Error("request_id is invalid.");
  return normalized;
}

function safeBlobSha(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(normalized)) throw new Error("Git blob SHA is invalid.");
  return normalized;
}

function extensionForMime(mime) {
  if (String(mime).includes("jpeg")) return "jpg";
  if (String(mime).includes("webp")) return "webp";
  if (String(mime).includes("gif")) return "gif";
  return "png";
}

function safeError(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 500);
}
