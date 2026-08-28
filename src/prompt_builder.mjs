import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildNoteBandPlan, parseSize } from "./image_postprocess.mjs";
import { runPolicyGate } from "./policy_gate.mjs";

const DEFAULT_APPEAL_VARIANTS = Object.freeze([
  {
    id: "request_led_direct",
    appeal_axis: "request_led",
    composition: "request_visual_direct",
    color: "palette_pool_selected",
    copy_type: "request_copy_verbatim",
    direction: "フォームの訴求軸と指定ビジュアルをそのまま主役にする直球構成。"
  },
  {
    id: "request_led_scene",
    appeal_axis: "request_led",
    composition: "request_visual_scene",
    color: "palette_pool_selected",
    copy_type: "request_copy_verbatim",
    direction: "フォーム指定のビジュアルを自然な生活・利用場面として見せる構成。"
  },
  {
    id: "request_led_closeup",
    appeal_axis: "request_led",
    composition: "request_visual_closeup",
    color: "palette_pool_selected",
    copy_type: "request_copy_verbatim",
    direction: "フォーム指定の主役やディテールを大きく見せ、訴求理解を高める構成。"
  },
  {
    id: "request_led_editorial",
    appeal_axis: "request_led",
    composition: "request_visual_editorial",
    color: "palette_pool_selected",
    copy_type: "request_copy_verbatim",
    direction: "フォーム指定の訴求とビジュアルを維持し、編集的なレイアウトで差別化する構成。"
  }
]);

const DEFAULT_VARIANTS = Object.freeze(DEFAULT_APPEAL_VARIANTS);

const DEFAULT_TEXT_QUALITY_PROMPT = Object.freeze({
  strict_text_instruction:
    "画像内に含める文字・記号・英字は {{locked_copy_quoted}} のみ。主コピーとオファーの文言は一字一句変更せず、そのまま描画する。改行・文字サイズ・色・書体・配置・帯などのデザイン調整は許可するが、言い換え・要約・追記・削除・句読点変更は禁止する。この文言以外の文字・記号・英字、ダミー英字、架空ロゴ、読めない文字を一切描かない。",
  no_text_instruction:
    "確定コピーが空のため、画像内に文字・記号・英字を一切描かない。ロゴ風の架空文字、ダミー英字、読めない文字化けも入れない。",
  typography_instruction:
    "太い日本語ゴシック体をベースに、白抜きまたは濃色文字で背景と十分なコントラストを確保する。文字はスマホ表示でも読める大きさにし、にじみ・崩れ・誤字・余計な句読点を避ける。",
  photo_realism_instruction:
    "実写人物や実写商品を使う場合は、85mmレンズ、自然光、浅い被写界深度の広告写真として自然に見せる。完璧すぎる肌、不自然なツヤ、左右対称すぎる構図、AIっぽい均質なライティングを避ける。"
});

