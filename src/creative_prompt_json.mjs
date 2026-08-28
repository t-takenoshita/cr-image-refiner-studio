import { extractResponseText } from "./text_quality_gate.mjs";

export const DEFAULT_CREATIVE_PROMPT_JSON_CONFIG = Object.freeze({
  enabled: false,
  model: "gpt-4o-mini",
  max_output_tokens: 5000
});

export async function generateCreativePromptJson(options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing. Token value was not read or displayed.");
  const config = { ...DEFAULT_CREATIVE_PROMPT_JSON_CONFIG, ...(options.config || {}) };
  const payload = buildCreativePromptJsonPayload(options.promptPack, config);
  const response = await (options.fetchImpl || fetch)("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI creative JSON returned HTTP ${response.status}: ${safeExcerpt(text, apiKey)}`);
  const body = text ? JSON.parse(text) : {};
  const parsed = parseCreativePromptJson(extractResponseText(body));
  return { ...parsed, model: payload.model, response_id: body.id || null, usage: body.usage || null };
}

export function buildCreativePromptJsonPayload(promptPack = {}, config = {}) {
  const summary = promptPack.request_summary || {};
  const brand = promptPack.brand_assets || {};
  const input = {
    request_id: promptPack.request_id || "",
    project_name: summary.project_name || "",
    product: summary.product || "",
    media: summary.media || "",
    creative_title: summary.creative_title || "",
    target_audience: summary.target_audience || "",
    audience_insight: summary.audience_insight || "",
    appeal: summary.appeal || "",
    offer: summary.offer || "",
    required_copy: summary.required_copy || "",
    visual_elements: summary.visual_elements || "",
    proof_copy: summary.proof_copy || "",
    performance_rationale: summary.performance_rationale || "",
    tone: summary.tone || "",
    notes: summary.notes || "",
    landing_page_url: summary.landing_page_url || "",
    reference_url: summary.reference_url || "",
    selected_logo: summary.logo_selection || "なし",
    logo_placement: brand.logo?.enabled ? brand.logo.placement : "none",
    assigned_palettes: (promptPack.variants || []).map((variant, index) => ({
      variant_index: index + 1,
      palette_name: variant.generation_tags?.color_palette_name || "",
      colors: variant.generation_tags?.color_palette_colors || "",
      mood: variant.generation_tags?.color_palette_mood || ""
    }))
  };
  return {
    model: config.model || DEFAULT_CREATIVE_PROMPT_JSON_CONFIG.model,
    input: [{ role: "user", content: [{ type: "input_text", text: buildCreativePromptJsonInstruction(input) }] }],
    text: {
      format: {
        type: "json_schema",
        name: "aicr_creative_prompt",
        strict: true,
        schema: creativePromptJsonSchema()
      }
    },
    max_output_tokens: config.max_output_tokens || DEFAULT_CREATIVE_PROMPT_JSON_CONFIG.max_output_tokens
  };
}

function creativePromptJsonSchema() {
  const string = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "strategy_summary", "variants"],
    properties: {
      schema_version: { type: "string", const: "aicr-creative-prompt-json-v1" },
      strategy_summary: string,
      variants: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["variant_index", "concept_name", "emotional_trigger", "stop_scroll", "read", "convince", "composition", "color_direction", "typography", "image_prompt"],
          properties: {
            variant_index: { type: "integer", minimum: 1, maximum: 4 },
            concept_name: string,
            emotional_trigger: string,
            stop_scroll: objectSchema(["hook", "visual_device"]),
            read: objectSchema(["information_hierarchy", "message"]),
            convince: objectSchema(["reason_to_believe", "transition_motivation"]),
            composition: string,
            color_direction: string,
            typography: string,
            image_prompt: string
          }
        }
      }
    }
  };
}

function objectSchema(keys) {
  return {
    type: "object",
    additionalProperties: false,
    required: keys,
    properties: Object.fromEntries(keys.map((key) => [key, { type: "string" }]))
  };
}

