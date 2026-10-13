"""Convert the official HotpotQA distractor validation Parquet to the runtime JSON format."""

import json
import sys
from pathlib import Path

try:
    import duckdb
except ImportError as error:
    raise SystemExit("Install duckdb into a temporary Python environment first.") from error

source = Path(sys.argv[1] if len(sys.argv) > 1 else ".data/hotpotqa/validation.parquet")
target = Path(sys.argv[2] if len(sys.argv) > 2 else ".data/hotpotqa/validation.json")
if not source.is_file():
    raise SystemExit(f"Missing input: {source}")
columns = ["id", "question", "answer", "type", "level", "supporting_facts", "context"]
rows = duckdb.execute("SELECT * FROM read_parquet(?)", [str(source)]).fetchall()
data = [dict(zip(columns, row)) for row in rows]
if not data or any(len(row["context"]["title"]) != len(row["context"]["sentences"]) for row in data):
    raise SystemExit("Invalid HotpotQA validation data")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
print(f"Imported {len(data)} records into {target}")
