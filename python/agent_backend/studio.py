"""供本地 Agent Server / Studio 加载现有意图路由图。"""
import json

from langchain_core.runnables import RunnableConfig

from agent_backend.intent_graph import build_intent_graph
from agent_backend.router import _retriever, load_examples, router_model, system_prompt


def make_graph(config: RunnableConfig):
    examples = load_examples()

    def search_examples(query):
        return _retriever(json.dumps(examples, ensure_ascii=False, sort_keys=True)).search(query)

    return build_intent_graph(router_model(), search_examples, system_prompt).with_config(recursion_limit=20)
