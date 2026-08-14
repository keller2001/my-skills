import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function cmdCommand(launcher, argument) {
  return argument ? `call "${launcher}" "${argument}"` : `call "${launcher}"`;
}

test("Windows PowerShell 5.1 可启动两种入口并保留 Node 失败码", { skip: !isWindows, timeout: 40_000 }, async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mpw-windows-launch-"));
  let selector;
  try {
    const version = spawnSync("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", windowsHide: true });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout.trim(), /^5\.1\./);

    const launcherRoot = path.join(fixtureRoot, "launcher");
    const articleRoot = path.join(fixtureRoot, "文章 中文 空格");
    fs.mkdirSync(launcherRoot, { recursive: true });
    fs.mkdirSync(path.join(articleRoot, "images"), { recursive: true });
    const launcher = path.join(launcherRoot, "launch.cmd");
    const article = path.join(articleRoot, "article.md");
    fs.copyFileSync(path.join(root, "launch.cmd"), launcher);
    fs.copyFileSync(path.join(root, "launch.ps1"), path.join(launcherRoot, "launch.ps1"));
    fs.writeFileSync(path.join(launcherRoot, "server.mjs"), "console.log(JSON.stringify({ argv: process.argv.slice(2) }));\n", "utf8");
    fs.writeFileSync(article, "# 启动器测试\n", "utf8");

    const explicit = spawnSync("cmd.exe", ["/d", "/s", "/c", cmdCommand(launcher, article)], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, input: "\r\n" });
    assert.equal(explicit.status, 0, `${explicit.stdout}\n${explicit.stderr}`);
    const marker = explicit.stdout.split(/\r?\n/).find((line) => line.startsWith("{"));
    assert.ok(marker, explicit.stdout);
    assert.deepEqual(JSON.parse(marker).argv, ["--article", path.resolve(article), "--open"]);

    let selectorStdout = "";
    let selectorStderr = "";
    selector = spawn("cmd.exe", ["/d", "/s", "/c", cmdCommand(launcher)], { windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] });
    selector.stdout.setEncoding("utf8");
    selector.stderr.setEncoding("utf8");
    selector.stdout.on("data", (chunk) => { selectorStdout += chunk; });
    selector.stderr.on("data", (chunk) => { selectorStderr += chunk; });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(selector.exitCode, null, `无参数入口提前退出\n${selectorStdout}\n${selectorStderr}`);
    assert.doesNotMatch(`${selectorStdout}\n${selectorStderr}`, /ParserError|UnexpectedToken/);
    spawnSync("taskkill.exe", ["/PID", String(selector.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await Promise.race([once(selector, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    selector = undefined;

    const failingRoot = path.join(fixtureRoot, "失败码");
    fs.mkdirSync(failingRoot);
    fs.copyFileSync(path.join(root, "launch.cmd"), path.join(failingRoot, "launch.cmd"));
    fs.writeFileSync(path.join(failingRoot, "launch.ps1"), "\uFEFF& node.exe -e \"process.exit(37)\"\r\nexit $LASTEXITCODE\r\n", "utf8");
    const failed = spawnSync("cmd.exe", ["/d", "/s", "/c", cmdCommand(path.join(failingRoot, "launch.cmd"))], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, input: "\r\n" });
    assert.equal(failed.status, 37, `${failed.stdout}\n${failed.stderr}`);
  } finally {
    if (selector?.pid && selector.exitCode === null) spawnSync("taskkill.exe", ["/PID", String(selector.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
