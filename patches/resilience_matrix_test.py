"""主要故障模式矩阵测试 (dsh-livebench-panel patch)。

用假客户端替换 openai.OpenAI / anthropic.Anthropic，把"上游可能怎么坏"逐条演一遍，
验证统一容错层的行为：该重试的重试、该摘参数摘参数、该判真实 0 分的不误判，
而且**不会一遇错就整题失败**。

跑法：
    .venv\\Scripts\\python resilience_matrix_test.py

不联网、不消耗任何 API 额度。
"""
from __future__ import annotations

import contextlib
import io
import logging
import sys
import types

sys.path.insert(0, 'livebench')

import httpx  # noqa: E402
import anthropic  # noqa: E402
import openai  # noqa: E402

from livebench.model import completions  # noqa: E402
from livebench.model.completions import API_ERROR_OUTPUT, get_api_function  # noqa: E402


# --------------------------------------------------------------------------
# 让测试跑得快：容错层的 sleep 全部跳过
# --------------------------------------------------------------------------
class _FastTime:
    def sleep(self, _seconds):
        pass


completions.time = _FastTime()  # type: ignore[assignment]


def http_error(cls, status: int, message: str):
    """构造和真实 SDK 同形状的异常：带 status_code 和 body。"""
    request = httpx.Request('POST', 'https://upstream.example/v1/chat/completions')
    response = httpx.Response(status, request=request, json={'error': {'message': message}})
    body = {'error': {'message': message, 'type': 'invalid_request_error'}}
    if cls is openai.APITimeoutError:
        return cls(request=request)
    if cls is openai.APIConnectionError:
        return cls(message=message, request=request)
    return cls(message, response=response, body=body)


def ns(**kwargs):
    return types.SimpleNamespace(**kwargs)


# --------------------------------------------------------------------------
# OpenAI 兼容假客户端
# --------------------------------------------------------------------------
class FakeCompletions:
    def __init__(self, owner):
        self.owner = owner

    def create(self, **kwargs):
        # 真实 SDK 会在发请求前把 NOT_GIVEN 哨兵值剥掉；假客户端照做，
        # 否则断言"参数有没有真的发出去"会被哨兵值误导。
        effective = {k: v for k, v in kwargs.items() if v is not openai.NOT_GIVEN}
        return self.owner.handle(effective)


class FakeResponses:
    """OpenAI Responses API（chat_completion_openai_responses 走这条）。"""

    script = []
    calls = []

    def create(self, **kwargs):
        effective = {k: v for k, v in kwargs.items() if v is not openai.NOT_GIVEN}
        FakeResponses.calls.append(effective)
        if FakeResponses.script:
            action = FakeResponses.script.pop(0)
            if isinstance(action, BaseException):
                raise action
            kind, _ = action
            if kind == 'empty':
                return ns(output_text='', usage=ns(output_tokens=1))
        return ns(output_text='responses answer', usage=ns(output_tokens=12))


class FakeOpenAI:
    """按脚本演出：script 里每项要么是异常实例（抛出），要么是 (kind, payload)。"""

    script = []
    calls = []

    def __init__(self, api_key=None, base_url=None, timeout=None, **kwargs):
        self.chat = ns(completions=FakeCompletions(self))
        self.responses = FakeResponses()

    def handle(self, kwargs):
        FakeOpenAI.calls.append(kwargs)
        if not FakeOpenAI.script:
            return FakeOpenAI.ok_response('default answer')
        action = FakeOpenAI.script.pop(0)
        if isinstance(action, BaseException):
            raise action
        kind, payload = action
        if kind == 'ok':
            return FakeOpenAI.ok_response(payload)
        if kind == 'ok_empty_choices':
            return ns(choices=[], usage=None)
        if kind == 'ok_empty_content':
            return FakeOpenAI.ok_response('')
        if kind == 'ok_token_exhaustion':
            return FakeOpenAI.ok_response('', finish_reason='length')
        raise AssertionError(f'unknown action {action}')

    @staticmethod
    def ok_response(text, finish_reason='stop'):
        message = ns(content=text, reasoning_content=None)
        choice = ns(message=message, finish_reason=finish_reason)
        usage = ns(completion_tokens=max(1, len(text)), prompt_tokens=11, prompt_tokens_details=None,
                   completion_tokens_details=None)
        return ns(choices=[choice], usage=usage)


