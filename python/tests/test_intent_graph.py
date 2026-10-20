"""真实 LangGraph 执行分支；只替换外部模型和检索数据。"""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from langchain_core.messages import AIMessage, ToolMessage

from agent_backend import router

USAGE = {"input_tokens": 20, "output_tokens": 5, "total_tokens": 25}
ROUTE = {"route": "daily-check", "reason": "查询具体 Airflow 失败任务"}


def decision(name="retrieve_examples", **args):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": "test-call"}], usage_metadata=USAGE)


class ScriptedModel:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.requests = []

    def bind_tools(self, tools, **kwargs):
        self.binding = kwargs
        return self

    def with_structured_output(self, schema, **kwargs):
        async def invoke(messages):
            self.requests.append((schema.__name__, messages))
            return {"parsed": schema.model_validate(next(self.responses)),
                    "raw": AIMessage(content="", usage_metadata=USAGE)}
        return SimpleNamespace(ainvoke=invoke)

    async def ainvoke(self, messages):
        self.requests.append(("decision", messages))
        return next(self.responses)


class IntentGraphTests(unittest.IsolatedAsyncioTestCase):
    async def run_graph(self, model, search=None, text="昨天某 DAG 为什么失败", history=None):
        self.search = search or Mock(return_value={"hits": [{"text": f"查失败任务{i}", "route": "daily-check"} for i in range(6)],
                                                  "search_type": "mmr", "cache_hit": True})
        with patch.object(router, "_retriever", return_value=SimpleNamespace(search=self.search)):
            return await router.classify_rag(text, model, [{"text": "样例", "route": "daily-check"}], history)

    async def test_direct_route_skips_embedding_and_retrieval(self):
        model = ScriptedModel(decision("Route", route="general", reason="打招呼"))
        with patch.object(router, "_retriever", side_effect=AssertionError("不应加载本地模型")):
            result = await router.classify_rag("你好", model, [{"text": "你好", "route": "general"}])
        self.assertEqual(result["route"], "general")
        self.assertIsNone(result["retrieval"])
        self.assertEqual(result["usage"]["total_tokens"], 25)

    async def test_toolnode_retrieves_then_grades_and_routes_with_original_history(self):
        model = ScriptedModel(decision(query="DAG 失败"), {"relevant": True, "reason": "包含失败排查"}, ROUTE)
        history = [{"role": "user", "content": "昨天某 DAG 失败了"}]
        result = await self.run_graph(model, text="那今天呢", history=history)
        self.search.assert_called_once_with("DAG 失败")
        self.assertEqual(result["route"], "daily-check")
        self.assertEqual([s["node"] for s in result["trace"]],
                         ["generate_query_or_respond", "retrieve", "grade_documents", "generate_answer"])
        final = model.requests[-1][1]
        self.assertEqual(final[0].content.count("输入："), 6)
        self.assertEqual(json.loads(final[1].content)["recent_messages"], history)
        self.assertEqual(result["usage"]["total_tokens"], 75)

    async def test_irrelevant_results_rewrite_and_retrieve_again(self):
        model = ScriptedModel(decision(query="第一次"), {"relevant": False, "reason": "业务不匹配"},
                              {"query": "Airflow DAG 失败日志"}, decision(query="Airflow DAG 失败日志"),
                              {"relevant": True, "reason": "匹配"}, ROUTE)
        result = await self.run_graph(model)
        self.assertEqual([call.args[0] for call in self.search.call_args_list], ["第一次", "Airflow DAG 失败日志"])
        self.assertEqual(model.binding["tool_choice"], "retrieve_examples")
        self.assertEqual(sum(step["node"] == "rewrite_question" for step in result["trace"]), 1)
        self.assertTrue(any(isinstance(message, ToolMessage) for message in model.requests[3][1]))
        self.assertEqual(json.loads(model.requests[-1][1][1].content)["current_input"], "昨天某 DAG 为什么失败")

    async def test_rewrite_limit_discards_irrelevant_examples(self):
        responses = []
        for i in range(3):
            responses.extend([decision(query=f"查询{i}"), {"relevant": False, "reason": "没有相关样例"}])
            if i < 2:
                responses.append({"query": f"查询{i + 1}"})
        model = ScriptedModel(*responses, ROUTE)
        result = await self.run_graph(model)
        self.assertEqual(self.search.call_count, 3)
        self.assertTrue(result["trace"][-2]["rewrite_limit_reached"])
        self.assertFalse(result["trace"][-1]["used_examples"])
        self.assertNotIn("输入：查失败任务", model.requests[-1][1][0].content)

    async def test_retrieval_error_is_not_treated_as_irrelevant_evidence(self):
        with self.assertRaisesRegex(RuntimeError, "索引读取失败"):
            await self.run_graph(ScriptedModel(decision(query="DAG")), Mock(side_effect=RuntimeError("索引读取失败")))
