import fs from "node:fs/promises";
import path from "node:path";
import { parseFeedback } from "./feedback_parser.mjs";
import { runPolicyGate } from "./policy_gate.mjs";
import { writeJson } from "./manifest.mjs";

export async function buildRevisionFromFeedback(options = {}) {
  const requestDir = options.requestDir;
  if (!requestDir) throw new Error("requestDir is required.");

  const promptPack = await readJson(path.join(requestDir, "prompt_pack.json"));
  const manifest = await readJson(path.join(requestDir, "manifest.json")).catch(() => null);
  const generatedAssets = await readJson(path.join(requestDir, "generated_assets.json")).catch(() => null);
  const parsedFeedback = parseFeedback(options.feedback || "", {
    variantIndex: options.variantIndex || null
  });
  const variantIndex = options.variantIndex || parsedFeedback.variant_index;
  if (!variantIndex || variantIndex < 1) {
    throw new Error("variant index is required. Use --variant N or include 画像N in the feedback.");
  }

  const sourceVariant = promptPack.variants.find((variant) => variant.variant_index === variantIndex);
  if (!sourceVariant) throw new Error(`variant ${variantIndex} was not found in prompt_pack.`);

  const revisionNumber = await nextRevisionNumber(requestDir);
  const revisionId = `${promptPack.request_id}_r${revisionNumber}_v${variantIndex}`;
  const revisionDir = path.join(requestDir, "revisions", `r${revisionNumber}_variant_${variantIndex}`);
  const revisedPrompt = buildRevisionPrompt({
    promptPack,
    sourceVariant,
    parsedFeedback,
    options
  });
  const policyGateResult = runPolicyGate(
    {
      text: revisedPrompt,
      prompt: revisedPrompt
    },
    options.guardrails || {}
  );
  const originalImage = generatedAssets?.images?.find((image) => image.variant_index === variantIndex) || null;
  const revision = {
    schema_version: "aicr-revision-prompt-v1",
    request_id: promptPack.request_id,
    revision_id: revisionId,
    revision_number: revisionNumber,
    created_at: new Date().toISOString(),
    dry_run: options.dryRun !== false,
    source: {
      variant_index: variantIndex,
      variant_id: sourceVariant.variant_id,
      original_image_path: originalImage?.local_path || null,
      chatwork_message_id: manifest?.delivery_result?.chatwork?.message_id || null
    },
    feedback: parsedFeedback,
    generation_tags: {
      ...sourceVariant.generation_tags,
      revision_number: revisionNumber,
      revision_target: `variant_${variantIndex}`,
      feedback_directives: Object.entries(parsedFeedback.directives)
        .filter(([, value]) => value)
        .map(([key]) => key)
    },
    revised_prompt: revisedPrompt,
    prompt_contract: {
      prompt_mode: "feedback_delta_on_verbatim_source",
      source_prompt_preserved: true,
      ai_safety_omission_performed: false,
      ai_policy_rewrite_performed: false,
      rewrite_scope: "only_feedback_and_explicit_extra_prompt"
    },
    policy_gate_result: policyGateResult,
    next_actions: buildNextActions({ policyGateResult, options })
  };

  const chatworkReply = buildRevisionChatworkDryRun({ promptPack, revision });
  await writeJson(path.join(revisionDir, "revision_prompt.json"), revision);
  await writeJson(path.join(revisionDir, "chatwork_reply_dry_run.json"), chatworkReply);
  await appendRevisionHistory(requestDir, revision);
  await updateManifestRevision(manifest, requestDir, revision);

  return {
    revision,
    chatworkReply,
    paths: {
      revisionDir,
      revisionPromptPath: path.join(revisionDir, "revision_prompt.json"),
      chatworkReplyDryRunPath: path.join(revisionDir, "chatwork_reply_dry_run.json"),
      revisionHistoryPath: path.join(requestDir, "revision_history.json")
    }
  };
}