const DEFAULT_COLOR_PALETTES = Object.freeze([
  {
    id: "emerald_white_gold",
    name: "エメラルド×白×ゴールド",
    colors: "深めグリーン / 白 / ゴールド",
    mood: "清潔感と上品さを両立。美容クリニックや信頼訴求に使いやすい。",
    accent_rule: "ゴールドは小さなバッジや罫線に限定し、白余白を広く取る。"
  },
  {
    id: "blush_pink_navy",
    name: "淡ピンク×ネイビー",
    colors: "淡いピンク / ネイビー / 白",
    mood: "女性向けのやわらかさと締まりを両立。悩み共感や美容感に強い。",
    accent_rule: "ネイビーで見出しを締め、ピンクは面やラベルに使う。"
  },
  {
    id: "clinic_blue_white",
    name: "クリニックブルー×白",
    colors: "明るいブルー / 白 / アクセントイエロー",
    mood: "医療系の清潔感、比較検討、安心材料の整理に向く。",
    accent_rule: "青と白を主役にし、黄色はCTAや重要語だけに使う。"
  },
  {
    id: "sage_beige_charcoal",
    name: "セージグリーン×ベージュ×チャコール",
    colors: "セージグリーン / ベージュ / チャコール",
    mood: "自然で落ち着いた印象。広告感を少し弱めたい時に向く。",
    accent_rule: "ベージュを背景、チャコールを文字、セージを装飾に使う。"
  },
  {
    id: "lavender_mint_white",
    name: "ラベンダー×ミント×白",
    colors: "ラベンダー / ミント / 白",
    mood: "やわらかく透明感のある美容感。若年女性向けに使いやすい。",
    accent_rule: "淡色同士でぼやけないよう、見出しだけ濃いラベンダーにする。"
  },
  {
    id: "black_gold_ivory",
    name: "黒×ゴールド×アイボリー",
    colors: "黒 / ゴールド / アイボリー",
    mood: "高級感、プレミアム感、単価感を落としたくない案件向け。",
    accent_rule: "黒を重くしすぎず、アイボリー面で可読性を確保する。"
  },
  {
    id: "coral_cream_teal",
    name: "コーラル×クリーム×ティール",
    colors: "コーラル / クリーム / ティール",
    mood: "温かく目立つが、安っぽくなりにくい。オファー訴求に向く。",
    accent_rule: "コーラルは主コピーやバッジ、ティールは締め色として使う。"
  },
  {
    id: "sky_gray_white",
    name: "スカイブルー×ライトグレー×白",
    colors: "スカイブルー / ライトグレー / 白",
    mood: "軽く爽やか。オンライン相談やハードルの低さを見せやすい。",
    accent_rule: "淡い背景にし、重要コピーだけ濃いブルーで読む順番を作る。"
  },
  {
    id: "rose_brown_cream",
    name: "ローズ×ブラウン×クリーム",
    colors: "ローズ / ブラウン / クリーム",
    mood: "肌なじみが良く、落ち着いた美容感や口コミ風に向く。",
    accent_rule: "ブラウンで文字を締め、ローズは見出しや小ラベルに使う。"
  },
  {
    id: "orange_navy_white",
    name: "オレンジ×ネイビー×白",
    colors: "オレンジ / ネイビー / 白",
    mood: "強いオファー感と信頼感を両立。短期CPA狙いにも使いやすい。",
    accent_rule: "オレンジで行動理由を作り、ネイビーで価格や見出しを締める。"
  },
  {
    id: "mauve_charcoal_silver",
    name: "モーヴ×チャコール×シルバー",
    colors: "モーヴ / チャコール / シルバー",
    mood: "大人っぽく静かな美容感。落ち着いた比較検討層向け。",
    accent_rule: "チャコール文字とシルバー罫線で、情報を上品に整理する。"
  },
  {
    id: "peach_olive_white",
    name: "ピーチ×オリーブ×白",
    colors: "ピーチ / オリーブ / 白",
    mood: "自然で親しみやすい。生活者目線や悩み共感に向く。",
    accent_rule: "ピーチを柔らかい面に、オリーブを締め色として使う。"
  },
  {
    id: "purple_coral_white",
    name: "パープル×コーラル×白",
    colors: "パープル / コーラル / 白",
    mood: "美容感と広告としての目立ちを両立。トレンド寄りに使える。",
    accent_rule: "パープルを主見出し、コーラルをオファーや吹き出しに使う。"
  },
  {
    id: "dusty_blue_mocha_white",
    name: "ダスティブルー×モカ×白",
    colors: "ダスティブルー / モカ / 白",
    mood: "落ち着きと信頼感を出しやすい。情報整理や比較訴求に向く。",
    accent_rule: "白を広く取り、モカは文字、ダスティブルーは面とラベルに使う。"
  },
  {
    id: "champagne_rose_charcoal",
    name: "シャンパン×ローズ×チャコール",
    colors: "シャンパン / ローズ / チャコール",
    mood: "上品な美容感と可読性を両立。高級感を出しつつ柔らかい。",
    accent_rule: "シャンパンを背景、ローズを小面積、チャコールを見出しに使う。"
  },
  {
    id: "ice_blue_pearl_gray",
    name: "アイスブルー×パールグレー",
    colors: "アイスブルー / パールグレー / 白",
    mood: "透明感と清潔感。医療/美容の安心材料を静かに見せやすい。",
    accent_rule: "淡色でぼやけないよう、見出しは濃いブルーグレーにする。"
  }
]);

