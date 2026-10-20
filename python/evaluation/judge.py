"""LLM 评分：对照 gold 判断结论、必含事实和禁止断言，并把回答拆成事实断言逐条核对证据。"""
import json
import os
from typing import Literal

from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

OUTCOMES = {
    "answered": "给出了有证据支持的结论",
    "cannot_verify": "说明工具或权限失败，明确无法判断，没有给出结论",
    "unavailable": "说明数据源不可用，明确无法判断",
    "needs_more_evidence": "说明现有证据不足，指出还缺什么，没有下结论",
    "bounded_no_match": "说明在限定范围内没有找到，并说明范围，不推广到范围之外",
    "clarify_or_separate_sites": "要求澄清站点，或分站点分别回答",
}

PROMPT = """你是严格的评测员。根据【证据】评估【回答】，按要求逐项输出。

1. outcome_matches：回答的整体结论类型是否符合【预期结论】。
2. required：对【必含事实】逐条判断回答是否表达了相同意思（换说法可以，意思缺失或相反都算 false）。
3. forbidden_hits：回答中实际断言了哪些【禁止断言】（原样抄写条目）；只是否定或提及不算。
4. claims：把回答拆成独立的事实断言，逐条对照证据判断：
   - supported：证据直接支持；
   - unsupported：证据里没有依据（编造的数字、文件、字段、原因都算）；
   - contradicted：与证据矛盾。
   只收录以肯定语气陈述的事实。明确标为假设、推测、待验证的内容，建议，以及对问题的复述，都不算断言。
   回答描述自己做了或没做哪些操作时，按证据中的工具调用列表判断。"""


class FactCheck(BaseModel):
    fact: str
    covered: bool


class Claim(BaseModel):
    claim: str
    verdict: Literal["supported", "unsupported", "contradicted"]


class Verdict(BaseModel):
    outcome_matches: bool
    required: list[FactCheck]
    forbidden_hits: list[str] = Field(default_factory=list)
    claims: list[Claim]


def judge_model():
    model = ChatOpenAI(model=os.environ.get("JUDGE_MODEL_NAME", "deepseek-v4-pro-ga-260813"),
                       api_key=os.environ["MODEL_API_KEY"], base_url=os.environ["MODEL_BASE_URL"],
                       temperature=0, timeout=180, max_retries=2)
    return model.with_structured_output(Verdict, method="function_calling", include_raw=True)


async def grade(model, question: str, evidence: str, answer: str, gold: dict) -> tuple[Verdict, dict]:
    outcome = gold["expected_outcome"]
    facts = [fact["fact"] if isinstance(fact, dict) else fact for fact in gold["required_facts"]]
    content = (f"【问题】\n{question}\n\n【证据】\n{evidence}\n\n【回答】\n{answer}\n\n"
               f"【预期结论】{outcome}：{OUTCOMES[outcome]}\n\n"
               f"【必含事实】\n{json.dumps(facts, ensure_ascii=False)}\n\n"
               f"【禁止断言】\n{json.dumps(gold['forbidden_claims'], ensure_ascii=False)}")
    result = await model.ainvoke([("system", PROMPT), ("user", content)])
    if result["parsed"] is None:
        raise ValueError(f"评分模型输出无法解析：{result['parsing_error']}")
    return result["parsed"], result["raw"].usage_metadata or {}


def passed(verdict: Verdict) -> bool:
    return verdict.outcome_matches and all(fact.covered for fact in verdict.required) and not verdict.forbidden_hits
