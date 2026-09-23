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
  ["题库 8 题，范围 0-1000 应截断为 8（不是 1001）", 8, 0, 1000, 8],
  ["题库 8 题，范围 -5 到 1000 应截断为 8", 8, -5, 1000, 8],
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

  // 端到端口径：8 题里 7 题空答案（思考吃满 token）、1 题 0.9167。
  // 走真实代码路径（答案行 → reduceAnswerLines → scoreJudgments）：
  // 分母只能是 1，正确率 91.7%，而不是 0.9167/8 = 11.5%。
  const mkQid = (i) => `000000000000000000000000000000000000000000000000000000000000000${i}`;
  const answerLines = [];
  const judgments = [];
  for (let i = 0; i < 8; i += 1) {
    const ansId = `ans${i}00000`;
    if (i === 0) {
      answerLines.push(`{"question_id": "${mkQid(i)}", "answer_id": "${ansId}", "model_id": "m", "choices": [{"index": 0, "turns": ["final answer"]}]}`);
      judgments.push({ questionId: mkQid(i), answerId: ansId, score: 0.916666666666667, tstamp: i + 1 });
    } else {
      answerLines.push(`{"question_id": "${mkQid(i)}", "answer_id": "${ansId}", "model_id": "m", "choices": [{"index": 0, "turns": [""]}], "api_info": {"eval_status": "token_exhaustion"}}`);
      judgments.push({ questionId: mkQid(i), answerId: ansId, score: 0, tstamp: i + 1 });
    }
  }
  const stat = mod.reduceAnswerLines(answerLines.join("\n"));
  if (stat.answered !== 8 || stat.empty !== 7 || stat.errors !== 0) {
    throw new Error(`8 题里应有 7 题空答案，实际 answered=${stat.answered} empty=${stat.empty} errors=${stat.errors}`);
  }
  const done = Math.max(0, stat.answered - stat.errors - stat.empty);
  if (done !== 1) throw new Error(`做出来应为 1，实际 ${done}`);
  const scored = mod.scoreJudgments(judgments, stat.byQid);
  const score = scored.judged > 0 ? (scored.sum / scored.judged) * 100 : null;
  if (scored.judged !== 1) throw new Error(`分母应为 1（空答案的判分不进分母），实际 ${scored.judged}`);
  if (Math.round(score * 10) / 10 !== 91.7) throw new Error(`正确率应为 91.7%，实际 ${score}`);
  return `${emptyCases.length} 条 + 口径 1 条`;
});

