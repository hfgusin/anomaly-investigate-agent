"""业务评测：真实模型跑案例，LLM 按 gold 评分，汇总任务成功率、幻觉率、耗时和 token。

    cd python && ../.venv-di/bin/python -m evaluation.run_agent evidence --repeat 3 --concurrency 4
    cd python && ../.venv-di/bin/python -m evaluation.run_agent tools

evidence：12 个给定证据的案例，不用工具，只测判断。
tools：portfolio/evaluation/worlds 里的虚构环境，Agent 按 daily-check Skill 自己调用工具取证。
"""
import argparse
import asyncio
from collections import deque
from contextlib import nullcontext
from datetime import datetime
import json
import os
from pathlib import Path
import time

from dotenv import load_dotenv
from langchain_core.messages import AIMessage
from langchain_core.utils.function_calling import convert_to_openai_tool

from agent_backend import demo_world, runtime
from agent_backend.paths import DATA_DIR, ROOT
from agent_backend.tools import tools_by_name

from .judge import grade, judge_model, passed

EVALUATION = ROOT / "portfolio/evaluation"
EVIDENCE_INSTRUCTION = "只根据用户给出的证据回答，每个结论后用括号引用证据 ID。证据不足时说明还缺什么，不要猜测。"


class Gateway:
    """替代 TS Gateway：放行模型请求，自动批准 Python 工具，并记录工具调用。"""

    def __init__(self):
        self.pending = deque()
        self.model_calls = 0
        self.calls = {}
        self.trace = []

    def send(self, kind, **payload):
        if kind == "model_request":
            self.model_calls += 1
            self.pending.append({"type": "model_allowed"})
        elif kind == "python_tool_call":
            self.calls[payload["id"]] = payload
            self.pending.append({"type": "tool_approval", "id": payload["id"], "approved": True,
                                 "arguments": json.loads(payload["arguments"])})
        elif kind == "tool_executed":
            call = self.calls[payload["id"]]
            self.trace.append({"name": call["name"], "arguments": call["arguments"], "isError": payload["isError"],
                               "content": payload["content"]})
            self.pending.append({"type": "tool_result", **payload})
        elif kind == "tool_call":
            self.pending.append({"type": "tool_result", "id": payload["id"], "isError": True,
                                 "content": "评测只执行 Python 工具。"})

    async def receive(self):
        return self.pending.popleft()


def evidence_cases():
    cases = json.loads((EVALUATION / "cases.json").read_text())["cases"]
    gold = {item["id"]: item for item in json.loads((EVALUATION / "gold.json").read_text())["expectations"]}
    for case in cases:
        evidence = json.dumps(case["evidence"], ensure_ascii=False, indent=1)
        yield {"id": case["id"], "family": case["family"], "gold": gold[case["id"]], "question": case["question"],
               "evidence": evidence, "world": None,
               "request": {"messages": [{"role": "user", "content": f"{case['question']}\n\n证据：\n{evidence}"}],
                           "activeToolNames": [], "skillInstruction": EVIDENCE_INSTRUCTION}}


def world_cases():
    skill = (ROOT / "skills/daily-check/SKILL.md").read_text()
    tools = [tool for tool in tools_by_name().values() if "daily-check" in (tool.metadata or {}).get("skills", [])]
    for path in sorted((EVALUATION / "worlds").glob("W*.json")):
        world = json.loads(path.read_text())
        yield {"id": world["id"], "family": world["family"], "gold": world["gold"], "question": world["question"],
               "world": world,
               "request": {"messages": [{"role": "user", "content": world["question"]}],
                           "toolDefinitions": [convert_to_openai_tool(tool) for tool in tools],
                           "activeToolNames": [tool.name for tool in tools], "skillInstruction": skill}}


async def run_case(case, judge):
    request = runtime.StartRequest.model_validate({"type": "start", "hostedSearch": False, **case["request"]})
    gateway = Gateway()
    started = time.perf_counter()
    record = {"id": case["id"], "family": case["family"]}
    try:
        with demo_world.installed(case["world"]) if case["world"] else nullcontext():
            messages = await runtime.run(request, send=gateway.send, recv=gateway.receive)
        record["answer"] = messages[-1].text
    except Exception as error:
        record["error"] = f"{type(error).__name__}: {error}"
    record.update(seconds=round(time.perf_counter() - started, 1), model_calls=gateway.model_calls,
                  tool_calls=[{k: v for k, v in item.items() if k != "content"} for item in gateway.trace])
    if "error" in record:
        return record
    record["tokens"] = sum((m.usage_metadata or {}).get("total_tokens", 0) for m in messages if isinstance(m, AIMessage))
    evidence = case.get("evidence") or "以下是本次运行的全部工具调用及返回，没列出的工具就是没有调用：\n\n" + "\n\n".join(
        f"[{item['name']} {item['arguments']}]\n{item['content'][:6000]}" for item in gateway.trace)
    try:
        verdict, usage = await grade(judge, case["question"], evidence, record["answer"], case["gold"])
    except Exception as error:
        record["judge_error"] = f"{type(error).__name__}: {error}"
        return record
    record.update(passed=passed(verdict), verdict=verdict.model_dump(), judge_tokens=usage.get("total_tokens", 0))
    return record


