#!/usr/bin/env node
/**
 * 本地自检脚本 —— 与 CI 口径一致，贡献者提交前跑一遍即可。
 *
 *   node scripts/check.mjs
 *
 * 检查三件事：
 *   1. node half / browser half 语法可解析（node --check）；
 *   2. package.json 的 dsh 插件声明完整（bundle.patch、client.platform=web）；
 *   3. npm 打包内容白名单 —— 只允许 lib/*、cordis.patch.yml、README.md、LICENSE、package.json，
 *      避免把开发脚本、临时文件、旧 tarball 误发到 npm。
 *
 * 退出码 0 = 全部通过；非 0 = 有检查失败（失败项已打印）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
}

check("语法检查 lib/index.js", () => {
  const r = spawnSync(process.execPath, ["--check", resolve(ROOT, "lib/index.js")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "node --check failed").trim());
  return "ok";
});

check("语法检查 lib/client.js", () => {
  const r = spawnSync(process.execPath, ["--check", resolve(ROOT, "lib/client.js")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "node --check failed").trim());
  return "ok";
});

check("dsh 插件声明", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  for (const key of ["name", "version", "main", "dsh"]) {
    if (!(key in pkg)) throw new Error(`package.json 缺少 ${key}`);
  }
  if (!pkg.dsh.bundle?.patch) throw new Error("dsh.bundle.patch 缺失（profile 无法挂载插件行）");
  if (pkg.dsh.client?.platform !== "web") throw new Error("dsh.client.platform 必须是 web");
  if (!existsSync(resolve(ROOT, pkg.dsh.bundle.patch))) throw new Error(`bundle.patch 指向的文件不存在：${pkg.dsh.bundle.patch}`);
  return `${pkg.name}@${pkg.version}`;
});

check("cordis.patch.yml 声明插件行", () => {
  const yml = readFileSync(resolve(ROOT, "cordis.patch.yml"), "utf8");
  if (!yml.includes("dsh-livebench-panel")) throw new Error("cordis.patch.yml 未出现插件名");
  return "ok";
});

check("npm 打包内容白名单", () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error((r.stderr || "npm pack --dry-run 失败").trim());
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  const allowed = /^(lib\/|cordis\.patch\.yml$|README\.md$|LICENSE$|package\.json$)/;
  const bad = files.filter((p) => !allowed.test(p));
  if (bad.length > 0) throw new Error(`打包内容出现预期外的文件：${bad.join(", ")}`);
  return files.join(", ");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(failed.length === 0 ? "\n全部通过 ✅" : `\n${failed.length} 项失败 ❌`);
process.exit(failed.length === 0 ? 0 : 1);
