# Changelog

本文件记录对外可见的行为变化。更早的版本历史见 npm：
<https://www.npmjs.com/package/dsh-livebench-panel?activeTab=versions>

版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.30] — 2026-09-23

本轮把"Anthropic 模型怎么发请求"和"看门狗怎么判死"两件事彻底定死。

- **Anthropic/Claude 系模型一律走 anthropic-messages 协议**（不再看 settings.yaml 里的 `api`）：
  名字里带 `claude` / `anthropic`（provider 或 model 任一）就走 LiveBench 的原生 anthropic 客户端，
  POST 到 `<baseURL>/v1/messages`，与会话窗口同协议。
  `baseURL` 会规范化（剥掉结尾的 `/`、`/v1`、`/v1/messages`）—— anthropic SDK 自己会拼
  `/v1/messages`，若把 openai 兼容渠道习惯写的 `https://host/v1` 直接交给它，会打到
  `https://host/v1/v1/messages`（404）。
- **请求形状对齐会话窗口（pi-ai）**，anthropic 通道写进生成的模型配置：
  - `thinking: {type: enabled, budget_tokens: N}`，N 按强度档取
    minimal 1024 / low 2048 / medium 8192 / high·xhigh·max 16384（= pi-ai 的 `DEFAULT_THINKING_BUDGETS`
    + `clampReasoning`）；强度选 `off` 时写 `{type: disabled}`（不写反而会让上游走"默认开思考"）；
  - 开了 thinking 就**不发 temperature**（写 `temperature: null`）。
  - 输出上限：`max_tokens` 夹到 `models[].maxTokens`（如 claude-fable-5-1 = 64000），
    非 anthropic 通道再按渠道习惯选字段名（aiportx 这类中转用 `max_completion_tokens`）。
- **看门狗不再自己制造故障**：以前只按 SDK 事件计时，而难题下模型进入 extended thinking、
  思考内容不回传、网关每 3 秒只发 `ping` —— 健康的长思考被判成"挂住"反复掐断，
  日志里刷 `RemoteProtocolError: peer closed connection without sending complete message body`。
  现在 **连接上任何字节的到达（含 ping）都算活着**；另加两道硬边界：
  - 单次请求总时长上限 `LIVEBENCH_STREAM_MAX_SECONDS`（默认 1800s，0=关闭）——
    即使保活不断，正文永远不来也会断开重试；
  - 首个字节等待上限 `LIVEBENCH_FIRST_BYTE_TIMEOUT`（默认 600s）——
    看门狗要等流对象建好才接管，这段窗口由 httpx 的 read 超时兜住。
  静默阈值默认仍是 600s，并按渠道声明的 `streamIdleTimeoutMs` 覆写。
- 运行日志首行新增 `[route]`：写明本次走哪个协议、POST 到哪个地址、max_tokens 与 thinking 形状，
  出问题时不必再猜面板发了什么。
- 回归自检：面板 **16 项**（新增「Anthropic 路由与 baseURL 规范化」16 条用例）、
  LiveBench 故障矩阵 **31 个场景**（新增 ping 字节算活 / 总时长到顶断开）。

## [0.2.29] — 2026-09-23

现场：`aiportx-claude/claude-fable-5-1@max` 在会话窗口里很快，一进 LiveBench 就"慢/卡死"。

- **根因：输出上限的字段名不一样。** 会话窗口走 pi-ai，会按渠道自动选字段
  （`openai-completions.js` 的 `detectCompat().maxTokensField`）：aiportx、code28 这类中转用
  **`max_completion_tokens`**；deepseek / moonshot / z.ai / together / nvidia / ant-ling /
  chutes / Cloudflare 网关用 `max_tokens`。而 LiveBench 的 `chat_completion_openai` 只看模型名里
  有没有 `"gpt"`：非 gpt 模型一律发 `max_tokens`。同一道 olympiad、同一 `reasoning_effort=max`，
  只换字段名的实测：
  - `max_completion_tokens=64000` → **224s 跑完**（1263 chunk、6297 字符，最大空档 106s）
  - `max_tokens=64000` → **420s 仍在静默**（首块 3.8s、276 chunk 后 172.7s 一个 chunk 都没有），
    无看门狗时长测跑到 **1232s** 才结束、中途空档最大 **449s**

  即：发错字段会让网关走"长思考"路径，把一道题拖成十几分钟，面板里就是卡死。
