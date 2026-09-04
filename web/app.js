import {
  clearSitePassword,
  clearGithubToken,
  deleteEncryptedGithubToken,
  dispatchPagesGeneration,
  exportEncryptedGithubToken,
  importEncryptedGithubToken,
  isPagesMode,
  readGithubToken,
  readSitePassword,
  restoreEncryptedGithubToken,
  saveEncryptedGithubToken,
  saveSitePassword,
  validateGithubToken,
  waitForPagesGeneration
} from "./github-pages.js?v=3";
import {
  clearHistoryEntries,
  deleteHistoryEntries,
  deleteTemplateEntries,
  historyBytes,
  listActiveHistory,
  listActiveTemplates,
  migrateLocalStorageHistory,
  migrateLocalStorageTemplates,
  saveHistoryEntry,
  saveTemplateEntry,
  trimHistoryEntries
} from "./image-history-db.js";

const LEGACY_STORAGE = {
  templates: "crir_templates_v2",
  history: "crir_history_v2"
};
const FIFTEEN_DAYS = 15 * 24 * 60 * 60 * 1000;
const HISTORY_TTL = 3 * 24 * 60 * 60 * 1000;
const LP_DRAFT_STORAGE = "crir_lp_draft_v1";
const PAGES_MODE = isPagesMode();

const LP_TONES = Object.freeze({
  logical: { label: "理詰め", direction: "情報の優先順位を明確にし、比較しやすい端正な構図" },
  trust: { label: "信頼", direction: "誇張を避け、安心材料と人物の自然な表情を丁寧に見せる構図" },
  bold: { label: "勢い", direction: "主役を大きく置き、強いコントラストと短い視線導線で決断を促す構図" },
  luxury: { label: "上質", direction: "余白と質感を活かし、情報量を絞って品よく見せる構図" },
  friendly: { label: "親しみ", direction: "生活者の距離感に寄せ、自然光と身近な情景で見せる構図" },
  experimental: { label: "実験的", direction: "定石から少しずらしたトリミングと編集的な配置で印象を残す構図" }
});

const state = {
  view: "article",
  stage: 1,
  articleImage: null,
  references: [],
  freeReferences: [],
  form: {},
  plan: null,
  images: [],
  selected: -1,
  selectedHistoryIds: new Set(),
  historyObjectUrls: [],
  editingTemplateId: null,
  generating: false,
  generationController: null,
  lpReference: null,
  lpHeroImage: null
};
let pendingTokenRequest = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function getStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function qualityLabel(quality = "medium") {
  return ({ low: "低", medium: "標準", high: "高", auto: "AIに任せる" })[quality] || "標準";
}

function updateMobileMenu(open) {
  const button = $("#mobile-menu");
  button.classList.toggle("is-open", open);
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", open ? "メニューを閉じる" : "メニューを開く");
  button.querySelector("span").textContent = open ? "×" : "☰";
}

