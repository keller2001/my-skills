import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createArticleFixture, onePixelPng } from "./test-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = createArticleFixture("server");
const { article, images } = fixture;
after(() => fixture.verifyAndCleanup());

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(root, "server.mjs"), "--article", article], {
    cwd: root, windowsHide: true, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error(`server startup timeout\n${stderr}`)), 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith("{"));
      if (!line) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`server exited ${code}\n${stderr}`)); });
  });
  return { child, ready, stderr: () => stderr };
}

function apiClient(info) {
  const parsed = new URL(info.url);
  const token = parsed.searchParams.get("token");
  const call = async (route, options = {}) => {
    const url = new URL(route, info.url);
    url.searchParams.set("token", token);
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };
  return call;
}

async function stopServer(child, call, hash) {
  if (call && hash) await call("/api/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedHash: hash }) }).catch(() => {});
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill();
}

test("既有中文和空格图片名可打开、读取与复制", { timeout: 40_000 }, async () => {
  const running = startServer();
  const info = await running.ready;
  const call = apiClient(info);
  const opened = await call("/api/document");
  assert.equal(opened.response.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.readOnly, false, JSON.stringify(opened.body.diagnostics));
  assert.deepEqual(opened.body.missingImages, []);
  for (const filename of ["中文图.png", "space name.png"]) {
    const image = await call(`/images/${encodeURIComponent(filename)}`);
    assert.equal(image.response.status, 200, filename);
  }
  const copied = await call("/api/copy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedHash: opened.body.hash }) });
  assert.equal(copied.response.status, 200, JSON.stringify(copied.body));
  assert.equal((copied.body.html.match(/data:image\/png;base64,/g) || []).length, 2);
  await stopServer(running.child, call, opened.body.hash);
});

test("打开不改写、Pipe 互斥、图片、保存、复制和回退全流程", { timeout: 60_000 }, async () => {
  const baseline = fs.readFileSync(article);
  const first = startServer();
  const info = await first.ready;
  const call = apiClient(info);
  let opened = await call("/api/document");
  if (opened.body.recovery?.type === "orphan-artifacts") {
    const resolved = await call("/api/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "discard-orphans" }) });
    assert.equal(resolved.response.status, 200, JSON.stringify(resolved.body));
    opened = await call("/api/document");
  }
  assert.equal(opened.response.status, 200);
  assert.deepEqual(fs.readFileSync(article), baseline, "仅打开和读取不应改写 article.md");

  const second = startServer();
  second.ready.catch(() => {});
  const [secondCode] = await once(second.child, "exit");
  assert.equal(secondCode, 2);
  assert.match(second.stderr(), /已在编辑/);

  const upload = await call("/api/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: onePixelPng });
  assert.equal(upload.response.status, 200, JSON.stringify(upload.body));
  assert.match(upload.body.path, /^images\/img-[a-f0-9]{12}\.png$/);
  assert.ok(fs.existsSync(path.join(path.dirname(article), upload.body.path.replaceAll("/", path.sep))));

  const doc = opened.body.doc;
  doc.content = doc.content.filter((node) => node.type !== "image");
  doc.content.push({ type: "paragraph", attrs: { align: "right" }, content: [{ type: "text", text: "集成保存测试" }] });
  doc.content.push({ type: "image", attrs: { src: upload.body.path, alt: "1x1", title: null, align: "center", uploadId: null } });
  const saved = await call("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc, expectedHash: opened.body.hash }) });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  assert.notEqual(saved.body.hash, opened.body.hash);
  assert.ok(fs.existsSync(path.join(images, ".mpw-recovery", "previous.md")));

  const copied = await call("/api/copy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedHash: saved.body.hash }) });
  assert.equal(copied.response.status, 200, JSON.stringify(copied.body));
  assert.match(copied.body.html, /data:image\/png;base64,/);
  assert.match(copied.body.html, /text-align:right/);
  assert.doesNotMatch(copied.body.html, /<script|\son\w+=|ProseMirror|localhost|127\.0\.0\.1:\d+\/images/i);
  assert.match(copied.body.plain, /集成保存测试/);

  const rolled = await call("/api/rollback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedHash: saved.body.hash }) });
  assert.equal(rolled.response.status, 200, JSON.stringify(rolled.body));
  assert.deepEqual(fs.readFileSync(article), baseline);
  await stopServer(first.child, call, rolled.body.hash);
});

test("连续五轮编辑、保存、关闭、重开", { timeout: 120_000 }, async () => {
  for (let round = 1; round <= 5; round += 1) {
    const running = startServer();
    const info = await running.ready;
    const call = apiClient(info);
    const opened = await call("/api/document");
    assert.equal(opened.response.status, 200, JSON.stringify(opened.body));
    const doc = opened.body.doc;
    doc.content = doc.content.filter((node) => node.type !== "image");
    doc.content.push({ type: "paragraph", attrs: { align: round % 2 ? "center" : "right" }, content: [{ type: "text", text: `第 ${round} 轮编辑` }] });
    const saved = await call("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc, expectedHash: opened.body.hash }) });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    await stopServer(running.child, call, saved.body.hash);
  }
  const text = fs.readFileSync(article, "utf8");
  for (let round = 1; round <= 5; round += 1) assert.match(text, new RegExp(`第 ${round} 轮编辑`));
});

test("外部修改冲突不覆盖", { timeout: 40_000 }, async () => {
  const running = startServer();
  const info = await running.ready;
  const call = apiClient(info);
  const opened = await call("/api/document");
  fs.appendFileSync(article, "\n外部修改保留\n", "utf8");
  const response = await call("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: opened.body.doc, expectedHash: opened.body.hash }) });
  assert.equal(response.response.status, 409);
  assert.match(fs.readFileSync(article, "utf8"), /外部修改保留/);
  running.child.kill();
  await once(running.child, "exit");
});

test("超限图片请求只报错不截断写入", { timeout: 40_000 }, async () => {
  const running = startServer();
  const info = await running.ready;
  const call = apiClient(info);
  const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, 0);
  const result = await call("/api/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: oversized });
  assert.equal(result.response.status, 413);
  const opened = await call("/api/document");
  await stopServer(running.child, call, opened.body.hash);
});

test("保存和回退的可注入事务阶段被强杀后可判定恢复", { timeout: 300_000 }, async () => {
  const baseline = startServer();
  const baselineInfo = await baseline.ready;
  const baselineCall = apiClient(baselineInfo);
  let baselineState = await baselineCall("/api/document");
  if (baselineState.body.recovery) {
    const action = baselineState.body.recovery.type === "orphan-artifacts" ? "discard-orphans"
      : baselineState.body.recovery.type === "save-prepared" ? "complete-save"
      : baselineState.body.recovery.type === "rollback-prepared" ? "complete-rollback" : "complete-exchange";
    await baselineCall("/api/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    baselineState = await baselineCall("/api/document");
  }
  await stopServer(baseline.child, baselineCall, baselineState.body.hash);

  const savePhases = ["during-candidate", "after-candidate", "during-transaction", "after-transaction", "after-old-previous", "before-replace", "after-replace"];
  for (const phase of savePhases) {
    const killed = startServer({ MPW_TEST_KILL_PHASE: phase });
    const info = await killed.ready;
    const call = apiClient(info);
    const opened = await call("/api/document");
    const doc = opened.body.doc;
    doc.content = doc.content.filter((node) => node.type !== "image");
    doc.content.push({ type: "paragraph", attrs: { align: "left" }, content: [{ type: "text", text: `强杀保存阶段 ${phase}` }] });
    await assert.rejects(call("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc, expectedHash: opened.body.hash }) }));
    if (killed.child.exitCode === null) await once(killed.child, "exit");

    const recovered = startServer();
    const recoveredInfo = await recovered.ready;
    const recoveredCall = apiClient(recoveredInfo);
    let state = await recoveredCall("/api/document");
    if (state.body.recovery) {
      const action = state.body.recovery.type === "orphan-artifacts" ? "discard-orphans" : "complete-save";
      const resolved = await recoveredCall("/api/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      assert.equal(resolved.response.status, 200, JSON.stringify(resolved.body));
      state = await recoveredCall("/api/document");
    }
    assert.equal(state.body.readOnly, false, JSON.stringify(state.body));
    await stopServer(recovered.child, recoveredCall, state.body.hash);
  }

  const rollbackPhases = ["during-rollback-transaction", "after-rollback-transaction", "after-rollback-replace", "before-swap-rename", "after-swap-rename"];
  for (const phase of rollbackPhases) {
    const killed = startServer({ MPW_TEST_KILL_PHASE: phase });
    const info = await killed.ready;
    const call = apiClient(info);
    const opened = await call("/api/document");
    await assert.rejects(call("/api/rollback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedHash: opened.body.hash }) }));
    if (killed.child.exitCode === null) await once(killed.child, "exit");

    const recovered = startServer();
    const recoveredInfo = await recovered.ready;
    const recoveredCall = apiClient(recoveredInfo);
    let state = await recoveredCall("/api/document");
    if (state.body.recovery) {
      const action = state.body.recovery.type === "orphan-artifacts" ? "discard-orphans"
        : state.body.recovery.type === "rollback-prepared" ? "complete-rollback" : "complete-exchange";
      const resolved = await recoveredCall("/api/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      assert.equal(resolved.response.status, 200, JSON.stringify(resolved.body));
      state = await recoveredCall("/api/document");
    }
    assert.equal(state.body.readOnly, false, JSON.stringify(state.body));
    await stopServer(recovered.child, recoveredCall, state.body.hash);
  }
  assert.deepEqual(fs.readdirSync(path.join(images, ".mpw-recovery")).sort(), ["previous.md", "transaction.json"]);
});
