# LiveBench 本地补丁说明

`dsh-livebench-panel` 只是控制台，评测由本机的 [LiveBench](https://github.com/LiveBench/LiveBench)
完成。官方 LiveBench 主要面向 Linux/macOS，且在**国内中转站 + 新版模型**场景下会遇到两类问题：

1. Unix 专属 API 在 Windows 上不可用；
2. 中转站对新模型拒收部分采样参数（例如 `` `temperature` is deprecated for this model ``），
   而 LiveBench 把参数写死在请求里且 `API_MAX_RETRY = 1`，于是一整题被记成 `$ERROR$`。

下面是我们验证过的最小补丁集合（共 8 个文件）。**不打补丁时，面板能打开、能启动评测，
但 Windows 上会出现判分全 0，遇到部分中转站会整题失败。**

## 补丁清单

| 文件 | 修改 | 原因 |
|---|---|---|
| `livebench/run_livebench.py` | `run_command` 在 Windows 下改用原生 shell | 原代码 `["bash","-c",...]` 在 Windows 会误连 WSL/cygwin 的 bash，找不到 venv 中的 python（exit 127） |
| `livebench/gen_api_answer.py` | 顶部 minisweagent 导入改为 try/except 惰性导入 | 内置 mini-swe-agent 使用 Unix 专属的 `fcntl`；只有 agentic coding 任务需要它（该类任务 Windows 不支持） |
| `livebench/process_results/coding/utils.py` | `import fcntl` 包裹 try/except | fcntl 仅用于 agentic 评分缓存锁，普通 coding 评分不需要 |
| `livebench/common.py` | `category_name` 取 bench 路径第 2 段，不再 `split('_')[0]` | `data_analysis` 等含下划线的类别名被截断成 `data`，任务路径找不到 |
| `livebench/process_results/math/AMPS_Hard/utils.py` | `run_with_timeout` 在 win32 下改为同步执行 | Windows 无 `signal.SIGALRM`，超时包装导致 AMPS_Hard 全部判 0 |
| `livebench/lcb_runner/evaluation/testing_util.py` | `signal.alarm`/`SIGALRM` 改为空操作；`resource.setrlimit` 仅 Linux 执行 | 同上，Unix 专属 API |
| `livebench/lcb_runner/evaluation/compute_code_generation_metrics.py` | `codegen_metrics` 开头调用 `warm_process_pool()` | Windows `ProcessPoolExecutor` 的 spawn 引导竞态导致 coding 判分全 0 |
| `livebench/model/completions.py` | 统一容错层：参数兼容 + 瞬态重试 + 空答案重发（见下） | 中转站/新模型拒收参数、号池 524、上游抖动返回空内容，都会把整题记成 `$ERROR$` |

## `completions.py` 的改动

### 0) 统一容错层（所有 provider 都过一遍）

**改之前有两个结构性缺陷，导致"一遇错就整题失败"：**

1. 内层 `@retry` 的 `retry_error_callback=retry_fail` 把异常**吞成 `$ERROR$` 返回值**，
   外层的"瞬态重试 / 参数兼容"永远看不到错误 —— 全是死代码；
2. `get_api_function` 里**只有字面量 `openai`** 走包装器，而插件实际使用的
   URL provider（`https://api.aiportx.com/v1`）和 `local` 都落到 else 分支的**裸函数**上，
   既没有参数兼容也没有任何重试。

**改之后**：`retry_fail` 改为抛出 `APIRequestFailed`（携带 `eval_status/error/error_msg`），
`get_api_function` 对**所有** provider 返回 `_resilient(handler)`。容错层按顺序兜：

| 顺序 | 处理 | 说明 |
|---|---|---|
| 1 | 已知不支持参数**预先摘除** | 进程级缓存，后续请求直接不再携带 |
| 2 | 400/422 点名参数 → **摘掉重发** | 见下节 |
| 3 | 瞬态/号池错误 → **退避重试** | 号池 10/30/60/120s；瞬态 3/8/20/40s（带抖动），最多 5 次 |
| 4 | 上游 200 但**内容为空** → **重发** | 最多 2 次（间隔 3/6s）；`choices` 为空、`content` 为空、流中断都算 |
| 5 | 仍失败 → 记 `$ERROR$` | 错误原文写进 `api_info.error_msg`，便于排查 |

**返回形状必须原样保留**（踩过的坑）：LiveBench 的 handler 有的返回 `(text, tokens)`、
有的返回 `(text, tokens, meta)`，`gen_api_answer` 用 `len(res) == 3` 区分。
包装层最初一律按 3 元组拆包，于是 `chat_completion_openai_responses`（2 元组）直接抛
`not enough values to unpack (expected 3, got 2)`，整题 `$ERROR$`。
现在按**运行时学习**到的真实元组长度原样返回 —— **不能信注解**：
`chat_completion_anthropic` 的注解写的是 `tuple[str, int]`，实际返回 3 元组。

**不重试的情况**（避免浪费额度和误判）：

- **401 / 403**：认证/权限问题，重试无意义；
- **值类错误**：`max_tokens ... greater than the model maximum` 这类不带"参数不被接受"措辞的；
- **模型拒答**：`invalid_prompt` 直接记 `$ERROR$`；
- **token 耗尽**：`finish_reason=length` + 空正文 → 记 `eval_status=token_exhaustion`
  （**真实的 0 分**，不是基础设施错误），不重试。

### 1) 参数兼容层（通用，不写死参数名）

现场示例：

```
anthropic.BadRequestError: 400 `temperature` is deprecated for this model
openai.BadRequestError:    400 field Temperature invalid, only 1 is allowed for this model
```

降级逻辑：

1. 请求收到 **400 / 422**，且报错文案含「已废弃 / 不支持 / 未知 / 无效 / 不允许 / only」这类
   措辞时，从**本次真正发送的参数**里反查被点名的那个（先匹配引号包裹的名字，再退回裸词）；
2. 把它摘掉后**立即重发**，并记进进程级缓存 `_UNSUPPORTED_API_KWARGS[上游|模型]`；
3. 同一进程内后续请求直接不再携带该参数 —— 实测 4 题只撞 1 次。

保护措施：

- `model` / `messages` / `system` 等结构性字段被点名也**不摘**；
- 裸词匹配要求**参数名与拒绝措辞落在同一个 40 字符窗口内**，
  所以 `max_tokens: 32000 is greater than the model maximum of 8192`（值超限）不会被误判成
  "max_tokens 不被支持"而悄悄摘掉长度上限；
- 状态码限定 `{400, 422}`。**不能写成 `400<=s<500`** —— 401 的文案里也会出现
  `invalid api key: temperature` 这种字样，摘参数只会掩盖真正的认证错误。

`temperature` / `top_p` / `reasoning_effort` / `thinking` / `max_tokens` 都适用，
anthropic / openai / openai_responses / URL provider 全部接入。

### 2) 请求形状降级阶梯（参数拒绝被伪装成 5xx 时兜底）

现场（aiportx 中转 + kimi-k3，2026-09-19）：请求带 `temperature: 0` 时网关**不返回 400**，
而是回

```
502 {'error': {'message': 'Upstream service temporarily unavailable'}}
```

参数兼容层只认 400/422 里点名的参数，这种"伪装成 5xx 的参数拒绝"永远学不会 ——
8 道题各自退避重试 5 次全部 502，整场评测白跑 35 分钟。逐项消融实测：
`temp=0` → 502；`temp=0` 去掉 `stream_options` → 502；`temp=1` → **OK 16.9s**；
不传 `temp` → **OK 7.0s**；`temp=0` 换 `max_tokens`/`reasoning_effort`/真题 prompt → 仍 502。

降级逻辑：**连续 2 次同形状的号池/5xx** 之后（参数形状不对时等 220s 退避毫无意义），
按阶梯逐档换形状各试一次：

1. `temperature` 0 → 1；
2. 不传 `temperature`；
3. 再去掉 `stream_options.include_usage`；
4. 再去掉 `model_api_kwargs`（`reasoning_effort` 等厂商私有参数）。

成功的那一档记进 `_LEARNED_SHAPES[上游|模型]`（**模块级**，不能放 `_resilient` 闭包里 ——
`gen_api_answer` 每次调用都重新包一层，闭包里的记忆活不过一次请求），
本次进程后续请求直接用对的形状。所有形状都失败仍记 `$ERROR$`，不会无限重试。

### 3) 流式静默看门狗（连接开着但一个字节都不给）

现场（code28.ccwu.cc + claude-fable-5-1，2026-09-22）：网关**接了请求、TCP 连接一直
ESTABLISHED、keep-alive 还在滴，但一个 SSE 事件都不发**。实测对比（同一题面）：

| 请求 | 结果 |
|---|---|
| 简单 prompt（4 种参数组合） | OK 4~6s |
| 真题题面 4364 字符，`mt=65536` | 首事件 5.8s，之后 **60s+ 零事件、正文 0 字符** |
| 真题题面，`mt=8192` / `mt=1024` | 同样静默（或 526 个事件全是思考、正文 0 字符） |
| 长英文 prompt 1400 词 | OK 71.6s（4699 事件、7823 字符） |

即：**内容相关的上游静默**。而 httpx 的 read 超时是按"两次读之间的间隔"算的，
keep-alive 让它在 1800s 内永不触发；Anthropic SDK 的默认 600s 超时同样拦不住 ——
面板里就表现为**完全没有动静**（一道题静默十几分钟，日志一个字都没有）。

现在两条流式通道都挂了 `_IdleStreamGuard`：按"多久没收到事件"独立计时，
超过 `LIVEBENCH_STREAM_IDLE_TIMEOUT` 就主动关流，日志写明

```
[dsh-livebench-panel] chat_completion_anthropic 上游 600s 没有任何输出（连接还开着，疑似被挂住）→ 主动断开，交给容错层重试: <模型>
```

随后抛出的 `TimeoutError: upstream stalled: no chunk for Ns (stream idle timeout)`
落在瞬态错误里，由容错层退避重试；重试仍不行就按老规矩记 `$ERROR$`
（面板口径：**没做出来**，不进正确率分母）。Anthropic 通道另给了显式
`httpx.Timeout(1800, connect=15)` 与 `max_retries=0`（重试统一交给容错层，日志才看得见）。

### 4) 静默阈值必须按渠道定，不能一刀切压小（实测 regression）

阈值最初写死 120s，结果把 **aiportx-claude 的正常长思考**当成"挂住"：

| 实测 | 结果 |
|---|---|
| aiportx-claude 答一道 olympiad（09-12 记录，当时没有看门狗） | **139~286s/题**，输出 1~2 万 token |
| 同一题的无看门狗长测 | 首 chunk 3.9s → **172.4s 空档** → 之后继续出块（空档是常态，不是挂住） |
| 阈值 120s 时的一次真实评测 | 一题被掐 5 次（120s×N + 退避 + 形状阶梯 ≈ 874s），最后记 `$ERROR$` |

所以现在的规则是：**默认 600s**，并且面板把 harness 在 settings.yaml 里为该渠道声明的
`streamIdleTimeoutMs` 透进来（`code-claude = 120000` → 120s，那个渠道确实是"接了请求就不回"）。
两个渠道各用合适的阈值，而不是一刀切。环境变量 `LIVEBENCH_STREAM_IDLE_TIMEOUT`
可以再覆盖（0 = 关闭）。

### 5) 输出上限的字段名：`max_tokens` vs `max_completion_tokens`（面板侧修，2026-09-23）

现场：`aiportx-claude/claude-fable-5-1@max` 在会话窗口里很快，一进 LiveBench 就"卡死"。

会话窗口走 pi-ai，会按渠道自动挑字段（`@earendil-works/pi-ai/dist/api/openai-completions.js`
里的 `detectCompat().maxTokensField`）：

- **`max_completion_tokens`**：aiportx / code28 这类中转（不在 useMaxTokens 名单里）；
- **`max_tokens`**：deepseek / moonshot / z.ai / together / nvidia / ant-ling / chutes / Cloudflare 网关。

而 LiveBench 的 `chat_completion_openai` 只看模型名里有没有 `"gpt"`，非 gpt 一律发 `max_tokens`。
同一道 olympiad、同一 `reasoning_effort=max`，只换字段名：

| 字段 | 结果 |
|---|---|
| `max_completion_tokens=64000` | **224s 跑完**（1263 chunk、6297 字符，最大空档 106s） |
| `max_tokens=64000` | 首块 3.8s、276 chunk 后 **172.7s 零 chunk**；无看门狗长测 **1232s** 才结束、最大空档 **449s** |

修法：**面板**在生成的模型配置里写死字段（`api_kwargs.default.max_completion_tokens: <上限>`）——
LiveBench 的 `if 'max_tokens' not in api_kwargs and 'max_completion_tokens' not in api_kwargs`
分支因此被跳过，字段名不再靠猜。判定规则与 pi-ai 一致（`maxTokensFieldFor`），
并尊重 settings.yaml 里显式写的 `compat.maxTokensField`；只有 harness 真会用
`max_completion_tokens` 的渠道才写。

## 回归自测

参数兼容层的归因逻辑有独立自测（14 条用例：真实现场文案、401/429/500 不该触发、
值超限不该触发、结构性字段保护、缓存按上游/模型隔离）：

```bat
cd /d <LiveBench 根目录>
.venv\Scripts\python param_compat_selftest.py     :: 参数归因逻辑（16 条用例）
.venv\Scripts\python resilience_matrix_test.py    :: 故障矩阵（29 个场景）
```

`resilience_matrix_test.py` 用假客户端把"上游可能怎么坏"逐条演一遍（不联网、不消耗额度）：

| 类别 | 场景 |
|---|---|
| 参数被拒 | 引号包裹的 `` `temperature` is deprecated ``、无引号的 `field Temperature invalid, only 1 is allowed`、anthropic 通道同款、`openai_responses` 通道同款 |
| 值类错误 | `max_tokens greater than the model maximum` → 必须**不**摘参数、**不**重试 |
| 认证 | 401 → 立即放弃（1 次调用，不重试不摘参数） |
| 网关/号池 | 429 连撞两次、524 无可用资源、502 HTML 页面、连接重置、读超时 |
| 响应异常 | 200 但 `choices` 为空数组、200 但 `content` 为空串、流中途断开、Responses 流没有 completed 事件 |
| 应当放弃 | 持续 500 到上限、模型拒答 `invalid_prompt` |
| 真实 0 分 | `finish_reason=length` + 空正文 → `token_exhaustion`，不重试 |
| 记忆 | 参数只撞一次，第二题不再携带 |
| 覆盖 | URL provider / `local` / anthropic / `openai_responses` 都必须走容错层 |
| 返回形状 | 2 元组 handler 原样返回、3 元组 handler 原样返回、未知形状时 3 元组且 `gen_api_answer` 两种拆包都能消费 |

## 打完补丁后的验收口径

以 `language/typos`、release `2024-11-25`、题目范围「起 0 止 2」（共 3 题）为例：

- 日志里出现 `Running 3 questions together`，且进度条走满 3/3；
- 答案文件 `data/live_bench/language/typos/model_answer/<model>.jsonl` 有 **3 行**且不含 `$ERROR$`；
- 面板成绩表该行括号显示 `(0/3)`（没做/没做完 0 题，共选 3 题），分数为 0/33.3/66.7/100 之一。

若日志出现 `上游拒绝了参数 ...` 或 `返回空答案，N s 后重发`，说明容错层生效了 —— 这是**预期行为**，不是错误。

## 面板侧必须配合的一点

面板**每次都写自己的模型配置**，并且 `--model` **永远用带时间戳的 display-name**，而不是把裸模型名
交给 LiveBench。原因是 LiveBench 的 `get_model_config(裸名)` 会去撞它自带的模型库：例如
`kimi-k3` 会命中 `model_configs/moonshotai.yml` 里的同名条目，从而**悄悄换掉**
provider / `api_kwargs` / `max_tokens`（实测 `temperature` 被改成 1.0、`max_tokens` 改成 131072），
用户选的 provider 就失效了。写了自己的配置后，解析结果确定为 `{local: <modelId>}` + `--api-base`。