# --------------------------------------------------------------------------
# Anthropic 假客户端
# --------------------------------------------------------------------------
class FakeStreamManager:
    def __init__(self, script, kwargs):
        self.script = script
        self.kwargs = kwargs

    def __enter__(self):
        FakeAnthropic.calls.append(self.kwargs)
        if FakeAnthropic.script:
            action = FakeAnthropic.script.pop(0)
            if isinstance(action, BaseException):
                raise action
        return FakeMessageStream()

    def __exit__(self, *exc):
        return False


class FakeMessageStream:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        yield ns(type='content_block_start', content_block=ns(type='text'))
        yield ns(type='content_block_delta', delta=ns(type='text_delta', text='anthropic answer'))
        yield ns(type='content_block_stop')

    def get_final_message(self):
        usage = ns(output_tokens=7, input_tokens=5, cache_read_input_tokens=None,
                   cache_creation_input_tokens=None)
        return ns(stop_reason='end_turn', usage=usage)


class FakeAnthropic:
    script = []
    calls = []

    def __init__(self, api_key=None, **kwargs):
        self.beta = self

    @property
    def messages(self):
        return self

    def stream(self, **kwargs):
        return FakeStreamManager(self.script, kwargs)


openai.OpenAI = FakeOpenAI
anthropic.Anthropic = FakeAnthropic


# --------------------------------------------------------------------------
# 场景定义
# --------------------------------------------------------------------------
def call_openai(script, **overrides):
    FakeOpenAI.script = list(script)
    FakeOpenAI.calls = []
    args = dict(
        model='aiportx-kimi__kimi-k3@max__test',
        messages=[{'role': 'user', 'content': 'hi'}],
        temperature=0,
        max_tokens=32000,
        model_api_kwargs={'reasoning_effort': 'max'},
        api_dict={'api_key': 'k', 'api_base': 'https://api.aiportx.com/v1'},
        stream=False,
    )
    args.update(overrides)
    fn = get_api_function('https://api.aiportx.com/v1')
    out, tokens, meta = fn(**args)
    return out, tokens, meta, FakeOpenAI.calls


def call_anthropic(script):
    FakeAnthropic.script = list(script)
    FakeAnthropic.calls = []
    fn = get_api_function('anthropic')
    out, tokens, meta = fn(
        model='code-claude__claude-fable-5@max__test',
        messages=[{'role': 'user', 'content': 'hi'}],
        temperature=0,
        max_tokens=32000,
        model_api_kwargs={},
        api_dict=None,
        stream=True,
    )
    return out, tokens, meta, FakeAnthropic.calls


SCENARIOS = []


def scenario(name):
    def deco(fn):
        SCENARIOS.append((name, fn))
        return fn
    return deco


@scenario('400 参数被拒（引号包裹）：摘掉 temperature 重发')
def _():
    out, _, _, calls = call_openai([
        http_error(openai.BadRequestError, 400, '`temperature` is deprecated for this model.'),
        ('ok', 'real answer'),
    ])
    assert out == 'real answer', out
    assert len(calls) == 2, f'应重发一次，实际 {len(calls)}'
    assert 'temperature' in calls[0] and 'temperature' not in calls[1], '第二次不应再带 temperature'


@scenario('400 参数被拒（无引号 + invalid/only）：kimi-k3 真实现场')
def _():
    out, _, _, calls = call_openai([
        http_error(openai.BadRequestError, 400,
                   "field Temperature invalid, only 1 is allowed for this model"),
        ('ok', 'real answer'),
    ])
    assert out == 'real answer', out
    assert 'temperature' not in calls[1]


