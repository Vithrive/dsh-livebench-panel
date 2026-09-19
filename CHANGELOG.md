# Changelog

本文件记录对外可见的行为变化。更早的版本历史见 npm：
<https://www.npmjs.com/package/dsh-livebench-panel?activeTab=versions>

版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.24] — 2026-09-19

- **修复「dsh web 从 conda 已激活的终端启动时，评测必然失败」**。现场：
  ```
  'source' is not recognized as an internal or external command
  Activating virtual environment: D:\ProgramData\Anaconda3\envs\mineru\bin\activate
  ModuleNotFoundError: No module named 'shortuuid'
  ```
  三个缺陷叠加：
  1. 插件把 `dsh web` 进程继承来的 `VIRTUAL_ENV`（此处是 conda 的 `mineru` 环境）原样传给 `run_livebench.py`；
  2. LiveBench 的 `detect_active_venv()` 读 `VIRTUAL_ENV` 后一律拼成 `<venv>/bin/activate`
     （Unix 路径），再执行 `source ...` —— Windows 上必然失败；
  3. 更致命的是它随后用**写死的 `:`** 拼 PATH，把插件刚前置好的 venv `Scripts` 条目和下一段
     粘成无效路径 `D:\...\mineru\bin:C:\WINDOWS\system32`，等于把 venv 解释器从 PATH 里删掉，
     后面裸调的 `python` 就回退到 conda 解释器（缺 LiveBench 依赖）。

  面板侧现在会从子进程环境里删掉 `VIRTUAL_ENV` / `CONDA_PREFIX` / `CONDA_DEFAULT_ENV`
  （它自己已经把正确的 venv 放在 PATH 最前，不需要任何 activate）；
  LiveBench 侧见 [docs/livebench-patches.md](docs/livebench-patches.md)。

## [0.2.23] — 2026-09-12

- **修复「空字符串范围被当成 0..0」**：面板表单没填起止时提交的是 `""` 而不是 `null`，
  旧代码只判 `!== null/undefined`，于是 `Number("") === 0`，范围被当成 `0..0` ——
  只检查第 0 题，导致「没做出来的题号」显示为空、而括号里却写着 5 题没做出来。
  现在 `""` 与 `null` 一律视为"未设范围"；写入元数据时也把空串规范化成 `null`。
- 「没做出来的题号」的定义收紧为**没有有效答案**的题：压根没跑、跑了但空答案
  （思考吃满 max-tokens）、跑了但 API 失败，三类都算——它们都该出分母，也都是要补跑的题。
- Baseline 且未设范围时，「选择题数」恒等于题库大小（不再随已答题数变化）。
- 老运行的元数据没有 `baselineIds` 时，可从 `baseline / baselineTask / baselinePicks`
  反查还原（`baselineIdsFor`），历史行也能列出缺失题号。

## [0.2.22] — 2026-09-12

- **Baseline 行现在会列出「没做出来的题号」**。编号是该题库内的 0 起下标，与
  「题目序号范围」的编号一致，可以直接复制去重跑（例如只补跑 `3`）。
  悬停在分数格上即可看到。
- 题号计算同样按**题库实际题数**裁剪：8 题的题库填 `0-1000`，基准仍是 8，
  题号只可能落在 `0-7`，不会按 1001 去编号。
- 新增回归测试：`clampedRangeLength` 覆盖 `0-1000` / `-5-1000` 等越界输入；
  `missingBaselineIndexes` 覆盖全量 / 越界范围 / 部分范围 / 尾部越界 / 全做出来 / 非 baseline。

## [0.2.21] — 2026-09-12

- **修复正确率分母：没做出来的题不再算作"做错"**。推理模型在难题上会把 `max_tokens`
  全烧在思考里、正文为空（`eval_status=token_exhaustion`），这类答案行**不是**
  `$ERROR$`，于是被当成"做错了"进了分母。实测 `deepseek-flash@max` 8 题里只答出 1 题
  （0.9167 分）却显示 **11.5%**（= 0.9167/8）；按「做对的题 / 做出来的题」应为 **91.7%**。
  现在答案行分三类：正常 / `$ERROR$`（API 失败）/ 空答案（token 耗尽、正文为空），
  后两类都从分母剔除，并在 tooltip 里分别标注。
- **max-tokens 上限 32768 → 200000**。olympiad 这类题的参考模型实测输出普遍在
  27k–30.6k，8 道"错题"全部是撞到 32768 上限后正文为空——也就是说旧上限会让
  "能力不够"和"预算不够"混在一起。
- 新增回归测试：空答案识别 6 条 + 正确率口径 1 条（`node scripts/check.mjs`）。

## [0.2.20] — 2026-09-12

