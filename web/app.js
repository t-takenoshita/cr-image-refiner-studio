import {
  clearSitePassword,
  clearGithubToken,
  dispatchPagesGeneration,
  isPagesMode,
  readGithubToken,
  readSitePassword,
  saveGithubToken,
  saveSitePassword,
  validateGithubToken,
  waitForPagesGeneration
} from "./github-pages.js";
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
const PAGES_MODE = isPagesMode();

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
  generating: false,
  generationController: null
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

function switchView(view) {
  if (state.view === "history" && view !== "history") revokeHistoryObjectUrls();
  state.view = view;
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-visible", panel.dataset.viewPanel === view));
  $$("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $("#sidebar").classList.remove("is-open");
  $("#mobile-menu").setAttribute("aria-expanded", "false");
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
  const job = await dispatchPagesGeneration({ token, sitePassword, mode, payload, references });
  return waitForPagesGeneration({
    token,
    job,
    signal: state.generationController?.signal,
    onStatus
  });
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
        { form: state.form, comment },
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
  const existing = readGithubToken();
  const existingPassword = readSitePassword();
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
  $("#site-password").value = existingPassword;
  $("#site-password").closest(".field").hidden = Boolean(PAGES_MODE && existingPassword);
  $("#github-token-error").textContent = "";
  $("#github-token-dialog").showModal();
  return promise;
}

async function submitGithubToken(event) {
  event.preventDefault();
  const token = $("#github-token").value.trim();
  const sitePassword = $("#site-password").value || readSitePassword();
  const button = $("#save-github-token");
  const error = $("#github-token-error");
  error.textContent = "";
  button.disabled = true;
  button.textContent = "確認中…";
  try {
    await validateGithubToken(token);
    if (!sitePassword) throw new Error("サイトパスワードを入力してください。");
    saveGithubToken(token);
    saveSitePassword(sitePassword);
    $("#github-token-dialog").close();
    pendingTokenRequest?.resolve({ token, sitePassword });
    pendingTokenRequest = null;
    updateConnectionUi();
  } catch (cause) {
    error.textContent = cause.message;
  } finally {
    button.disabled = false;
    button.textContent = "接続する";
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
  $("#github-connect").classList.toggle("is-connected", connected);
  $("#github-connect-label").textContent = connected ? "GitHub接続済み" : "GitHub接続";
  $("#runtime-status .status-dot").classList.toggle("is-waiting", !connected);
  $("#runtime-status small").textContent = connected ? "Actionsバックグラウンド生成" : "初回のみGitHub接続が必要";
}

async function toggleGithubConnection() {
  if (readGithubToken()) {
    clearGithubToken();
    updateConnectionUi();
    return;
  }
  try { await requireGithubCredentials(); } catch {}
}

function initializeMode() {
  const connect = $("#github-connect");
  const logout = $(".logout-form");
  if (PAGES_MODE) {
    connect.hidden = false;
    logout.hidden = false;
    $("#runtime-mode-label").textContent = "GitHub Pagesモード";
    $("#privacy-copy").innerHTML = "<strong>一時保存</strong><br>参考画像は処理開始後、生成結果は12時間後にGitHubから削除します。";
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
    await saveTemplateEntry({ id: crypto.randomUUID(), name: state.form.articleTitle, data: state.form, createdAt: Date.now(), expiresAt: Date.now() + FIFTEEN_DAYS });
    alert("テンプレートを15日間保存しました。");
  } catch (cause) {
    alert(`テンプレートを保存できませんでした: ${cause.message}`);
  }
}

async function renderTemplates() {
  try {
    const templates = await listActiveTemplates();
    $("#template-list").innerHTML = templates.length ? templates.map((item) => `<article class="template-card"><div><h3>${escapeHtml(item.name)}</h3><p>期限：${new Date(item.expiresAt).toLocaleDateString("ja-JP")} · ${escapeHtml(item.data.direction || "")}</p></div><div class="template-actions"><button class="button button-primary" data-template-use="${item.id}">使う</button><button class="button button-secondary" data-template-renew="${item.id}">15日延長</button><button class="button button-secondary" data-template-delete="${item.id}">削除</button></div></article>`).join("") : `<div class="empty-canvas"><span>▤</span><h2>テンプレートはありません</h2><p>記事画像制作の右上から保存できます。</p></div>`;
  } catch (cause) {
    $("#template-list").innerHTML = `<div class="empty-canvas"><span>!</span><h2>テンプレートを開けませんでした</h2><p>${escapeHtml(cause.message)}</p></div>`;
  }
}

async function templateAction(action, id) {
  const templates = await listActiveTemplates();
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
  if (action === "renew") {
    item.expiresAt = Date.now() + FIFTEEN_DAYS;
    await saveTemplateEntry(item);
  }
  if (action === "delete") await deleteTemplateEntries([id]);
  await renderTemplates();
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
    state.generationController = new AbortController();
    const result = PAGES_MODE
      ? await runPagesJob(
          "free",
          { prompt, count: Number($("#free-count").value) },
          state.freeReferences,
          ({ message }) => { $("#free-results").innerHTML = `<div class="spinner"></div><h2>画像を生成中</h2><p>${escapeHtml(message)}</p>`; }
        )
      : await api("/api/generate", {
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
    state.generationController = null;
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
  $("#template-list").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.templateUse) templateAction("use", button.dataset.templateUse);
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
bindEvents();
initializeBrowserDatabase().catch((cause) => console.error("[IndexedDB]", cause.message));
setInterval(async () => {
  await listActiveHistory();
  await listActiveTemplates();
  if (state.view === "history") await renderHistory();
  if (state.view === "templates") await renderTemplates();
}, 15 * 60 * 1000);