@scenario('400 值超限（max_tokens 超上限）：不摘参数、不重试')
def _():
    out, _, meta, calls = call_openai([
        http_error(openai.BadRequestError, 400,
                   'max_tokens: 32000 is greater than the model maximum of 8192'),
    ])
    assert out == API_ERROR_OUTPUT, out
    assert len(calls) == 1, f'不该重试，实际 {len(calls)} 次'
    assert meta['error'] == 'BadRequestError'


@scenario('401 认证失败：立即放弃（不重试、不摘参数）')
def _():
    out, _, meta, calls = call_openai([http_error(openai.AuthenticationError, 401, 'invalid api key')])
    assert out == API_ERROR_OUTPUT
    assert len(calls) == 1, f'不该重试，实际 {len(calls)} 次'


@scenario('429 限流两次后成功：退避重试')
def _():
    out, _, _, calls = call_openai([
        http_error(openai.RateLimitError, 429, 'rate limit exceeded'),
        http_error(openai.RateLimitError, 429, 'rate limit exceeded'),
        ('ok', 'after retry'),
    ])
    assert out == 'after retry', out
    assert len(calls) == 3


@scenario('524 号池无可用资源：退避重试后成功')
def _():
    out, _, _, calls = call_openai([
        http_error(openai.InternalServerError, 524, '当前号池渠道暂时无可用资源'),
        ('ok', 'after pool retry'),
    ])
    assert out == 'after pool retry', out
    assert len(calls) == 2


@scenario('502 网关返回 HTML 页面：重试后成功')
def _():
    out, _, _, calls = call_openai([
        http_error(openai.InternalServerError, 502, '<html><body>502 Bad Gateway</body></html>'),
        ('ok', 'after gateway retry'),
    ])
    assert out == 'after gateway retry', out


@scenario('连接被重置：重试后成功')
def _():
    out, _, _, calls = call_openai([
        http_error(openai.APIConnectionError, 0, 'Connection reset by peer'),
        ('ok', 'after reconnect'),
    ])
    assert out == 'after reconnect', out


@scenario('读超时：重试后成功')
def _():
    out, _, _, calls = call_openai([
        http_error(openai.APITimeoutError, 0, 'Request timed out.'),
        ('ok', 'after timeout retry'),
    ])
    assert out == 'after timeout retry', out


@scenario('200 但 choices 为空数组：重发后拿到内容')
def _():
    out, _, _, calls = call_openai([('ok_empty_choices', None), ('ok', 'recovered')])
    assert out == 'recovered', out
    assert len(calls) == 2


@scenario('200 但 content 为空串：重发后拿到内容')
def _():
    out, _, _, calls = call_openai([('ok_empty_content', None), ('ok', 'recovered')])
    assert out == 'recovered', out


@scenario('模型拒答 invalid_prompt：立即记 $ERROR$，不重试')
def _():
    out, _, meta, calls = call_openai([http_error(openai.BadRequestError, 400,
                                                  'invalid_prompt: content policy')])
    assert out == API_ERROR_OUTPUT, out
    assert len(calls) == 1, f'不该重试，实际 {len(calls)} 次'


@scenario('token 耗尽（finish_reason=length + 空内容）：记真实 0 分，不重试')
def _():
    out, tokens, meta, calls = call_openai([('ok_token_exhaustion', None)])
    assert out == '', repr(out)
    assert meta.get('eval_status') == 'token_exhaustion', meta
    assert len(calls) == 1, '不该重试'


@scenario('持续 500：重试到上限后记 $ERROR$，且错误信息完整')
def _():
    err = lambda: http_error(openai.InternalServerError, 500, 'internal server error')
    out, _, meta, calls = call_openai([err(), err(), err(), err(), err(), err()])
    assert out == API_ERROR_OUTPUT
    assert len(calls) == completions._RESILIENCE_MAX_ATTEMPTS, f'实际 {len(calls)}'
    assert meta['error_msg']


