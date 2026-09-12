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
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
}

await check("语法检查 lib/index.js", () => {
  const r = spawnSync(process.execPath, ["--check", resolve(ROOT, "lib/index.js")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "node --check failed").trim());
  return "ok";
});

await check("语法检查 lib/client.js", () => {
  const r = spawnSync(process.execPath, ["--check", resolve(ROOT, "lib/client.js")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "node --check failed").trim());
  return "ok";
});

await check("dsh 插件声明", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  for (const key of ["name", "version", "main", "dsh"]) {
    if (!(key in pkg)) throw new Error(`package.json 缺少 ${key}`);
  }
  if (!pkg.dsh.bundle?.patch) throw new Error("dsh.bundle.patch 缺失（profile 无法挂载插件行）");
  if (pkg.dsh.client?.platform !== "web") throw new Error("dsh.client.platform 必须是 web");
  if (!existsSync(resolve(ROOT, pkg.dsh.bundle.patch))) throw new Error(`bundle.patch 指向的文件不存在：${pkg.dsh.bundle.patch}`);
  return `${pkg.name}@${pkg.version}`;
});

await check("cordis.patch.yml 声明插件行", () => {
  const yml = readFileSync(resolve(ROOT, "cordis.patch.yml"), "utf8");
  if (!yml.includes("dsh-livebench-panel")) throw new Error("cordis.patch.yml 未出现插件名");
  return "ok";
});

await check("npm 打包内容白名单", () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error((r.stderr || "npm pack --dry-run 失败").trim());
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  const allowed = /^(lib\/|cordis\.patch\.yml$|README\.md$|LICENSE$|package\.json$)/;
  const bad = files.filter((p) => !allowed.test(p));
  if (bad.length > 0) throw new Error(`打包内容出现预期外的文件：${bad.join(", ")}`);
  return files.join(", ");
});

// ---------------------------------------------------------------------------
// 回归测试：成绩表"选择题数"的边界裁剪
//
// 踩过的坑：题库只有 8 题、题号范围填 0-8 时，旧实现只做 min(total, end-begin+1)
// 会算出 9 题，于是 notDone 永远多 1，全做对也显示 (-1/8)。
// 正确语义是 Python 切片长度：min(total, end+1) - min(total, begin)。
// ---------------------------------------------------------------------------
const statsCases = [
  // [说明, total, begin, end, 期望]
  ["题库 8 题，范围 0-8（越界 1 题）应截断为 8", 8, 0, 8, 8],
  ["题库 8 题，范围 0-7（正好）", 8, 0, 7, 8],
  ["题库 8 题，范围 0-2", 8, 0, 2, 3],
  ["题库 8 题，范围 6-9（尾部越界）应截断为 2", 8, 6, 9, 2],
  ["题库 8 题，范围 0-100 应截断为 8", 8, 0, 100, 8],
  ["题库 36 题，范围 0-35（正好全量）", 36, 0, 35, 36],
  ["题库 36 题，范围 30-40（尾部越界）", 36, 30, 40, 6],
  ["题库 36 题，范围 40-50（整体越界）应为 0", 36, 40, 50, 0],
  ["题库 72 题，范围 6-9", 72, 6, 9, 4],
  ["total 非法时返回 null（调用方回退）", 0, 0, 5, null],
];

await check("成绩表边界裁剪（baseline 统计回归）", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const bad = [];
  for (const [label, total, begin, end, want] of statsCases) {
    const got = mod.clampedRangeLength(total, begin, end);
    if (got !== want) bad.push(`${label}: got=${got} want=${want}`);
  }
  if (bad.length > 0) throw new Error(bad.join(" | "));
  return `${statsCases.length} 条用例`;
});