- **修复**：面板在生成的模型配置里写死该用哪个字段（`api_kwargs.default.max_completion_tokens`），
  LiveBench 看到就不再自己猜。字段名按 pi-ai 的同一套规则判定
  （`maxTokensFieldFor`，也尊重 settings.yaml 里显式写的 `compat.maxTokensField`），
  并且只在 harness 真会用 `max_completion_tokens` 的渠道上写。
- 回归自检扩到 **16 项**（新增「输出上限字段名」10 条 + 「配置写入」2 条用例）。

## [0.2.28] — 2026-09-22

现场：`aiportx-claude/claude-fable-5-1@max` 跑 `math/olympiad`"效率非常低"——每道题都被
静默看门狗在 120s 处掐断、重试 5 次后记 `$ERROR$`；而同一个模型在会话里访问很快。

- **上一版引入的 regression：静默阈值一刀切 120s，把 Claude 的正常长思考当成"挂住"。**
  无看门狗长测（同一道 olympiad）：首 chunk 4.0s，中途空档 **172s / 235s / 449s**，
  整题跑完 **1232s（20.5 分钟）**、703 chunk；09-12 的历史记录是 139~286s/题、输出 1~2 万 token。
  这种"模型在思考、网关中途一个 chunk 都不转发"是常态，不是挂住。现在：**默认 600s**，
  并且面板把 harness 在 settings.yaml 里为该渠道声明的 `streamIdleTimeoutMs` 透给看门狗
  （`code-claude = 120000` → 120s，那个渠道确实是"接了请求就不回"），两个渠道各用合适的阈值。
- **新增：面板遵守 settings.yaml 里的渠道约束。**
  - `models[].maxTokens`（如 `claude-fable-5-1 = 64000`、`kimi-k3 = 131000`、
    `code-claude = 180000`）现在会夹住 `--max-tokens`：面板默认 65536，对声明 64000 的模型
    会按 64000 发送，并在运行日志首行写明 `[cap] …`；
  - `streamIdleTimeoutMs` 作为静默看门狗阈值透给 LiveBench（见上）；
  - 两者都从 settings.yaml 解析（`providerCapsFromSettings`，纯函数、有回归用例），
    `/config` 也把它们暴露给前端。
- 回归自检扩到 **14 项**（新增「渠道约束读取」6 条用例）。

## [0.2.27] — 2026-09-22

现场：`code-claude`（`https://code28.ccwu.cc`）跑 `math/olympiad` 时面板**完全没有动静** ——
进度条停在 0/8，日志一个字都不再输出，十几分钟没有任何反应（用会话窗口访问同一渠道是正常的）。

- **根因不在模型，在"静默"没人管**。实测该渠道对 olympiad 题面：非流式直接 Cloudflare **524**
  （125s 无响应）；流式是"首事件 3~6s 之后彻底静默、正文 0 字符"。同一渠道换简单 prompt、
  换 1400 词英文 prompt 都正常（71s / 7823 字符）——**内容相关的上游静默**。
  而 LiveBench 的流式通道既没有超时也没有静默检测（httpx 的 read 超时按"两次读的间隔"算，
  网关 keep-alive 让它永不触发；Anthropic SDK 默认 600s 同样拦不住），于是一道题能静默十几分钟。
- **LiveBench 侧两处兜底**（细节见 [docs/livebench-patches.md](docs/livebench-patches.md)）：
  - 两条流式通道都加 `_IdleStreamGuard`：`LIVEBENCH_STREAM_IDLE_TIMEOUT`（默认 **120s**，
    与 harness 里该渠道的 `streamIdleTimeoutMs` 一致，0=关闭）内没有任何事件就主动关流，
    日志写明「上游 120s 没有任何输出（连接还开着，疑似被挂住）→ 主动断开，交给容错层重试」，
    再按瞬态错误退避重试；
  - Anthropic 通道给显式 `httpx.Timeout(1800, connect=15)` + `max_retries=0`
    （重试统一交给容错层，日志才看得见）。
  - 另有一处更早的兜底：**请求形状降级阶梯** —— 连续 2 次同形状 5xx 后依次试
    `temperature 0→1` / 不传 `temperature` / 去掉 `stream_options` / 去掉 `model_api_kwargs`，
    专治"参数被网关伪装成 502"（aiportx + kimi-k3 现场）。
