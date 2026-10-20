"""意图路由评测："大模型打标 + 小模型执行"。

    cd python && ../.venv-di/bin/python -m evaluation.run_router label   # 大模型标注候选池，写 config/router-examples.json，需人工复核
    cd python && ../.venv-di/bin/python -m evaluation.run_router eval    # 在人工标注测试集上对比四种方案
"""
import argparse
import asyncio
from collections import Counter
from datetime import datetime
import json
import hashlib
import os
import time

from dotenv import load_dotenv

from agent_backend.paths import DATA_DIR, ROOT
from agent_backend.router import DEFAULT_MODEL, EXAMPLES, classify, classify_rag, load_examples, router_model, _retriever

ROUTER_DIR = ROOT / "portfolio/evaluation/router"
LARGE_MODEL = "deepseek-v4-pro-ga-260813"
ROUTES = ["daily-check", "ads-check", "general", "clarify"]


def keyword_route(text: str) -> str:
    lowered = text.lower()
    if any(word in lowered for word in ("scs_take_rate_ads", "广告", "take rate", "ads", "调价", "加投", "减投", "campaign")):
        return "ads-check"
    if any(word in lowered for word in ("失败", "挂", "报错", "dag", "airflow", "红", "排查", "keyerror", "task")):
        return "daily-check"
    return "general"


async def run_all(texts, model, examples, concurrency=8):
    limit = asyncio.Semaphore(concurrency)

    async def one(text):
        async with limit:
            started = time.perf_counter()
            try:
                route, usage = await classify(text, model, examples)
                return {"route": route.route, "seconds": time.perf_counter() - started, "tokens": usage.get("total_tokens", 0)}
            except Exception as error:
                return {"route": None, "error": type(error).__name__, "seconds": time.perf_counter() - started, "tokens": 0}

    return await asyncio.gather(*(one(text) for text in texts))


async def label():
    pool = json.loads((ROUTER_DIR / "pool.json").read_text())
    results = await run_all(pool, router_model(LARGE_MODEL, thinking=True), [])
    examples = [{"text": text, "route": result["route"]} for text, result in zip(pool, results) if result["route"]]
    EXAMPLES.write_text(json.dumps(examples, ensure_ascii=False, indent=1) + "\n")
    print(Counter(e["route"] for e in examples), f"已写入 {EXAMPLES}，请人工复核后再用于 few-shot。")


def _percentile(values, q):
    ordered = sorted(values)
    return ordered[round(q * (len(ordered) - 1))]


def score(name, cases, results):
    correct = sum(r["route"] == c["route"] for c, r in zip(cases, results))
    confusion = Counter(f"{c['route']}→{r['route']}" for c, r in zip(cases, results) if r["route"] != c["route"])
    seconds = [r["seconds"] for r in results]
    return {"name": name, "accuracy": correct / len(cases), "errors": sum("error" in r for r in results),
            "p50_ms": round(_percentile(seconds, 0.5) * 1000), "p95_ms": round(_percentile(seconds, 0.95) * 1000),
            "avg_tokens": round(sum(r["tokens"] for r in results) / len(results)), "confusion": dict(confusion.most_common())}


