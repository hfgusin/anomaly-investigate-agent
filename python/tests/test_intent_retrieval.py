"""真实本地 MiniLM 检索与受控判定器；不连接模型服务。"""
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agent_backend.intent_retrieval import ExampleRetriever, HuggingFaceEmbeddings, MODEL_REVISION
from agent_backend import router


@unittest.skipUnless((Path.home() / ".cache/huggingface/hub/models--sentence-transformers--paraphrase-multilingual-MiniLM-L12-v2/snapshots" / MODEL_REVISION / "modules.json").exists(), "需要本地 Sentence Transformers MiniLM；见 docs/intent-routing.md")
class RetrievalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.examples = router.load_examples()
        cls.path = Path(cls.tmp.name) / "embeddings"
        cls.index = ExampleRetriever(cls.examples, cache_dir=cls.path)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_exact_example_is_retrieved_with_normalized_vector(self):
        text = "PHLOCAL 非主店周二的广告操作应该从哪里查"
        result = self.index.search(text)
        self.assertEqual(result["hits"][0]["text"], text)
        vector = self.index.embeddings.embed_query(text)
        self.assertEqual(len(vector), 384)
        self.assertAlmostEqual(math.sqrt(sum(v * v for v in vector)), 1, places=5)
        self.assertEqual(result["search_type"], "mmr")
        self.assertEqual([hit["rank"] for hit in result["hits"]], list(range(1, 7)))
        self.assertTrue(all(hit["route"] in router.Route.model_json_schema()["properties"]["route"]["enum"]
                            for hit in result["hits"]))

    def test_cache_is_reused_and_changed_examples_rebuild(self):
        with patch.object(HuggingFaceEmbeddings, "embed_documents", side_effect=AssertionError("已有向量不应重新编码")):
            cached = ExampleRetriever(self.examples, cache_dir=self.path)
        self.assertTrue(cached.cache_hit)
        self.assertEqual(cached.fingerprint, self.index.fingerprint)
        before = set(self.path.rglob("*"))
        with patch.object(HuggingFaceEmbeddings, "embed_documents", autospec=True,
                          side_effect=HuggingFaceEmbeddings.embed_documents) as encode:
            changed = ExampleRetriever(self.examples + [{"text": "新业务来源样例", "route": "source-lookup"}], cache_dir=self.path)
        self.assertEqual(encode.call_count, 1)
        self.assertEqual(encode.call_args.args[1], ["新业务来源样例"])
        self.assertFalse(changed.cache_hit)
        self.assertNotEqual(changed.fingerprint, self.index.fingerprint)
        self.assertEqual(len(set(self.path.rglob("*")) - before), 1)
        self.assertEqual(changed.search("新业务来源样例")["hits"][0]["route"], "source-lookup")

    def test_long_query_returns_bounded_examples(self):
        result = self.index.search("广告任务的执行情况需要核对。" * 100)
        self.assertEqual(len(result["hits"]), 6)
        self.assertEqual(len({hit["text"] for hit in result["hits"]}), 6)
