import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createArticleFixture } from "./test-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = createArticleFixture("edge");
const { article } = fixture;
const evidenceRoot = path.join(fixture.fixtureRoot, "edge-evidence");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else this.events.push(message);
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    const timeout = new Promise((_, reject) => setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`CDP call timeout: ${method}`));
    }, 15_000));
    return Promise.race([result, timeout]);
  }
  close() { this.socket.close(); }
}

function startServer() {
  const child = spawn(process.execPath, [path.join(root, "server.mjs"), "--article", article], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`server timeout\n${stderr}`)), 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith("{"));
      if (!line) return;
      clearTimeout(timer); resolve(JSON.parse(line));
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}\n${stderr}`)); });
  });
  return { child, ready };
}

async function waitForFile(file, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${file}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "browser evaluation failed");
  return result.result.value;
}

async function waitUntil(check, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("browser condition timeout");
}

test("真实 Edge 中编辑、自动保存、关闭等待锁定、双 MIME 复制、隔离预览与本地请求", { timeout: 120_000 }, async (t) => {
  assert.ok(fs.existsSync(edge), "本机 Edge 不存在");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  let running;
  let edgeProcess;
  let browser;
  let page;
  t.after(async () => {
    page?.close();
    browser?.close();
    if (edgeProcess?.pid && edgeProcess.exitCode === null) spawnSync("taskkill.exe", ["/PID", String(edgeProcess.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    if (running?.child?.exitCode === null) running.child.kill();
    if (running?.child && running.child.exitCode === null) await Promise.race([once(running.child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    fixture.verifyAndCleanup();
  });
  running = startServer();
  const info = await running.ready;
  const origin = new URL(info.url).origin;
  const profile = path.join(evidenceRoot, "profile");
  edgeProcess = spawn(edge, ["--headless=new", "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  const activePort = path.join(profile, "DevToolsActivePort");
  await waitForFile(activePort);
  const [port, browserPath] = fs.readFileSync(activePort, "utf8").trim().split(/\r?\n/);
  browser = new Cdp(`ws://127.0.0.1:${port}${browserPath}`);
  await browser.ready;
  await browser.call("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  const { targetId } = await browser.call("Target.createTarget", { url: info.url });
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const targetInfo = targets.find((entry) => entry.id === targetId);
  assert.ok(targetInfo?.webSocketDebuggerUrl);
  page = new Cdp(targetInfo.webSocketDebuggerUrl);
  await page.ready;
  await page.call("Page.enable");
  await page.call("Runtime.enable");
  await page.call("Network.enable");
  await waitUntil(() => evaluate(page, "document.readyState === 'complete' && !!document.querySelector('#editor .ProseMirror')"));
  await evaluate(page, `window.__mpwFetch=window.fetch.bind(window);window.__mpwDelayedSave=false;window.__mpwCloseStarted=false;window.__mpwRollbackRequests=0;window.fetch=async(...args)=>{const request=String(args[0]);if(request.includes('/api/rollback'))window.__mpwRollbackRequests+=1;if(request.includes('/api/close'))window.__mpwCloseStarted=true;const response=await window.__mpwFetch(...args);if(request.includes('/api/save')&&!window.__mpwDelayedSave){window.__mpwDelayedSave=true;await new Promise(resolve=>setTimeout(resolve,1500))}if(request.includes('/api/close'))await new Promise(resolve=>setTimeout(resolve,2500));return response}`);

  await evaluate(page, "document.querySelector('#editor .ProseMirror').focus()");
  await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", modifiers: 2 });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", modifiers: 2 });
  await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  const marker = `Edge 真实编辑 ${Date.now()}`;
  await page.call("Input.insertText", { text: marker });
  await waitUntil(() => evaluate(page, "document.querySelector('#status').textContent.includes('正在保存')"), 10_000);
  const duringSave = " 保存中继续输入";
  await page.call("Input.insertText", { text: duringSave });
  try {
    await waitUntil(() => evaluate(page, `document.querySelector('#status').textContent.includes('保存') && document.querySelector('#status').dataset.kind === 'ok' && !document.querySelector('[data-command=hr]').disabled`), 40_000);
  } catch (error) {
    const state = await evaluate(page, `({status:document.querySelector('#status').textContent,kind:document.querySelector('#status').dataset.kind,dialog:document.querySelector('#dialog-message')?.textContent,body:document.body.innerText.slice(0,1200)})`);
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  const hasSeparator = await evaluate(page, "!!document.querySelector('[data-command=hr]')");
  assert.equal(hasSeparator, true);
  await evaluate(page, "document.querySelector('[data-command=hr]').click()");
  try {
    await waitUntil(() => evaluate(page, `document.querySelector('#status').textContent.includes('保存') && document.querySelector('#status').dataset.kind === 'ok'`), 40_000);
  } catch (error) {
    const state = await evaluate(page, `({status:document.querySelector('#status').textContent,kind:document.querySelector('#status').dataset.kind,dialog:document.querySelector('#dialog-message')?.textContent,body:document.body.innerText.slice(0,1200)})`);
    throw new Error(`${error.message} after separator save: ${JSON.stringify(state)}`);
  }

  const copyRect = await evaluate(page, "(() => { const r=document.querySelector('#copy').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:document.querySelector('#copy').disabled}; })()");
  assert.equal(copyRect.disabled, false);
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: copyRect.x, y: copyRect.y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: copyRect.x, y: copyRect.y, button: "left", clickCount: 1 });
  await waitUntil(() => evaluate(page, "document.querySelector('#status').textContent.includes('已同时复制')"), 20_000);
  const clipboard = await evaluate(page, `(async()=>{const items=await navigator.clipboard.read();const out={types:[...items[0].types]};for(const type of out.types)out[type]=await (await items[0].getType(type)).text();return out})()`);
  assert.ok(clipboard.types.includes("text/html"));
  assert.ok(clipboard.types.includes("text/plain"));
  assert.match(clipboard["text/plain"], new RegExp(marker));
  assert.match(clipboard["text/html"], /font-family|font-weight:700|line-height/);
  assert.doesNotMatch(clipboard["text/html"], /<script|\son\w+=|ProseMirror|localhost|127\.0\.0\.1:\d+\/images/i);
  for (const match of clipboard["text/html"].matchAll(/src="data:(image\/(?:png|jpeg|gif|webp));base64,([^"]+)"/g)) {
    const bytes = Buffer.from(match[2], "base64");
    assert.ok(bytes.length > 8);
    if (match[1] === "image/png") assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  }
  const previewReady = await evaluate(page, "document.querySelector('#preview').srcdoc.length > 0");
  assert.equal(previewReady, true);
  const screenshot = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(evidenceRoot, "edge-editor.png"), Buffer.from(screenshot.data, "base64"));

  const networkUrls = page.events.filter((event) => event.method === "Network.requestWillBeSent").map((event) => event.params.request.url);
  assert.ok(networkUrls.length > 0);
  assert.ok(networkUrls.every((requestUrl) => requestUrl.startsWith(origin) || requestUrl === "about:blank"), networkUrls.join("\n"));

  const savedMarkdown = fs.readFileSync(article, "utf8");
  assert.match(savedMarkdown, new RegExp(`${marker}${duringSave}`));
  assert.match(savedMarkdown, /(?:^|\n)---(?:\n|$)/);
  const rejectedDuringClose = `关闭等待输入 ${Date.now()}`;
  await evaluate(page, "document.querySelector('#save-close').click()");
  await waitUntil(() => evaluate(page, "window.__mpwCloseStarted === true"), 10_000);
  const closeState = await evaluate(page, "({editable:document.querySelector('#editor .ProseMirror').getAttribute('contenteditable'),text:document.querySelector('#editor .ProseMirror').innerText})");
  assert.equal(closeState.editable, "false");
  const rollbackState = await evaluate(page, "(() => { const button=document.querySelector('#rollback'); const r=button.getBoundingClientRect(); return {disabled:button.disabled,x:r.x+r.width/2,y:r.y+r.height/2,toolbarDisabled:[...document.querySelectorAll('#toolbar button')].every(item=>item.disabled)} })()");
  assert.equal(rollbackState.disabled, true);
  assert.equal(rollbackState.toolbarDisabled, true);
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: rollbackState.x, y: rollbackState.y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: rollbackState.x, y: rollbackState.y, button: "left", clickCount: 1 });
  await evaluate(page, "document.querySelector('#rollback').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))");
  await evaluate(page, "document.querySelector('#editor .ProseMirror').focus()");
  await page.call("Input.insertText", { text: rejectedDuringClose });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await evaluate(page, `document.querySelector('#editor .ProseMirror').innerText.includes(${JSON.stringify(rejectedDuringClose)})`), false);
  assert.equal(await evaluate(page, "window.__mpwRollbackRequests"), 0);
  await waitUntil(() => evaluate(page, "document.body.innerText.includes('已安全保存并关闭')"), 10_000);
  const afterCloseMarkdown = fs.readFileSync(article, "utf8");
  assert.doesNotMatch(afterCloseMarkdown, new RegExp(rejectedDuringClose));
  assert.equal(afterCloseMarkdown, savedMarkdown, "关闭等待期间文章不得被回退或再次改写");
  await Promise.race([once(running.child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (running.child.exitCode === null) running.child.kill();
  page.close(); browser.close(); edgeProcess.kill();
});
