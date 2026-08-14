import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  editorSchema, parseMarkdown, documentFromJson, assertRoundTrip, sameDocument,
  renderConfirmedHtml, plainText,
} from "./validator.bundle.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.resolve(SCRIPT_DIR, "../../assets/rich-editor");
const ATOMIC_SCRIPT = path.join(SCRIPT_DIR, "atomic-files.ps1");
const MAX_DOCUMENT = 10 * 1024 * 1024;
const MAX_IMAGE = 25 * 1024 * 1024;
const SAFE_IMAGE_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}_-])?$/u;
const FORBIDDEN_BROWSER_PORTS = new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);
const IDLE_MS = 90_000;
const args = process.argv.slice(2);
const articleArg = valueAfter("--article");
const shouldOpen = args.includes("--open");
const faultPhase = process.env.MPW_TEST_KILL_PHASE || "";
if (!articleArg) fail("Missing --article path.");

const articlePath = path.resolve(articleArg);
if (path.basename(articlePath) !== "article.md") fail("选中的文件必须严格命名为 article.md。");
if (!fs.existsSync(articlePath) || !fs.statSync(articlePath).isFile()) fail("找不到选中的 article.md。");
const articleRoot = path.dirname(articlePath);
const imagesRoot = path.join(articleRoot, "images");
const recoveryRoot = path.join(imagesRoot, ".mpw-recovery");
const canonicalArticle = fs.realpathSync.native(articlePath).toLowerCase();
const pipeHash = sha256(Buffer.from(canonicalArticle, "utf8")).slice(0, 32);
const pipePath = `\\\\.\\pipe\\mpw-rich-editor-${pipeHash}`;
const pipeServer = net.createServer(() => {});
await listenPipe();

runAtomic("check", { TargetPath: articlePath });
runAtomic("check", { TargetPath: imagesRoot });
fs.mkdirSync(recoveryRoot, { recursive: true });
runAtomic("check", { TargetPath: articlePath });
runAtomic("check", { TargetPath: imagesRoot });
const initialIdentity = captureIdentity();
const probe = probeFilesystem();
let frozenReason = probe.ok ? null : `当前文件系统不支持可验证的 File.Replace 语义：${probe.error}`;
let recovery = inspectRecovery();
let busyWrites = 0;
let lastHeartbeat = Date.now();
let closing = false;

const token = crypto.randomBytes(32).toString("base64url");
const server = http.createServer((request, response) => {
  lastHeartbeat = Date.now();
  void route(request, response).catch((error) => sendError(response, error));
});
const port = await listenBrowserSafePort();
const url = `http://127.0.0.1:${port}/?token=${token}`;
console.log(JSON.stringify({ ok: true, url, article: articlePath, pipe: pipePath }));
if (shouldOpen) openBrowser(url);

const idleTimer = setInterval(() => {
  if (!closing && busyWrites === 0 && Date.now() - lastHeartbeat > IDLE_MS) void shutdown();
}, 10_000);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

async function listenBrowserSafePort() {
  for (;;) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const assigned = server.address().port;
    if (!FORBIDDEN_BROWSER_PORTS.has(assigned)) return assigned;
    await new Promise((resolve) => server.close(resolve));
  }
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

function captureIdentity() {
  const rootReal = fs.realpathSync.native(articleRoot);
  const imagesReal = fs.realpathSync.native(imagesRoot);
  const rootStat = fs.statSync(articleRoot);
  const imagesStat = fs.statSync(imagesRoot);
  return { rootReal, imagesReal, rootId: `${rootStat.dev}:${rootStat.ino}`, imagesId: `${imagesStat.dev}:${imagesStat.ino}` };
}

function assertIdentity() {
  try {
    runAtomic("check", { TargetPath: articlePath });
    runAtomic("check", { TargetPath: imagesRoot });
  } catch (error) {
    frozenReason = `路径安全复验失败，已冻结写入：${error.message}`;
    throw statusError(409, frozenReason);
  }
  const current = captureIdentity();
  for (const key of Object.keys(initialIdentity)) {
    const left = String(current[key]);
    const right = String(initialIdentity[key]);
    if (key.endsWith("Real") ? left.toLowerCase() !== right.toLowerCase() : left !== right) {
      frozenReason = "文章目录或 images 目录在运行期间被替换，已冻结写入。";
      throw statusError(409, frozenReason);
    }
  }
}

