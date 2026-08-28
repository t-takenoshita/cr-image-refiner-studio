import crypto from "node:crypto";

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
  const templateConfig = loadPromptTemplateConfig();
  const variants = templateConfig.variants;
  const textQualityPrompt = templateConfig.text_quality_prompt;
  const requestForPrompt = request;
  const colorPalettes = selectColorPalettes(requestForPrompt, variants.length, options);
  const designToneHint = buildDesignToneHint(requestForPrompt);
  const textContract = buildTextContract(requestForPrompt, textQualityPrompt);

  const promptVariants = variants.map((variant, index) => {
    const colorPalette = colorPalettes[index];
    const variantWithPalette = applyTextContractToVariant(applyColorPalette(variant, colorPalette), textContract);
    const variantId = `${requestForPrompt.request_id}_v${index + 1}_${variantWithPalette.id}`;
    const prompt = buildVariantPrompt(requestForPrompt, variantWithPalette, index, {
      textContract,
      outputSize: options.outputSize
    });
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
      generation_tags: generationTags
    };
  });

  return {
    schema_version: "aicr-prompt-pack-v1",
    request_id: requestForPrompt.request_id,
    generated_at: now.toISOString(),
    source: requestForPrompt.source,
    request_summary: buildRequestSummary(requestForPrompt),
    creative_prompt_principles: buildCreativePromptPrinciples(),
    variants: promptVariants
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
  const requesterNgList = request.ng_expressions || [];
  const requesterNg = requesterNgList.length ? requesterNgList.join(" / ") : "";
  const visualElements = request.visual_elements || "依頼内容に沿った自然な人物・商品理解の補助要素";
  const proofCopy = request.proof_copy || "";
  const performanceRationale = request.performance_rationale || "クリック前理解とCVR改善";
  const creativeTitle = request.creative_title || "未指定";
  const designToneHint = buildDesignToneHint(request);
  const textContract = options.textContract || variant.text_contract_object || buildTextContract(request);
  const outputSize = options.outputSize || "1088x1088";
  const [outputWidth, outputHeight] = outputSize === "auto"
    ? [0, 0]
    : outputSize.split("x").map(Number);
  const outputShape = outputSize === "auto"
    ? "内容に最適な縦横比"
    : outputWidth === outputHeight
      ? "正方形"
      : outputWidth > outputHeight ? "横長" : "縦長";

  const lines = [
    `Image2で日本語の${outputShape}広告バナーを1枚生成してください。`,
    CREATIVE_PROMPT_PRINCIPLES.role,
    `案件: ${projectName}`,
    projectId ? `案件ID: ${projectId}` : "",
    `CR案の仮タイトル: ${creativeTitle}`,
    `商材: ${product}`,
    `想定媒体: ${media}`,
    `サイズ: ${outputSize === "auto" ? "内容に最適なサイズを選ぶ" : `${outputSize}px`}、スマホで可読性が高い構図。`,
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
    logo_selection: request.logo_selection || ""
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

function loadPromptTemplateConfig() {
  return {
    variants: DEFAULT_VARIANTS,
    text_quality_prompt: DEFAULT_TEXT_QUALITY_PROMPT
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