const CREATIVE_PROMPT_PRINCIPLES = Object.freeze({
  role: "あなたはプロの広告デザイナーです。",
  first_view: "LPのファーストビューのように、世界観・訴求・オファーが一目で伝わる画像CRにする。ただし、今後何をするかの手順説明は入れない。",
  design_requirements: Object.freeze([
    "適度な余白を取り、情報を詰め込みすぎない",
    "視線導線を作り、主コピー、ビジュアル、オファーの順に自然に読める",
    "訴求力が高く、ターゲットの欲求・不安・比較軸に刺さる",
    "文字のジャンプ率とメリハリを大きくし、スマホでも主コピーが読める",
    "ダイナミックな躍動感を作る",
    "遊びのあるグラフィック要素やテキスト処理を入れる",
    "誘導文を入れる場合は短いオファー/ベネフィット表示に留め、予約から施術までの流れや3STEPなどの手順説明にしない",
    "案件ごとの世界観をしっかり伝える"
  ]),
  copy_flow: "まずターゲット向けの訴求力あるキャッチコピーを1つ設計し、それを画像内の主役として扱う。依頼の必須コピーがある場合は必須コピーを優先する。",
  avoid: Object.freeze([
    "過度なあしらい",
    "過度な文章",
    "情報過多",
    "装飾過多でオファーや主コピーが読みにくくなること",
    "簡単3STEPや3ステップなどの手順説明",
    "予約、相談、来院、施術など今後何をするかの流れ説明",
    "まず、次に、最後に、のようなプロセス訴求"
  ])
});

export async function buildPromptPack(request, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const templateConfig = await loadPromptTemplateConfig(options.templatePath);
  const variants = templateConfig.variants;
  const textQualityPrompt = templateConfig.text_quality_prompt;
  const requestForPrompt = enrichBrandAssetsForPrompt(request, options.guardrails || {});
  const requestPolicyGate = runPolicyGate({ request: requestForPrompt }, options.guardrails);
  const colorPalettes = selectColorPalettes(requestForPrompt, variants.length, options);
  const designToneHint = buildDesignToneHint(requestForPrompt);
  const textContract = buildTextContract(requestForPrompt, textQualityPrompt);

  const promptVariants = variants.map((variant, index) => {
    const colorPalette = colorPalettes[index];
    const variantWithPalette = applyTextContractToVariant(applyColorPalette(variant, colorPalette), textContract);
    const variantId = `${requestForPrompt.request_id}_v${index + 1}_${variantWithPalette.id}`;
    const prompt = buildVariantPrompt(requestForPrompt, variantWithPalette, index, { textContract });
    const generationTags = {
      appeal_variant: variantWithPalette.appeal_variant_id || variantWithPalette.id,
      appeal_axis: variantWithPalette.appeal_axis,
      design_style: variantWithPalette.design_style_id || "palette_pool",
      design_style_name: variantWithPalette.design_style_name || "配色プール選定",
      composition: variantWithPalette.composition,
      color: variantWithPalette.color,
      color_palette_id: colorPalette.id,
      color_palette_name: colorPalette.name,
      color_palette_colors: colorPalette.colors,
      color_palette_mood: colorPalette.mood,
      color_policy: "palette_pool_deterministic_shuffle",
      design_tone_hint: designToneHint,
      copy_type: variantWithPalette.copy_type,
      layout: variantWithPalette.layout,
      typography: variantWithPalette.typography,
      offer: requestForPrompt.offer || "offer_unspecified"
    };
    const policyGateResult = runPolicyGate(
      {
        request: requestForPrompt,
        variant: {
          ...variantWithPalette,
          prompt
        },
        prompt
      },
      options.guardrails
    );

    return {
      variant_id: variantId,
      variant_index: index + 1,
      prompt,
      text_contract: {
        ...textContract,
        variant_text_contract: variantWithPalette.text_contract || "",
        variant_text_style_instruction: variantWithPalette.text_style_instruction || "",
        variant_photo_treatment: variantWithPalette.photo_treatment || ""
      },
      prompt_source_policy: buildPromptSourcePolicy(),
      generation_tags: generationTags,
      policy_gate_result: policyGateResult
    };
  });

  return {
    schema_version: "aicr-prompt-pack-v1",
    request_id: requestForPrompt.request_id,
    generated_at: now.toISOString(),
    source: requestForPrompt.source,
    request_summary: buildRequestSummary(requestForPrompt),
    client_master: requestForPrompt.client_master || null,
    brand_assets: buildPromptPackBrandAssets(requestForPrompt),
    prompt_contract: buildPromptContract(),
    creative_prompt_principles: buildCreativePromptPrinciples(),
    request_policy_gate_result: requestPolicyGate,
    variants: promptVariants,
    learning_boundary: {
      auto_register_learning: false,
      reason: "成果不明の生成結果は勝ち学習へ自動登録しない。採用/非採用/成果が明確なものだけ候補化する。"
    }
  };
}