export function buildCreativePromptJsonInstruction(input) {
  const lockedMainCopy = JSON.stringify(String(input.required_copy || ""));
  const lockedOfferCopy = JSON.stringify(String(input.offer || ""));
  return [
    "Image2で日本語の広告画像を4枚生成するためのプロンプトを設計してください。",
    "あなたは、獲得効率とブランド継続性の両方を理解するプロの広告デザイナーです。",
    "JSON形式でプロンプトを出力してから画像生成を行います。",
    "以下の設計要件をメインプロンプトとして可能な限り維持してください。AIによる調整は、依頼値の差し込み、未指定項目の妥当な補完、4案への展開、JSON構造への整理に必要な最小限だけ許可します。訴求、オファー条件、根拠、ターゲット、ブランド条件を勝手に変更しないでください。",
    "",
    "## 目的",
    "依頼JSONの案件名、商材、媒体、ターゲット、インサイト、訴求、オファー、KPI相当の情報を読み取り、未指定項目は根拠を創作せず依頼内容から妥当に設計してください。",
    "ターゲットのBeforeの認識からAfterの認識への態度変容を、各案で明示してください。",
    "4案すべてで依頼JSONのappeal（訴求軸）とvisual_elements（入れたいビジュアル要素）を最優先してください。案番号ごとにベネフィット、悩み共感、BA・施術、オファーへ固定しないでください。",
    "4案の違いは、フォーム指定の訴求とビジュアルを変えることではなく、構図、距離感、場面、トリミング、視線誘導、デザイン処理で作ってください。",
    "BA、施術場面、悩み場面、商品、人物などを、appealまたはvisual_elementsに明示されていないのに案番号だけを理由として追加しないでください。",
    "LPのファーストビューのように、世界観・訴求・オファーが一目で伝わる1080x1080の正方形広告にしてください。",
    "1枚で伝えるメッセージは1つです。説明広告ではなく、ターゲットの思い込みを1つ変える広告にしてください。",
    "記事LP / LPと、感情の約束、オファー表現、証拠の順番、デザイン温度を揃えてください。",
    "各案は必ず、①ターゲットの手を止める ②内容を読む ③納得して記事へ遷移する、という3つの壁を順番に超える設計にしてください。",
    "",
    "## 画像内コピー",
    `固定主コピー: ${lockedMainCopy}`,
    `固定オファーコピー: ${lockedOfferCopy}`,
    "固定主コピーと固定オファーコピーはフォーム回答の原文です。どちらも一字一句変更せず、全4案のimage_promptへそのまま含めてください。言い換え、要約、補足、語尾変更、表記変更、句読点の追加・削除は禁止です。",
    "固定文言の改行、文字サイズ、色、書体、配置、帯などのデザインは各案に合わせて調整できます。",
    "画像内に含める文字・記号・英字は、image_prompt内で明示する確定文言だけです。",
    "確定文言は一字一句変えず、余計な句読点、ダミー英字、架空ロゴ、読めない文字、飾り文字を追加しないでください。引用符そのものは描画しません。",
    "依頼にない誘導文言は無理に作らず、不要なら省略してください。",
    "",
    "## 構図・文字設計",
    "視線は『主コピー → 主ビジュアル → オファー』の順に流してください。",
    "主役は1つに絞り、四辺に十分な余白を確保し、スマホ表示でも0.5秒で主コピーとオファーを理解できる構図にしてください。",
    "主コピーを最も大きく、極太で読みやすい日本語ゴシック体にし、オファーを2番目、誘導文言を3番目の階層にしてください。",
    "文字のジャンプ率と背景コントラストを大きくし、小さい長文、細い文字、文字詰まり、端に寄りすぎた配置を避けてください。",
    "",
    "## ビジュアル・世界観",
    "visual_elementsに具体的な人物・商品・部位・場面・モチーフがある場合は、全4案で必ず採用してください。別の主役へ置き換えないでください。",
    "visual_elementsが空欄または『特になし』の場合だけ、appeal、主コピー、ターゲットから最適なビジュアルを案ごとに提案してください。",
    "notes（補足メモ）のビジュアル指定はvisual_elementsを補強する情報として反映してください。ただしvisual_elementsと矛盾する場合はvisual_elementsを優先してください。",
    "配色は依頼JSONのassigned_palettesを案番号ごとに必ず引き継ぎ、4案で同じ色調へ収束させないでください。",
    "notes（補足メモ）に明示的な色指定がある場合だけ、その指定をassigned_palettesより優先してください。補足メモの色指定を無視、弱化、別色へ置換してはいけません。toneはデザインの雰囲気として扱い、色指定の根拠にはしないでください。",
    "明示的なピンク指定がなく、担当assigned_paletteにもピンクが含まれない案を、ピンク系・ローズ系・マゼンタ系へ変更しないでください。",
    "帯・下線・付箋・吹き出し等は必要最小限とし、案件固有の世界観を明確にして汎用ストック広告に見せないでください。",
    "実写人物や商品は、自然光、実在する広告撮影、自然な肌理、わずかな生活感を持たせてください。",
    "正面の作り笑顔だけでなく、斜め向き、手元、横顔、後ろ姿など自然な瞬間を優先し、必要に応じて85mm相当、浅い被写界深度、candid、slightly imperfectの質感を使ってください。",
    "完璧すぎる肌、不自然なツヤ、過度な左右対称、均質なAIライティングを避けてください。",
    "",
    "## オファー・ブランド・根拠",
    "オファーの固定条件を変えず、始めやすさ、希少性、費用対効果、相談しやすさのうち依頼に合う見せ方を選んでください。",
    "CTAボタンは禁止とし、必要な誘導文言は短い下部帯・ラベル・付箋で表示してください。予約から施術までの流れや簡単3STEPは入れません。",
    "根拠はproof_copyにあるものだけを使い、なければ根拠数字を使わないでください。",
    "ロゴは後工程で正方形広告の外側・上部左寄せに追加します。広告内にロゴやロゴ風文字を生成しないでください。",
    "必須注釈は後工程で正確に合成するため、画像生成内には入れないでください。",
    "根拠のない実績、価格、割引率、満足度、No.1、保証、期限、医療結果を追加しないでください。",
    "",
    "## 厳格なNG",
    "過度なあしらい、装飾過多、情報過多、主コピーを弱くする小見出しや説明文、文字や人物を端まで詰めることを禁止します。",
    "原色同士の衝突、虹色、蛍光色、多色使い、架空のロゴ・UI・口コミ・星評価・権威バッジを禁止します。",
    "根拠のない『無料』『限定』『本日終了』『必ず』『完全』『No.1』を禁止します。",
    "極端なBefore/After、身体的コンプレックスを過度に煽る表現、ターゲットや参考人物の顔・年齢・性別・ブランド条件の勝手な変更を禁止します。",
    "画像内コピー以外の文字・記号・英字、予約・相談・来院・施術までを説明する3STEP表現を禁止します。",
    "",
    "## 生成品質",
    "広告感は保ちつつAI生成らしい過剰な整い方を避け、ターゲットが『自分向けだ』と瞬時に理解できる画像CRにしてください。",
    "各image_promptの末尾に、誰向けか、1枚1メッセージ、視線順、指定外文字、誤字、スマホ可読性、余白、根拠、LP連続性を生成時に自己点検する指示を含めてください。",
    "4案の訴求軸・構図・クリック理由は重複させないでください。",
    "最終的なimage_promptは、そのまま画像生成APIへ渡せる具体的な日本語指示にしてください。",
    "次のJSONのみを出力してください。Markdownや説明文は禁止です。",
    JSON.stringify({
      schema_version: "aicr-creative-prompt-json-v1",
      strategy_summary: "依頼全体の戦略",
      variants: [{
        variant_index: 1,
        concept_name: "案名",
        emotional_trigger: "動かす感情",
        stop_scroll: { hook: "手を止める要素", visual_device: "視覚的仕掛け" },
        read: { information_hierarchy: "読む順番", message: "理解させる内容" },
        convince: { reason_to_believe: "納得材料", transition_motivation: "記事へ進む動機" },
        composition: "構図",
        color_direction: "配色",
        typography: "文字設計",
        image_prompt: "画像生成APIへ渡す完成プロンプト"
      }]
    }),
    "variantsはvariant_index 1〜4の4件を必ず含めてください。",
    `依頼JSON: ${JSON.stringify(input)}`
  ].join("\n");
}

