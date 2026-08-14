import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.resolve(root, "../../assets/rich-editor");
const files = [
  path.join(assets, "index.html"), path.join(assets, "editor.css"), path.join(assets, "theme.css"),
  path.join(assets, "editor.bundle.js"), path.join(root, "validator.bundle.mjs"), path.join(root, "server.mjs"),
  path.join(root, "launch.cmd"), path.join(root, "launch.ps1"),
];

test("离线交付文件不含远程加载、CDN、遥测或更新检查", () => {
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /(?:src|href)\s*=\s*["']https?:\/\//i, file);
    assert.doesNotMatch(text, /import\s*\(\s*["']https?:\/\//i, file);
    assert.doesNotMatch(text, /(?:fetch|XMLHttpRequest|EventSource|WebSocket)\s*\(\s*["']https?:\/\/(?!127\.0\.0\.1|localhost)/i, file);
    assert.doesNotMatch(text, /\b(?:cdn|telemetry|analytics|update[-_ ]?check)\b/i, file);
  }
});

test("正式启动器只调用本地 Node 和内置脚本", () => {
  const cmd = fs.readFileSync(path.join(root, "launch.cmd"), "utf8");
  const ps = fs.readFileSync(path.join(root, "launch.ps1"), "utf8");
  assert.match(cmd, /launch\.ps1/);
  assert.match(ps, /server\.mjs/);
  assert.doesNotMatch(`${cmd}\n${ps}`, /npm|npx|Invoke-WebRequest|curl|Start-BitsTransfer/i);
});