export function buildVariantPrompt(request, variant, index = 0, options = {}) {
  const projectName = request.project?.name || "AICR依頼";
  const projectId = request.project?.id || "";
  const product = request.project?.product || "対象商材";
  const media = request.project?.media || "広告媒体";
  const target = request.target_audience || "依頼シートのターゲット";
  const appeal = request.appeal || "相談しやすさと比較検討のしやすさ";
  const offer = request.offer || "依頼シートのオファー";
  const tone = request.tone || "清潔感、信頼感、スマホで読みやすい";
  const clientNgList = request.client_master?.ng_expressions || [];
  const requesterNgList = (request.ng_expressions || []).filter(
    (term) => !clientNgList.some((clientTerm) => clientTerm.toLowerCase() === term.toLowerCase())
  );
  const requesterNg = requesterNgList.length ? requesterNgList.join(" / ") : "";
  const clientNg = clientNgList.length ? clientNgList.join(" / ") : "";
  const visualElements = request.visual_elements || "依頼内容に沿った自然な人物・商品理解の補助要素";
  const proofCopy = request.proof_copy || "";
  const performanceRationale = request.performance_rationale || "クリック前理解とCVR改善";
  const creativeTitle = request.creative_title || "未指定";
  const designToneHint = buildDesignToneHint(request);
  const textContract = options.textContract || variant.text_contract_object || buildTextContract(request);
  const brandPromptLines = buildBrandPromptLines(request);

  const lines = [
    `Image2で日本語の正方形広告バナーを1枚生成してください。`,
    CREATIVE_PROMPT_PRINCIPLES.role,
    `案件: ${projectName}`,
    projectId ? `案件ID: ${projectId}` : "",
    `CR案の仮タイトル: ${creativeTitle}`,
    `商材: ${product}`,
    `想定媒体: ${media}`,
    `サイズ: 1080x1080、スマホフィードで可読性が高い構図。`,
    `ターゲット: ${target}`,
    `狙う欲求・不安・比較軸: ${request.audience_insight || appeal}`,
    `訴求軸: ${appeal}`,
    `オファー解釈: ${offer}`,
    `画像内に含める主コピー: ${textContract.expected_text_quoted}`,
    `画像内に含めるオファーコピー: ${textContract.offer_text_quoted}`,
    `文字厳密指定: ${variant.text_contract || textContract.strict_text_instruction}`,
    `キャッチコピー設計: ${CREATIVE_PROMPT_PRINCIPLES.copy_flow}`,
    `希望テイスト/デザインヒント: ${designToneHint}`,
    `配色パターン: ${variant.color_palette_name || variant.color}（${variant.color_palette_colors || variant.color}）`,
    ...brandPromptLines,
    variant.color_palette_mood ? `配色の狙い: ${variant.color_palette_mood}` : "",
    variant.color_palette_accent_rule ? `配色運用: ${variant.color_palette_accent_rule}` : "",
    `配色ルール: 4案で同じ固定配色を繰り返さない。この案では上記の配色パターンを主軸にし、希望テイストに合う範囲で濃淡・余白・アクセント量を調整する。蛍光色、虹色、多色使い、原色同士の衝突、読みにくい低コントラストは避ける。白、黒、薄グレー以外の追加色を勝手に足さない。`,
    `案${index + 1}の方向性: ${variant.direction}`,
    variant.design_style_name ? `デザインスタイル: ${variant.design_style_name}` : "",
    `構図: ${variant.composition}`,
    `色設計: ${variant.color}`,
    variant.layout ? `レイアウト処理: ${variant.layout}` : "",
    variant.typography ? `文字処理: ${variant.typography}` : "",
    variant.text_style_instruction ? `文字品質/可読性: ${variant.text_style_instruction}` : "",
    variant.graphic_elements ? `装飾/質感: ${variant.graphic_elements}` : "",
    variant.visual_treatment ? `写真/人物処理: ${variant.visual_treatment}` : "",
    variant.photo_treatment ? `実写撮影条件: ${variant.photo_treatment}` : "",
    `コピータイプ: ${variant.copy_type}`,
    `テイスト: ${tone}`,
    `入れたいビジュアル要素: ${visualElements}`,
    `LPファーストビュー設計: ${CREATIVE_PROMPT_PRINCIPLES.first_view}`,
    `デザイン要件: ${CREATIVE_PROMPT_PRINCIPLES.design_requirements.join(" / ")}`,
    `NGデザイン: ${CREATIVE_PROMPT_PRINCIPLES.avoid.join(" / ")}`,
    proofCopy ? `入れたい文言・数字・権威付け: ${proofCopy}` : "",
    `CPA/CVRに効きそうな理由: ${performanceRationale}`,
    requesterNg ? `依頼者指定NG表現: ${requesterNg}` : "",
    clientNg ? `案件別NG表現: ${clientNg}` : "",
    `目的: CPA/CVR改善につながるクリック前理解を高める。来院率・契約率・契約単価まで見据えた継続性も考慮する。`
  ];

  return lines.filter(Boolean).join("\n");
}

