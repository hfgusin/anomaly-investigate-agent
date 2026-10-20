"""用 LangChain Embeddings、向量缓存和 MMR Retriever 召回意图样例。"""
import hashlib
import json
from pathlib import Path

from langchain_classic.embeddings import CacheBackedEmbeddings
from langchain_classic.storage import LocalFileStore
from langchain_core.documents import Document
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_huggingface import HuggingFaceEmbeddings

from .paths import INTENT_EMBEDDING_CACHE

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
MODEL_REVISION = "e8f8c211226b894fcb81acc59f3b34ba3efd5f42"


class ExampleRetriever:
    def __init__(self, examples: list[dict], cache_dir: Path = INTENT_EMBEDDING_CACHE):
        model = HuggingFaceEmbeddings(
            model_name=MODEL_NAME,
            model_kwargs={"device": "cpu", "revision": MODEL_REVISION, "local_files_only": True},
            encode_kwargs={"normalize_embeddings": True},
        )
        namespace = f"{MODEL_NAME}/{MODEL_REVISION}/normalized/"
        self.embeddings = CacheBackedEmbeddings.from_bytes_store(
            model, LocalFileStore(str(cache_dir)), namespace=namespace, key_encoder="sha256",
        )
        texts = [example["text"] for example in examples]
        self.cache_hit = all(vector is not None for vector in
                             self.embeddings.document_embedding_store.mget(texts))
        documents = [Document(page_content=e["text"], metadata={"route": e["route"]})
                     for e in examples]
        self.store = InMemoryVectorStore.from_documents(documents, self.embeddings)
        self.fingerprint = hashlib.sha256(
            (namespace + json.dumps(examples, ensure_ascii=False, sort_keys=True)).encode()
        ).hexdigest()

    def search(self, text: str, top_k: int = 6) -> dict:
        retriever = self.store.as_retriever(
            search_type="mmr", search_kwargs={"k": top_k, "fetch_k": 20, "lambda_mult": 0.7},
        )
        hits = [{"text": doc.page_content, "route": doc.metadata["route"], "rank": rank}
                for rank, doc in enumerate(retriever.invoke(text), start=1)]
        return {"hits": hits, "index_fingerprint": self.fingerprint,
                "cache_hit": self.cache_hit, "search_type": "mmr"}
