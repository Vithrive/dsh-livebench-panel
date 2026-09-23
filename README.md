# dsh-livebench-panel

[![npm version](https://img.shields.io/npm/v/dsh-livebench-panel.svg)](https://www.npmjs.com/package/dsh-livebench-panel)
[![npm downloads](https://img.shields.io/npm/dm/dsh-livebench-panel.svg)](https://www.npmjs.com/package/dsh-livebench-panel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DSH web 插件：在 **Trajectory 视图（轨迹视图）** 的「对话 / 轨迹」标签右侧新增一个 **LiveBench** 标签页。点进去即可用下拉框选择参数，直接对本机 LiveBench 发起评测并查看成绩。

> 💬 使用问题、配置分享、成绩对比 → [Discussions](https://github.com/Vithrive/dsh-livebench-panel/discussions)；
> 缺陷与功能建议 → [Issues](https://github.com/Vithrive/dsh-livebench-panel/issues)。
> 遇到报错请先看 [LiveBench 本地补丁说明](docs/livebench-patches.md)，多数问题源于漏打补丁。

## ⚠️ 依赖要求（必读）

本插件只是**控制台**，真正的评测由 [LiveBench](https://github.com/LiveBench/LiveBench) 项目在本机完成。仅安装插件时，面板底部会显示同样的安装指引。完整安装步骤（Windows，约 10–20 分钟）：

```bat
:: 1) 克隆 LiveBench（放到默认路径可免配置；装在其它目录请设环境变量 DSH_LIVEBENCH_HOME 指向它）
git clone https://github.com/LiveBench/LiveBench V:\PythonProject\C_UtilizeSpace\LiveBench

:: 2) 用 Python 3.11 建虚拟环境并安装（3.10 会因 litellm 报 NotRequired 错误）
cd /d V:\PythonProject\C_UtilizeSpace\LiveBench
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install -e .

:: 3) 仅评测 coding 类需要：安装评分依赖（较大，含 TensorFlow）
.venv\Scripts\python -m pip install -r livebench\code_runner\requirements_eval.txt

:: 4) 下载题目数据（约 250MB）
cd livebench
..\.venv\Scripts\python download_questions.py

:: 5) 重启 dsh web，回到面板点「刷新」
```

装在其它目录时：设置**系统环境变量** `DSH_LIVEBENCH_HOME=<你的LiveBench目录>`，重启 dsh web 生效。

## 面板选项说明

| 选项 | 含义 | 选择建议 |
|---|---|---|
| 模型 | harness 全部 provider 的全部模型（含内置 deepseek-official）；分组展示 | 首次验证选小任务 + 便宜模型 |
| 推理强度 | 该模型的 reasoning effort（无配置则禁用）；编码进条目名，不同强度独立出分 | 日常 `medium`/`high`；对比测试固定同一档 |
| 题集 release | LiveBench 题目发布批次 | 公开题目最全的是 `2024-11-25`（推荐） |
| **Baseline 题库** | 参考模型的实测对错题集，**可脱离分类/任务单独使用**（见下节） | 快速探针：参考模型「做错」的题 |
| 分类 | 六大类：coding / math / reasoning / language / data_analysis / instruction_following | 首次验证选 `language` |
| 任务 | 分类下的具体任务（如 language/typos 拼写纠错） | 首次验证选 `typos`（短平快） |
| 题目序号范围 | 起止下标（0 起，**含首尾**）；选 Baseline 时序号相对该题库 | 冒烟测试填 0–1（只跑 2 题） |
| max-tokens | 单次回答的 token 上限（默认 65536，上限 200000） | 推理模型别低于 32768，否则思考吃满预算、正文为空，这题会被记成「没做出来」 |

## Baseline 题库（探针）

用**一个参考模型的实测对错**当尺子，快速判断别的模型处在哪个档位。位于「分类 / 任务」之上，
三层可选：

1. **参考模型**：`Baseline(glm-5.3-flash@max)`
2. **任务**：该参考模型已经跑过全量的任务（如 `olympiad（36）`）
3. **做错 / 做对**：各自标注题目数量（如 `做错（8）` / `做对（28）`），可多选

选中后**不需要也不应该再选分类/任务**——"不选 = 全部分类"这条规则对 Baseline 不适用。
「题目序号范围」仍然生效，序号相对 Baseline 题库（0 起、含首尾）；超出上界不会报错，
会按实际题数截断。

**为什么默认勾「做错」**：探针的价值在于"参考模型做不出来的题"。参考模型能轻松做对的题，
对更强的模型没有分辨力，混进来只会稀释信号。「做对」也保留，用于反向验证
（例如确认某模型确实强于参考模型）。

**当前内置的数据**（2026-09-12 实测，release `2024-11-25`）：

| 参考模型 | 任务 | 全量 | 做对 | 做错 |
|---|---|---|---|---|
| `zai-coding-cn__glm-5.3-flash@max` | `math/olympiad` | 36 | 28 | 8 |

实测效果（跑「做错」那 8 题）：`aiportx-gg/grok-4.6@xhigh` 明显强于参考模型；
`deepseek-official/deepseek-flash@max` 明显更弱。失败的 8 题全部属于 olympiad 的
**公式还原**题型——把解答里的公式挖空让模型补全，是纯符号推理，很吃"智力"。

后续任务按同样方式补进 `lib/index.js` 的 `BASELINE_SETS.tasks` 即可：
只需填 `passed` / `failed` 两组 question id（取自 LiveBench 的 `question.jsonl`），
面板用 `--question-id` 直接指定，题目在题库里是否连续都无所谓。

## 功能

- **标签页位置**：`conversation.view` 槽位 `id: "livebench"`、`order: 20`（对话 = 0，轨迹 = 10，LiveBench 排最右）。
- **模型下拉框**：读取 `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers` **并合并内置 `deepseek-official` 路由**（`@deepseek-ai/dsh-llm-deepseek` 注册的 DeepSeek-V4-Flash / V4-Pro / V4-Flash-Vision-Exp，默认 `https://api.deepseek.com` + `DEEPSEEK_API_KEY`，用户 `llm-deepseek` 设置节可覆盖），与 harness 模型选择同源，展示**全部 provider / 全部模型**；`openai-completions` 且配置了 `baseURL` 的 provider 会被标记为可直连 LiveBench（`--api-base` 路由）。
- **推理强度下拉框**（模型右侧）：来自模型配置的 `reasoningEfforts` 映射（如 gpt-5.6 系 off/low/medium/high/xhigh/max，DeepSeek off/low/high/max）。选定后：
  - 插件向 `livebench/model/model_configs/dsh_panel_generated__<display-name>.yaml` 写入一条模型配置（每个模型一个文件，避免并发写同名文件互相覆盖），经 LiveBench 的 `api_kwargs.default.reasoning_effort` 透传给 API（`off` 表示不透传、由后端走默认）；
  - 强度编码进 display-name（如 `code-gpt__gpt-5.6-sol@high`），**不同强度在成绩表中是独立条目**，可直接对比。
- **参数下拉框**：题集 release（LiveBench 全部 releases）、分类（coding/math/reasoning/language/data_analysis/instruction_following）、任务（随分类联动）、题目序号范围、max-tokens（**默认 32000**，自动夹到模型声明的上限；LiveBench 自带默认只有 4096，推理模型会思考吃满、正文为空，难题可手动调到 65536）、**并发请求数**（`--parallel-requests`，1/2/3/4/6/8，默认 1=串行；模型单题思考慢时并发多题是唯一能等比缩短总时长的开关）。
- **协议路由**：**Anthropic/Claude 系模型一律走 `anthropic-messages`**（POST `<baseURL>/v1/messages`，
  与会话窗口同协议；`baseURL` 会自动剥掉 `/v1`、`/v1/messages` 后缀，因为 anthropic SDK 自己会拼）；
  其余模型按 settings.yaml 的 `api` 走 `openai-completions` / `openai-responses` / 内置端点。
  运行日志首行打印 `[route] …`，写明协议、目标地址、`max_tokens` 与 thinking 形状。
- **请求形状对齐会话窗口**：anthropic 通道按强度档附上
  `thinking: {type: enabled, budget_tokens: N}`（minimal 1024 / low 2048 / medium 8192 /
  high·xhigh·max 16384；`off` → `{type: disabled}`），并因此**不发 `temperature`**；
  非 anthropic 通道按渠道习惯选长度上限字段（aiportx 这类中转用 `max_completion_tokens`），
  且 `--max-tokens` 会夹到该模型在 settings.yaml 里声明的上限。
- **流式看门狗不会误杀健康请求**：判活标准是"连接上是否还有字节"（含网关每 3 秒的 `ping`），
  默认 600s 无字节才断开重试（可用渠道声明的 `streamIdleTimeoutMs` 覆写）；
  另有两道硬边界——单次请求总时长上限（`LIVEBENCH_STREAM_MAX_SECONDS`，默认 1800s）
  与首个字节等待上限（`LIVEBENCH_FIRST_BYTE_TIMEOUT`，默认 600s）。
- **进度心跳**：模型长时间思考时网关只发 `ping`、正文迟迟不来，日志里会每 30 秒出现一行
  `仍在接收: 已 120s，连接累计 12345 字节（模型思考中，正文未到）`，长思考不会"看起来卡死"
  （`LIVEBENCH_PROGRESS_SECONDS`，0 = 关闭）。
- **运行控制**：开始 / 停止 / 刷新；最多 9 个模型并发评测（每个模型同时只跑 1 次）；实时滚动日志（每 2.5s 轮询）；「刷新」会清掉已结束的运行日志。
- **自动补跑（API 抖动兜底）**：一次评测要连续打几百次 API，中转站 502/限流/超时是常态。
  跑完后若答案文件里还有 `$ERROR$`，面板会自动用 `--resume --retry-failures`
  **只重跑失败的那几题**（最多 3 轮，间隔 15s / 60s / 3min），并复用同一个条目名 ——
  已成功题目的答案与判分都保留，成绩表里仍然只有一行。Baseline 评测同样适用。
  日志里会打印 `[自动补跑] …`。
  注意：思考吃满 max-tokens 的空答案（不是 `$ERROR$`）不会自动补跑——那不是抖动，
  把 max-tokens 调大后手动重跑才有意义。
- **题目数据集离线读取**：huggingface.co 在国内常常连不通，而已缓存的分类根本不需要联网。
  面板检测到本次要跑的分类都在 `.hf_cache` 里时，直接以 `HF_HUB_OFFLINE=1` 启动，
  省掉 5 轮 HEAD 超时重试（每次白等 20~60s）；缺缓存的分类保持联网，不影响新 release。
- **成绩表**：直接读取 `data/live_bench/**/model_judgment/ground_truth_judgment.jsonl` 计算 模型 × 任务 平均分（分数 = 正确率 ×100，单元格下方括号标注「**本次没做或没做完的题数 / 用户选择的题数**」，即题目序号范围的题数；不参与正确率计算的总题数不展示），无需等 LiveBench 自己出榜。**判分与答案按 `answer_id` 配对**：补跑换过答案的题只认新判分，旧的 0 分不会把成绩拉低；答案文件里同一题出现多行时按最后一行取值（与 LiveBench 自身口径一致）。支持按模型名/时间排序、拖 ⠿ 自定义行序、勾选或单行按钮删除成绩（删除会同时清掉该模型的答案与判分行；只有空壳文件的“幽灵行”不会再被扫描出来，删除结果稳定持久）。
- **题目序号范围按闭区间处理**：LiveBench 的 `--question-end` 是开区间（`questions[begin:end]`），面板按用户直觉采用闭区间（传参时 `止 + 1`），因此界面上填的题数与实际跑的题数一致。

## 依赖

- 本机 LiveBench 检出：默认 `V:\PythonProject\C_UtilizeSpace\LiveBench`，可用环境变量 `DSH_LIVEBENCH_HOME` 覆盖。
- 已配置好的评测 venv：`<root>\.venv\Scripts\python.exe`（Python 3.11，`pip install -e .` 完成）。
- API Key：从 harness provider 的 `apiKeyEnv` 环境变量解析，经 `LIVEBENCH_API_KEY` 传给 LiveBench，**不会**出现在命令行或浏览器响应里。

## API（同源）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/dsh-livebench-panel/api/config` | GET | 可用性、releases、分类→任务表、providers+models |
| `/dsh-livebench-panel/api/start` | POST | 启动一次 `run_livebench.py` |
| `/dsh-livebench-panel/api/status` | GET | 运行状态 + 日志尾部 |
| `/dsh-livebench-panel/api/stop` | POST | 终止当前评测 |
| `/dsh-livebench-panel/api/results` | GET | 汇总成绩行 |
| `/dsh-livebench-panel/api/delete` | POST | 删除指定 模型×分类×任务 的答案与判分记录（正文 `{rows:[{model,category,task}]}`；正在评测的模型会被跳过并在 `skipped` 中返回） |
| `/dsh-livebench-panel/api/clear` | POST | 清掉已结束的运行日志/记录 |
| `/dsh-livebench-panel/api/home` | POST | 保存 LiveBench 检出路径 |

## 安装

### 方式 A：从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-livebench-panel
```

### 方式 B：从本仓库安装

```bash
git clone https://github.com/Vithrive/dsh-livebench-panel.git ~/.dsh/plugins/dsh-livebench-panel
```

然后在 `~/.dsh/profiles/web/package.json` 中：

1. `dependencies` 加入 `"dsh-livebench-panel": "link:../../plugins/dsh-livebench-panel"`；
2. `dsh.profile.bundles` 数组加入 `"dsh-livebench-panel"`。

最后在 profile 目录执行 `pnpm install`，重启 `dsh web`，打开任一会话的轨迹视图即可看到 **LiveBench** 标签。

## 开发

提交前跑一遍自检（语法 + 插件声明 + npm 打包内容白名单，与 CI 口径一致）：

```bash
node scripts/check.mjs
```

仓库结构：

```
lib/index.js            node 半：/dsh-livebench-panel/api/* 路由，spawn run_livebench.py
lib/client.js           浏览器半：注册 conversation.view 槽位的 LiveBench 标签
cordis.patch.yml        把插件行插入 profile 的 bundle 层
scripts/check.mjs       本地自检（语法 / 插件声明 / 打包白名单）
docs/livebench-patches.md  依赖的 LiveBench 本地补丁（Windows + 中转站兼容）
smoke.mjs               开发期冒烟脚本（不进 npm 包）
```

## 交流与反馈

- **Bug / 功能建议**：[Issues](https://github.com/Vithrive/dsh-livebench-panel/issues)（有对应模板）
- **使用问题 / 配置分享 / 成绩对比**：[Discussions](https://github.com/Vithrive/dsh-livebench-panel/discussions)
- 提交 Issue 时请附：插件版本、系统与 Node/Python 版本、复现用的 release + 任务 + 题号范围 + provider/模型、以及完整日志（记得打码 API Key 和私有域名）。

## License

[MIT](LICENSE) © 2026 cszr (Vithrive)