// ---------------------------------------------------------------------------
// 回归测试：Baseline「没做出来的题号」
//
// 编号必须是该题库内的 0 起下标（与「题目序号范围」一致），且范围先按题库实际题数裁剪：
// 8 题的题库填 0-1000 时，基准是 8 而不是 1001，题号也只能落在 0-7。
// ---------------------------------------------------------------------------
await check("Baseline 没做出来的题号", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const ids = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"];
  const seen = new Set(["a0", "a2", "a4", "a6"]); // 1、3、5、7 没做出来

  const all = mod.missingBaselineIndexes({ baselineIds: ids, begin: null, end: null }, seen);
  if (JSON.stringify(all) !== JSON.stringify([1, 3, 5, 7])) {
    throw new Error(`全量应为 [1,3,5,7]，实际 ${JSON.stringify(all)}`);
  }
  // 空字符串范围必须等同于"未设范围"（否则 Number("") === 0，范围变成 0..0）
  const emptyStr = mod.missingBaselineIndexes({ baselineIds: ids, begin: "", end: "" }, seen);
  if (JSON.stringify(emptyStr) !== JSON.stringify([1, 3, 5, 7])) {
    throw new Error(`空串范围应等同未设，应为 [1,3,5,7]，实际 ${JSON.stringify(emptyStr)}`);
  }
  // 越界范围：基准仍是 8，题号仍落在 0-7
  const over = mod.missingBaselineIndexes({ baselineIds: ids, begin: 0, end: 1000 }, seen);
  if (JSON.stringify(over) !== JSON.stringify([1, 3, 5, 7])) {
    throw new Error(`0-1000 应为 [1,3,5,7]，实际 ${JSON.stringify(over)}`);
  }
  // 只跑 0-3：缺 1、3
  const part = mod.missingBaselineIndexes({ baselineIds: ids, begin: 0, end: 3 }, seen);
  if (JSON.stringify(part) !== JSON.stringify([1, 3])) {
    throw new Error(`0-3 应为 [1,3]，实际 ${JSON.stringify(part)}`);
  }
  // 尾部越界 6-1000：只到 7，缺 7
  const tail = mod.missingBaselineIndexes({ baselineIds: ids, begin: 6, end: 1000 }, seen);
  if (JSON.stringify(tail) !== JSON.stringify([7])) {
    throw new Error(`6-1000 应为 [7]，实际 ${JSON.stringify(tail)}`);
  }
  // 全部做出来
  const none = mod.missingBaselineIndexes({ baselineIds: ids, begin: null, end: null }, new Set(ids));
  if (JSON.stringify(none) !== "[]") throw new Error(`全做出来应为 []，实际 ${JSON.stringify(none)}`);
  // 非 baseline 运行返回 null
  const na = mod.missingBaselineIndexes({ begin: 0, end: 3 }, seen);
  if (na !== null) throw new Error(`非 baseline 应返回 null，实际 ${JSON.stringify(na)}`);
  // 老元数据（没有 baselineIds）应能从 baseline/baselineTask/baselinePicks 反查
  const legacySeen = new Set(["placeholder"]);
  const legacy = mod.missingBaselineIndexes(
    { baseline: "glm53flash", baselineTask: "live_bench/math/olympiad", baselinePicks: ["failed"], begin: null, end: null },
    legacySeen);
  // 一个 id 都不匹配 → 8 题全部算没做出来，编号 0-7
  if (!Array.isArray(legacy) || legacy.length !== 8 || legacy[0] !== 0 || legacy[7] !== 7) {
    throw new Error(`老元数据应反查出 8 题、编号 0-7，实际 ${JSON.stringify(legacy)}`);
  }
  // 把第 0 题的 id 塞进 seen：老元数据反查出的列表必须与 baselineIds 一致，
  // 否则编号会错位（这正是"整列都显示没做出来"的原因）
  const idsOfLegacy = mod.baselineIdsFor
    ? mod.baselineIdsFor({ baseline: "glm53flash", baselineTask: "live_bench/math/olympiad", baselinePicks: ["failed"] })
    : null;
  if (!Array.isArray(idsOfLegacy) || idsOfLegacy.length !== 8) {
    throw new Error(`baselineIdsFor 应反查出 8 个 id，实际 ${JSON.stringify(idsOfLegacy && idsOfLegacy.length)}`);
  }
  const partialSeen = new Set([idsOfLegacy[0], idsOfLegacy[4]]);
  const legacyPartial = mod.missingBaselineIndexes(
    { baseline: "glm53flash", baselineTask: "live_bench/math/olympiad", baselinePicks: ["failed"], begin: null, end: null },
    partialSeen);
  if (JSON.stringify(legacyPartial) !== JSON.stringify([1, 2, 3, 5, 6, 7])) {
    throw new Error(`老元数据部分完成应为 [1,2,3,5,6,7]，实际 ${JSON.stringify(legacyPartial)}`);
  }
  return "8 条用例";
});

