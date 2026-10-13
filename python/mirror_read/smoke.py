"""快速确认 mirror_read 模块可导入且与 TS 行为一致的小检查。"""

from __future__ import annotations

from .config_read import read_config
from .protocol import parse_request
from .tool_policy import has_side_effect, tool_risk


def main() -> None:
    assert parse_request({"type": "req", "id": "1", "method": "connect"}) is not None
    assert parse_request({"type": "nope"}) is None
    assert tool_risk("write_file") == "write"
    assert has_side_effect("read_file") is False
    cfg = read_config({"MIRROR_RUNTIME": "demo", "PORT": "18789"}, root=".")
    assert cfg.mode == "demo" and cfg.port == 18789
    print("mirror_read smoke OK")


if __name__ == "__main__":
    main()
