import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createArticleFixture } from "./test-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function start(article) {
  const child = spawn(process.execPath, [path.join(root, "server.mjs"), "--article", article], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith("{"));
      if (line) resolve(JSON.parse(line));
    });
    child.once("exit", (code) => reject(new Error(`server exited ${code}\n${stderr}`)));
  });
  return { child, ready };
}

test("运行期间 images 目录被 Junction 替换后冻结写入", { timeout: 45_000 }, async (t) => {
  const fixture = createArticleFixture("path-safety");
  const { article, images } = fixture;
  const originalImages = path.join(fixture.workRoot, "images-original");
  t.after(() => {
    if (fs.existsSync(images) && fs.lstatSync(images).isSymbolicLink()) fs.rmdirSync(images);
    if (fs.existsSync(originalImages) && !fs.existsSync(images)) fs.renameSync(originalImages, images);
    fixture.verifyAndCleanup();
  });
  const running = start(article);
  const info = await running.ready;
  const parsed = new URL(info.url);
  const token = parsed.searchParams.get("token");
  fs.renameSync(images, originalImages);
  const junction = spawnSync("powershell.exe", ["-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:MPW_LINK -Target $env:MPW_TARGET | Out-Null"], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, MPW_LINK: images, MPW_TARGET: originalImages },
  });
  assert.equal(junction.status, 0, junction.stderr);
  const response = await fetch(`${parsed.origin}/api/document?token=${token}`);
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.match(body.error, /冻结写入|Reparse point/);
  running.child.kill();
  await once(running.child, "exit");
  assert.ok(fs.lstatSync(images).isSymbolicLink(), "保留 Junction 测试现场");
  assert.ok(fs.existsSync(path.join(originalImages, ".mpw-recovery")));
});