// ---------------------------------------------------------------------------
// 回归测试：答案行归并（补跑会把新答案**追加**到同一个文件里）
//
// 踩过的坑：kimi-k3 那次 8 题全 502（中转 502 Upstream service temporarily
// unavailable），跑完后没有自动补跑（baseline 请求不送 benchNames，扫描函数扫了个空）。
// 补跑用的是 --resume --retry-failures：只重跑失败题，新答案追加在旧行后面，
// 旧行不会被删。按行累加就会把同一题算两次 —— 作答数、$ERROR$ 数虚高，
// 括号里的「没做出来 / 选择题数」跟着一起错。
// ---------------------------------------------------------------------------
await check("答案行归并（补跑去重）", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const q1 = "0499deda2f068008d488551abf96b4b758c6ed6b79cd2ec6a204d1250b140421";
  const q2 = "0d3a48049dc5da31531654f59e7866832579f812b892610bd1b178fc4d010d0c";
  const errLine = (qid, ansId) => `{"question_id": "${qid}", "answer_id": "${ansId}", "model_id": "m", "choices": [{"index": 0, "turns": ["$ERROR$"]}], "api_info": {"eval_status": "api_error"}}`;
  const okLine = (qid, ansId) => `{"question_id": "${qid}", "answer_id": "${ansId}", "model_id": "m", "choices": [{"index": 0, "turns": ["final answer"]}]}`;
  const emptyLine = (qid, ansId) => `{"question_id": "${qid}", "answer_id": "${ansId}", "model_id": "m", "choices": [{"index": 0, "turns": [""]}], "api_info": {"eval_status": "token_exhaustion"}}`;
  const cases = [
    // [说明, 行, 期望作答数, 期望 $ERROR$ 数, 期望空答案数, 期望有效答案数]
    ["补跑成功：旧 $ERROR$ + 新答案 → 只算 1 题、无失败",
      [errLine(q1, "olderr1"), okLine(q1, "newok22")], 1, 0, 0, 1],
    ["补跑又失败：旧答案 + 新 $ERROR$ → 只算 1 题、1 失败",
      [okLine(q1, "oldok11"), errLine(q1, "newerr2")], 1, 1, 0, 0],
    ["思考吃满 token：算「没做出来」，但不是 $ERROR$",
      [emptyLine(q1, "empty11")], 1, 0, 1, 0],
    ["补跑把空答案换成了真答案",
      [emptyLine(q1, "empty11"), okLine(q1, "newok22")], 1, 0, 0, 1],
    ["两题各一行 → 2 题",
      [okLine(q1, "ok11111"), okLine(q2, "ok22222")], 2, 0, 0, 2],
  ];
  const bad = [];
  for (const [label, lines, wantAnswered, wantErrors, wantEmpty, wantOk] of cases) {
    const stat = mod.reduceAnswerLines(lines.join("\n"));
    if (stat.answered !== wantAnswered || stat.errors !== wantErrors
      || stat.empty !== wantEmpty || stat.okIds.size !== wantOk) {
      bad.push(`${label}: got answered=${stat.answered} errors=${stat.errors} empty=${stat.empty} ok=${stat.okIds.size}`);
    }
  }
  if (bad.length > 0) throw new Error(bad.join(" | "));
  return `${cases.length} 条用例`;
});

// ---------------------------------------------------------------------------
// 回归测试：判分只认「属于本次答案」的那一条
//
// 踩过的坑：补跑会换新的 answer_id，而旧答案（$ERROR$ 那一版）的 0 分判分
// 还留在 ground_truth_judgment.jsonl 里。老实现把所有判分行直接求和，
// 于是"补跑后全做对"也会被旧 0 分拉低（8 题 4 对 + 4 条旧 0 分 = 50%）。
// ---------------------------------------------------------------------------
await check("判分与答案配对（补跑不被旧判分拉低）", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const qids = Array.from({ length: 8 }, (_, i) => `000000000000000000000000000000000000000000000000000000000000000${i}`);
  const errLines = qids.map((q, i) => `{"question_id": "${q}", "answer_id": "old${i}0000", "model_id": "m", "choices": [{"index": 0, "turns": ["$ERROR$"]}], "api_info": {"eval_status": "api_error"}}`);
  const oldJudgments = qids.map((q, i) => ({ questionId: q, answerId: `old${i}0000`, score: 0, tstamp: 100 + i }));

  // ① 补跑前：8 题全 $ERROR$，判分全是 0 分 → 一题都不进分母，正确率 null（面板显示 —）
  const before = mod.reduceAnswerLines(errLines.join("\n"));
  if (before.answered !== 8 || before.errors !== 8) {
    throw new Error(`补跑前应为 8 题全 $ERROR$，实际 answered=${before.answered} errors=${before.errors}`);
  }
  const s0 = mod.scoreJudgments(oldJudgments, before.byQid);
  if (s0.judged !== 0) throw new Error(`全失败时分母应为 0，实际 ${s0.judged}`);

  // ② 补跑后：8 题都拿到新答案（新 answer_id），判分文件里旧 0 分 + 新判分并存
  const newLines = qids.map((q, i) => `{"question_id": "${q}", "answer_id": "new${i}0000", "model_id": "m", "choices": [{"index": 0, "turns": ["final answer"]}]}`);
  const newJudgments = qids.map((q, i) => ({ questionId: q, answerId: `new${i}0000`, score: 0.25 * (i % 5), tstamp: 900 + i }));
  const after = mod.reduceAnswerLines([...errLines, ...newLines].join("\n"));
  if (after.answered !== 8 || after.errors !== 0 || after.okIds.size !== 8) {
    throw new Error(`补跑后应为 8 题全有答案，实际 answered=${after.answered} errors=${after.errors} ok=${after.okIds.size}`);
  }
  const s1 = mod.scoreJudgments([...oldJudgments, ...newJudgments], after.byQid);
  const wantSum = newJudgments.reduce((n, j) => n + j.score, 0);
  if (s1.judged !== 8) throw new Error(`补跑后分母应为 8（旧判分不算），实际 ${s1.judged}`);
  if (Math.abs(s1.sum - wantSum) > 1e-9) throw new Error(`补跑后分数应为新判分之和 ${wantSum}，实际 ${s1.sum}`);

  // ③ 部分补跑成功：5 题有答案、3 题仍是 $ERROR$ → 分母只有 5
  const partial = mod.reduceAnswerLines([...errLines, ...newLines.slice(0, 5)].join("\n"));
  const s2 = mod.scoreJudgments([...oldJudgments, ...newJudgments.slice(0, 5)], partial.byQid);
  if (s2.judged !== 5) throw new Error(`部分补跑时分母应为 5，实际 ${s2.judged}`);

  // ④ 老判分没有 answer_id（无法区分）→ 沿用旧行为计入
  const legacy = mod.scoreJudgments([{ questionId: qids[0], answerId: null, score: 1, tstamp: 5 }], after.byQid);
  if (legacy.judged !== 1 || legacy.sum !== 1) {
    throw new Error(`老判分（无 answer_id）应计入，实际 judged=${legacy.judged} sum=${legacy.sum}`);
  }
  // ⑤ 只剩旧答案的判分（当前答案换了 id）→ 丢弃，宁可少一题也不给错分
  const stale = mod.scoreJudgments([{ questionId: qids[0], answerId: "gone0000", score: 1, tstamp: 5 }], after.byQid);
  if (stale.judged !== 0) throw new Error(`旧答案的判分应丢弃，实际 judged=${stale.judged}`);
  return "5 条用例";
});

