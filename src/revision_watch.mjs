export function normalizeFeedbackText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function feedbackAlreadyHandled(item, state = {}, history = {}) {
  const messageId = stringValue(item.message_id);
  const variantIndex = Number(item.resolved_variant_index || item.resolved_variant_indexes?.[0] || 0);
  const feedbackText = normalizeFeedbackText(item.feedback_text);

  if (messageId) {
    const processedByMessage = (state.processed_feedback_items || []).some(
      (entry) => stringValue(entry.message_id) === messageId
    );
    if (processedByMessage) return true;

    const blockedByMessage = (state.blocked_feedback_items || []).some(
      (entry) => stringValue(entry.message_id) === messageId
    );
    if (blockedByMessage) return true;
  }

  return (history.revisions || []).some((entry) => {
    return (
      Number(entry.variant_index) === variantIndex &&
      normalizeFeedbackText(entry.feedback_text) === feedbackText
    );
  });
}

export function selectPendingFeedbackItems(parsed, state = {}, history = {}) {
  return (parsed.feedback_items || []).filter((item) => {
    const indexes = item.resolved_variant_indexes || [];
    return (
      item.can_build_revision_prompt === true &&
      item.routing_status === "resolved" &&
      indexes.length === 1 &&
      Number.isInteger(Number(indexes[0])) &&
      !feedbackAlreadyHandled(item, state, history)
    );
  });
}

export function addProcessedFeedbackState(state = {}, item, result = {}) {
  const next = {
    schema_version: "aicr-auto-revision-state-v1",
    updated_at: new Date().toISOString(),
    processed_feedback_items: [...(state.processed_feedback_items || [])],
    blocked_feedback_items: [...(state.blocked_feedback_items || [])]
  };
  next.processed_feedback_items.push({
    message_id: stringValue(item.message_id),
    request_id: stringValue(result.request_id || item.request_id_hint),
    variant_index: Number(item.resolved_variant_index || item.resolved_variant_indexes?.[0] || 0),
    feedback_text: item.feedback_text || "",
    processed_at: next.updated_at,
    status: result.status || "",
    image_paths: result.image_paths || [],
    chatwork_message_id: result.chatwork_message_id || null
  });
  return next;
}

export function addBlockedFeedbackState(state = {}, item, error) {
  const next = {
    schema_version: "aicr-auto-revision-state-v1",
    updated_at: new Date().toISOString(),
    processed_feedback_items: [...(state.processed_feedback_items || [])],
    blocked_feedback_items: [...(state.blocked_feedback_items || [])]
  };
  next.blocked_feedback_items.push({
    message_id: stringValue(item.message_id),
    request_id: stringValue(item.request_id_hint),
    variant_index: Number(item.resolved_variant_index || item.resolved_variant_indexes?.[0] || 0),
    feedback_text: item.feedback_text || "",
    blocked_at: next.updated_at,
    error: String(error?.message || error || "")
  });
  return next;
}

function stringValue(value) {
  return value == null ? "" : String(value);
}