export function buildRequestSummary(request) {
  return {
    requester: request.requester?.name || "",
    project_id: request.project?.id || "",
    project_name: request.project?.name || "",
    product: request.project?.product || "",
    media: request.project?.media || "",
    creative_title: request.creative_title || "",
    target_audience: request.target_audience || "",
    audience_insight: request.audience_insight || "",
    appeal: request.appeal || "",
    offer: request.offer || "",
    required_copy: request.required_copy || "",
    visual_elements: request.visual_elements || "",
    proof_copy: request.proof_copy || "",
    performance_rationale: request.performance_rationale || "",
    tone: request.tone || "",
    notes: request.notes || "",
    landing_page_url: request.urls?.landing_page || "",
    reference_url: request.urls?.reference || "",
    logo_selection: request.logo_selection || "",
    drive_folder_url: request.urls?.drive_folder || "",
    chatwork_room_id_present: Boolean(request.chatwork?.room_id),
    client_master_matched: request.client_master?.matched ?? null
  };
}

function buildCreativePromptPrinciples() {
  return {
    source: "user_provided_image_cr_prompt_learning_2026-06-16",
    role: CREATIVE_PROMPT_PRINCIPLES.role,
    first_view: CREATIVE_PROMPT_PRINCIPLES.first_view,
    copy_flow: CREATIVE_PROMPT_PRINCIPLES.copy_flow,
    design_requirements: [...CREATIVE_PROMPT_PRINCIPLES.design_requirements],
    avoid: [...CREATIVE_PROMPT_PRINCIPLES.avoid],
    note: "フォーム原文は保持し、画像CRのデザイン品質を上げるための共通生成指示として使う。"
  };
}

function buildPromptContract() {
  return {
    source_text_policy: "verbatim_form_fields",
    prompt_mode: "verbatim_by_default",
    ai_rewrite_performed: false,
    ai_safety_omission_performed: false,
    policy_gate_mode: "disabled",
    human_revision_required_for_rewrite: false,
    note: "リポジトリ独自のポリシー判定は無効です。"
  };
}

function buildPromptSourcePolicy() {
  return {
    prompt_mode: "verbatim_by_default",
    ai_rewrite_performed: false,
    ai_safety_omission_performed: false,
    policy_gate_mutated_prompt: false
  };
}