// ---------------------------------------------------------------------------
// 回归测试：Anthropic 模型一律走 anthropic-messages 协议
//
// 用户要求：后续测 Anthropic/Claude 系模型，一律用 /v1/messages 协议（会话窗口用的就是它）。
// 面板据此不看 settings.yaml 里的 api 字段：名字里带 claude/anthropic 就走 anthropic 通道。
// baseURL 还要规范化 —— anthropic SDK 自己会拼 /v1/messages，
// 若直接把 openai 兼容渠道习惯写的 `https://host/v1` 交给它，会 POST 到
// `https://host/v1/v1/messages`（404）。
// ---------------------------------------------------------------------------
await check("Anthropic 模型的路由与 baseURL 规范化", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const bad = [];
  const cases = [
    ["https://api.aiportx.com", "https://api.aiportx.com"],
    ["https://api.aiportx.com/", "https://api.aiportx.com"],
    ["https://api.aiportx.com/v1", "https://api.aiportx.com"],
    ["https://api.aiportx.com/v1/", "https://api.aiportx.com"],
    ["https://api.aiportx.com/v1/messages", "https://api.aiportx.com"],
    ["https://code28.ccwu.cc", "https://code28.ccwu.cc"],
  ];
  for (const [input, want] of cases) {
    const got = mod.anthropicBaseUrl(input);
    if (got !== want) bad.push(`${input} → ${got}（应为 ${want}）`);
  }
  if (!mod.isAnthropicModel("aiportx-claude", "claude-fable-5-1")) bad.push("claude 模型应判为 anthropic");
  if (!mod.isAnthropicModel("my-provider", "claude-opus-5")) bad.push("按 model id 也应判为 anthropic");
  if (!mod.isAnthropicModel("anthropic-proxy", "some-model")) bad.push("按 provider id 也应判为 anthropic");
  if (mod.isAnthropicModel("aiportx-kimi", "kimi-k3")) bad.push("kimi-k3 不该判为 anthropic");
  if (mod.isAnthropicModel("deepseek-official", "deepseek-flash")) bad.push("deepseek 不该判为 anthropic");

  // thinking 档位：low/medium/high/xhigh/max 有预算；off → disabled；未选 → 不写
  if (mod.thinkingBudgetForEffort("max") !== 16384) bad.push("max 档预算应为 16384");
  if (mod.thinkingBudgetForEffort("low") !== 2048) bad.push("low 档预算应为 2048");
  if (mod.thinkingBudgetForEffort("off") !== null) bad.push("off 档不应有预算");
  const enabled = mod.thinkingModeForEffort("xhigh");
  if (!enabled || enabled.type !== "enabled" || enabled.budget_tokens !== 16384) bad.push("xhigh 应给 enabled+16384");
  const disabled = mod.thinkingModeForEffort("off");
  if (!disabled || disabled.type !== "disabled") bad.push("off 应给 disabled");
  if (mod.thinkingModeForEffort(null) !== null) bad.push("没选强度时不应写 thinking");
  if (bad.length > 0) throw new Error(bad.join(" | "));
  return `${cases.length + 10} 条用例`;
});

