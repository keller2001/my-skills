import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZQAAAAASUVORK5CYII=", "base64");

const articleText = `# 富文本编辑器自包含测试\n\n这篇文章只由测试临时创建。\n\n![中文图](images/%E4%B8%AD%E6%96%87%E5%9B%BE.png)\n\n![空格图](images/space%20name.png)\n`;

function manifest(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replaceAll(path.sep, "/");
      if (entry.isDirectory()) visit(full);
      else entries.push([relative, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
    }
  };
  visit(root);
  return entries;
}

export function createArticleFixture(label) {
  const parent = path.resolve(process.env.MPW_TEST_ROOT || os.tmpdir());
  fs.mkdirSync(parent, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(parent, `mpw-${label}-`));
  const originalRoot = path.join(fixtureRoot, "original-snapshot");
  const workRoot = path.join(fixtureRoot, "work");
  for (const target of [originalRoot, workRoot]) {
    fs.mkdirSync(path.join(target, "images"), { recursive: true });
    fs.writeFileSync(path.join(target, "article.md"), articleText, "utf8");
    fs.writeFileSync(path.join(target, "images", "中文图.png"), onePixelPng);
    fs.writeFileSync(path.join(target, "images", "space name.png"), onePixelPng);
  }
  const originalManifest = manifest(originalRoot);
  return {
    fixtureRoot,
    originalRoot,
    workRoot,
    article: path.join(workRoot, "article.md"),
    images: path.join(workRoot, "images"),
    verifyAndCleanup() {
      try {
        assert.deepEqual(manifest(originalRoot), originalManifest, "原始快照内容或文件集合发生变化");
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    },
  };
}