await check("release 有效题数过滤", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const tasks = {
    math: {
      demo: {
        buckets: [
          { r: "2024-08-31", rm: "", n: 50 },           // 2024-11-25 有效
          { r: "2024-06-24", rm: "", n: 50 },           // 2024-11-25 有效
          { r: "2024-06-24", rm: "2024-08-31", n: 50 }, // 已在 2024-08-31 退役
        ],
        total: 150,
      },
    },
  };
  const a = mod.releaseQuestionCount(tasks, "math", "demo", "2024-11-25");
  if (a !== 100) throw new Error(`2024-11-25 应为 100（退役桶被剔除），实际 ${a}`);
  // 2024-06-24：桶1 还没发布；桶2、桶3 都有效（桶3 要到 2024-08-31 才退役）
  const b = mod.releaseQuestionCount(tasks, "math", "demo", "2024-06-24");
  if (b !== 100) throw new Error(`2024-06-24 应为 100，实际 ${b}`);
  const e = mod.releaseQuestionCount(tasks, "math", "demo", "2024-08-31");
  if (e !== 100) throw new Error(`2024-08-31 应为 100（桶3 恰在当日退役），实际 ${e}`);
  const f = mod.releaseQuestionCount(tasks, "math", "demo", "2024-06-01");
  if (f !== 0) throw new Error(`2024-06-01 应为 0（无题发布），实际 ${f}`);
  const c = mod.releaseQuestionCount(tasks, "math", "nope", "2024-11-25");
  if (c !== null) throw new Error(`未知任务应返回 null，实际 ${c}`);
  const d = mod.releaseQuestionCount(tasks, "math", "demo", "");
  if (d !== null) throw new Error(`空 release 应返回 null，实际 ${d}`);
  return "6 条用例";
});

// ---------------------------------------------------------------------------
// 回归测试：正确率的分母
//
// 踩过的坑：推理模型把 max_tokens 全烧在思考里、正文为空（token_exhaustion）时，
// 答案行不是 $ERROR$，于是被当成"做错了"进了分母。
// 实测 deepseek-flash@max 8 题里只答出 1 题（0.9167 分），却显示 11.5%（= 0.9167/8）。
// 正确口径（用户定义）：正确率 = 做对的题 / **做出来的题**。
// ---------------------------------------------------------------------------
const emptyCases = [
  ["token_exhaustion 行算「没做出来」",
    '{"choices": [{"index": 0, "turns": [""]}], "total_output_tokens": 32000, "api_info": {"eval_status": "token_exhaustion"}}', true],
  ["turns 为空数组",
    '{"choices": [{"index": 0, "turns": []}]}', true],
  ["choices 直接是空串",
    '{"choices": [""]}', true],
  ["正常答案不算空",
    '{"choices": [{"index": 0, "turns": ["The answer is 42"]}]}', false],
  ["答案里出现空串片段但整体非空",
    '{"choices": [{"index": 0, "turns": ["part1", "part2"]}]}', false],
  ["$ERROR$ 由 errors 统计，不算 empty",
    '{"choices": [{"index": 0, "turns": ["$ERROR$"]}]}', false],
];

await check("空答案识别（正确率分母回归）", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const bad = [];
  for (const [label, line, want] of emptyCases) {
    const got = mod.isEmptyAnswerLine(line);
    if (got !== want) bad.push(`${label}: got=${got} want=${want}`);
  }
  if (bad.length > 0) throw new Error(bad.join(" | "));

  // 端到端口径：8 题、7 题空、1 题 0.9167 → 分母应为 1，正确率 91.7%
  const answered = 8, errors = 0, empty = 7, judgedCount = 8, sum = 0.916666666666667;
  const notProduced = errors + empty;
  const done = Math.max(0, answered - notProduced);
  const judgedDone = Math.max(0, judgedCount - notProduced);
  const score = judgedDone > 0 ? (sum / judgedDone) * 100 : null;
  if (done !== 1) throw new Error(`做出来应为 1，实际 ${done}`);
  if (Math.round(score * 10) / 10 !== 91.7) throw new Error(`正确率应为 91.7%，实际 ${score}`);
  return `${emptyCases.length} 条 + 口径 1 条`;
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(failed.length === 0 ? "\n全部通过 ✅" : `\n${failed.length} 项失败 ❌`);
process.exit(failed.length === 0 ? 0 : 1);