@scenario('参数被拒后记忆：第二题不再携带该参数（只撞一次）')
def _():
    completions._UNSUPPORTED_API_KWARGS.clear()
    call_openai([http_error(openai.BadRequestError, 400, '`temperature` is deprecated'), ('ok', 'a')])
    _, _, _, calls2 = call_openai([('ok', 'b')])
    assert len(calls2) == 1, '第二题不该再撞 400'
    assert 'temperature' not in calls2[0], '第二题不应携带 temperature'
    completions._UNSUPPORTED_API_KWARGS.clear()


@scenario('anthropic 通道 400 参数被拒：摘掉 temperature 重发')
def _():
    completions._UNSUPPORTED_API_KWARGS.clear()
    out, _, _, calls = call_anthropic([
        http_error(anthropic.BadRequestError, 400, '`temperature` is deprecated for this model.'),
    ])
    assert out == 'anthropic answer', out
    assert len(calls) == 2, f'应重发一次，实际 {len(calls)}'
    assert 'temperature' not in calls[1], '第二次不应带 temperature'
    completions._UNSUPPORTED_API_KWARGS.clear()


@scenario('anthropic 通道 524：退避重试后成功（以前完全没有重试）')
def _():
    out, _, _, calls = call_anthropic([
        http_error(anthropic.InternalServerError, 524, '当前号池渠道暂时无可用资源'),
    ])
    assert out == 'anthropic answer', out
    assert len(calls) == 2, f'应重试，实际 {len(calls)}'


@scenario('anthropic 通道 401：立即放弃')
def _():
    out, _, meta, calls = call_anthropic([http_error(anthropic.AuthenticationError, 401, 'invalid x-api-key')])
    assert out == API_ERROR_OUTPUT
    assert len(calls) == 1


@scenario('URL provider / local 也走容错层（以前是裸函数）')
def _():
    for provider in ('https://api.aiportx.com/v1', 'local', 'mistral', 'openai_responses', 'anthropic'):
        fn = get_api_function(provider)
        assert callable(fn), provider
    FakeOpenAI.script = [http_error(openai.InternalServerError, 503, 'service unavailable'),
                         ('ok', 'wrapped')]
    FakeOpenAI.calls = []
    fn = get_api_function('local')
    out, _, _ = fn(model='m', messages=[{'role': 'user', 'content': 'x'}], temperature=0,
                   max_tokens=100, model_api_kwargs=None,
                   api_dict={'api_key': 'k', 'api_base': 'https://api.aiportx.com/v1'}, stream=False)
    assert out == 'wrapped', out
    assert len(FakeOpenAI.calls) == 2, 'local provider 必须重试'


@scenario('2 元组 handler 原样返回 (text, tokens)，不被拆成 3 元组')
def _():
    def two_tuple(**kwargs):
        return 'two tuple answer', 5

    wrapped = completions._resilient(two_tuple)
    res = wrapped(model='m', messages=[], temperature=0, max_tokens=1,
                  model_api_kwargs=None, api_dict=None, stream=False)
    assert res == ('two tuple answer', 5), f'返回形状被改了: {res!r}'


@scenario('未成功过一次时失败：返回 3 元组，gen_api_answer 的两种拆包方式都能消费')
def _():
    # 首次调用就失败时无法预知 handler 的真实返回形状（注解不可信），
    # 这时统一给 3 元组：gen_api_answer 用 `len(res) == 3` 分支，
    # 3 元组对 2/3 元组 handler 都安全，而且能把 eval_status 带进 api_info。
    def failing_two_tuple(**kwargs):
        raise completions.APIRequestFailed(RuntimeError('boom'))

    res = completions._resilient(failing_two_tuple)(
        model='m', messages=[], temperature=0, max_tokens=1,
        model_api_kwargs=None, api_dict=None, stream=False)

    # 完全按 gen_api_answer.py:120-124 的逻辑消费
    if len(res) == 3:
        output, num_tokens, meta = res
    else:
        output, num_tokens = res
        meta = None
    assert output == API_ERROR_OUTPUT, res
    assert num_tokens == 0, res
    assert meta and meta.get('eval_status') == 'api_error', res