export function parseCreativePromptJson(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.variants) || parsed.variants.length !== 4) throw new Error("Creative prompt JSON must contain exactly 4 variants.");
  parsed.variants.forEach((variant, index) => {
    if (Number(variant.variant_index) !== index + 1) throw new Error(`Creative prompt JSON variant_index must be ${index + 1}.`);
    if (!String(variant.image_prompt || "").trim()) throw new Error(`Creative prompt JSON variant ${index + 1} is missing image_prompt.`);
  });
  return { schema_version: "aicr-creative-prompt-json-v1", ...parsed };
}

export function applyCreativePromptJson(promptPack, creativeJson) {
  const summary = promptPack.request_summary || {};
  return {
    ...promptPack,
    creative_prompt_json: creativeJson,
    variants: promptPack.variants.map((variant, index) => ({
      ...variant,
      prompt: appendGenerationContracts(creativeJson.variants[index].image_prompt, summary, variant),
      creative_strategy: creativeJson.variants[index]
    }))
  };
}

function appendGenerationContracts(imagePrompt, summary, variant) {
  const mainCopy = String(summary.required_copy || "");
  const offerCopy = String(summary.offer || "");
  const tone = String(summary.tone || "");
  const notes = String(summary.notes || "");
  const appeal = String(summary.appeal || "");
  const visualElements = String(summary.visual_elements || "");
  const paletteName = String(variant.generation_tags?.color_palette_name || "");
  const paletteColors = String(variant.generation_tags?.color_palette_colors || "");
  return [
    String(imagePrompt || "").trim(),
    "",
    "【フォーム原文・最優先の固定文字契約】",
    `主コピー: ${JSON.stringify(mainCopy)}`,
    `オファーコピー: ${JSON.stringify(offerCopy)}`,
    "上記2文言は一字一句変更せず描画する。言い換え・要約・補足・追記・削除・句読点変更は禁止。改行・サイズ・色・書体・位置・帯などのデザイン調整のみ許可する。上記以外の文字・記号・英字は描画しない。",
    "",
    "【訴求・ビジュアル契約・最優先】",
    `フォームの訴求軸: ${JSON.stringify(appeal)}`,
    `フォームの入れたいビジュアル要素: ${JSON.stringify(visualElements)}`,
    `フォームの補足メモ: ${JSON.stringify(notes)}`,
    "全4案で上記の訴求軸と入れたいビジュアル要素を最優先する。案番号を理由に、画像1=ベネフィット、画像2=悩み共感、画像3=BA・施術、画像4=オファーという固定割り当てを行わない。指定ビジュアルを別の人物・商品・場面へ置き換えない。BA、施術、悩み場面はフォームに明示がある場合だけ使用する。ビジュアル要素が空欄または「特になし」の場合だけ、訴求軸・主コピー・ターゲットから適切な主役を提案する。4案の差は構図、距離感、場面、トリミング、視線誘導、デザイン処理で作る。",
    "",
    "【配色契約・最優先】",
    `フォームの希望テイスト（雰囲気のみ・色固定には使わない）: ${JSON.stringify(tone)}`,
    `フォームの補足メモ: ${JSON.stringify(notes)}`,
    `この案の指定パレット: ${JSON.stringify(paletteName)} / ${JSON.stringify(paletteColors)}`,
    "補足メモに明示的な色指定がある場合だけ、その色指定を最優先して正確に反映する。希望テイストは雰囲気の参考に留め、色固定には使用しない。補足メモに明示色がない場合は、この案の指定パレットを主配色として使用する。他案と同じピンク系へ勝手に統一しない。補足メモのピンク指定または指定パレットへのピンク記載がない場合、ピンク・ローズ・マゼンタを主色にしない。"
  ].join("\n");
}

function safeExcerpt(text, token) {
  return String(text || "").replaceAll(token, "[redacted]").slice(0, 300);
}
