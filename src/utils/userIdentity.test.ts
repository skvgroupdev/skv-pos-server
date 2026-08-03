import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLoosePhoneRegex,
  normalizeLaoMobilePhone,
  normalizeUsername,
} from "./userIdentity";

test("normalizes supported Lao mobile phone formats", () => {
  assert.equal(normalizeLaoMobilePhone("20 5555 5555"), "2055555555");
  assert.equal(normalizeLaoMobilePhone("020-5555-5555"), "2055555555");
  assert.equal(normalizeLaoMobilePhone("+856 20 5555 5555"), "2055555555");
  assert.equal(normalizeLaoMobilePhone("85602055555555"), "2055555555");
});

test("rejects invalid login phone values", () => {
  assert.equal(normalizeLaoMobilePhone("205555555"), "");
  assert.equal(normalizeLaoMobilePhone("3055555555"), "");
  assert.equal(normalizeLaoMobilePhone("not-a-phone"), "");
});

test("normalizes usernames without adding a tenant prefix", () => {
  assert.equal(normalizeUsername("  My Employee  "), "myemployee");
  assert.equal(normalizeUsername("cashier.one"), "cashier.one");
});

test("matches legacy formatted phone values", () => {
  const regex = buildLoosePhoneRegex("2055555555");
  assert.match("020 5555 5555", regex);
  assert.match("+856 20 5555 5555", regex);
  assert.doesNotMatch("020 1111 1111", regex);
});