function enrichBrandAssetsForPrompt(request, guardrails = {}) {
  if (!request.brand_assets) return request;

  const brandAssets = {
    ...request.brand_assets,
    logo: { ...(request.brand_assets.logo || {}) },
    required_note: { ...(request.brand_assets.required_note || {}) },
    brand_color: { ...(request.brand_assets.brand_color || {}) }
  };
  const enriched = {
    ...request,
    brand_assets: brandAssets
  };
  const noteEnabled = brandAssets.required_note?.enabled === true && Boolean(brandAssets.required_note?.text);
  if (!noteEnabled) return enriched;

  const finalSize = parseSize(guardrails.image2_api?.final_size || "1080x1080") || { width: 1080, height: 1080 };
  const noteBandPlan = buildNoteBandPlan({
    noteText: brandAssets.required_note.text,
    width: finalSize.width,
    height: finalSize.height,
    config: guardrails.brand_assets?.note_band || {},
    brandColorHex: brandAssets.brand_color?.hex || ""
  });
  if (noteBandPlan.status !== "planned") return enriched;

  brandAssets.required_note.band_plan = summarizeNoteBandPlan(noteBandPlan);
  if (guardrails.brand_assets?.bottom_safe_area_prompt_enabled !== false) {
    brandAssets.bottom_safe_area = {
      schema_version: "aicr-bottom-safe-area-v1",
      prompt_enabled: true,
      source: "required_note_band_plan",
      bottom_percent: noteBandPlan.bottom_safe_area_percent,
      band_height: noteBandPlan.band_height,
      canvas_width: noteBandPlan.width,
      canvas_height: noteBandPlan.height
    };
  }
  if (
    brandAssets.logo?.enabled === true &&
    brandAssets.logo?.avoid_note_band_enabled === true &&
    guardrails.brand_assets?.logo_avoid_note_band_enabled !== false
  ) {
    brandAssets.logo.adjusted_for_note_band = true;
    brandAssets.logo.effective_placement = `${brandAssets.logo.placement || "bottom_right"}_above_note_band`;
  }

  return enriched;
}

function buildPromptPackBrandAssets(request) {
  if (!request.brand_assets) return null;
  return {
    schema_version: request.brand_assets.schema_version || "aicr-brand-assets-v1",
    logo: {
      available: Boolean(request.brand_assets.logo?.available),
      enabled: Boolean(request.brand_assets.logo?.enabled),
      reference: request.brand_assets.logo?.reference || "",
      source_type: request.brand_assets.logo?.source_type || "",
      source: request.brand_assets.logo?.source || "",
      label: request.brand_assets.logo?.label || "",
      plate_background_color: request.brand_assets.logo?.plate_background_color || "",
      plate_padding: Number(request.brand_assets.logo?.plate_padding) || 0,
      max_width_ratio: Number(request.brand_assets.logo?.max_width_ratio) || 0,
      max_height_ratio: Number(request.brand_assets.logo?.max_height_ratio) || 0,
      margin: Number(request.brand_assets.logo?.margin) || 0,
      alignment: request.brand_assets.logo?.alignment || "",
      placement: request.brand_assets.logo?.placement || "bottom_right",
      effective_placement: request.brand_assets.logo?.effective_placement || request.brand_assets.logo?.placement || "bottom_right",
      adjusted_for_note_band: Boolean(request.brand_assets.logo?.adjusted_for_note_band),
      avoid_note_band_enabled: Boolean(request.brand_assets.logo?.avoid_note_band_enabled),
      postprocess_overlay_enabled: Boolean(request.brand_assets.logo?.postprocess_overlay_enabled),
      api_input_required: Boolean(request.brand_assets.logo?.api_input_required)
    },
    required_note: {
      available: Boolean(request.brand_assets.required_note?.available),
      enabled: Boolean(request.brand_assets.required_note?.enabled),
      text: request.brand_assets.required_note?.text || "",
      source: request.brand_assets.required_note?.source || "",
      band_plan: request.brand_assets.required_note?.band_plan || null
    },
    brand_color: {
      available: Boolean(request.brand_assets.brand_color?.available),
      hex: request.brand_assets.brand_color?.hex || "",
      use_for_note_band: Boolean(request.brand_assets.brand_color?.use_for_note_band),
      prompt_enabled: Boolean(request.brand_assets.brand_color?.prompt_enabled)
    },
    bottom_safe_area: request.brand_assets.bottom_safe_area || null,
    notes: request.brand_assets.notes || ""
  };
}

