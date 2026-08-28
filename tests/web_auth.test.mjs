import test from "node:test";
import assert from "node:assert/strict";
import {
  clearSessionCookie,
  createSessionCookie,
  createSessionToken,
  isAuthenticated,
  isValidPassword,
  parseCookies
} from "../src/web_auth.mjs";

test("validates the shared password without exposing it", () => {
  assert.equal(isValidPassword("correct horse", "correct horse"), true);
  assert.equal(isValidPassword("wrong", "correct horse"), false);
  assert.equal(isValidPassword("", "correct horse"), false);
});

test("creates and validates an HttpOnly session cookie", () => {
  const header = createSessionCookie("local-secret", { secure: true, maxAge: 60 });
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Secure/);
  assert.equal(header.includes("local-secret"), false);
  assert.equal(isAuthenticated({ cookie: header.split(";")[0] }, "local-secret"), true);
  assert.equal(isAuthenticated({ cookie: header.split(";")[0] }, "another-secret"), false);
});

test("parses cookies and clears only the studio session", () => {
  assert.deepEqual(parseCookies("a=1; crir_session=abc%20123"), { a: "1", crir_session: "abc 123" });
  assert.match(clearSessionCookie(), /^crir_session=;/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
  assert.equal(createSessionToken("x"), createSessionToken("x"));
});
