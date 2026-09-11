"""参数兼容层自测 (dsh-livebench-panel patch) —— 只验证归因逻辑，不发真实请求。

跑法： .venv\\Scripts\\python param_compat_selftest.py
"""
import sys

sys.path.insert(0, 'livebench')
from livebench.model.completions import (  # noqa: E402
    _PARAM_COMPAT_MAX_RETRIES,
    blamed_api_kwarg,
    unsupported_kwargs_for,
)


class FakeErr(Exception):
    """模仿 anthropic/openai SDK 的 APIStatusError：带 status_code / body。"""

    def __init__(self, status_code, message):
        super().__init__(message)
        self.status_code = status_code
        self.body = {'error': {'message': message}}


REQ = {'max_tokens': 32000, 'temperature': 0, 'top_p': 0.9, 'reasoning_effort': 'max'}

CASES = [
    # (名称, 异常, 期望归因)
    ("真实现场：anthropic 中转站拒绝 temperature",
     FakeErr(400, "`temperature` is deprecated for this model."), 'temperature'),
    ("真实现场：aiportx 对 kimi-k3 只允许 temperature=1（无引号 + invalid/only）",
     FakeErr(400, "Error code: 400 - {'error': {'message': 'field Temperature invalid, "
                  "only 1 is allowed for this model', 'type': 'invalid_request_error'}}"),
     'temperature'),
    ("openai 风格：不支持的参数（单引号）",
     FakeErr(400, "Unsupported parameter: 'reasoning_effort' is not supported with this model."),
     'reasoning_effort'),
    ("不带引号但含关键字",
     FakeErr(400, "unknown parameter top_p"), 'top_p'),
    ("422 也算 4xx",
     FakeErr(422, '{"detail":"`max_tokens` is not supported"}'), 'max_tokens'),
    ("值超限不该摘参数（max_tokens 超上限）",
     FakeErr(400, "max_tokens: 32000 is greater than the model maximum of 8192"), None),
    ("值类型错误但不含拒绝措辞，保守不动手",
     FakeErr(400, "temperature must be a float between 0 and 2"), None),
    ("401 认证问题不该摘参数",
     FakeErr(401, "invalid api key: temperature"), None),
    ("429 限流不该摘参数",
     FakeErr(429, "rate limit exceeded for temperature quota"), None),
    ("500 服务端错误不该摘参数",
     FakeErr(500, "internal server error"), None),
    ("点名结构性字段 model 时不动手",
     FakeErr(400, "`model` is not supported"), None),
    ("无关 4xx 文案",
     FakeErr(400, "invalid request: messages must not be empty"), None),
    ("没有 status_code 的异常",
     RuntimeError("`temperature` is deprecated"), None),
]

failed = 0
for name, exc, expected in CASES:
    got = blamed_api_kwarg(exc, REQ)
    ok = got == expected
    failed += 0 if ok else 1
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: got={got!r} expected={expected!r}")

# 缓存是进程级且按 scope 隔离的
a = unsupported_kwargs_for('anthropic|http://x|m1')
a.add('temperature')
print(f"[{'PASS' if 'temperature' in unsupported_kwargs_for('anthropic|http://x|m1') else 'FAIL'}] "
      f"同一 scope 复用缓存")
print(f"[{'PASS' if not unsupported_kwargs_for('anthropic|http://y|m1') else 'FAIL'}] "
      f"不同上游互不影响")
print(f"[{'PASS' if not unsupported_kwargs_for('anthropic|http://x|m2') else 'FAIL'}] "
      f"不同模型互不影响")
print(f"\n_PARAM_COMPAT_MAX_RETRIES = {_PARAM_COMPAT_MAX_RETRIES}")
print('ALL PASS' if failed == 0 else f'{failed} CASE(S) FAILED')
sys.exit(1 if failed else 0)