- **新增 Baseline 题库（探针）**：位于「分类 / 任务」之上的独立条目，三层可选 ——
  参考模型 → 任务 → 做对/做错（各带题目数量）。选中后可以不选任何分类/任务，
  「不选 = 全部分类」这条规则对它不适用；「题目序号范围」仍然生效，序号相对该题库。
  首发内置 `Baseline(glm-5.3-flash@max)` 的 `math/olympiad`（全量 36 题，做对 28 / 做错 8）。
- **修复成绩表"选择题数"的边界裁剪统计错误**：题库只有 8 题而题号范围填 0-8 时，
  旧实现只做 `min(total, end-begin+1)` 会算出 9 题（`total` 还取的是任务原始题数 72），
  于是 `notDone` 永远多 1，全做对也显示 `(-1/8)`。现在按 Python 切片语义裁剪
  （`min(total, end+1) - min(total, begin)`），且基准按
  `Baseline 子集大小 > 该 release 下有效题数 > 原始题数` 依次选取。
  两者都加了回归测试（`node scripts/check.mjs`）。
- 成绩表**默认按 time 倒序**排列（最新在前）；点击表头仍可切换模型名/时间排序，
  拖 ⠿ 则回到本机保存的自定义行序。没有时间戳的行固定排在最后。

## [0.2.19] — 2026-09-12

- 为 Baseline 题库打基础：支持把「一组 question id」交给 LiveBench 跑
  （`--question-id`），并在成绩表里标注该行属于哪个 Baseline 子集。
  注意 `--question-id` 与 `--question-begin/--question-end` 叠加时，范围作用在
  **id 过滤之后**的列表上。

## [0.2.18] — 2026-09-11

- **修复 provider 被悄悄换掉**：以前当 provider 既不是 anthropic/responses、且未选推理强度时，
  面板不写自己的模型配置，并把**裸模型名**当 `--model` 传给 LiveBench。LiveBench 的
  `get_model_config(裸名)` 会命中它自带的同名配置（例如 `kimi-k3` 命中 `moonshotai.yml`），
  于是改用那份配置的 provider / `api_kwargs` / `max_tokens`。现在**每次都写自己的配置**，
  `--model` **永远用 display-name**，解析结果确定为 `{local: <modelId>}` + `--api-base`。
- 配套的 LiveBench 侧改动见
  [docs/livebench-patches.md](docs/livebench-patches.md)：把"一遇错就整题 `$ERROR$`"改成
  统一容错层（参数兼容 + 瞬态退避重试 + 空答案重发），并覆盖**所有** provider
  （此前 URL provider 与 `local` 走的是裸函数，根本没有重试）。

## [0.2.17] — 2026-09-11

- 补充 `repository` / `bugs` / `homepage` 元数据，npm 页面可直接跳转本仓库。

## [0.2.16] — 2026-09-11

- **修正题目序号范围的语义**：LiveBench 的 `--question-end` 是**开区间**
  （`gen_api_answer.py` 里是 `questions[begin:end]`），面板原先直接透传，导致界面上
  填「起 6 止 9」实际只跑 3 题。现在面板按用户直觉采用**闭区间**（`止 + 1` 后再传给
  LiveBench），界面填的题数与实际跑的题数一致。
- 成绩表括号改为 **(本次没做或没做完的题数 / 用户选择的题数)**，去掉不参与正确率
  计算的总题数；`×`（未执行该任务）不再显示无意义的括号。
- 没有运行元数据的历史记录，选择题数兜底由「该任务总题数」改为「本次实际写入的答案
  行数」——只跑了几题的老数据不再显示成 150 题。

## [0.2.15] — 2026-09-11

- 成绩表括号显示语义调整（配合 0.2.16 的口径）。

## [0.2.14] — 2026-09-11

- 同上：单元格副标题与 tooltip 文案随口径调整。

## [0.2.13] — 2026-09-11

- **修复「删除成绩后一刷新又回来」**：`/delete` 把答案文件删空后会留下 0 字节空壳，
  而 `/results` 是按 `model_answer/` 的**文件名**推导模型行的，于是那一行又被扫描出来。
  现在：
  - `/results` 忽略 0 行的答案文件（不再凭空产出成绩行）；
  - `/delete` 清空后直接删除文件（含历史遗留的 0 字节空壳）；
  - 正在评测中的模型会被跳过，并在响应 `skipped` 中返回，前端弹窗提示。
- 顺带清理了数据目录中 67 个 0 字节 `*.jsonl`。

[0.2.24]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.23...v0.2.24
[0.2.23]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.22...v0.2.23
[0.2.22]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.21...v0.2.22
[0.2.21]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.20...v0.2.21
[0.2.20]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.18...v0.2.20
[0.2.18]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.17...v0.2.18
[0.2.17]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/Vithrive/dsh-livebench-panel/compare/v0.2.12...v0.2.13