async def evaluate():
    cases = json.loads((ROUTER_DIR / "test.json").read_text())
    texts = [c["text"] for c in cases]
    examples = load_examples()
    small = os.environ.get("ROUTER_MODEL_NAME", DEFAULT_MODEL)
    keyword = [{"route": keyword_route(t), "seconds": 0.0, "tokens": 0} for t in texts]
    runs = [("关键词规则", keyword),
            (f"小模型零样本（{small}）", await run_all(texts, router_model(small), [])),
            (f"小模型 + 大模型标注示例 {len(examples)} 条", await run_all(texts, router_model(small), examples)),
            (f"大模型零样本（{LARGE_MODEL}，开启思考）", await run_all(texts, router_model(LARGE_MODEL, thinking=True), []))]
    scores = [score(name, cases, results) for name, results in runs]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output = DATA_DIR / "evaluation" / f"router-{stamp}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"scores": scores, "predictions": {name: [r["route"] for r in results] for name, results in runs},
                                  "cases": cases}, ensure_ascii=False, indent=1))
    lines = [f"# 意图路由评测", "", f"- 时间：{datetime.now():%Y-%m-%d %H:%M}；测试集 {len(cases)} 条（{dict(Counter(c['route'] for c in cases))}）", "",
             "| 方案 | 准确率 | 失败 | p50 | p95 | 平均 token | 主要混淆 |", "|---|---|---|---|---|---|---|"]
    for s in scores:
        confusion = "、".join(f"{k}×{v}" for k, v in list(s["confusion"].items())[:4]) or "—"
        lines.append(f"| {s['name']} | {s['accuracy']:.1%} | {s['errors']} | {s['p50_ms']}ms | {s['p95_ms']}ms | {s['avg_tokens']} | {confusion} |")
    (ROOT / "portfolio/evaluation/results/router.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"完整记录：{output}")


async def evaluate_retrieval(live=False):
    cases = json.loads((ROUTER_DIR / "rag-dev.json").read_text())["cases"]
    examples = load_examples()
    retriever = _retriever(json.dumps(examples, ensure_ascii=False, sort_keys=True))
    rows = []
    model = router_model() if live else None
    for case in cases:
        started = time.perf_counter()
        if live:
            try:
                result = await classify_rag(case["text"], model, examples, case.get("history"))
                row = {"id": case["id"], "expected": case["route"], **result}
            except Exception as error:
                row = {"id": case["id"], "expected": case["route"], "route": None,
                       "error": type(error).__name__}
        else:
            query = "当前输入：" + case["text"]
            if case.get("history"):
                query += "\n最近对话：" + "\n".join(f"{m['role']}: {m['content']}" for m in case["history"])
            row = {"id": case["id"], "expected": case["route"], "retrieval": retriever.search(query)}
        row["seconds"] = time.perf_counter() - started
        rows.append(row)
        print(f"{case['id']}: {row.get('route', 'retrieval only')}", flush=True)
    retrieved = [r for r in rows if r.get("retrieval")]
    recalled = [r for r in retrieved if any(hit["route"] == r["expected"] for hit in r["retrieval"]["hits"])]
    summary = {"cases": len(rows), "retrieval_cases": len(retrieved),
               "candidate_recall_at_6": len(recalled) / len(retrieved) if retrieved else None,
               "scope": "16 synthetic development cases; not a held-out production benchmark",
               "classification_evaluated": live}
    if live:
        summary.update(accuracy=sum(r.get("route") == r["expected"] for r in rows) / len(rows),
                       errors=sum("error" in r for r in rows),
                       oos_recall=sum(r.get("route") == "out-of-scope" for r in rows if r["expected"] == "out-of-scope") / sum(r["expected"] == "out-of-scope" for r in rows))
    output = DATA_DIR / "evaluation" / ("router-rag-live.json" if live else "router-retrieval.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    identity = {"dataset_sha256": hashlib.sha256((ROUTER_DIR / "rag-dev.json").read_bytes()).hexdigest(),
                "model": os.environ.get("ROUTER_MODEL_NAME", DEFAULT_MODEL) if live else None,
                "code_sha256": hashlib.sha256(b"".join((ROOT / file).read_bytes() for file in
                    ["python/agent_backend/router.py", "python/agent_backend/intent_graph.py", "python/agent_backend/intent_retrieval.py", "config/router-examples.json"])).hexdigest()}
    output.write_text(json.dumps({"summary": summary, **identity, "results": rows}, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False))
    print(f"报告：{output}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["label", "eval", "retrieval", "rag"])
    args = parser.parse_args()
    load_dotenv(ROOT / ".env", override=True)
    if args.command in {"retrieval", "rag"}:
        asyncio.run(evaluate_retrieval(live=args.command == "rag"))
    else:
        asyncio.run(label() if args.command == "label" else evaluate())


if __name__ == "__main__":
    main()