- 回归自测扩到 **29 个场景**（新增静默看门狗：无事件时主动断开、有心跳时不误判）。

## [0.2.26] — 2026-09-21

现场：`--bench-name live_bench`（全部分类）的评测卡在 huggingface.co 的 HEAD 超时
重试上，日志刷满 `[WinError 10060] … Retrying in 1s/2s/4s/8s [Retry N/5]`，
跑到第 3 个分类已白等 10 分钟，题目一道都还没开始跑。

- **修复「全跑时 HF 离线判断失效」**。数据集缓存的判断是按分类拼目录
  （`.hf_cache/datasets/livebench___<分类>`）做的，而 `--bench-name live_bench`
  的路径里没有分类段（旧代码直接 `return false`）→ 判成"没缓存" → 联网 → 6 个分类
  各刷 5 轮超时重试。现在裸 `live_bench` 会补上**全部分类**（分类列表直接读
  LiveBench 源码里的 `LIVE_BENCH_CATEGORIES`，读不到用内置兜底），分类缓存齐全即离线启动。
- 缺缓存的分类不再静默：运行日志首行会写明"以下分类的数据集还没有本地缓存：…，
  本次会联网向 huggingface.co 取；连不通时会先超时重试 5 轮再失败"，
  省得再把这段等待当成故障来排查。

## [0.2.25] — 2026-09-19

现场：一次 Baseline 评测（`aiportx-kimi/kimi-k3@xhigh`，8 题）全程撞上中转的
`502 Upstream service temporarily unavailable`，8 题全部 `$ERROR$`，35 分钟后
"Benchmark completed successfully"，成绩表只留下一行 `—`，**没有任何重试**。

- **修复「Baseline 评测不会自动补跑」**。自动补跑的扫描函数读的是 `body.benchNames`，
  而 Baseline 请求送的是 `baseline / baselineTask / baselinePicks`（不含 `benchNames`），
  于是扫描范围为空集，"检测到 N 条失败答案"永远不会触发。现在扫描用**服务端解析后**的
  bench 列表（`live_bench/<分类>[/<任务>]`），Baseline 与普通评测走同一条路径。
  运行日志里也会明确写出补跑检查结果（`[自动补跑] …`）。
- **自动补跑复用同一个 display-name**：以前补跑会生成新的时间戳条目名，等于把整套题目
  重跑一遍（浪费已成功的答案），成绩表里还会多出一行。现在补跑写回同一个答案文件，
  `--resume --retry-failures` 只重跑失败的那几题，其余答案与判分都保留。
- **修复「补跑后正确率被旧判分拉低」**（潜在错误，比上面更危险）：补跑会为同一题生成
  新的 `answer_id`，而旧答案（`$ERROR$` 那一版）的 0 分判分仍留在
  `ground_truth_judgment.jsonl` 里。旧实现把所有判分行直接求和，于是"补跑后全做对"
  也会被旧 0 分拽下来（8 题 4 对 + 4 条旧 0 分 = 50%）。现在判分与答案按
  `answer_id` 配对，只统计**属于本次答案**的判分；没做出答案（`$ERROR$` /
  思考吃满 token）的题，其判分一律不进分母。
- **修复「同一题被算两次」**：补跑的答案追加在同一个文件里，旧行不会被删
  （LiveBench 自己按 `question_id` 取最后一行）。面板现在也按 `question_id` 归并，
  作答数、`$ERROR$` 数、括号里的「没做出来 / 选择题数」不再虚高。
- **max-tokens 默认值 32000 → 65536**：推理模型在 olympiad 这类难题上会把预算全烧在
  思考里（`eval_status=token_exhaustion`，正文为空 → 记「没做出来」），32k 不够。
  上限仍是 200000。
- **huggingface.co 连不通时不再白等**：题目数据集已缓存的分类直接以
  `HF_HUB_OFFLINE=1` 启动，跳过 5 轮 HEAD 超时重试（实测每次白等 20~60s 并刷一屏
  `WinError 10060`）；缺缓存的分类仍保持联网，避免新 release 取不到题目。
  运行日志首行会说明本次是否离线读取。

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