function assertArticleTarget(target) {
  assertIdentity();
  runAtomic("check", { TargetPath: target });
  if (fs.existsSync(target)) {
    const real = fs.realpathSync.native(target);
    const articleReal = initialIdentity.rootReal + path.sep + "article.md";
    const insideImages = real.toLowerCase().startsWith(initialIdentity.imagesReal.toLowerCase() + path.sep);
    if (real.toLowerCase() !== articleReal.toLowerCase() && real.toLowerCase() !== initialIdentity.imagesReal.toLowerCase() && !insideImages) {
      frozenReason = "文件真实路径超出文章白名单，已冻结写入。";
      throw statusError(409, frozenReason);
    }
  }
}

function runAtomic(action, values = {}) {
  const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ATOMIC_SCRIPT, "-Action", action, "-ArticlePath", articlePath];
  for (const [key, value] of Object.entries(values)) psArgs.push(`-${key}`, String(value));
  const result = spawnSync("powershell.exe", psArgs, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `atomic-files.ps1 failed (${action})`).trim());
  return JSON.parse(result.stdout.trim());
}

function probeFilesystem() {
  try { runAtomic("probe"); return { ok: true }; }
  catch (error) { return { ok: false, error: error.message }; }
}

function transactionPath() { return path.join(recoveryRoot, "transaction.json"); }
function previousPath() { return path.join(recoveryRoot, "previous.md"); }

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function hashIfExists(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fileHash(file) : null;
}

function inspectRecovery() {
  const txFile = transactionPath();
  const listOrphanArtifacts = () => fs.readdirSync(recoveryRoot).filter((name) => /^(candidate-|previous-old-|rollback-swap-|transaction-new-|transaction-old-).+\.(?:tmp|md)$/.test(name));
  const orphanRecovery = (orphanFiles) => ({
    type: "orphan-artifacts", message: "发现没有事务记录对应的候选或交换文件，已保持现场只读。",
    options: [{ action: "discard-orphans", label: "保留当前正文并移除孤立事务文件" }, { action: "keep-scene", label: "保持现场（只读）" }], orphanFiles,
  });
  if (!fs.existsSync(txFile)) {
    const orphanFiles = listOrphanArtifacts();
    if (orphanFiles.length) return orphanRecovery(orphanFiles);
    return null;
  }
  const tx = safeReadJson(txFile);
  if (!tx || !["save", "rollback"].includes(tx.operation)) {
    frozenReason = "恢复事务记录无法识别，已停止写入。";
    return { message: frozenReason, options: [] };
  }
  if (["committed", "aborted"].includes(tx.phase)) {
    const orphanFiles = listOrphanArtifacts();
    return orphanFiles.length ? orphanRecovery(orphanFiles) : null;
  }
  const article = hashIfExists(articlePath);
  const previous = hashIfExists(previousPath());
  const candidate = tx.candidateFile ? hashIfExists(path.join(recoveryRoot, tx.candidateFile)) : null;
  const swap = tx.swapFile ? hashIfExists(path.join(recoveryRoot, tx.swapFile)) : null;
  if (tx.operation === "save") {
    if (article === tx.candidateHash && previous === tx.articleHash) {
      writeTransaction({ ...tx, phase: "committed", recoveredAt: new Date().toISOString() });
      removeInternal(tx.oldPreviousFile);
      return null;
    }
    if (article === tx.articleHash && candidate === tx.candidateHash) {
      return { type: "save-prepared", message: "发现一次未完成的保存，请选择完成保存或保留当前正文。", options: [
        { action: "complete-save", label: "完成保存" }, { action: "keep-current", label: "保留当前正文" },
      ], tx };
    }
  }
  if (tx.operation === "rollback") {
    if (article === tx.previousHash && previous === tx.articleHash) {
      writeTransaction({ ...tx, phase: "committed", recoveredAt: new Date().toISOString() });
      return null;
    }
    if (article === tx.articleHash && previous === tx.previousHash) {
      return { type: "rollback-prepared", message: "发现未开始的回退事务。", options: [
        { action: "complete-rollback", label: "完成交换" }, { action: "keep-current", label: "保留当前正文" },
      ], tx };
    }
    if (article === tx.previousHash && swap === tx.articleHash && !previous) {
      return { type: "rollback-mid", message: "回退已完成系统替换，两个版本都在；可完成交换或保持现场只读。", options: [
        { action: "complete-exchange", label: "完成交换" }, { action: "keep-scene", label: "保持现场（只读）" },
      ], tx };
    }
  }
  frozenReason = "恢复现场的文件哈希与事务记录不匹配，已停止自动处理。";
  return { type: "mismatch", message: frozenReason, options: [], tx };
}

