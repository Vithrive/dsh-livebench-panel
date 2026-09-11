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
| `livebench/model/completions.py` | 参数兼容层 + 号池退避重试（见下） | 中转站/新模型拒收参数、或号池返回 524，都会把整题记成 `$ERROR$` |

## `completions.py` 的改动

### 1) 参数兼容层（通用，不写死参数名）

现场示例：

```
anthropic.BadRequestError: Error code: 400 -
  {'error': {'message': '`temperature` is deprecated for this model.'}}
```

降级逻辑：

1. 请求收到 **4xx**，且报错文案含「不支持 / 已废弃 / 未知参数」这类措辞时，从**本次真正发送的
   参数**里反查被点名的那个（先匹配引号包裹的名字，再退回裸词，取最长匹配）；
2. 把它摘掉后**立即重发**，并记进进程级缓存 `_UNSUPPORTED_API_KWARGS[上游|模型]`；
3. 同一进程内后续请求直接不再携带该参数 —— 实测 3 题只撞 1 次。

保护措施：

- `model` / `messages` / `system` 等结构性字段被点名也**不摘**；
- `max_tokens exceeds the model limit` 这类**值超限**文案不含上述措辞，不会误摘参数；
- 401 / 429 / 5xx 一律不摘参数，走各自的错误处理。

`temperature` / `top_p` / `reasoning_effort` / `thinking` / `max_tokens` 都适用，
anthropic 与 openai-completions 两条通道都已接入。

### 2) 号池退避重试

`_openai_with_retry` 对 `524 / 522 / 520 / 429 / 无可用资源 / 请稍后重试` 等号池类错误最多
尝试 5 次，退避 10/30/60/120s（带抖动）；其它瞬态错误 3 次，退避 5/15/30s。

## 回归自测

参数兼容层的归因逻辑有独立自测（14 条用例：真实现场文案、401/429/500 不该触发、
值超限不该触发、结构性字段保护、缓存按上游/模型隔离）：

```bat
cd /d <LiveBench 根目录>
.venv\Scripts\python param_compat_selftest.py
```

## 打完补丁后的验收口径

以 `language/typos`、release `2024-11-25`、题目范围「起 0 止 2」（共 3 题）为例：

- 日志里出现 `Running 3 questions together`，且进度条走满 3/3；
- 答案文件 `data/live_bench/language/typos/model_answer/<model>.jsonl` 有 **3 行**且不含 `$ERROR$`；
- 面板成绩表该行括号显示 `(-0/3)`（没做/没做完 0 题，共选 3 题），分数为 0/33.3/66.7/100 之一。

若日志出现 `拒绝了参数 ...` 的 WARNING，说明参数兼容层生效了 —— 这是**预期行为**，不是错误。
