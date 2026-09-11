# LiveBench 本地补丁与自测脚本

本目录是 [docs/livebench-patches.md](../docs/livebench-patches.md) 的可执行版本。

| 文件 | 用途 |
|---|---|
| `livebench-local.patch` | 针对 [LiveBench](https://github.com/LiveBench/LiveBench) 的本地补丁（8 个文件），含 Windows 兼容 + 统一容错层 |
| `param_compat_selftest.py` | 参数归因逻辑自测（16 条用例） |
| `resilience_matrix_test.py` | 故障矩阵自测（25 个场景，假客户端注入，不联网、不消耗额度） |

## 应用补丁

```bash
# 1) 先克隆 LiveBench（与补丁基线一致的版本）
git clone https://github.com/LiveBench/LiveBench /path/to/LiveBench
cd /path/to/LiveBench

# 2) 应用补丁（先 --check 看看能不能干净应用）
git apply --check /path/to/dsh-livebench-panel/patches/livebench-local.patch
git apply        /path/to/dsh-livebench-panel/patches/livebench-local.patch

# 3) 若某个 hunk 冲突（LiveBench 上游改动过该文件），用三方合并逐个解决
git apply --3way /path/to/dsh-livebench-panel/patches/livebench-local.patch

# 4) 拷贝自测脚本到 LiveBench 根目录并跑一遍
cp /path/to/dsh-livebench-panel/patches/*.py .
.venv/bin/python param_compat_selftest.py      # Windows: .venv\Scripts\python.exe
.venv/bin/python resilience_matrix_test.py
```

两个自测都**不联网、不调用任何模型 API**，全部用假客户端模拟上游故障，可以放心反复跑。

## 补丁包含什么

1. **Windows 兼容**（6 处）：`run_livebench.py` 的 shell、`minisweagent`/`fcntl` 惰性导入、
   `common.py` 的类别名解析、AMPS_Hard 的超时包装、`lcb_runner` 的 Unix 专属 API、
   coding 判分的进程池预热。
2. **统一容错层**（`model/completions.py`）：让"一遇错就整题 `$ERROR$`"变成
   "参数兼容 → 退避重试 → 空答案重发 → 兜底 `$ERROR$`"，并覆盖**所有** provider
   （此前 URL provider 与 `local` 走的是裸函数，完全没有重试）。

细节、判定规则与"刻意不重试"的清单见 [docs/livebench-patches.md](../docs/livebench-patches.md)。
