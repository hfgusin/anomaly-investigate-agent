from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / ".data"
BUSINESS_SOURCES = ROOT / "script_and_data_info_record.md"

INTENT_EMBEDDING_CACHE = DATA_DIR / "intent-router/embeddings"