// ---------------------------------------------------------------------------
// 回归测试：settings.yaml 里的渠道约束必须被读进来
//
// 踩过的坑：面板只读 id/name/reasoningEfforts，把两个约束丢了 ——
//   1. `models[].maxTokens`（claude-fable-5-1 = 64000）→ 面板默认发 --max-tokens 65536，
//      超过该模型在 harness 里声明的上限；
//   2. `streamIdleTimeoutMs`（code-claude = 120000）→ harness 自己给渠道设的
//      "流多久没数据就掐断"，面板要把它透给 LiveBench 的静默看门狗；
//      没声明的渠道必须用保守默认（600s），否则会把 Claude 正常的长思考
//      （实测一题 139~286s、中途空档 172s）当成"挂住"反复掐断。
// ---------------------------------------------------------------------------
await check("渠道约束（maxTokens / streamIdleTimeoutMs）读取", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const providers = mod.providerCapsFromSettings({
    "llm-pi-ai": {
      providers: {
        "aiportx-claude": {
          displayName: "aiportx-claude",
          api: "openai-completions",
          baseURL: "https://api.aiportx.com/v1",
          apiKeyEnv: "AIPORTX_CLAUDE_API_KEY",
          models: [{ id: "claude-fable-5-1", name: "claude-fable-5-1", maxTokens: 64000 }],
        },
        "code-claude": {
          api: "anthropic-messages",
          baseURL: "https://code28.ccwu.cc",
          streamIdleTimeoutMs: 120000,
          models: [{ id: "claude-fable-5-1", maxTokens: 180000 }],
        },
        "no-caps": { api: "openai-completions", baseURL: "https://x/v1", models: [{ id: "m" }] },
      },
    },
  });
  const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
  if (byId["aiportx-claude"].models[0].maxTokens !== 64000) {
    throw new Error(`claude maxTokens 应为 64000，实际 ${byId["aiportx-claude"].models[0].maxTokens}`);
  }
  if (byId["code-claude"].streamIdleTimeoutMs !== 120000) {
    throw new Error(`code-claude streamIdleTimeoutMs 应为 120000，实际 ${byId["code-claude"].streamIdleTimeoutMs}`);
  }
  if (byId["code-claude"].models[0].maxTokens !== 180000) throw new Error("code-claude 模型上限未读到");
  if (byId["aiportx-claude"].streamIdleTimeoutMs !== null) throw new Error("未声明时应为 null（交给 LiveBench 的保守默认）");
  if (byId["no-caps"].models[0].maxTokens !== null) throw new Error("未声明 maxTokens 时应为 null");
  if (!byId["deepseek-official"]) throw new Error("内置 deepseek-official 路由丢了");
  // 输出上限的字段名：会话窗口（pi-ai）怎么发，面板就让 LiveBench 怎么发
  if (byId["aiportx-claude"].maxTokensField !== "max_completion_tokens") {
    throw new Error(`aiportx 这类中转应为 max_completion_tokens，实际 ${byId["aiportx-claude"].maxTokensField}`);
  }
  if (mod.maxTokensFieldFor({ id: "deepseek", baseURL: "https://api.deepseek.com" }) !== "max_tokens") {
    throw new Error("deepseek 应为 max_tokens");
  }
  if (mod.maxTokensFieldFor({ id: "x", baseURL: "https://api.z.ai/v1" }) !== "max_tokens") throw new Error("z.ai 应为 max_tokens");
  if (mod.maxTokensFieldFor({ id: "x", baseURL: "https://x/v1", compat: { maxTokensField: "max_tokens" } }) !== "max_tokens") {
    throw new Error("settings.yaml 里显式声明的 compat.maxTokensField 应优先");
  }
  return "10 条用例";
});

