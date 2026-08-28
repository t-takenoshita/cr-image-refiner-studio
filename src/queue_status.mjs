import fs from "node:fs/promises";
import path from "node:path";
import { getRequestOutputDir } from "./manifest.mjs";
import { isProcessableStatus, normalizeRequestRow, normalizeStatus } from "./request_schema.mjs";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export async function buildQueueEntries(rows, options = {}) {
  const entries = [];

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = options.firstDataRowNumber ? options.firstDataRowNumber + index : index + 2;
    const request = normalizeRequestRow(rows[index], {
      rowNumber,
      sourceKind: options.sourceKind || "csv",
      fixturePath: options.fixturePath || null,
      sheetId: options.sheetId || null,
      gid: options.gid || null,
      now: options.now
    });
    const artifacts = await inspectRequestArtifacts(options.dataRoot, request.request_id);
    entries.push({
      row: rows[index],
      row_index: index,
      row_number: rowNumber,
      request,
      artifacts,
      queue_status: buildQueueStatus(request, artifacts)
    });
  }

  return entries;
}

export function selectQueueEntries(entries, options = {}) {
  const onlyNew = Boolean(options.onlyNew);
  const statuses = parseStatusFilter(options.statuses);
  const limit = Number.parseInt(options.limit || String(entries.length), 10);

  return entries
    .filter((entry) => {
      if (statuses.length > 0 && !statuses.includes(normalizeStatus(entry.request.status))) return false;
      if (statuses.length === 0 && !isProcessableStatus(entry.request.status)) return false;
      if (onlyNew && entry.queue_status.already_seen) return false;
      return true;
    })
    .slice(0, Number.isFinite(limit) ? limit : entries.length);
}

export function summarizeQueueEntries(entries) {
  return entries.map((entry) => ({
    row_number: entry.row_number,
    request_id: entry.request.request_id,
    status: entry.request.status,
    processable_status: isProcessableStatus(entry.request.status),
    processing_state: entry.queue_status.processing_state,
    already_seen: entry.queue_status.already_seen,
    already_generated: entry.queue_status.already_generated,
    already_posted: entry.queue_status.already_posted,
    failed: entry.queue_status.failed,
    project_name: entry.request.project.name,
    creative_title: entry.request.creative_title,
    requester_name: entry.request.requester.name,
    submitted_at: entry.request.submitted_at,
    policy_recheck_required: entry.queue_status.policy_recheck_required,
    artifacts: {
      output_dir: entry.artifacts.output_dir,
      manifest_json: entry.artifacts.manifest_path,
      prompt_pack_json: entry.artifacts.prompt_pack_path,
      image_count: entry.artifacts.image_count,
      generated_variant_count: entry.artifacts.generated_variant_count,
      expected_image_count: entry.artifacts.expected_image_count,
      delivery_result_json: entry.artifacts.delivery_result_path
    }
  }));
}

export async function inspectRequestArtifacts(dataRoot, requestId) {
  const outputDir = getRequestOutputDir(dataRoot, requestId);
  const manifestPath = path.join(outputDir, "manifest.json");
  const promptPackPath = path.join(outputDir, "prompt_pack.json");
  const deliveryResultPath = path.join(outputDir, "delivery_result.json");
  const imagesDir = path.join(outputDir, "images");
  const manifest = await readJsonIfExists(manifestPath);
  const promptPack = await readJsonIfExists(promptPackPath);
  const deliveryResult = await readJsonIfExists(deliveryResultPath);
  const imageCount = await countImageFiles(imagesDir);
  const generatedVariantCount = await countGeneratedImageVariants(imagesDir);
  const expectedImageCount = Array.isArray(promptPack?.variants) ? promptPack.variants.length : 4;

  return {
    output_dir: outputDir,
    manifest_path: manifest ? manifestPath : null,
    prompt_pack_path: promptPack ? promptPackPath : null,
    delivery_result_path: deliveryResult ? deliveryResultPath : null,
    manifest_status: manifest?.status || null,
    manifest_run_status: manifest?.run_status || null,
    chatwork_message_id: deliveryResult?.message_id || manifest?.chatwork_message_id || null,
    image_count: imageCount,
    generated_variant_count: generatedVariantCount,
    expected_image_count: expectedImageCount
  };
}

function buildQueueStatus(request, artifacts) {
  const alreadyPrompted = Boolean(artifacts.prompt_pack_path || artifacts.manifest_path);
  const expectedImageCount = artifacts.expected_image_count || 4;
  const generatedCount = artifacts.generated_variant_count ?? artifacts.image_count;
  const alreadyGenerated = generatedCount >= expectedImageCount || ["generated", "posted", "done"].includes(artifacts.manifest_status);
  const alreadyPosted = Boolean(artifacts.delivery_result_path || artifacts.chatwork_message_id || artifacts.manifest_status === "posted");
  const failed = artifacts.manifest_status === "error" || isFailedRunStatus(artifacts.manifest_run_status);
  let processingState = "unseen";

  if (alreadyPosted) processingState = "posted";
  else if (alreadyGenerated) processingState = "generated";
  else if (failed) processingState = "failed";
  else if (alreadyPrompted) processingState = "prompted";

  return {
    already_seen: alreadyPrompted || alreadyGenerated || alreadyPosted,
    already_generated: alreadyGenerated,
    already_posted: alreadyPosted,
    failed,
    processing_state: processingState,
    policy_recheck_required: request.status === "error" || request.status === "needs_revision"
  };
}

function isFailedRunStatus(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized.includes("failed") || normalized.includes("rejected") || normalized.includes("blocked");
}

function parseStatusFilter(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return raw.map((item) => normalizeStatus(item)).filter(Boolean);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function countImageFiles(dirPath) {
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    return dirents.filter((dirent) => dirent.isFile() && IMAGE_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    return 0;
  }
}

async function countGeneratedImageVariants(dirPath) {
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    const indexes = new Set();
    for (const dirent of dirents) {
      if (!dirent.isFile() || !IMAGE_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) continue;
      const match = dirent.name.match(/^variant_(\d+)_/);
      if (match) indexes.add(match[1]);
    }
    return indexes.size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    return 0;
  }
}