async function route(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/" && request.method === "GET") {
    if (requestUrl.searchParams.get("token") !== token) throw statusError(403, "启动令牌无效。");
    response.setHeader("Set-Cookie", `mpw_token=${token}; HttpOnly; SameSite=Strict; Path=/`);
    return serveStatic(response, "index.html", "text/html; charset=utf-8");
  }
  if (["/editor.css", "/editor.bundle.js"].includes(pathname) && request.method === "GET") {
    return serveStatic(response, pathname.slice(1), pathname.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
  }
  authorize(request, requestUrl);
  if (pathname === "/api/heartbeat" && request.method === "POST") return sendJson(response, 200, { ok: true });
  if (pathname === "/api/document" && request.method === "GET") return sendDocument(response);
  if (pathname === "/api/save" && request.method === "POST") return saveRequest(request, response);
  if (pathname === "/api/upload" && request.method === "POST") return uploadRequest(request, response);
  if (pathname.startsWith("/images/") && request.method === "GET") return serveImage(response, pathname.slice("/images/".length));
  if (pathname === "/api/copy" && request.method === "POST") return copyRequest(request, response);
  if (pathname === "/api/rollback" && request.method === "POST") return rollbackRequest(request, response);
  if (pathname === "/api/recovery" && request.method === "POST") return recoveryRequest(request, response);
  if (pathname === "/api/close" && request.method === "POST") return closeRequest(request, response);
  throw statusError(404, "找不到请求的本地接口。");
}

function authorize(request, requestUrl) {
  const cookie = request.headers.cookie || "";
  const cookieOk = cookie.split(/;\s*/).includes(`mpw_token=${token}`);
  if (!cookieOk && requestUrl.searchParams.get("token") !== token) throw statusError(403, "启动令牌无效。");
}

function serveStatic(response, filename, type) {
  const target = path.join(ASSET_DIR, filename);
  const bytes = fs.readFileSync(target);
  response.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'" });
  response.end(bytes);
}

function readArticle() {
  assertArticleTarget(articlePath);
  const bytes = fs.readFileSync(articlePath);
  if (bytes.length > MAX_DOCUMENT) throw statusError(413, "article.md 超过 10 MiB 上限。");
  return { markdown: bytes.toString("utf8"), hash: sha256(bytes) };
}

function currentDocument() {
  const current = readArticle();
  const parsed = parseMarkdown(current.markdown);
  const diagnostics = [...parsed.diagnostics];
  if (frozenReason) diagnostics.unshift(frozenReason);
  if (recovery) diagnostics.unshift(recovery.message);
  const doc = parsed.doc || editorSchema.topNodeType.createAndFill();
  const missingImages = parsed.doc ? findMissingImages(parsed.doc) : [];
  return { ...current, doc, diagnostics: [...new Set(diagnostics)], readOnly: parsed.readOnly || Boolean(frozenReason) || Boolean(recovery), missingImages };
}

function sendDocument(response) {
  const data = currentDocument();
  sendJson(response, 200, { doc: data.doc.toJSON(), hash: data.hash, diagnostics: data.diagnostics, readOnly: data.readOnly, missingImages: data.missingImages, recovery: publicRecovery(recovery) });
}

function publicRecovery(value) {
  if (!value) return null;
  return { type: value.type, message: value.message, options: value.options };
}

async function saveRequest(request, response) {
  ensureWritable();
  const body = await readJson(request, MAX_DOCUMENT);
  const current = readArticle();
  if (body.expectedHash !== current.hash) throw statusError(409, "article.md 已被外部修改，本窗口已停止覆盖。");
  let submitted;
  try { submitted = documentFromJson(body.doc); }
  catch (error) { throw statusError(422, error.message); }
  const markdown = assertRoundTrip(submitted);
  const parsed = parseMarkdown(markdown);
  if (!parsed.doc || parsed.readOnly || !sameDocument(submitted, parsed.doc)) throw statusError(422, "服务端独立往返校验失败。");
  if (Buffer.byteLength(markdown) + Buffer.byteLength(JSON.stringify(body.doc)) > MAX_DOCUMENT) throw statusError(413, "正文与文档树合计超过 10 MiB。");
  busyWrites += 1;
  try {
    const hash = await saveTransaction(current.hash, markdown);
    const missingImages = findMissingImages(submitted);
    sendJson(response, 200, { ok: true, hash, missingImages });
  } finally { busyWrites -= 1; }
}