// ---------------------------------------------------------------------------
// 回归测试：生成的模型配置必须带上"输出上限字段名"
//
// 现场：aiportx-claude 同一道 olympiad 题、同一 reasoning_effort=max，
//   发 max_completion_tokens=64000 → 224s 跑完（最大空档 106s）
//   发 max_tokens=64000        → 1232s 才跑完，中途 449s 一个 chunk 都没有（面板里"卡死"）
// LiveBench 只按模型名里有没有 "gpt" 选字段，所以必须由面板在配置里写死。
// ---------------------------------------------------------------------------
await check("模型配置写入输出上限字段（max_completion_tokens）", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const { mkdtempSync, mkdirSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "dlb-cfg-"));
  try {
    mkdirSync(join(root, "model", "model_configs"), { recursive: true });
    const layout = { livebenchDir: root };

    const err1 = mod.writeGeneratedModelConfig(layout, null, {
      displayName: "aiportx-claude__claude-fable-5-1@max__r1",
      modelId: "claude-fable-5-1",
      reasoningEffort: "max",
      protocol: "openai",
      maxTokens: 64000,
      maxTokensField: "max_completion_tokens",
    });
    if (err1 !== null) throw new Error(`写入失败：${err1}`);
    const doc = readFileSync(join(root, "model", "model_configs", "dsh_panel_generated__aiportx-claude__claude-fable-5-1@max__r1.yaml"), "utf8");
    if (!doc.includes("max_completion_tokens: 64000")) throw new Error(`配置里没有 max_completion_tokens：\n${doc}`);
    if (/^\s*max_tokens:/m.test(doc)) throw new Error("不应同时写 max_tokens（LiveBench 会二选一）");
    if (!doc.includes("reasoning_effort: max")) throw new Error("reasoning_effort 丢了");
    if (!doc.includes("local: claude-fable-5-1")) throw new Error("api_name 丢了");

    // deepseek 这类渠道用 max_tokens：面板不写任何字段，交给 LiveBench 走它自己的默认
    const err2 = mod.writeGeneratedModelConfig(layout, null, {
      displayName: "deepseek-official__deepseek-v4-flash@max__r2",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "max",
      protocol: "openai",
      maxTokens: 8192,
      maxTokensField: "max_tokens",
    });
    if (err2 !== null) throw new Error(`写入失败：${err2}`);
    const doc2 = readFileSync(join(root, "model", "model_configs", "dsh_panel_generated__deepseek-official__deepseek-v4-flash@max__r2.yaml"), "utf8");
    if (doc2.includes("max_completion_tokens") || /^\s*max_tokens:/m.test(doc2)) {
      throw new Error(`max_tokens 渠道不该写字段名：\n${doc2}`);
    }
    if (!doc2.includes("reasoning_effort: max")) throw new Error("reasoning_effort 丢了");
    return "2 条用例";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 回归测试：HF 数据集离线判断
//
// 踩过的坑：`--bench-name live_bench`（全跑）时 bench 路径里没有分类段，而
// "要跑哪些数据集"是按分类拼缓存目录（livebench___<分类>）判断的。
// 漏掉分类 → 集合为空 → 判成"没缓存" → 每个分类的 HEAD 请求都超时重试 5 轮
// （WinError 10060 刷屏；实测跑到第 3 个分类已经白等 10 分钟，题目一道没开始跑）。
// ---------------------------------------------------------------------------
await check("HF 数据集离线判断（全跑 live_bench 也要认出来）", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const cats = ["coding", "data_analysis", "instruction_following", "math", "reasoning", "language"];
  const setOf = (paths) => [...mod.hfCategoriesFor(paths, cats)].sort().join(",");

  const all = setOf(["live_bench"]);
  if (all !== [...cats].sort().join(",")) throw new Error(`全跑应需全部分类，实际 ${all}`);
  const one = setOf(["live_bench/math/olympiad"]);
  if (one !== "math") throw new Error(`单任务应只需 math，实际 ${one}`);
  const two = setOf(["live_bench/math", "live_bench/coding/LCB_generation"]);
  if (two !== "coding,math") throw new Error(`分类+任务应为 coding,math，实际 ${two}`);
  const empty = mod.hfCategoriesFor([], cats).size;
  if (empty !== 0) throw new Error(`空 bench 列表应为空集，实际 ${empty}`);

  // 分类列表的权威来源是 LiveBench 自己的 common.py
  const real = process.env.DSH_LIVEBENCH_HOME || "V:\\PythonProject\\C_UtilizeSpace\\LiveBench";
  if (existsSync(resolve(real, "livebench", "common.py"))) {
    const parsed = mod.livebenchCategories(real);
    if (parsed.length < 5 || !parsed.includes("math")) {
      throw new Error(`从 common.py 解析出的分类不对：${JSON.stringify(parsed)}`);
    }
  }
  const fallback = mod.livebenchCategories(resolve(ROOT, "no-such-livebench"));
  if (fallback.length !== cats.length) throw new Error(`读不到源码时应回退到内置列表，实际 ${JSON.stringify(fallback)}`);
  return "5 条用例";
});