def _percentile(values, q):
    ordered = sorted(values)
    return ordered[round(q * (len(ordered) - 1))] if ordered else None


def summarize(records):
    completed = [r for r in records if "answer" in r]
    scored = [r for r in completed if "verdict" in r]
    claims = [c for r in scored for c in r["verdict"]["claims"]]
    bad = [c for c in claims if c["verdict"] != "supported"]
    seconds = [r["seconds"] for r in completed]
    return {
        "runs": len(records),
        "completion_rate": len(completed) / len(records),
        "scored": len(scored),
        "task_success_rate": sum(r["passed"] for r in scored) / len(scored) if scored else None,
        "hallucination_rate": len(bad) / len(claims) if claims else None,
        "claims": len(claims),
        "runs_with_unsupported_claim": sum(any(c["verdict"] != "supported" for c in r["verdict"]["claims"]) for r in scored),
        "avg_tool_calls": sum(len(r["tool_calls"]) for r in completed) / len(completed) if completed else None,
        "avg_model_calls": sum(r["model_calls"] for r in completed) / len(completed) if completed else None,
        "p50_seconds": _percentile(seconds, 0.5),
        "p95_seconds": _percentile(seconds, 0.95),
        "avg_tokens": sum(r["tokens"] for r in completed) / len(completed) if completed else None,
    }


def report(mode, summary, records, model_name):
    def pct(value):
        return "—" if value is None else f"{value:.1%}"

    lines = [f"# 业务评测结果：{mode}", "",
             f"- 时间：{datetime.now():%Y-%m-%d %H:%M}；Agent 模型：`{model_name}`；评分模型：`{os.environ.get('JUDGE_MODEL_NAME', 'deepseek-v4-pro-ga-260813')}`",
             f"- 运行 {summary['runs']} 次，完成率 {pct(summary['completion_rate'])}，评分 {summary['scored']} 次",
             f"- 任务成功率 {pct(summary['task_success_rate'])}（结论正确 + 必含事实全覆盖 + 无禁止断言）",
             f"- 幻觉率 {pct(summary['hallucination_rate'])}（无证据或与证据矛盾的断言 / 全部 {summary['claims']} 条断言），"
             f"含幻觉断言的运行 {summary['runs_with_unsupported_claim']} 次",
             f"- 平均工具调用 {summary['avg_tool_calls'] or 0:.1f} 次，平均模型调用 {summary['avg_model_calls'] or 0:.1f} 次，"
             f"平均 token {summary['avg_tokens'] or 0:.0f}",
             f"- 耗时 p50 {summary['p50_seconds']}s，p95 {summary['p95_seconds']}s", "",
             "| 案例 | 类型 | 结果 | 未覆盖事实 / 禁止断言 / 幻觉断言 | 工具 | 秒 |", "|---|---|---|---|---|---|"]
    for r in records:
        if "verdict" not in r:
            lines.append(f"| {r['id']} | {r['family']} | 未评分 | {r.get('error') or r.get('judge_error')} | {len(r['tool_calls'])} | {r['seconds']} |")
            continue
        v = r["verdict"]
        problems = ([f"缺：{f['fact']}" for f in v["required"] if not f["covered"]]
                    + [f"禁：{c}" for c in v["forbidden_hits"]]
                    + [f"{c['verdict']}：{c['claim']}" for c in v["claims"] if c["verdict"] != "supported"])
        cell = "<br>".join(problems).replace("|", "\\|") or "—"
        lines.append(f"| {r['id']} | {r['family']} | {'通过' if r['passed'] else '失败'} | {cell} | {len(r['tool_calls'])} | {r['seconds']} |")
    return "\n".join(lines) + "\n"


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["evidence", "tools"])
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--concurrency", type=int, default=4, help="仅 evidence 模式生效；tools 模式的虚构环境是进程级替换，只能串行")
    parser.add_argument("--only", nargs="*", help="只跑指定案例 ID")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env", override=True)
    os.environ["LANGSMITH_TRACING"] = "false"
    cases = list(evidence_cases() if args.mode == "evidence" else world_cases())
    cases = [c for c in cases if not args.only or c["id"] in args.only] * args.repeat
    judge = judge_model()
    limit = asyncio.Semaphore(args.concurrency if args.mode == "evidence" else 1)

    async def bounded(case):
        async with limit:
            record = await run_case(case, judge)
            print(record["id"], record.get("passed", record.get("error") or record.get("judge_error")), flush=True)
            return record

    records = await asyncio.gather(*(bounded(case) for case in cases))
    summary = summarize(records)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output = DATA_DIR / "evaluation" / f"{args.mode}-{stamp}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"summary": summary, "records": records}, ensure_ascii=False, indent=1))
    results = EVALUATION / "results"
    results.mkdir(exist_ok=True)
    (results / f"{args.mode}.md").write_text(report(args.mode, summary, records, os.environ.get("MODEL_NAME")))
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"完整记录：{output}")


if __name__ == "__main__":
    asyncio.run(main())