function switchView(view) {
  if (state.view === "history" && view !== "history") revokeHistoryObjectUrls();
  state.view = view;
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-visible", panel.dataset.viewPanel === view));
  $$("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $("#sidebar").classList.remove("is-open");
  updateMobileMenu(false);
  if (view === "history") void renderHistory();
  if (view === "templates") void renderTemplates();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goStage(stage) {
  state.stage = stage;
  $$("[data-stage]").forEach((panel) => panel.classList.toggle("is-visible", Number(panel.dataset.stage) === stage));
  $$("#stepper li").forEach((item, index) => {
    item.classList.toggle("is-current", index + 1 === stage);
    item.classList.toggle("is-done", index + 1 < stage);
    if (index + 1 < stage) item.querySelector("span").textContent = "✓";
    else item.querySelector("span").textContent = String(index + 1);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function fileToDataUrl(file) {
  if (!file) return null;
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function setFiles(input, target, max = 4) {
  const files = [...input.files].slice(0, max);
  const values = await Promise.all(files.map(fileToDataUrl));
  state[target] = values.filter(Boolean);
  const previewId = target === "freeReferences" ? "#free-reference-preview" : "#reference-preview";
  $(previewId).innerHTML = state[target].map((src) => `<img src="${src}" alt="参考画像">`).join("");
}

function getLpFormData() {
  const form = $("#lp-form");
  const checkedTone = $("input[name='tone']:checked", form);
  return {
    product: $("#lp-product").value.trim(),
    target: $("#lp-target").value.trim(),
    promise: $("#lp-promise").value.trim(),
    goal: $("#lp-goal").value,
    problem: $("#lp-problem").value.trim(),
    benefit: $("#lp-benefit").value.trim(),
    proof: $("#lp-proof").value.trim(),
    offer: $("#lp-offer").value.trim(),
    cta: $("#lp-cta").value.trim(),
    tone: checkedTone?.value || "logical",
    sections: $$('input[name="sections"]:checked', form).map((input) => input.value),
    visual: $("#lp-visual-direction").value.trim(),
    imageSize: $("#lp-image-size").value,
    imageQuality: $("#lp-image-quality").value
  };
}

function buildLpSections(data) {
  const definitions = {
    problem: ["悩み・共感", data.problem || "読者が抱える具体的な悩みを入力"],
    solution: ["解決方法", data.promise || "商品が悩みを解く仕組みを入力"],
    benefit: ["選ばれる理由", data.benefit || "比較したときに選ばれる理由を入力"],
    proof: ["根拠・実績", data.proof || "実績・監修・レビューなど、確認できる根拠を追加"],
    flow: ["利用の流れ", data.goal ? `${data.goal}までの手順と所要時間を整理` : "申し込みから利用までの手順を整理"],
    faq: ["よくある質問", "購入や申し込みを止める不安を、質問と回答で解消"],
    closing: ["最後の後押し", data.offer || `主導線「${data.cta || data.goal || "未選択"}」へ進む前の不安を解消`]
  };
  return data.sections.map((key) => ({ key, title: definitions[key][0], body: definitions[key][1], pending: !data[key] && ["problem", "benefit", "proof"].includes(key) }));
}

function saveLpDraft(data) {
  try {
    localStorage.setItem(LP_DRAFT_STORAGE, JSON.stringify(data));
    $("#lp-draft-status").innerHTML = '<span aria-hidden="true">●</span>下書き保存済み';
  } catch {
    $("#lp-draft-status").innerHTML = '<span aria-hidden="true">!</span>下書きを保存できません';
  }
}

function restoreLpDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(LP_DRAFT_STORAGE)); }
  catch { draft = null; }
  if (!draft || typeof draft !== "object") {
    renderLpBlueprint();
    return;
  }

  const fieldIds = {
    product: "#lp-product",
    target: "#lp-target",
    promise: "#lp-promise",
    goal: "#lp-goal",
    problem: "#lp-problem",
    benefit: "#lp-benefit",
    proof: "#lp-proof",
    offer: "#lp-offer",
    cta: "#lp-cta",
    visual: "#lp-visual-direction",
    imageSize: "#lp-image-size",
    imageQuality: "#lp-image-quality"
  };
  Object.entries(fieldIds).forEach(([key, selector]) => {
    if (typeof draft[key] === "string" && $(selector)) $(selector).value = draft[key];
  });
  if (LP_TONES[draft.tone]) {
    const tone = $(`input[name="tone"][value="${draft.tone}"]`);
    if (tone) tone.checked = true;
  }
  if (Array.isArray(draft.sections)) {
    $$('input[name="sections"]').forEach((input) => { input.checked = draft.sections.includes(input.value); });
  }
  $("#lp-draft-status").innerHTML = '<span aria-hidden="true">●</span>下書きを復元';
  renderLpBlueprint();
}

function renderLpBlueprint() {
  const data = getLpFormData();
  const tone = LP_TONES[data.tone] || LP_TONES.logical;
  const sections = buildLpSections(data);
  const ready = [data.product, data.target, data.promise, data.goal].filter(Boolean).length;
  const cta = data.cta || data.goal || "主導線を選択";
  let subcopy = "商品と届けたい相手を入力すると、ここにファーストビューの骨格が出ます。";
  if (data.product && data.target) subcopy = `${data.target}に向けて、${data.product}の価値がひと目で伝わる導入。`;
  else if (data.product) subcopy = `${data.product}を誰に届けるか入力してください。`;
  else if (data.target) subcopy = `${data.target}に届ける商品・サービスを入力してください。`;

  $("#lp-preview-sheet").dataset.tone = data.tone;
  $("#lp-preview-tone").textContent = tone.label;
  $("#lp-preview-headline").textContent = data.promise || "一番伝えたい約束を入力";
  $("#lp-preview-sub").textContent = subcopy;
  $("#lp-preview-cta").textContent = cta;
  $("#lp-readiness-value").textContent = `${ready} / 4`;
  $("#lp-readiness-bar").style.setProperty("--lp-progress", String(ready / 4));
  $("#lp-preview-count").textContent = `${sections.length + 1}セクション`;
  $("#lp-preview-flow").innerHTML = sections.map((section, index) => `<article class="lp-flow-item ${section.pending ? "is-pending" : ""}"><span class="lp-flow-index">${String(index + 2).padStart(2, "0")}</span><div><h3>${escapeHtml(section.title)}</h3><p>${escapeHtml(section.body)}</p></div></article>`).join("");
}

function setLpTool(tabName) {
  $$("[data-lp-tab]").forEach((button) => {
    const active = button.dataset.lpTab === tabName;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$("[data-lp-panel]").forEach((panel) => { panel.hidden = panel.dataset.lpPanel !== tabName; });
}

function validateLpField(field) {
  const wrapper = field.closest("[data-lp-field]");
  if (!wrapper) return true;
  const helper = field.getAttribute("aria-describedby") ? $(`#${field.getAttribute("aria-describedby")}`) : null;
  const valid = !field.required || Boolean(field.value.trim());
  field.setAttribute("aria-invalid", String(!valid));
  wrapper.dataset.state = valid && field.value.trim() ? "success" : valid ? "default" : "error";
  if (helper) {
    helper.textContent = valid
      ? helper.dataset.defaultCopy || ""
      : field.tagName === "SELECT"
        ? "主導線が未選択です。LPで一番促す行動を選んでください。"
        : `${field.labels?.[0]?.textContent.replace("＊", "").replace("必須", "").trim() || "この項目"}が未入力です。内容を入力してください。`;
  }
  return valid;
}

function setLpActionState(button, status, label) {
  button.dataset.state = status;
  button.querySelector(".lp-button-label").textContent = label;
}

function resetLpAction(button, label, delay = 1800) {
  window.setTimeout(() => setLpActionState(button, "default", label), delay);
}

function reviewLpDesign() {
  const required = $$("#lp-form [required]");
  required.forEach((field) => { field.dataset.touched = "true"; });
  const invalid = required.filter((field) => !validateLpField(field));
  const button = $("#lp-review");
  if (invalid.length) {
    const panel = invalid[0].closest("[data-lp-panel]");
    if (panel) setLpTool(panel.dataset.lpPanel);
    setLpActionState(button, "error", "未入力を確認");
    invalid[0].focus({ preventScroll: true });
    invalid[0].scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    resetLpAction(button, "設計を確認");
    return;
  }

  renderLpBlueprint();
  saveLpDraft(getLpFormData());
  setLpActionState(button, "success", "設計を更新済み");
  $(".lp-preview").scrollIntoView?.({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  resetLpAction(button, "設計を確認");
}

function lpOutlineText(data) {
  const tone = LP_TONES[data.tone] || LP_TONES.logical;
  const sections = buildLpSections(data);
  return [
    `LP設計図：${data.product || "商品・サービス未入力"}`,
    `ターゲット：${data.target || "未入力"}`,
    `約束する変化：${data.promise || "未入力"}`,
    `主導線：${data.cta || data.goal || "未選択"}`,
    `トーン：${tone.label}`,
    "",
    "01 ファーストビュー",
    `見出し：${data.promise || "要入力"}`,
    `補足：${data.target && data.product ? `${data.target}に向けて、${data.product}の価値を伝える` : "要入力"}`,
    ...sections.flatMap((section, index) => ["", `${String(index + 2).padStart(2, "0")} ${section.title}`, section.body]),
    "",
    `素材方向：${data.visual || "未入力"}`,
    "注：事実未確認の数字は使用しない"
  ].join("\n");
}

async function copyLpOutline() {
  const button = $("#lp-copy-outline");
  setLpActionState(button, "loading", "コピー中");
  try {
    await navigator.clipboard.writeText(lpOutlineText(getLpFormData()));
    setLpActionState(button, "success", "コピー済み");
  } catch {
    setLpActionState(button, "error", "コピーできません");
  }
  resetLpAction(button, "設計図をコピー", 2500);
}

async function saveLpHeroHistory(image, title) {
  const response = await fetch(image.dataUrl);
  if (!response.ok) throw new Error("生成画像を読み込めませんでした。");
  const now = Date.now();
  await saveHistoryEntry({
    id: image.id || crypto.randomUUID(),
    blob: await response.blob(),
    title: `${title || "LP"}・FV素材`,
    createdAt: now,
    expiresAt: now + HISTORY_TTL
  });
  await trimHistoryEntries(20);
}

async function generateLpHero() {
  const data = getLpFormData();
  const required = [$("#lp-product"), $("#lp-target"), $("#lp-promise")];
  const invalid = required.filter((field) => {
    field.dataset.touched = "true";
    return !validateLpField(field);
  });
  const button = $("#lp-generate-hero");
  const error = $("#lp-visual-error");
  error.textContent = "";
  if (invalid.length) {
    setLpTool("brief");
    setLpActionState(button, "error", "基本情報を確認");
    resetLpAction(button, "FV素材を1枚生成");
    return;
  }

  const tone = LP_TONES[data.tone] || LP_TONES.logical;
  const prompt = [
    "ランディングページのファーストビューに使う横長の背景素材を1枚生成してください。",
    `商品・サービス: ${data.product}`,
    `想定する閲覧者: ${data.target}`,
    `ページで伝える変化: ${data.promise}`,
    `トーンと構図: ${tone.direction}`,
    `見せたい情景・被写体: ${data.visual || "商品・サービスの内容が直感的に伝わる自然な情景"}`,
    "文字、記号、架空ロゴは一切入れない。コピーを重ねる余白を画面左側に確保する。過度に左右対称な構図と均質なAI風ライティングは避ける。"
  ].join("\n");

  button.disabled = true;
  setLpActionState(button, "loading", "FV素材を生成中");
  $("#lp-hero-visual").innerHTML = '<div><span>FV</span><p>背景素材を生成しています</p></div>';
  try {
    state.generationController = new AbortController();
    const result = PAGES_MODE
      ? await runPagesJob(
          "free",
          { prompt, count: 1, generationConfig: { size: data.imageSize, quality: data.imageQuality } },
          state.lpReference ? [state.lpReference] : [],
          ({ message }) => { $("#lp-hero-visual").innerHTML = `<div><span>FV</span><p>${escapeHtml(message)}</p></div>`; }
        )
      : await api("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, references: state.lpReference ? [state.lpReference] : [], count: 1, generationConfig: { size: data.imageSize, quality: data.imageQuality } })
        });
    const image = result.images[0];
    state.lpHeroImage = image;
    const [width, height] = data.imageSize.split("x").map(Number);
    $("#lp-hero-visual").innerHTML = `<img src="${image.dataUrl}" alt="${escapeHtml(data.product)}のLP用ファーストビュー素材" width="${width || 1536}" height="${height || 1024}">`;
    await saveLpHeroHistory(image, data.product);
    setLpActionState(button, "success", "生成して履歴に保存");
  } catch (cause) {
    error.textContent = `FV素材を生成できませんでした。${cause.message} 設定を確認して再試行してください。`;
    $("#lp-hero-visual").innerHTML = '<div><span>!</span><p>素材を生成できませんでした</p></div>';
    setLpActionState(button, "error", "もう一度生成");
  } finally {
    state.generationController = null;
    button.disabled = false;
    if (button.dataset.state === "success") resetLpAction(button, "FV素材を1枚生成", 2500);
  }
}

function getFormData() {
  const data = Object.fromEntries(new FormData($("#article-form")).entries());
  return {
    articleTitle: data.articleTitle?.trim(),
    targetAudience: data.targetAudience?.trim(),
    problem: data.problem?.trim(),
    direction: data.direction?.trim(),
    requiredCopy: data.requiredCopy?.trim(),
    offer: data.offer?.trim(),
    imageSize: data.imageSize || "1088x1088",
    imageQuality: data.imageQuality || "medium",
    tone: data.direction?.trim(),
    visualElements: data.problem?.trim(),
    submittedAt: state.form.submittedAt || new Date().toISOString()
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && payload.loginRequired) {
    window.location.assign("./login");
    throw new Error("ログインが必要です。");
  }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function browserPlan() {
  const variants = [
    ["直球訴求", "指定内容をそのまま主役にする構成"],
    ["利用シーン", "自然な生活・利用場面として見せる構成"],
    ["クローズアップ", "人物や商品のディテールを大きく見せる構成"],
    ["エディトリアル", "情報を整理した編集的なレイアウト"]
  ];
  return {
    requestId: crypto.randomUUID(),
    variants: variants.map(([name, description], index) => ({
      id: `browser-v${index + 1}`,
      index: index + 1,
      tags: { color_palette_name: name, design_tone_hint: description }
    }))
  };
}

function renderPlan() {
  const fields = [
    ["案件", state.form.articleTitle || "未設定"],
    ["ターゲット", state.form.targetAudience || "記事の見込みユーザー"],
    ["変更理由", state.form.problem],
    ["方向性", state.form.direction],
    ["必須コピー", state.form.requiredCopy || "文字なし"],
    ["オファー", state.form.offer || "指定なし"],
    ["生成設定", `${state.form.imageSize || "1088x1088"}・${qualityLabel(state.form.imageQuality)}`]
  ];
  $("#requirements").innerHTML = fields.map(([label, value]) => `<div class="requirement"><span>◇</span><div><b>${escapeHtml(label)}</b><br>${escapeHtml(value || "指定なし")}</div></div>`).join("");
  $("#variant-list").innerHTML = state.plan.variants.map((variant, index) => `<article class="variant-card"><span class="variant-index">0${index + 1}</span><div><h3>${escapeHtml(variant.tags?.color_palette_name || `構図案 ${index + 1}`)}</h3><p>${escapeHtml(variant.tags?.design_tone_hint || variant.tags?.composition || "依頼内容を維持した別構図")}</p></div></article>`).join("");
  $("#review-summary").innerHTML = fields.map(([label, value]) => `<div class="review-row"><b>${escapeHtml(label)}</b><span>${escapeHtml(value || "指定なし")}</span></div>`).join("");
}

async function planArticle(event) {
  event.preventDefault();
  const error = $("#form-error");
  error.textContent = "";
  state.form = getFormData();
  if (!state.form.articleTitle || !state.form.problem || !state.form.direction) {
    error.textContent = "案件名・変更理由・変更方向を入力してください。";
    return;
  }
  const button = event.submitter;
  button.disabled = true;
  button.textContent = "AI要件を整理中…";
  try {
    state.plan = PAGES_MODE
      ? browserPlan()
      : await api("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state.form)
        });
    renderPlan();
    goStage(2);
  } catch (cause) {
    error.textContent = cause.message;
  } finally {
    button.disabled = false;
    button.textContent = "AIに要件を整理してもらう →";
  }
}

function updateGenerationStatus(message, progress = 15) {
  $("#generation-status").textContent = message;
  const bar = $("#generation-progress");
  bar.classList.add("is-determinate");
  bar.style.setProperty("--progress", String(Math.max(0.05, Math.min(1, progress / 100))));
}

async function runPagesJob(mode, payload, references, onStatus) {
  const { token, sitePassword } = await requireGithubCredentials();
  try {
    const job = await dispatchPagesGeneration({ token, sitePassword, mode, payload, references });
    return await waitForPagesGeneration({
      token,
      sitePassword,
      job,
      signal: state.generationController?.signal,
      onStatus
    });
  } catch (cause) {
    if (/GitHub API: (Bad credentials|Resource not accessible|Not Found)/i.test(cause.message || "")) {
      clearGithubToken();
      updateConnectionUi();
    }
    throw cause;
  }
}

async function generateArticle() {
  try {
    state.generating = true;
    state.generationController = new AbortController();
    goStage(4);
    const comment = $("#marketer-comment").value.trim();
    let images;

    if (PAGES_MODE) {
      updateGenerationStatus("参考画像をGitHubへ一時送信しています…", 10);
      const result = await runPagesJob(
        "article",
        {
          form: state.form,
          comment,
          generationConfig: { size: state.form.imageSize, quality: state.form.imageQuality }
        },
        [state.articleImage, ...state.references].filter(Boolean),
        ({ message, progress }) => updateGenerationStatus(message, progress)
      );
      images = result.images;
    } else {
      images = [];
      for (let index = 0; index < state.plan.variants.length; index += 1) {
        if (!state.generating) return;
        updateGenerationStatus(`構図案 ${index + 1}/4 を生成しています…`, 12 + index * 22);
        const variant = state.plan.variants[index];
        const result = await api("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: `${variant.prompt}${comment ? `\n追加コメント: ${comment}` : ""}`,
            references: [state.articleImage, ...state.references].filter(Boolean),
            generationConfig: { size: state.form.imageSize, quality: state.form.imageQuality },
            count: 1
          })
        });
        images.push(result.images[0]);
      }
    }

    state.images = images;
    state.selected = -1;
    renderArticleImages();
    goStage(5);
  } catch (cause) {
    if (cause.name !== "AbortError") alert(cause.message);
    goStage(3);
  } finally {
    state.generating = false;
    state.generationController = null;
  }
}

function renderArticleImages() {
  $("#article-results").innerHTML = state.images.map((image, index) => `<article class="image-card ${index === state.selected ? "is-selected" : ""}" data-image-index="${index}" tabindex="0" role="button" aria-pressed="${index === state.selected}"><img src="${image.dataUrl}" alt="生成案 ${index + 1}"><footer><strong>生成案 ${index + 1}</strong><span>${index === state.selected ? "✓ 選択中" : "選択"}</span></footer></article>`).join("");
  $("#confirm-selection").disabled = state.selected < 0;
}

function selectArticleImage(index) {
  state.selected = index;
  renderArticleImages();
}

async function confirmSelection() {
  const image = state.images[state.selected];
  if (!image) return;
  $("#final-image").innerHTML = `<img src="${image.dataUrl}" alt="採用候補画像">`;
  try {
    await saveHistory(image);
  } catch (cause) {
    alert(`画像履歴を保存できませんでした: ${cause.message}`);
  }
  goStage(6);
}

async function saveHistory(image) {
  const now = Date.now();
  const response = await fetch(image.dataUrl);
  if (!response.ok) throw new Error("生成画像を読み込めませんでした。");
  await saveHistoryEntry({
    id: image.id || crypto.randomUUID(),
    blob: await response.blob(),
    title: state.form.articleTitle || "生成画像",
    createdAt: now,
    expiresAt: now + HISTORY_TTL
  });
  await trimHistoryEntries(20);
}

async function renderHistory() {
  try {
    const history = await listActiveHistory();
    revokeHistoryObjectUrls();
    const activeIds = new Set(history.map((item) => item.id));
    state.selectedHistoryIds = new Set([...state.selectedHistoryIds].filter((id) => activeIds.has(id)));
    $("#history-storage-size").textContent = `画像データ ${formatBytes(historyBytes(history))} · 3日保存`;
    $("#delete-selected-history").disabled = state.selectedHistoryIds.size === 0;
    $("#clear-history").disabled = history.length === 0;
    $("#history-grid").innerHTML = history.length ? history.map((item) => {
      const selected = state.selectedHistoryIds.has(item.id);
      const objectUrl = URL.createObjectURL(item.blob);
      state.historyObjectUrls.push(objectUrl);
      return `<article class="history-card ${selected ? "is-selected" : ""}"><label class="history-select"><input type="checkbox" data-history-select="${escapeHtml(item.id)}" ${selected ? "checked" : ""}><span>削除対象に選択</span></label><img src="${objectUrl}" alt="${escapeHtml(item.title)}"><div><h3>${escapeHtml(item.title)}</h3><p>${new Date(item.createdAt).toLocaleString("ja-JP")} · ${remainingTime(item.expiresAt)}</p><a class="button button-secondary" href="${objectUrl}" download="${escapeHtml(item.title)}.png">保存</a></div></article>`;
    }).join("") : `<div class="empty-canvas"><span>◷</span><h2>履歴はまだありません</h2><p>採用候補を確定すると3日間保存されます。</p></div>`;
  } catch (cause) {
    $("#history-grid").innerHTML = `<div class="empty-canvas"><span>!</span><h2>履歴を開けませんでした</h2><p>${escapeHtml(cause.message)}</p></div>`;
  }
}

function revokeHistoryObjectUrls() {
  for (const url of state.historyObjectUrls) URL.revokeObjectURL(url);
  state.historyObjectUrls = [];
}

async function deleteSelectedHistory() {
  if (!state.selectedHistoryIds.size) return;
  await deleteHistoryEntries([...state.selectedHistoryIds]);
  state.selectedHistoryIds.clear();
  await renderHistory();
}

async function clearHistory() {
  if (!window.confirm("ブラウザに保存した画像履歴をすべて削除しますか？")) return;
  await clearHistoryEntries();
  state.selectedHistoryIds.clear();
  await renderHistory();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function remainingTime(expiresAt) {
  const hours = Math.max(0, Math.ceil((Number(expiresAt) - Date.now()) / (60 * 60 * 1000)));
  return `残り約${hours}時間`;
}

async function requireGithubCredentials() {
  const existingPassword = readSitePassword();
  let existing = readGithubToken();
  if (!existing && existingPassword) {
    try { existing = await restoreEncryptedGithubToken(existingPassword); }
    catch { clearGithubToken(); }
  }
  if (existing && existingPassword) return { token: existing, sitePassword: existingPassword };
  if (pendingTokenRequest) return pendingTokenRequest.promise;

  let resolveRequest;
  let rejectRequest;
  const promise = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  pendingTokenRequest = { promise, resolve: resolveRequest, reject: rejectRequest };
  $("#github-token").value = "";
  $("#github-token").required = true;
  $("#github-token").placeholder = "github_pat_...";
  $("#site-password").value = existingPassword;
  $("#site-password").closest(".field").hidden = Boolean(PAGES_MODE && existingPassword);
  $("#github-token-error").textContent = "";
  $("#save-github-token").textContent = "接続して保存";
  $("#github-token-dialog").showModal();
  return promise;
}

async function submitGithubToken(event) {
  event.preventDefault();
  const token = $("#github-token").value.trim() || readGithubToken();
  const sitePassword = $("#site-password").value || readSitePassword();
  const button = $("#save-github-token");
  const error = $("#github-token-error");
  error.textContent = "";
  button.disabled = true;
  button.textContent = "確認中…";
  try {
    await validateGithubToken(token);
    if (!sitePassword) throw new Error("サイトパスワードを入力してください。");
    await saveEncryptedGithubToken(token, sitePassword);
    saveSitePassword(sitePassword);
    $("#github-token-dialog").close();
    pendingTokenRequest?.resolve({ token, sitePassword });
    pendingTokenRequest = null;
    updateConnectionUi();
  } catch (cause) {
    error.textContent = cause.message;
  } finally {
    button.disabled = false;
    button.textContent = "接続して保存";
  }
}

function cancelGithubToken() {
  $("#github-token-dialog").close();
  pendingTokenRequest?.reject(new DOMException("GitHub接続がキャンセルされました。", "AbortError"));
  pendingTokenRequest = null;
}

function updateConnectionUi() {
  if (!PAGES_MODE) return;
  const connected = Boolean(readGithubToken() && readSitePassword());
  $("#github-connect").hidden = connected;
  $("#github-connect").classList.toggle("is-connected", connected);
  $("#github-connect-label").textContent = connected ? "GitHub接続済み" : "GitHub接続";
  $("#runtime-status .status-dot").classList.toggle("is-waiting", !connected);
  $("#runtime-status small").textContent = connected ? "Actionsバックグラウンド生成" : "初回のみGitHub接続が必要";
}

async function toggleGithubConnection() {
  const password = readSitePassword();
  if (!readGithubToken() && password) {
    try { await restoreEncryptedGithubToken(password); } catch {}
  }
  const connected = Boolean(readGithubToken());
  $("#github-token").value = "";
  $("#github-token").required = !connected;
  $("#github-token").placeholder = connected ? "更新する場合だけ新しいtokenを入力" : "github_pat_...";
  $("#site-password").value = password;
  $("#site-password").closest(".field").hidden = Boolean(PAGES_MODE && password);
  $("#github-token-error").textContent = "";
  $("#save-github-token").textContent = connected ? "接続情報を更新" : "接続して保存";
  $("#github-token-dialog").showModal();
}

async function exportGithubConnection() {
  const error = $("#github-token-error");
  try {
    const payload = await exportEncryptedGithubToken();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "cr-image-refiner-connection.json";
    link.click();
    URL.revokeObjectURL(url);
    error.textContent = "暗号化済み接続ファイルを書き出しました。";
  } catch (cause) {
    error.textContent = cause.message;
  }
}

async function importGithubConnection(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const error = $("#github-token-error");
  try {
    const password = readSitePassword() || $("#site-password").value;
    if (!password) throw new Error("先にサイトパスワードを入力してください。");
    const payload = JSON.parse(await file.text());
    await importEncryptedGithubToken(payload, password);
    saveSitePassword(password);
    updateConnectionUi();
    $("#github-token-dialog").close();
    pendingTokenRequest?.resolve({ token: readGithubToken(), sitePassword: password });
    pendingTokenRequest = null;
  } catch (cause) {
    error.textContent = cause.message || "接続ファイルを読み込めませんでした。";
  } finally {
    event.target.value = "";
  }
}

async function deleteGithubConnection() {
  if (!window.confirm("このブラウザに保存したGitHub tokenを削除しますか？")) return;
  await deleteEncryptedGithubToken();
  $("#github-token-dialog").close();
  pendingTokenRequest?.reject(new DOMException("GitHub接続が削除されました。", "AbortError"));
  pendingTokenRequest = null;
  updateConnectionUi();
}

async function restoreGithubConnection() {
  if (!PAGES_MODE || !readSitePassword()) return;
  try { await restoreEncryptedGithubToken(readSitePassword()); }
  catch (cause) { console.warn("[GitHub connection]", cause.message); }
  updateConnectionUi();
}

function initializeMode() {
  const connect = $("#github-connect");
  const logout = $(".logout-form");
  if (PAGES_MODE) {
    connect.hidden = false;
    logout.hidden = true;
    $("#runtime-mode-label").textContent = "GitHub Pagesモード";
    $("#privacy-copy").innerHTML = "<strong>暗号化一時保存</strong><br>画像は暗号化して受け渡し、完了通知は12時間後に削除します。";
    updateConnectionUi();
  } else {
    connect.hidden = true;
    logout.hidden = false;
  }
}

async function saveTemplate() {
  state.form = getFormData();
  if (!state.form.articleTitle) return alert("テンプレート名として案件名を入力してください。");
  try {
    const now = Date.now();
    if (state.editingTemplateId) {
      const templates = await listActiveTemplates();
      const current = templates.find((item) => item.id === state.editingTemplateId);
      if (!current) throw new Error("更新するテンプレートが見つかりません。もう一度選び直してください。");
      await saveTemplateEntry({
        ...current,
        name: state.form.articleTitle,
        data: state.form,
        updatedAt: now,
        expiresAt: now + FIFTEEN_DAYS
      });
      setTemplateEditMode(null);
      alert("テンプレート内容を更新し、保存期限を15日後へ延長しました。");
      return;
    }
    await saveTemplateEntry({ id: crypto.randomUUID(), name: state.form.articleTitle, data: state.form, createdAt: now, updatedAt: now, expiresAt: now + FIFTEEN_DAYS });
    alert("テンプレートを15日間保存しました。");
  } catch (cause) {
    alert(`テンプレートを保存できませんでした: ${cause.message}`);
  }
}

function setTemplateEditMode(item) {
  state.editingTemplateId = item?.id || null;
  $("#template-editing-label").hidden = !item;
  $("#template-editing-label").textContent = item ? `編集中：${item.name}` : "テンプレート編集中";
  $("#cancel-template-edit").hidden = !item;
  $("#save-template").textContent = item ? "内容を更新して15日延長" : "テンプレート保存";
}

function applyTemplateToForm(item, { editing = false } = {}) {
  Object.entries(item.data).forEach(([key, value]) => {
    const field = $(`[name="${key}"]`);
    if (field) field.value = value || "";
  });
  setTemplateEditMode(editing ? item : null);
  switchView("article");
  goStage(1);
}

async function renderTemplates() {
  try {
    const templates = await listActiveTemplates();
    $("#template-list").innerHTML = templates.length ? templates.map((item) => `<article class="template-card"><div><h3>${escapeHtml(item.name)}</h3><p>期限：${new Date(item.expiresAt).toLocaleDateString("ja-JP")} · ${escapeHtml(item.data.direction || "")}</p></div><div class="template-actions"><button class="button button-primary" data-template-use="${item.id}">使う</button><button class="button button-secondary" data-template-edit="${item.id}">内容を編集</button><button class="button button-secondary" data-template-renew="${item.id}">期限を15日延長</button><button class="button button-secondary" data-template-delete="${item.id}">削除</button></div></article>`).join("") : `<div class="empty-canvas"><span>▤</span><h2>テンプレートはありません</h2><p>記事画像制作の右上から保存できます。</p></div>`;
  } catch (cause) {
    $("#template-list").innerHTML = `<div class="empty-canvas"><span>!</span><h2>テンプレートを開けませんでした</h2><p>${escapeHtml(cause.message)}</p></div>`;
  }
}

async function templateAction(action, id) {
  const templates = await listActiveTemplates();
  const item = templates.find((entry) => entry.id === id);
  if (!item) return;
  if (action === "use") {
    applyTemplateToForm(item);
    return;
  }
  if (action === "edit") {
    applyTemplateToForm(item, { editing: true });
    return;
  }
  if (action === "renew") {
    item.updatedAt = Date.now();
    item.expiresAt = Date.now() + FIFTEEN_DAYS;
    await saveTemplateEntry(item);
  }
  if (action === "delete") {
    await deleteTemplateEntries([id]);
    if (state.editingTemplateId === id) setTemplateEditMode(null);
  }
  await renderTemplates();
}

async function generateFree() {
  const prompt = $("#free-prompt").value.trim();
  const error = $("#free-error");
  error.textContent = "";
  if (!prompt) return error.textContent = "生成したい画像を入力してください。";
  const button = $("#generate-free");
  const generationConfig = {
    size: $("#free-image-size").value,
    quality: $("#free-image-quality").value
  };
  button.disabled = true;
  button.textContent = "生成しています…";
  $("#free-results").innerHTML = `<div class="spinner"></div><h2>画像を生成中</h2><p>構図を組み立てています。</p>`;
  try {
    state.generationController = new AbortController();
    const result = PAGES_MODE
      ? await runPagesJob(
          "free",
          { prompt, count: Number($("#free-count").value), generationConfig },
          state.freeReferences,
          ({ message }) => { $("#free-results").innerHTML = `<div class="spinner"></div><h2>画像を生成中</h2><p>${escapeHtml(message)}</p>`; }
        )
      : await api("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, references: state.freeReferences, count: Number($("#free-count").value), generationConfig })
        });
    $("#free-results").className = "free-result-grid";
    $("#free-results").innerHTML = result.images.map((image, index) => `<figure><img src="${image.dataUrl}" alt="フリー生成画像 ${index + 1}"><figcaption><a href="${image.dataUrl}" download="free-image-${index + 1}.png">画像を保存</a></figcaption></figure>`).join("");
  } catch (cause) {
    $("#free-results").className = "empty-canvas";
    $("#free-results").innerHTML = `<span>!</span><h2>生成できませんでした</h2><p>${escapeHtml(cause.message)}</p>`;
  } finally {
    state.generationController = null;
    button.disabled = false;
    button.textContent = "画像を生成する →";
  }
}

function bindEvents() {
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$("[data-lp-tab]").forEach((button) => button.addEventListener("click", () => setLpTool(button.dataset.lpTab)));
  $("#lp-form").addEventListener("input", (event) => {
    const field = event.target.closest("input, textarea, select");
    if (field?.dataset.touched) validateLpField(field);
    renderLpBlueprint();
    saveLpDraft(getLpFormData());
  });
  $("#lp-form").addEventListener("focusout", (event) => {
    const field = event.target.closest("[data-lp-field] input, [data-lp-field] textarea, [data-lp-field] select");
    if (!field) return;
    field.dataset.touched = "true";
    validateLpField(field);
  });
  $("#lp-review").addEventListener("click", reviewLpDesign);
  $("#lp-copy-outline").addEventListener("click", copyLpOutline);
  $("#lp-generate-hero").addEventListener("click", generateLpHero);
  $("#lp-reference").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    state.lpReference = await fileToDataUrl(file);
    $("#lp-reference-name").textContent = file ? file.name : "任意・1枚";
    event.target.closest(".upload-zone").classList.toggle("has-reference", Boolean(file));
  });
  $("#mobile-menu").addEventListener("click", () => {
    const open = $("#sidebar").classList.toggle("is-open");
    updateMobileMenu(open);
  });
  $("#article-form").addEventListener("submit", planArticle);
  $("#article-image").addEventListener("change", async (event) => {
    state.articleImage = await fileToDataUrl(event.target.files[0]);
    $("#article-preview").src = state.articleImage || "";
    event.target.closest(".upload-zone").classList.toggle("has-image", Boolean(state.articleImage));
  });
  $("#reference-images").addEventListener("change", (event) => setFiles(event.target, "references", 3));
  $("#free-reference").addEventListener("change", (event) => setFiles(event.target, "freeReferences", 4));
  $$("[data-back]").forEach((button) => button.addEventListener("click", () => goStage(Number(button.dataset.back))));
  $$("[data-next]").forEach((button) => button.addEventListener("click", () => goStage(Number(button.dataset.next))));
  $("#generate-article").addEventListener("click", generateArticle);
  $("#cancel-generation").addEventListener("click", () => {
    state.generating = false;
    state.generationController?.abort();
    goStage(3);
  });
  $("#article-results").addEventListener("click", (event) => {
    const card = event.target.closest("[data-image-index]");
    if (card) selectArticleImage(Number(card.dataset.imageIndex));
  });
  $("#article-results").addEventListener("keydown", (event) => {
    const card = event.target.closest("[data-image-index]");
    if (card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); selectArticleImage(Number(card.dataset.imageIndex)); }
  });
  $("#confirm-selection").addEventListener("click", confirmSelection);
  $("#download-final").addEventListener("click", () => {
    const image = state.images[state.selected];
    if (!image) return;
    const link = document.createElement("a"); link.href = image.dataUrl; link.download = `${state.form.articleTitle || "creative"}.png`; link.click();
  });
  $("#revise-final").addEventListener("click", () => goStage(3));
  $("#save-template").addEventListener("click", saveTemplate);
  $("#cancel-template-edit").addEventListener("click", () => setTemplateEditMode(null));
  $("#template-list").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.templateUse) templateAction("use", button.dataset.templateUse);
    if (button.dataset.templateEdit) templateAction("edit", button.dataset.templateEdit);
    if (button.dataset.templateRenew) templateAction("renew", button.dataset.templateRenew);
    if (button.dataset.templateDelete) templateAction("delete", button.dataset.templateDelete);
  });
  $("#generate-free").addEventListener("click", generateFree);
  $("#history-grid").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-history-select]");
    if (!checkbox) return;
    if (checkbox.checked) state.selectedHistoryIds.add(checkbox.dataset.historySelect);
    else state.selectedHistoryIds.delete(checkbox.dataset.historySelect);
    void renderHistory();
  });
  $("#delete-selected-history").addEventListener("click", deleteSelectedHistory);
  $("#clear-history").addEventListener("click", clearHistory);
  $("#github-connect").addEventListener("click", toggleGithubConnection);
  $("#github-token-form").addEventListener("submit", submitGithubToken);
  $("#cancel-github-token").addEventListener("click", cancelGithubToken);
  $("#export-github-token").addEventListener("click", exportGithubConnection);
  $("#import-github-token").addEventListener("change", importGithubConnection);
  $("#delete-github-token").addEventListener("click", deleteGithubConnection);
  $(".logout-form").addEventListener("submit", (event) => {
    if (!PAGES_MODE) return;
    event.preventDefault();
    sessionStorage.removeItem("crir_pages_authenticated");
    clearGithubToken();
    clearSitePassword();
    window.location.reload();
  });
}

async function initializeBrowserDatabase() {
  const legacyHistory = getStored(LEGACY_STORAGE.history, []);
  const legacyTemplates = getStored(LEGACY_STORAGE.templates, []);
  await migrateLocalStorageHistory(legacyHistory, HISTORY_TTL);
  await migrateLocalStorageTemplates(legacyTemplates);
  try {
    localStorage.removeItem(LEGACY_STORAGE.history);
    localStorage.removeItem(LEGACY_STORAGE.templates);
  } catch {
    // IndexedDB remains the active store even when legacy storage is unavailable.
  }
  await listActiveHistory();
  await listActiveTemplates();
}

initializeMode();
restoreLpDraft();
bindEvents();
initializeBrowserDatabase().catch((cause) => console.error("[IndexedDB]", cause.message));
window.addEventListener("crir:pages-authenticated", () => void restoreGithubConnection());
void restoreGithubConnection();
setInterval(async () => {
  await listActiveHistory();
  await listActiveTemplates();
  if (state.view === "history") await renderHistory();
  if (state.view === "templates") await renderTemplates();
}, 15 * 60 * 1000);
