import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { validateLicenseMetadata } from "./src/license-audit.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(ROOT, "../../assets/rich-editor");
const LOCK = path.join(ROOT, "package-lock.json");
const AUDITED_LOCK_SHA256 = "86f0de9b165b07b4073cbbf82e78acd4cdf400874f378452c7f455be641f409c";

const lockBytes = fs.readFileSync(LOCK);
const lockHash = crypto.createHash("sha256").update(lockBytes).digest("hex");
if (lockHash !== AUDITED_LOCK_SHA256) {
  throw new Error(`package-lock.json 与已审计锁文件不一致，停止构建。当前 SHA-256: ${lockHash}`);
}

const lock = JSON.parse(lockBytes.toString("utf8"));
const packageEntries = Object.entries(lock.packages)
  .filter(([location]) => location)
  .map(([location, metadata]) => ({ location: location.replaceAll("\\", "/"), metadata }))
  .sort((left, right) => right.location.length - left.location.length);

validateLicenseMetadata(packageEntries);

const validatorOptions = {
  entryPoints: [path.join(ROOT, "src/validator.js")], bundle: true, platform: "node", format: "esm",
  target: "node24", metafile: true, write: false, legalComments: "none",
};
const editorOptions = {
  entryPoints: [path.join(ROOT, "src/editor.js")], bundle: true, platform: "browser", format: "iife",
  target: ["chrome120", "edge120"], metafile: true, write: false, legalComments: "none",
};
const [validatorTrial, editorTrial] = await Promise.all([build(validatorOptions), build(editorOptions)]);

function packageLocationsFor(meta) {
  const found = new Set();
  for (const input of Object.keys(meta.inputs)) {
    const absolute = path.resolve(ROOT, input).replaceAll("\\", "/").toLowerCase();
    const match = packageEntries.find(({ location }) => absolute.startsWith(path.resolve(ROOT, location).replaceAll("\\", "/").toLowerCase() + "/"));
    if (match) found.add(match.location);
  }
  return found;
}

const runtimeLocations = new Set([...packageLocationsFor(validatorTrial.metafile), ...packageLocationsFor(editorTrial.metafile)]);
const runtimePackages = packageEntries
  .filter(({ location }) => runtimeLocations.has(location))
  .map(({ metadata }) => `${metadata.name || packageNameFromLocation(metadata, "") || "unknown"}@${metadata.version}`);

function packageNameFromLocation(metadata, location) {
  if (metadata.name) return metadata.name;
  const marker = "node_modules/";
  const index = location.lastIndexOf(marker);
  return index >= 0 ? location.slice(index + marker.length) : location;
}

const bundleManifest = packageEntries
  .filter(({ location }) => runtimeLocations.has(location))
  .map(({ location, metadata }) => ({ name: packageNameFromLocation(metadata, location), version: metadata.version }))
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const banner = `/* MPW_BUNDLE_PACKAGES ${JSON.stringify(bundleManifest)} */`;

await build({ ...validatorOptions, write: true, outfile: path.join(ROOT, "validator.bundle.mjs"), banner: { js: banner } });
await build({ ...editorOptions, write: true, outfile: path.join(ASSETS, "editor.bundle.js"), banner: { js: banner } });

function packageDirectory(location) {
  const direct = path.join(ROOT, location);
  if (fs.existsSync(direct)) return direct;
  if (location.startsWith("node_modules/@esbuild/")) return path.join(ROOT, "node_modules/esbuild");
  throw new Error(`无法读取依赖目录：${location}`);
}

function licenseFile(directory) {
  const candidate = fs.readdirSync(directory).find((name) => /^licen[cs]e/i.test(name));
  if (!candidate) throw new Error(`依赖缺少完整许可证文件：${directory}`);
  return path.join(directory, candidate);
}

function sourceOf(pkg, location) {
  if (location.startsWith("node_modules/@esbuild/")) return "https://github.com/evanw/esbuild";
  const source = pkg.repository || pkg.homepage;
  const value = typeof source === "string" ? source : source?.url;
  if (!value) throw new Error(`依赖缺少来源仓库：${pkg.name}@${pkg.version}`);
  return value.replace(/^git\+/, "").replace(/\.git$/, "");
}

const unique = new Map();
for (const entry of packageEntries) {
  const directory = packageDirectory(entry.location);
  const pkgPath = path.join(directory, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const name = packageNameFromLocation(entry.metadata, entry.location);
  const key = `${name}@${entry.metadata.version}`;
  if (unique.has(key)) {
    if (runtimeLocations.has(entry.location)) unique.get(key).runtime = true;
    continue;
  }
  const licenseDirectory = entry.location.startsWith("node_modules/@esbuild/") ? path.join(ROOT, "node_modules/esbuild") : directory;
  const licenseText = fs.readFileSync(licenseFile(licenseDirectory), "utf8").trim();
  const copyright = licenseText.split(/\r?\n/).filter((line) => /copyright/i.test(line)).join("\n");
  if (!licenseText || !copyright) throw new Error(`依赖缺少完整许可证或原始版权声明：${key}`);
  unique.set(key, {
    name, version: entry.metadata.version, license: entry.metadata.license, copyright,
    source: sourceOf(pkg, entry.location), runtime: runtimeLocations.has(entry.location), licenseText,
  });
}

const notices = [
  "THIRD-PARTY SOFTWARE NOTICES",
  "",
  "This file preserves the original copyright statements and complete license text for every locked third-party package.",
  "Runtime bundle: yes means the package was found in editor.bundle.js or validator.bundle.mjs metadata.",
  "",
];
for (const item of [...unique.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
  notices.push("================================================================================", `Package: ${item.name}`, `Version: ${item.version}`, `License: ${item.license}`, `Source repository: ${item.source}`, `Runtime bundle: ${item.runtime ? "yes" : "no"}`, "Original copyright statement(s):", item.copyright, "", "Complete license text:", item.licenseText, "");
}
fs.writeFileSync(path.join(ASSETS, "THIRD_PARTY_NOTICES.txt"), `${notices.join("\n").trimEnd()}\n`, "utf8");

const noticeText = fs.readFileSync(path.join(ASSETS, "THIRD_PARTY_NOTICES.txt"), "utf8");
for (const item of bundleManifest) {
  if (!noticeText.includes(`Package: ${item.name}\nVersion: ${item.version}\n`)) throw new Error(`bundle 依赖未出现在通知文件：${item.name}@${item.version}`);
}
console.log(JSON.stringify({ ok: true, lockHash, lockedPackages: unique.size, runtimePackages: runtimePackages.length, bundleManifest }, null, 2));