// ---------------------------------------------------------------------------
// 回归测试：自动补跑的扫描范围
//
// 踩过的坑（kimi-k3 8 题全 502 那次）：扫描函数读的是 body.benchNames，
// 而 Baseline 请求送的是 baseline/baselineTask/baselinePicks —— 没有 benchNames，
// 于是扫了个空，"检测到 N 条失败答案"永远不会触发，评测全军覆没也没有任何重试。
// 现在扫描用服务端解析后的 bench 列表（live_bench/<cat>[/<task>]）。
// ---------------------------------------------------------------------------
await check("自动补跑扫描（Baseline 也能找到失败题）", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "lib/index.js")).href);
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "dlb-scan-"));
  try {
    // dataDir 就是 <LiveBench>/livebench/data/live_bench，bench 路径的第一段是它自己
    const dir = join(root, "math", "olympiad", "model_answer");
    mkdirSync(dir, { recursive: true });
    const q = (i) => `000000000000000000000000000000000000000000000000000000000000000${i}`;
    const errLine = (i) => `{"question_id": "${q(i)}", "answer_id": "err${i}0000", "model_id": "m", "choices": [{"index": 0, "turns": ["$ERROR$"]}], "api_info": {"eval_status": "api_error"}}`;
    const okLine = (i) => `{"question_id": "${q(i)}", "answer_id": "ok${i}00000", "model_id": "m", "choices": [{"index": 0, "turns": ["answer"]}]}`;
    // 3 题：0 失败、1 失败后又补跑成功、2 正常
    writeFileSync(join(dir, "aiportx-kimi__kimi-k3@xhigh__r1.jsonl"),
      [errLine(0), errLine(1), okLine(1), okLine(2)].join("\n") + "\n", "utf8");

    // Baseline 场景：bench 列表由服务端从 baselineTask 解析而来（body 里没有 benchNames）
    const r = await mod.countErrorAnswersAsync(root, "aiportx-kimi__kimi-k3@xhigh__r1", ["live_bench/math/olympiad"]);
    if (r.errors !== 1 || r.failedIds.length !== 1 || r.failedIds[0] !== q(0)) {
      throw new Error(`应只剩 1 题失败（第 1 题补跑成功过），实际 ${JSON.stringify(r.failedIds)}`);
    }
    // 分类级 bench（live_bench/math）也要能扫到
    const byCat = await mod.countErrorAnswersAsync(root, "aiportx-kimi__kimi-k3@xhigh__r1", ["live_bench/math"]);
    if (byCat.errors !== 1) throw new Error(`live_bench/math 级别应扫到 1 题，实际 ${byCat.errors}`);
    // bench 列表为空（旧实现就是这种情况）→ 扫不到任何东西
    const empty = await mod.countErrorAnswersAsync(root, "aiportx-kimi__kimi-k3@xhigh__r1", []);
    if (empty.errors !== 0) throw new Error(`空 bench 列表应为 0，实际 ${empty.errors}`);
    return "3 条用例";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(failed.length === 0 ? "\n全部通过 ✅" : `\n${failed.length} 项失败 ❌`);
process.exit(failed.length === 0 ? 0 : 1);