async function saveTransaction(articleHash, markdown) {
  assertIdentity();
  const candidateHash = sha256(Buffer.from(markdown, "utf8"));
  if (candidateHash === articleHash) return articleHash;
  const candidateFile = `candidate-${candidateHash.slice(0, 12)}.tmp`;
  const candidatePath = path.join(recoveryRoot, candidateFile);
  assertArticleTarget(candidatePath);
  await durableWrite(candidatePath, Buffer.from(markdown, "utf8"));
  if (fileHash(candidatePath) !== candidateHash) throw new Error("候选稿写入后哈希不一致。");
  killAt("after-candidate");
  const previous = previousPath();
  const previousHash = hashIfExists(previous);
  const oldPreviousFile = previousHash ? `previous-old-${previousHash.slice(0, 12)}.tmp` : null;
  const tx = { version: 1, operation: "save", phase: "prepared", createdAt: new Date().toISOString(), articleHash, candidateHash, candidateFile, previousHash, oldPreviousFile };
  writeTransaction(tx);
  killAt("after-transaction");
  if (previousHash) {
    const oldPath = path.join(recoveryRoot, oldPreviousFile);
    assertArticleTarget(oldPath);
    await fsp.rename(previous, oldPath);
  }
  killAt("after-old-previous");
  assertIdentity();
  killAt("before-replace");
  runAtomic("replace", { SourcePath: candidatePath, TargetPath: articlePath, BackupPath: previous });
  killAt("after-replace");
  assertIdentity();
  if (fileHash(articlePath) !== candidateHash || fileHash(previous) !== articleHash) throw new Error("系统替换后哈希校验失败，已保留恢复现场。");
  writeTransaction({ ...tx, phase: "committed", committedAt: new Date().toISOString() });
  removeInternal(oldPreviousFile);
  return candidateHash;
}

async function uploadRequest(request, response) {
  ensureWritable();
  if (busyWrites > 0) throw statusError(409, "同一会话只允许一个图片写入任务。");
  busyWrites += 1;
  try {
    const bytes = await readBytes(request, MAX_IMAGE);
    const ext = imageExtension(bytes);
    if (!ext) throw statusError(415, "只接受真实 PNG、JPEG、GIF 或 WebP 图片。");
    const hash = sha256(bytes);
    let suffix = 0;
    let filename;
    for (;;) {
      filename = `img-${hash.slice(0, 12)}${suffix ? `-${suffix}` : ""}.${ext}`;
      const target = path.join(imagesRoot, filename);
      assertArticleTarget(target);
      if (!fs.existsSync(target)) { await durableWrite(target, bytes); break; }
      if (fileHash(target) === hash) break;
      suffix += 1;
    }
    sendJson(response, 200, { ok: true, path: `images/${filename}`, hash });
  } finally { busyWrites -= 1; }
}

function imageExtension(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

function findMissingImages(doc) {
  const missing = [];
  doc.descendants((node) => {
    if (node.type.name !== "image") return;
    const filename = node.attrs.src.slice("images/".length);
    const target = path.join(imagesRoot, filename);
    try { assertArticleTarget(target); if (!fs.existsSync(target) || !imageExtension(fs.readFileSync(target))) missing.push(node.attrs.src); }
    catch { missing.push(node.attrs.src); }
  });
  return [...new Set(missing)];
}

function serveImage(response, filename) {
  if (!SAFE_IMAGE_NAME.test(filename)) throw statusError(400, "图片名无效。");
  const target = path.join(imagesRoot, filename);
  assertArticleTarget(target);
  if (!fs.existsSync(target)) throw statusError(404, "图片缺失。");
  const bytes = fs.readFileSync(target);
  const ext = imageExtension(bytes);
  if (!ext) throw statusError(415, "图片真实内容无效。");
  const types = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  response.writeHead(200, { "Content-Type": types[ext], "Content-Length": bytes.length, "Cache-Control": "no-store" });
  response.end(bytes);
}

async function copyRequest(request, response) {
  const body = await readJson(request, 4096);
  const current = currentDocument();
  if (current.readOnly || current.hash !== body.expectedHash) throw statusError(409, "服务端刚重读的版本与客户端确认版本不一致。");
  if (current.missingImages.length) throw statusError(409, "存在缺图，替换或移除前不能复制。");
  const imageData = new Map();
  current.doc.descendants((node) => {
    if (node.type.name !== "image") return;
    const target = path.join(articleRoot, node.attrs.src.replaceAll("/", path.sep));
    assertArticleTarget(target);
    const bytes = fs.readFileSync(target);
    const ext = imageExtension(bytes);
    const mime = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext];
    imageData.set(node.attrs.src, `data:${mime};base64,${bytes.toString("base64")}`);
  });
  const themeCss = fs.readFileSync(path.join(ASSET_DIR, "theme.css"), "utf8");
  const html = renderConfirmedHtml(current.doc, imageData, themeCss);
  if (/<script|\son\w+=|ProseMirror|localhost|127\.0\.0\.1:\d+\/images/i.test(html)) throw new Error("复制内容安全扫描失败。");
  sendJson(response, 200, { ok: true, html, plain: plainText(current.doc), hash: current.hash });
}