export function buildRevisionPrompt({ promptPack, sourceVariant, parsedFeedback, options = {} }) {
  const summary = promptPack.request_summary || {};
  const activeDirectives = Object.entries(parsedFeedback.directives)
    .filter(([, value]) => value)
    .map(([key]) => key);
  const directiveNotes = buildDirectiveNotes(parsedFeedback.directives);
  const explicitAvoids = buildExplicitAvoids(parsedFeedback.directives);
  const sourcePrompt = sourceVariant.prompt || "";

  return [
    "Image2で日本語の正方形広告バナーを1枚、修正版として再生成してください。",
    "",
    "## 元依頼",
    `案件: ${summary.project_name || promptPack.request_id}`,
    `CR案の仮タイトル: ${summary.creative_title || ""}`,
    `ターゲット: ${summary.target_audience || ""}`,
    `訴求軸: ${summary.appeal || ""}`,
    `オファー解釈: ${summary.offer || ""}`,
    `元コピー: ${summary.required_copy || ""}`,
    "",
    "## 修正対象",
    `variant_id: ${sourceVariant.variant_id}`,
    `variant_index: ${sourceVariant.variant_index}`,
    `元generation_tags: ${JSON.stringify(sourceVariant.generation_tags)}`,
    "",
    "## FB",
    parsedFeedback.feedback_text || parsedFeedback.raw_feedback,
    "",
    "## FBから抽出した修正方向",
    activeDirectives.length ? activeDirectives.join(", ") : "manual_feedback_only",
    directiveNotes,
    explicitAvoids ? "\n## FB由来の明示的な禁止/置き換え" : "",
    explicitAvoids,
    "",
    "## 修正版の生成指示",
    "元案の良いところは残しつつ、FBに該当する要素だけを優先的に調整してください。",
    "修正対象ではない訴求軸、ターゲット、オファー、商品理解は大きく変えないでください。",
    "日本語テキストは大きく、崩れにくく、スマホで読める配置にしてください。",
    "画像CRでは、FBで明示されていない限り、簡単3STEP、3ステップ、予約→相談→来院→施術など、今後何をするかを伝える手順説明は入れないでください。",
    "元prompt参考に手順系構成、次回行動、CTA、3STEP系の古い共通指示が含まれていても、新しい画像CRルールを優先し、採用しないでください。",
    options.extraPrompt ? `追加指示: ${options.extraPrompt}` : "",
    "",
    "## 元prompt参考",
    sourcePrompt
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildRevisionChatworkDryRun({ promptPack, revision }) {
  const summary = promptPack.request_summary || {};
  return {
    schema_version: "aicr-revision-chatwork-dry-run-v1",
    request_id: promptPack.request_id,
    revision_id: revision.revision_id,
    send_executed: false,
    message: [
      "[AICR Factory revision dry-run]",
      `案件: ${summary.project_name || ""}`,
      `修正対象: 画像${revision.source.variant_index}`,
      `revision: r${revision.revision_number}`,
      `FB: ${revision.feedback.feedback_text || revision.feedback.raw_feedback}`,
      `policy_gate: ${revision.policy_gate_result.status}`,
      "修正版画像を生成したあと、このスレッドに追加投稿します。"
    ].join("\n"),
    files: []
  };
}

function buildDirectiveNotes(directives) {
  const notes = [];
  if (directives.weaken_offer) notes.push("- FBに従って、オファー/無料訴求の見せ方を調整する。");
  if (directives.remove_limited_time_offer) {
    notes.push("- FBに従って、期間限定・今だけ・締切・期限・W杯が終わるまで等のシーズン/期限に依存する訴求は画像内コピーから外す。");
    notes.push("- 期限訴求の代わりに、サッカー好き男性の見た目不安、比較検討、相談のしやすさなど、期限に依存しない訴求へ置き換える。");
  }
  if (directives.remove_step_flow) {
    notes.push("- FBに従って、簡単3STEP/3ステップ/番号付き手順/予約から施術までの流れ説明を画像内から外す。");
    notes.push("- 手順枠を削った分は、主コピー・オファー・人物/商品世界観・余白に振り分ける。");
  }
  if (directives.reduce_ba) notes.push("- FBに従って、BA/比較感の強さを調整する。");
  if (directives.increase_ba) notes.push("- FBに従って、BA/比較感を強める。");
  if (directives.improve_readability) notes.push("- コピーの可読性を最優先し、文字数と階層を整理する。");
  if (directives.reduce_information_density) notes.push("- FBに従って、情報量・文字量・要素数を絞り、主訴求がぱっと見で伝わる密度にする。");
  if (directives.change_copy) notes.push("- 見出しやコピーをFB意図に合わせて差し替える。");
  if (directives.change_color) notes.push("- 色味/トーンをFBに合わせて調整する。");
  if (directives.change_composition) notes.push("- 写真/UI/余白/構図をFBに合わせて調整する。");
  if (directives.policy_safer) notes.push("- FBが明示的に審査リスク調整を求めている場合のみ、その範囲で表現を調整する。");
  return notes.length ? notes.join("\n") : "- FB本文を優先して修正する。";
}

function buildExplicitAvoids(directives) {
  const avoids = [];
  if (directives.remove_limited_time_offer) {
    avoids.push("- 画像内コピーに「期間限定」「今だけ」「締切」「期限」「W杯が終わるまで」「終わるまでに」などの期限訴求を入れない。");
    avoids.push("- 元コピーに期限訴求が含まれる場合は、その期限部分だけを外し、見た目不安/比較/相談しやすさに寄せたコピーへ置き換える。");
  }
  if (directives.remove_step_flow) {
    avoids.push("- 画像内に「簡単3STEP」「3ステップ」「1/2/3の手順カード」「予約→相談→来院→施術」のような流れ説明を入れない。");
    avoids.push("- CTAや誘導文は短いオファー/ベネフィット表示に留め、プロセス説明にしない。");
  }
  return avoids.join("\n");
}

function buildNextActions({ policyGateResult, options }) {
  return {
    can_generate: true,
    generation_mode: options.generate ? "assistant_imagegen_required" : "dry_run_prompt_only",
    reason: options.generate
      ? "Codexのimage_genでrevised_promptを使って1枚再生成してください。"
      : "--generate指定時に、revised_promptを使って該当案だけ再生成します。"
  };
}

async function nextRevisionNumber(requestDir) {
  const revisionsDir = path.join(requestDir, "revisions");
  const entries = await fs.readdir(revisionsDir, { withFileTypes: true }).catch(() => []);
  const numbers = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.match(/^r(\d+)_/))
    .filter(Boolean)
    .map((match) => Number.parseInt(match[1], 10));
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}

async function appendRevisionHistory(requestDir, revision) {
  const historyPath = path.join(requestDir, "revision_history.json");
  const history = await readJson(historyPath).catch(() => ({
    schema_version: "aicr-revision-history-v1",
    request_id: revision.request_id,
    revisions: []
  }));
  history.revisions.push({
    revision_id: revision.revision_id,
    revision_number: revision.revision_number,
    variant_index: revision.source.variant_index,
    created_at: revision.created_at,
    feedback_text: revision.feedback.feedback_text || revision.feedback.raw_feedback,
    policy_gate_status: revision.policy_gate_result.status
  });
  await writeJson(historyPath, history);
}

async function updateManifestRevision(manifest, requestDir, revision) {
  if (!manifest) return;
  manifest.status = "needs_revision";
  manifest.run_status = "revision_prompt_ready";
  manifest.revision_count = (manifest.revision_count || 0) + 1;
  manifest.revisions = manifest.revisions || [];
  manifest.revisions.push({
    revision_id: revision.revision_id,
    revision_number: revision.revision_number,
    variant_index: revision.source.variant_index,
    created_at: revision.created_at,
    policy_gate_status: revision.policy_gate_result.status
  });
  await writeJson(path.join(requestDir, "manifest.json"), manifest);
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}