function buildBrandPromptLines(request) {
  const lines = [];
  const brandAssets = request.brand_assets || {};
  const brandColor = brandAssets.brand_color?.hex || "";
  if (brandColor && brandAssets.brand_color?.prompt_enabled === true) {
    lines.push(`案件別ブランドカラー: ${brandColor}。配色パターンと衝突しない範囲で、アクセントや帯・罫線に活用する。`);
  }
  if (brandAssets.bottom_safe_area?.prompt_enabled === true) {
    lines.push(
      `下部セーフエリア: 画像下部${brandAssets.bottom_safe_area.bottom_percent}%（約${brandAssets.bottom_safe_area.band_height}px）は後工程で注釈帯を重ねるため、無地に近い余白にし、文字・ロゴ・顔・商品・価格など重要要素を配置しない。`
    );
  }
  if (brandAssets.logo?.prompt_instruction_enabled) {
    const placement = brandAssets.logo.placement || "bottom_right";
    if (brandAssets.logo.adjusted_for_note_band) {
      lines.push(
        `ロゴ配置指定: 入力画像として渡されるロゴ画像は、変形・再描画・色変更・文字起こしせず、右下寄りかつ注釈帯の上端より上に収まる位置へ配置する。最終後処理でも同じロゴ画像を帯の外側に合成するため、AIがロゴ風の架空文字や図形を新規生成しない。`
      );
    } else {
      lines.push(
        `ロゴ配置指定: 入力画像として渡されるロゴ画像を、変形・再描画・色変更・文字起こしせず、そのまま${placement === "bottom_right" ? "右下" : placement}に配置する。ロゴをAIが文字や図形として新規生成しない。`
      );
    }
  }
  if (brandAssets.required_note?.enabled && brandAssets.required_note?.text) {
    lines.push(
      "注釈帯予約: 生成後に下部へ必須注釈帯をプログラム合成するため、下端には顔・主コピー・重要オファーを置かない。注釈文言自体は画像生成AIに描かせない。"
    );
  }
  return lines;
}

function summarizeNoteBandPlan(plan) {
  return {
    schema_version: plan.schema_version,
    status: plan.status,
    width: plan.width,
    height: plan.height,
    band_height: plan.band_height,
    band_top: plan.band_top,
    bottom_safe_area_percent: plan.bottom_safe_area_percent,
    line_count: plan.line_count,
    background_color: plan.style?.backgroundColor || "",
    text_color: plan.style?.textColor || ""
  };
}

async function loadPromptTemplateConfig(templatePath) {
  if (!templatePath) {
    return {
      variants: DEFAULT_VARIANTS,
      text_quality_prompt: DEFAULT_TEXT_QUALITY_PROMPT
    };
  }
  const absolutePath = path.resolve(templatePath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.variants) || parsed.variants.length < 4) {
    throw new Error("prompt template must contain at least 4 variants.");
  }
  return {
    variants: normalizeLegacyVariants(parsed.variants).slice(0, 4),
    text_quality_prompt: normalizeTextQualityPrompt(parsed.text_quality_prompt)
  };
}

function normalizeLegacyVariants(variants) {
  return variants.map((variant, index) => ({
    ...normalizeAppealVariant(variant, index),
    design_style_id: variant.design_style_id || "palette_pool",
    design_style_name: variant.design_style_name || "配色プール選定"
  }));
}

function normalizeAppealVariant(variant, index) {
  const fallback = DEFAULT_APPEAL_VARIANTS[index] || DEFAULT_APPEAL_VARIANTS[index % DEFAULT_APPEAL_VARIANTS.length] || {};
  return {
    ...fallback,
    ...variant,
    id: variant.id || fallback.id || `appeal_${index + 1}`,
    direction: variant.direction || fallback.direction || ""
  };
}

