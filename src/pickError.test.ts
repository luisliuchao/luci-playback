import assert from "node:assert/strict";
import { test } from "node:test";
import { explainPickError } from "./pickError.ts";

test("replaces the browser system-files error with a Luci-home hint", () => {
  const error = new DOMException("The selected folder contains system files.", "SecurityError");
  assert.match(explainPickError(error), /Luci home/);
  assert.doesNotMatch(explainPickError(error), /system files/i);
});

test("keeps our own folder messages", () => {
  assert.match(explainPickError(new Error("That is not a Luci home folder.")), /Luci home folder/);
});
