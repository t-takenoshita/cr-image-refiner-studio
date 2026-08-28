import { MANAGEMENT_COLUMNS } from "./request_schema.mjs";

export function buildSheetStatusUpdate(options = {}) {
  const request = options.request;
  if (!request) throw new Error("request is required.");

  const now = options.now ? new Date(options.now) : new Date();
  const artifacts = options.artifacts || {};
  const nextStatus = options.status || request.status;
  const updates = {
    request_id: request.request_id,
    status: nextStatus
  };

  if (options.priority) updates.priority = options.priority;
  if (options.lockedAt) updates.locked_at = options.lockedAt;
  if (options.lockedBy) updates.locked_by = options.lockedBy;
  if (options.generatedAt) updates.generated_at = options.generatedAt;
  if (artifacts.drive_folder_url) updates.drive_folder_url = artifacts.drive_folder_url;
  for (let index = 0; index < 4; index += 1) {
    const imageUrl = artifacts.image_urls?.[index];
    if (imageUrl) updates[`image_${index + 1}_url`] = imageUrl;
  }
  if (artifacts.chatwork_message_id) updates.chatwork_message_id = artifacts.chatwork_message_id;
  if (options.errorMessage !== undefined) updates.error_message = options.errorMessage;

  const retryCount = Number.parseInt(request.raw?.retry_count ?? request.counters?.retry_count ?? 0, 10) || 0;
  const revisionCount = Number.parseInt(request.raw?.revision_count ?? request.counters?.revision_count ?? 0, 10) || 0;
  updates.retry_count = nextStatus === "error" ? retryCount + 1 : retryCount;
  updates.revision_count = nextStatus === "needs_revision" ? revisionCount + 1 : revisionCount;

  if (options.adoptionStatus !== undefined) updates.adoption_status = options.adoptionStatus;
  if (options.feedback !== undefined) updates.feedback = options.feedback;

  return {
    schema_version: "aicr-sheet-update-v1",
    dry_run: Boolean(options.dryRun ?? true),
    generated_at: now.toISOString(),
    target: {
      source: request.source,
      key_column: "request_id",
      key_value: request.request_id
    },
    columns: MANAGEMENT_COLUMNS,
    updates,
    diff: buildDiff(request.raw || {}, updates)
  };
}

function buildDiff(rawRow, updates) {
  return Object.entries(updates).map(([column, next]) => ({
    column,
    before: rawRow[column] ?? "",
    after: next
  }));
}