function buildDesignToneHint(request) {
  return request.tone || request.notes || "依頼シートの希望テイスト";
}

function buildTextContract(request, textQualityPrompt = DEFAULT_TEXT_QUALITY_PROMPT) {
  const normalizedPrompt = normalizeTextQualityPrompt(textQualityPrompt);
  const expectedText = normalizeTextForContract(request.required_copy);
  const offerText = normalizeTextForContract(request.offer);
  const expectedTextQuoted = quoteExactText(expectedText);
  const offerTextQuoted = quoteExactText(offerText);
  const lockedCopy = [expectedText, offerText].filter(Boolean);
  const lockedCopyQuoted = lockedCopy.map(quoteExactText).join(" と ");
  const baseVariables = {
    required_copy: expectedText,
    required_copy_quoted: expectedTextQuoted,
    offer_copy: offerText,
    offer_copy_quoted: offerTextQuoted,
    locked_copy_quoted: lockedCopyQuoted
  };
  const strictTextInstruction = expectedText
    ? renderTemplate(normalizedPrompt.strict_text_instruction, baseVariables)
    : renderTemplate(normalizedPrompt.no_text_instruction, baseVariables);
  const typographyInstruction = renderTemplate(normalizedPrompt.typography_instruction, {
    ...baseVariables,
    strict_text_instruction: strictTextInstruction
  });
  const photoRealismInstruction = renderTemplate(normalizedPrompt.photo_realism_instruction, {
    ...baseVariables,
    strict_text_instruction: strictTextInstruction,
    typography_instruction: typographyInstruction
  });

  return {
    expected_text: expectedText,
    expected_text_quoted: expectedTextQuoted,
    offer_text: offerText,
    offer_text_quoted: offerTextQuoted,
    locked_copy_quoted: lockedCopyQuoted,
    strict_text_instruction: strictTextInstruction,
    typography_instruction: typographyInstruction,
    photo_realism_instruction: photoRealismInstruction
  };
}

function applyTextContractToVariant(variant, textContract) {
  return {
    ...variant,
    text_contract_object: textContract,
    text_contract: renderTemplate(variant.text_contract || "{{strict_text_instruction}}", textContract),
    text_style_instruction: renderTemplate(variant.text_style_instruction || "{{typography_instruction}}", textContract),
    photo_treatment: renderTemplate(variant.photo_treatment || "{{photo_realism_instruction}}", textContract)
  };
}

function normalizeTextQualityPrompt(value = {}) {
  return {
    ...DEFAULT_TEXT_QUALITY_PROMPT,
    ...Object.fromEntries(
      Object.entries(value || {})
        .map(([key, item]) => [key, String(item || "").trim()])
        .filter(([, item]) => item)
    )
  };
}

function renderTemplate(template, variables = {}) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) return String(variables[key] ?? "");
    return match;
  });
}

function normalizeTextForContract(value) {
  return String(value || "").trim();
}

function quoteExactText(value) {
  return `「${String(value || "")}」`;
}

function applyColorPalette(variant, palette) {
  return {
    ...variant,
    color: `${palette.name}: ${palette.colors}`,
    color_palette_id: palette.id,
    color_palette_name: palette.name,
    color_palette_colors: palette.colors,
    color_palette_mood: palette.mood,
    color_palette_accent_rule: palette.accent_rule
  };
}

function selectColorPalettes(request, count, options = {}) {
  const palettePool = options.colorPalettes?.length ? options.colorPalettes : DEFAULT_COLOR_PALETTES;
  const seed = options.paletteSeed || [
    request.request_id,
    request.project?.name,
    request.creative_title,
    request.submitted_at
  ].filter(Boolean).join("|");
  const sorted = palettePool
    .map((palette, index) => ({
      palette,
      score: hashInteger(`${seed}|${palette.id}|${index}`)
    }))
    .sort((left, right) => left.score - right.score || left.palette.id.localeCompare(right.palette.id))
    .map((entry) => entry.palette);

  return Array.from({ length: count }, (_, index) => sorted[index % sorted.length]);
}

function hashInteger(value) {
  return Number.parseInt(crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8), 16);
}
