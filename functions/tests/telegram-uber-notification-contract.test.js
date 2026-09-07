"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("Telegram reconoce proofUrl de cierres Uber", () => {
  assert.match(source, /data\.proofUrl/);
  assert.match(source, /notifyUberClosureTelegramGroupV1/);
  assert.match(source, /document: "uber_weekly_closures\/{docId}"/);
});
