import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "crir_session";
const SESSION_MESSAGE = "cr-image-refiner-authenticated";

function digest(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest();
}

export function isValidPassword(provided, expected) {
  if (!provided || !expected) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

export function createSessionToken(password) {
  return createHmac("sha256", password).update(SESSION_MESSAGE).digest("base64url");
}

export function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [part, ""];
    return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
  }));
}

export function isAuthenticated(headers = {}, password = "") {
  if (!password) return false;
  const token = parseCookies(headers.cookie || "")[SESSION_COOKIE] || "";
  return isValidPassword(token, createSessionToken(password));
}

export function createSessionCookie(password, { secure = false, maxAge = 8 * 60 * 60 } = {}) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(createSessionToken(password))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie({ secure = false } = {}) {
  const attributes = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