async function rollbackRequest(request, response) {
  ensureWritable();
  const body = await readJson(request, 4096);
  const current = readArticle();
  if (current.hash !== body.expectedHash) throw statusError(409, "article.md 已被外部修改。");
  if (!fs.existsSync(previousPath())) throw statusError(409, "没有可回退的上一确认版本。");
  busyWrites += 1;
  try { await rollbackTransaction(current.hash); sendJson(response, 200, { ok: true, hash: fileHash(articlePath) }); }
  finally { busyWrites -= 1; }
}

async function rollbackTransaction(articleHash, existingTx = null) {
  const previous = previousPath();
  const previousHash = fileHash(previous);
  const swapFile = `rollback-swap-${articleHash.slice(0, 12)}.md`;
  const swapPath = path.join(recoveryRoot, swapFile);
  const tx = existingTx || { version: 1, operation: "rollback", phase: "prepared", createdAt: new Date().toISOString(), articleHash, previousHash, swapFile };
  if (!existingTx) writeTransaction(tx);
  killAt("after-rollback-transaction");
  assertIdentity();
  runAtomic("replace", { SourcePath: previous, TargetPath: articlePath, BackupPath: swapPath });
  killAt("after-rollback-replace");
  if (fileHash(articlePath) !== previousHash || fileHash(swapPath) !== articleHash) throw new Error("回退系统替换后哈希校验失败。");
  killAt("before-swap-rename");
  await fsp.rename(swapPath, previous);
  killAt("after-swap-rename");
  if (fileHash(articlePath) !== previousHash || fileHash(previous) !== articleHash) throw new Error("回退交换完成后哈希校验失败。");
  writeTransaction({ ...tx, phase: "committed", committedAt: new Date().toISOString() });
}

async function recoveryRequest(request, response) {
  if (!recovery) throw statusError(409, "当前没有待处理的恢复现场。");
  const body = await readJson(request, 4096);
  if (body.action === "keep-scene") return sendJson(response, 200, { ok: true, keptReadOnly: true });
  if (body.action === "discard-orphans" && recovery.type === "orphan-artifacts") {
    for (const filename of recovery.orphanFiles) removeInternal(filename);
    recovery = inspectRecovery();
    return sendJson(response, 200, { ok: true, recovery: publicRecovery(recovery) });
  }
  if (!recovery.tx) throw statusError(400, "该恢复动作与当前现场不匹配。");
  const tx = recovery.tx;
  busyWrites += 1;
  try {
    if (body.action === "complete-save" && recovery.type === "save-prepared") {
      const candidate = path.join(recoveryRoot, tx.candidateFile);
      runAtomic("replace", { SourcePath: candidate, TargetPath: articlePath, BackupPath: previousPath() });
      if (fileHash(articlePath) !== tx.candidateHash || fileHash(previousPath()) !== tx.articleHash) throw new Error("恢复保存后哈希校验失败。");
      writeTransaction({ ...tx, phase: "committed", recoveredAt: new Date().toISOString() });
      removeInternal(tx.oldPreviousFile);
    } else if (body.action === "keep-current" && ["save-prepared", "rollback-prepared"].includes(recovery.type)) {
      if (recovery.type === "save-prepared") {
        removeInternal(tx.candidateFile);
        if (tx.oldPreviousFile && fs.existsSync(path.join(recoveryRoot, tx.oldPreviousFile)) && !fs.existsSync(previousPath())) await fsp.rename(path.join(recoveryRoot, tx.oldPreviousFile), previousPath());
      }
      writeTransaction({ ...tx, phase: "aborted", abortedAt: new Date().toISOString() });
    } else if (body.action === "complete-rollback" && recovery.type === "rollback-prepared") {
      await rollbackTransaction(tx.articleHash, tx);
    } else if (body.action === "complete-exchange" && recovery.type === "rollback-mid") {
      const swap = path.join(recoveryRoot, tx.swapFile);
      await fsp.rename(swap, previousPath());
      if (fileHash(articlePath) !== tx.previousHash || fileHash(previousPath()) !== tx.articleHash) throw new Error("完成交换后哈希校验失败。");
      writeTransaction({ ...tx, phase: "committed", recoveredAt: new Date().toISOString() });
    } else throw statusError(400, "该恢复动作与当前事务不匹配。");
    recovery = inspectRecovery();
    sendJson(response, 200, { ok: true, recovery: publicRecovery(recovery) });
  } finally { busyWrites -= 1; }
}

