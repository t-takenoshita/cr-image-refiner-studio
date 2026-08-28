const AUTHENTICATED_KEY = "crir_pages_authenticated";
const PASSWORD_KEY = "crir_site_password";
const IS_GITHUB_PAGES = window.location.hostname.endsWith(".github.io")
  || new URLSearchParams(window.location.search).get("pages-auth-test") === "1";

const shell = document.querySelector("#pages-auth-shell");
const form = document.querySelector("#pages-login-form");
const passwordInput = document.querySelector("#pages-login-password");
const error = document.querySelector("#pages-login-error");
let authConfigPromise;

if (!IS_GITHUB_PAGES) {
  unlockPage();
} else if (
  sessionStorage.getItem(AUTHENTICATED_KEY) === "1"
  && sessionStorage.getItem(PASSWORD_KEY)
) {
  unlockPage();
} else {
  lockPage();
  form.addEventListener("submit", submitPassword);
}

async function submitPassword(event) {
  event.preventDefault();
  const password = passwordInput.value;
  const button = form.querySelector("button[type=submit]");
  error.textContent = "";
  button.disabled = true;
  button.textContent = "確認中…";
  try {
    const config = await loadAuthConfig();
    const actual = await deriveVerifier(password, config);
    const expected = base64ToBytes(config.verifier);
    if (!constantTimeEqual(actual, expected)) throw new Error("パスワードが違います。");
    sessionStorage.setItem(AUTHENTICATED_KEY, "1");
    sessionStorage.setItem(PASSWORD_KEY, password);
    passwordInput.value = "";
    unlockPage();
  } catch (cause) {
    error.textContent = cause.message || "ログインできませんでした。";
    passwordInput.select();
  } finally {
    button.disabled = false;
    button.textContent = "ログインする";
  }
}

function loadAuthConfig() {
  if (!authConfigPromise) {
    authConfigPromise = fetch("./site-auth-config.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("ログイン設定を読み込めませんでした。");
        return response.json();
      })
      .then((config) => {
        if (
          config?.version !== 1
          || config.algorithm !== "PBKDF2-SHA256"
          || !Number.isInteger(config.iterations)
          || config.iterations < 100_000
        ) throw new Error("ログイン設定が不正です。");
        return config;
      });
  }
  return authConfigPromise;
}

async function deriveVerifier(password, config) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64ToBytes(config.salt),
      iterations: config.iterations
    },
    material,
    256
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function lockPage() {
  document.body.classList.add("pages-auth-locked");
  document.body.classList.remove("pages-auth-checking");
  shell.hidden = false;
  requestAnimationFrame(() => passwordInput.focus());
}

function unlockPage() {
  shell.hidden = true;
  document.body.classList.remove("pages-auth-checking", "pages-auth-locked");
  document.body.classList.add("pages-auth-unlocked");
  window.dispatchEvent(new CustomEvent("crir:pages-authenticated"));
}