@scenario('3 元组 handler 成功/失败都保持 3 元组')
def _():
    def three_tuple(**kwargs):
        return 'three', 9, {'input_tokens': 3}

    wrapped = completions._resilient(three_tuple)
    assert wrapped(model='m') == ('three', 9, {'input_tokens': 3})

    def failing_three_tuple(**kwargs):
        raise completions.APIRequestFailed(RuntimeError('boom'))

    res = completions._resilient(failing_three_tuple)(model='m')
    assert len(res) == 3 and res[0] == API_ERROR_OUTPUT, res


@scenario('openai_responses 真实现场：返回 2 元组，不再报 unpack 错误')
def _():
    FakeOpenAI.script = []
    FakeOpenAI.calls = []
    FakeResponses.script = []
    fn = get_api_function('openai_responses')
    res = fn(model='gpt-6-astra', messages=[{'role': 'user', 'content': 'q'}],
             temperature=0, max_tokens=32000, model_api_kwargs={'reasoning_effort': 'xhigh'},
             api_dict={'api_key': 'k', 'api_base': 'https://api.aiportx.com/v1'}, stream=False)
    assert isinstance(res, tuple) and len(res) == 2, f'应为 2 元组，实际 {res!r}'
    text, tokens = res
    assert text == 'responses answer' and tokens == 12, res


@scenario('openai_responses 收到 400 参数被拒：摘掉 reasoning/temperature 后成功')
def _():
    FakeResponses.script = [http_error(openai.BadRequestError, 400,
                                      "Unsupported parameter: 'temperature' is not supported with this model.")]
    fn = get_api_function('openai_responses')
    res = fn(model='gpt-6-astra', messages=[{'role': 'user', 'content': 'q'}],
             temperature=0, max_tokens=32000, model_api_kwargs=None,
             api_dict={'api_key': 'k', 'api_base': 'https://api.aiportx.com/v1'}, stream=False)
    assert res[0] == 'responses answer', res
    assert FakeResponses.calls, '应有实际请求'
    assert 'temperature' not in FakeResponses.calls[-1], '第二次不应带 temperature'


@scenario('openai_responses 空答案：重发后拿到内容')
def _():
    FakeResponses.script = [('empty', None)]
    fn = get_api_function('openai_responses')
    res = fn(model='gpt-6-astra', messages=[{'role': 'user', 'content': 'q'}],
             temperature=0, max_tokens=32000, model_api_kwargs=None,
             api_dict={'api_key': 'k', 'api_base': 'https://api.aiportx.com/v1'}, stream=False)
    assert res[0] == 'responses answer', res


def main():
    # 关掉 tenacity 的 warning/traceback 噪音，只看结论
    logging.disable(logging.CRITICAL)
    print(f'故障矩阵：{len(SCENARIOS)} 个场景\n')
    failed = 0
    for name, fn in SCENARIOS:
        completions._UNSUPPORTED_API_KWARGS.clear()
        captured = io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):
                fn()
            print(f'  PASS  {name}')
        except AssertionError as exc:
            failed += 1
            print(f'  FAIL  {name}')
            print(f'        {exc}')
            _show_trace(captured)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f'  ERROR {name}')
            print(f'        {type(exc).__name__}: {exc}')
            _show_trace(captured)
    print()
    print('全部通过 ✅' if failed == 0 else f'{failed} 个场景未通过 ❌')
    return 1 if failed else 0


def _show_trace(captured):
    lines = [l for l in captured.getvalue().splitlines() if l.strip()]
    for line in lines[-6:]:
        print(f'        | {line[:150]}')


if __name__ == '__main__':
    sys.exit(main())
