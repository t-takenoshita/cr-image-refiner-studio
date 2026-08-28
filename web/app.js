const STORAGE = {
  templates: "crir_templates_v2",
  history: "crir_history_v2"
};
const FIFTEEN_DAYS = 15 * 24 * 60 * 60 * 1000;

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
  generating: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function getStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function setStored(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function switchView(view) {
  state.view = view;
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-visible", panel.dataset.viewPanel === view));
  $$("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $("#sidebar").classList.remove("is-open");
  $("#mobile-menu").setAttribute("aria-expanded", "false");
  if (view === "history") renderHistory();
  if (view === "templates") renderTemplates();
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

function getFormData() {
  const data = Object.fromEntries(new FormData($("#article-form")).entries());
  return {
    articleTitle: data.articleTitle?.trim(),
    targetAudience: data.targetAudience?.trim(),
    problem: data.problem?.trim(),
    direction: data.direction?.trim(),
    requiredCopy: data.requiredCopy?.trim(),
    offer: data.offer?.trim(),
    tone: data.direction?.trim(),
    visualElements: data.problem?.trim()
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function renderPlan() {
  const fields = [
    ["案件", state.form.articleTitle || "未設定"],
    ["ターゲット", state.form.targetAudience || "記事の見込みユーザー"],
    ["変更理由", state.form.problem],
    ["方向性", state.form.direction],
    ["必須コピー", state.form.requiredCopy || "文字なし"],
    ["オファー", state.form.offer || "指定なし"]
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
    state.plan = await api("/api/plan", {
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

async function generateArticle() {
  try {
    state.generating = true;
    goStage(4);
    const comment = $("#marketer-comment").value.trim();
    const images = [];
    for (let index = 0; index < state.plan.variants.length; index += 1) {
      if (!state.generating) return;
      $("#generation-progress").style.width = `${12 + index * 22}%`;
      const variant = state.plan.variants[index];
      const result = await api("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `${variant.prompt}${comment ? `\n追加コメント: ${comment}` : ""}`, references: [state.articleImage, ...state.references].filter(Boolean), count: 1 })
      });
      images.push(result.images[0]);
    }
    state.images = images;
    state.selected = -1;
    renderArticleImages();
    goStage(5);
  } catch (cause) {
    alert(cause.message);
    goStage(3);
  } finally {
    state.generating = false;
  }
}

function renderArticleImages() {
  $("#article-results").innerHTML = state.images.map((image, index) => `<article class="image-card" data-image-index="${index}" tabindex="0" role="button" aria-pressed="${index === state.selected}"><img src="${image.dataUrl}" alt="生成案 ${index + 1}"><footer><strong>生成案 ${index + 1}</strong><span>${index === state.selected ? "✓ 選択中" : "選択"}</span></footer></article>`).join("");
  $("#confirm-selection").disabled = state.selected < 0;
}

function selectArticleImage(index) {
  state.selected = index;
  renderArticleImages();
}

function confirmSelection() {
  const image = state.images[state.selected];
  if (!image) return;
  $("#final-image").innerHTML = `<img src="${image.dataUrl}" alt="採用候補画像">`;
  saveHistory(image);
  goStage(6);
}

function saveHistory(image) {
  const history = getStored(STORAGE.history, []);
  history.unshift({ id: image.id, dataUrl: image.dataUrl, title: state.form.articleTitle || "生成画像", createdAt: Date.now() });
  setStored(STORAGE.history, history.slice(0, 20));
}

function renderHistory() {
  const history = getStored(STORAGE.history, []);
  $("#history-grid").innerHTML = history.length ? history.map((item) => `<article class="history-card"><img src="${item.dataUrl}" alt="${escapeHtml(item.title)}"><div><h3>${escapeHtml(item.title)}</h3><p>${new Date(item.createdAt).toLocaleString("ja-JP")}</p><a class="button button-secondary" href="${item.dataUrl}" download="${escapeHtml(item.title)}.png">保存</a></div></article>`).join("") : `<div class="empty-canvas"><span>◷</span><h2>履歴はまだありません</h2><p>採用候補を確定するとここに保存されます。</p></div>`;
}

function activeTemplates() {
  const now = Date.now();
  const templates = getStored(STORAGE.templates, []).filter((item) => item.expiresAt > now);
  setStored(STORAGE.templates, templates);
  return templates;
}

function saveTemplate() {
  state.form = getFormData();
  if (!state.form.articleTitle) return alert("テンプレート名として案件名を入力してください。");
  const templates = activeTemplates();
  templates.unshift({ id: crypto.randomUUID(), name: state.form.articleTitle, data: state.form, createdAt: Date.now(), expiresAt: Date.now() + FIFTEEN_DAYS });
  setStored(STORAGE.templates, templates);
  alert("テンプレートを15日間保存しました。");
}

function renderTemplates() {
  const templates = activeTemplates();
  $("#template-list").innerHTML = templates.length ? templates.map((item) => `<article class="template-card"><div><h3>${escapeHtml(item.name)}</h3><p>期限：${new Date(item.expiresAt).toLocaleDateString("ja-JP")} · ${escapeHtml(item.data.direction || "")}</p></div><div class="template-actions"><button class="button button-primary" data-template-use="${item.id}">使う</button><button class="button button-secondary" data-template-renew="${item.id}">15日延長</button><button class="button button-secondary" data-template-delete="${item.id}">削除</button></div></article>`).join("") : `<div class="empty-canvas"><span>▤</span><h2>テンプレートはありません</h2><p>記事画像制作の右上から保存できます。</p></div>`;
}

function templateAction(action, id) {
  let templates = activeTemplates();
  const item = templates.find((entry) => entry.id === id);
  if (!item) return;
  if (action === "use") {
    Object.entries(item.data).forEach(([key, value]) => {
      const field = $(`[name="${key}"]`);
      if (field) field.value = value || "";
    });
    switchView("article");
    goStage(1);
    return;
  }
  if (action === "renew") item.expiresAt = Date.now() + FIFTEEN_DAYS;
  if (action === "delete") templates = templates.filter((entry) => entry.id !== id);
  setStored(STORAGE.templates, templates);
  renderTemplates();
}

async function generateFree() {
  const prompt = $("#free-prompt").value.trim();
  const error = $("#free-error");
  error.textContent = "";
  if (!prompt) return error.textContent = "生成したい画像を入力してください。";
  const button = $("#generate-free");
  button.disabled = true;
  button.textContent = "生成しています…";
  $("#free-results").innerHTML = `<div class="spinner"></div><h2>画像を生成中</h2><p>構図を組み立てています。</p>`;
  try {
    const result = await api("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, references: state.freeReferences, count: Number($("#free-count").value) })
    });
    $("#free-results").className = "free-result-grid";
    $("#free-results").innerHTML = result.images.map((image, index) => `<figure><img src="${image.dataUrl}" alt="フリー生成画像 ${index + 1}"><figcaption><a href="${image.dataUrl}" download="free-image-${index + 1}.png">画像を保存</a></figcaption></figure>`).join("");
  } catch (cause) {
    $("#free-results").className = "empty-canvas";
    $("#free-results").innerHTML = `<span>!</span><h2>生成できませんでした</h2><p>${escapeHtml(cause.message)}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = "画像を生成する →";
  }
}

function bindEvents() {
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $("#mobile-menu").addEventListener("click", () => {
    const open = $("#sidebar").classList.toggle("is-open");
    $("#mobile-menu").setAttribute("aria-expanded", String(open));
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
  $("#cancel-generation").addEventListener("click", () => { state.generating = false; goStage(3); });
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
  $("#template-list").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.templateUse) templateAction("use", button.dataset.templateUse);
    if (button.dataset.templateRenew) templateAction("renew", button.dataset.templateRenew);
    if (button.dataset.templateDelete) templateAction("delete", button.dataset.templateDelete);
  });
  $("#generate-free").addEventListener("click", generateFree);
}

bindEvents();
activeTemplates();
