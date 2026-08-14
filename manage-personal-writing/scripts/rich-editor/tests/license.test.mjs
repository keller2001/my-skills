import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateLicenseMetadata } from "../src/license-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.resolve(root, "../../assets/rich-editor");

test("缺失和不兼容许可证元数据必须失败", () => {
  assert.throws(() => validateLicenseMetadata([{ location: "missing", metadata: { version: "1.0.0" } }]), /缺少/);
  assert.throws(() => validateLicenseMetadata([{ location: "gpl", metadata: { version: "1.0.0", license: "GPL-3.0" } }]), /不兼容/);
  assert.throws(() => validateLicenseMetadata([{ location: "unknown", metadata: { version: "1.0.0", license: "UNKNOWN" } }]), /不兼容/);
});

test("bundle 元数据与第三方通知逐项对应", () => {
  const notices = fs.readFileSync(path.join(assets, "THIRD_PARTY_NOTICES.txt"), "utf8");
  for (const bundle of ["validator.bundle.mjs", path.join(assets, "editor.bundle.js")]) {
    const text = fs.readFileSync(path.isAbsolute(bundle) ? bundle : path.join(root, bundle), "utf8");
    const manifest = JSON.parse(/^\/\* MPW_BUNDLE_PACKAGES (.+) \*\//.exec(text)?.[1] || "[]");
    assert.ok(manifest.length > 0);
    for (const item of manifest) assert.match(notices, new RegExp(`Package: ${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nVersion: ${item.version.replaceAll(".", "\\.")}\\n`));
  }
  assert.doesNotMatch(notices, /License: (UNKNOWN|GPL|AGPL|SSPL)/i);
});
