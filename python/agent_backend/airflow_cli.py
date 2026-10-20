"""命令行直接调用 Airflow 工具，不经过模型和网页审批。

    python -m agent_backend.airflow_cli airflow_get_run '{"dag_id": "d", "dag_run_id": "r"}'

成功时 stdout 打印 JSON；失败时错误写到 stderr，退出码非零。TS 自动化看板通过它调用。
"""
from contextlib import nullcontext
import json
import os
import sys
from langchain_core.tools import ToolException

from . import demo_world
from .paths import ROOT
from .tools.airflow import AIRFLOW_TOOLS
from .tools.airflow_scan import airflow_scan_failures


def load_dotenv() -> None:
    """Fill missing variables from the repo .env; variables already set by the caller win."""
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and not key.lstrip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def main(argv: list[str]) -> int:
    tools = {tool.name: tool for tool in [*AIRFLOW_TOOLS, airflow_scan_failures]}
    if len(argv) < 2 or argv[1] not in tools:
        print(f"用法：python -m agent_backend.airflow_cli <{'|'.join(tools)}> ['<JSON 参数>']", file=sys.stderr)
        return 2
    load_dotenv()
    world = os.environ.get("MIRROR_DEMO_WORLD")
    try:
        # .func skips handle_tool_error so failures surface as a non-zero exit.
        with demo_world.installed(demo_world.load(world)) if world else nullcontext():
            result = tools[argv[1]].func(**json.loads(argv[2] if len(argv) > 2 else "{}"))
    except ToolException as error:
        print(error, file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
