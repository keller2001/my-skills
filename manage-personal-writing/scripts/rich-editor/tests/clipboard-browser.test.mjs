import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createArticleFixture } from "./test-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browsers = [
  ["Edge", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", 40_000],
  ["Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", 13_000],
];

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
      if (!message.id) return void this.events.push(message);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP call timeout: ${method}`)), 20_000))]);
  }
  close() { this.socket.close(); }
}

function startServer(article) {
  const child = spawn(process.execPath, [path.join(root, "server.mjs"), "--article", article], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`server timeout\n${stderr}`)), 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}\n${stderr}`)); });
  });
  return { child, ready };
}

async function waitUntil(check, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("browser condition timeout");
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "browser evaluation failed");
  return result.result.value;
}

async function exposeEditorView(cdp) {
  await cdp.call("Debugger.enable");
  const bundle = fs.readFileSync(path.resolve(root, "..", "..", "assets", "rich-editor", "editor.bundle.js"), "utf8");
  const lineNumber = bundle.split(/\r?\n/).findIndex((line) => line.includes("function dispatchTransaction(transaction)"));
  assert.ok(lineNumber >= 0, "bundle 中未找到 dispatchTransaction");
  const breakpoint = await cdp.call("Debugger.setBreakpointByUrl", { lineNumber, urlRegex: "editor\\.bundle\\.js" });
  assert.ok(breakpoint.locations.length > 0, "未设置 dispatchTransaction 断点");
  const point = await evaluate(cdp, "(() => { const button=[...document.querySelectorAll('#toolbar button')].find(item=>item.textContent.trim()==='H2'); const r=button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  const eventIndex = cdp.events.length;
  const release = cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  const paused = await waitUntil(() => cdp.events.slice(eventIndex).find((event) => event.method === "Debugger.paused"), 10_000);
  const frame = paused.params.callFrames.find((item) => item.functionName === "dispatchTransaction");
  assert.ok(frame, "未在 dispatchTransaction 暂停");
  await cdp.call("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: "window.__mpwTestView=view" });
  await cdp.call("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId });
  await cdp.call("Debugger.resume");
  await release;
  assert.equal(await evaluate(cdp, "!!window.__mpwTestView"), true);
  await cdp.call("Debugger.disable");
}

for (const [browserName, executable, copyDelay] of browsers) {
  test(`真实 ${browserName} 中延迟生成的 HTML/plain 可由一次点击写入剪贴板`, { timeout: 100_000 }, async (t) => {
    assert.ok(fs.existsSync(executable), `${browserName} 不存在`);
    const fixture = createArticleFixture(`clipboard-${browserName.toLowerCase()}`);
    let running;
    let browserProcess;
    let browser;
    let page;
    t.after(async () => {
      page?.close();
      browser?.close();
      if (browserProcess?.pid && browserProcess.exitCode === null) {
        spawnSync("taskkill.exe", ["/PID", String(browserProcess.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        await Promise.race([once(browserProcess, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
      }
      if (running?.child?.exitCode === null) running.child.kill();
      if (running?.child && running.child.exitCode === null) await Promise.race([once(running.child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
      fixture.verifyAndCleanup();
    });

    running = startServer(fixture.article);
    const info = await running.ready;
    const origin = new URL(info.url).origin;
    const profile = path.join(fixture.fixtureRoot, "browser-profile");
    browserProcess = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
    const activePort = path.join(profile, "DevToolsActivePort");
    await waitUntil(() => fs.existsSync(activePort));
    const [port, browserPath] = fs.readFileSync(activePort, "utf8").trim().split(/\r?\n/);
    browser = new Cdp(`ws://127.0.0.1:${port}${browserPath}`);
    await browser.ready;
    await browser.call("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    const { targetId } = await browser.call("Target.createTarget", { url: info.url });
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    page = new Cdp(targets.find((entry) => entry.id === targetId).webSocketDebuggerUrl);
    await page.ready;
    await page.call("Runtime.enable");
    await waitUntil(() => evaluate(page, "document.readyState === 'complete' && !!document.querySelector('#copy') && !document.querySelector('#copy').disabled && document.querySelector('#status').textContent.includes('已打开')"));
    const beforeMarkdown = fs.readFileSync(fixture.article, "utf8");
    await exposeEditorView(page);
    await evaluate(page, "document.querySelector('.ProseMirror').focus()");
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await waitUntil(() => evaluate(page, "document.querySelector('#status').dataset.kind === 'ok' && !document.querySelector('#copy').disabled"));
    assert.equal(fs.readFileSync(fixture.article, "utf8"), beforeMarkdown);
    assert.equal(await evaluate(page, `(() => { const expected='这篇文章只由测试临时创建。'; const walker=document.createTreeWalker(document.querySelector('.ProseMirror'),NodeFilter.SHOW_TEXT); let node; while(node=walker.nextNode()){const index=node.data.indexOf(expected);if(index<0)continue;document.querySelector('.ProseMirror').focus();const range=document.createRange();range.setStart(node,index+expected.length);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));return true}return false})()`), true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await evaluate(page, `window.__mpwFetch=window.fetch.bind(window);window.__mpwCopyRequests=0;window.fetch=async(...args)=>{const request=String(args[0]);const response=await window.__mpwFetch(...args);if(request.includes('/api/copy')){window.__mpwCopyRequests+=1;await new Promise(resolve=>setTimeout(resolve,${copyDelay}))}return response};window.__mpwClipboardWrite=navigator.clipboard.write.bind(navigator.clipboard);navigator.clipboard.write=(items)=>{window.__mpwActivationAtWrite=navigator.userActivation.isActive;if(!window.__mpwActivationAtWrite)return Promise.reject(new DOMException('clipboard write lost user activation','NotAllowedError'));return window.__mpwClipboardWrite(items)}`);
    const point = await evaluate(page, "(() => { const button=document.querySelector('#copy'); const r=button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
    await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await waitUntil(() => evaluate(page, "window.__mpwCopyRequests === 1"));
    const rejectedDuringCopy = `复制期间输入 ${browserName} ${Date.now()}`;
    const locked = await evaluate(page, `({editable:document.querySelector('.ProseMirror').getAttribute('contenteditable'),copyDisabled:document.querySelector('#copy').disabled,saveDisabled:document.querySelector('#save-close').disabled,rollbackDisabled:document.querySelector('#rollback').disabled,fileDisabled:document.querySelector('#image-input').disabled,toolbarDisabled:[...document.querySelectorAll('#toolbar button')].every(button=>button.disabled),status:document.querySelector('#status').textContent,preview:document.querySelector('#preview').srcdoc})`);
    assert.equal(locked.editable, "false");
    assert.equal(locked.copyDisabled, true);
    assert.equal(locked.saveDisabled, true);
    assert.equal(locked.rollbackDisabled, true);
    assert.equal(locked.fileDisabled, true);
    assert.equal(locked.toolbarDisabled, true);
    assert.match(locked.status, /正在生成富文本并写入剪贴板/);
    assert.equal(locked.preview, "");
    await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    assert.equal(await evaluate(page, "(()=>{document.querySelector('#copy').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));document.querySelector('[data-command=hr]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return window.__mpwTestView.someProp('handleKeyDown',handler=>handler(window.__mpwTestView,new KeyboardEvent('keydown',{key:'b',code:'KeyB',ctrlKey:true,bubbles:true,cancelable:true})))})()"), true);
    await page.call("Input.insertText", { text: rejectedDuringCopy });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await evaluate(page, "window.__mpwCopyRequests"), 1);
    assert.equal(await evaluate(page, `document.querySelector('.ProseMirror').innerText.includes(${JSON.stringify(rejectedDuringCopy)})`), false);
    assert.equal(fs.readFileSync(fixture.article, "utf8"), beforeMarkdown);
    const state = await waitUntil(() => evaluate(page, `(() => { const status=document.querySelector('#status'); if(!status.textContent.includes('已同时复制富文本和纯文本')&&status.dataset.kind!=='error') return null; return {status:status.textContent,kind:status.dataset.kind,preview:document.querySelector('#preview').srcdoc}; })()`), copyDelay + 20_000);
    assert.equal(state.kind, "ok", state.status);
    assert.match(state.status, /已同时复制富文本和纯文本/);
    assert.equal(await evaluate(page, "window.__mpwActivationAtWrite"), true);
    assert.match(state.preview, /font-family|line-height/);
    assert.match(state.preview, /data:image\/png;base64,/);

    const clipboard = await evaluate(page, `(async()=>{const items=await navigator.clipboard.read();const out={types:[...items[0].types]};for(const type of out.types)out[type]=await(await items[0].getType(type)).text();return out})()`);
    assert.ok(clipboard.types.includes("text/html"));
    assert.ok(clipboard.types.includes("text/plain"));
    assert.match(clipboard["text/plain"], /这篇文章只由测试临时创建/);
    assert.match(clipboard["text/html"], /font-family|line-height/);
    assert.match(clipboard["text/html"], /data:image\/png;base64,/);
    assert.doesNotMatch(clipboard["text/html"], /<script|\son\w+=|localhost|127\.0\.0\.1:\d+\/images/i);
    assert.equal(fs.readFileSync(fixture.article, "utf8"), beforeMarkdown);
    const unlocked = await evaluate(page, `({editable:document.querySelector('.ProseMirror').getAttribute('contenteditable'),copyDisabled:document.querySelector('#copy').disabled,saveDisabled:document.querySelector('#save-close').disabled,text:document.querySelector('.ProseMirror').innerText})`);
    assert.equal(unlocked.editable, "true");
    assert.equal(unlocked.copyDisabled, false);
    assert.equal(unlocked.saveDisabled, false);
    assert.equal(unlocked.text.includes(rejectedDuringCopy), false);
    const plainAfterCopy = ` 解锁后普通输入 ${browserName} ${Date.now()}`;
    await evaluate(page, "document.querySelector('.ProseMirror').focus()");
    await page.call("Input.insertText", { text: plainAfterCopy });
    await waitUntil(() => evaluate(page, "document.querySelector('#status').dataset.kind === 'ok' && !document.querySelector('#copy').disabled"));
    assert.equal(await evaluate(page, `[...document.querySelectorAll('.ProseMirror strong')].some(node=>node.textContent.includes(${JSON.stringify(plainAfterCopy)}))`), false);
    const afterTyping = fs.readFileSync(fixture.article, "utf8");
    assert.match(afterTyping, new RegExp(plainAfterCopy));
    assert.doesNotMatch(afterTyping, new RegExp(`\\*\\*${plainAfterCopy}\\*\\*`));
  });
}