async function closeRequest(request, response) {
  const body = await readJson(request, 4096);
  const current = readArticle();
  if (busyWrites || current.hash !== body.expectedHash) throw statusError(409, "尚未达到安全关闭条件。");
  sendJson(response, 200, { ok: true });
  setTimeout(() => void shutdown(), 100);
}

function ensureWritable() {
  if (frozenReason) throw statusError(409, frozenReason);
  if (recovery) throw statusError(409, "需要先处理恢复现场。");
  assertIdentity();
}

async function durableWrite(target, bytes) {
  assertArticleTarget(target);
  const handle = await fsp.open(target, "wx");
  try {
    if (faultPhase === "during-candidate" && path.basename(target).startsWith("candidate-")) {
      await handle.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      await handle.sync();
      killAt("during-candidate");
    }
    await handle.writeFile(bytes);
    await handle.sync();
  }
  finally { await handle.close(); }
  assertArticleTarget(target);
}

function writeTransaction(transaction) {
  const target = transactionPath();
  assertArticleTarget(target);
  const bytes = Buffer.from(`${JSON.stringify(transaction, null, 2)}\n`, "utf8");
  const temporary = path.join(recoveryRoot, `transaction-new-${crypto.randomBytes(6).toString("hex")}.tmp`);
  const descriptor = fs.openSync(temporary, "wx");
  try {
    const midPhase = transaction.operation === "rollback" ? "during-rollback-transaction" : "during-transaction";
    if (faultPhase === midPhase) {
      fs.writeSync(descriptor, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      fs.fsyncSync(descriptor);
      killAt(midPhase);
    }
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  if (fs.existsSync(target)) {
    const backup = path.join(recoveryRoot, `transaction-old-${crypto.randomBytes(6).toString("hex")}.tmp`);
    runAtomic("replace", { SourcePath: temporary, TargetPath: target, BackupPath: backup });
    fs.unlinkSync(backup);
  } else fs.renameSync(temporary, target);
  assertArticleTarget(target);
}

function removeInternal(filename) {
  if (!filename) return;
  const target = path.join(recoveryRoot, filename);
  assertArticleTarget(target);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

function killAt(phase) {
  if (faultPhase === phase) process.kill(process.pid);
}

async function readJson(request, limit) {
  const bytes = await readBytes(request, limit);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw statusError(400, "JSON 请求无效。"); }
}

async function readBytes(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw statusError(413, `请求超过 ${Math.round(limit / 1024 / 1024)} MiB 上限。`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, value) {
  if (response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length, "Cache-Control": "no-store" });
  response.end(bytes);
}

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendError(response, error) {
  console.error(error.stack || error.message);
  sendJson(response, error.status || 500, { error: error.message || "本地服务发生错误。" });
}

function listenPipe() {
  return new Promise((resolve, reject) => {
    pipeServer.once("error", (error) => {
      if (error.code === "EADDRINUSE") reject(new Error("这篇文章已在编辑。"));
      else reject(error);
    });
    pipeServer.listen(pipePath, resolve);
  }).catch((error) => fail(error.message, 2));
}

function openBrowser(targetUrl) {
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Process -FilePath $env:MPW_EDITOR_URL"], {
    detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, MPW_EDITOR_URL: targetUrl },
  });
  child.unref();
}

async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(idleTimer);
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => pipeServer.close(resolve));
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
