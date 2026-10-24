#!/usr/bin/env python3
"""Send one command to the dedicated XCTest runner's Documents directory."""
import json
import sys
import subprocess
import time
import uuid
from pathlib import Path

documents = Path(sys.argv[1])
if not documents.is_dir():
    container = subprocess.check_output(["xcrun", "simctl", "get_app_container", sys.argv[1], "com.locallab.capture.xctrunner", "data"], text=True).strip()
    documents = Path(container) / "Documents"
command = {"id": str(uuid.uuid4()), "action": sys.argv[2]}
for argument in sys.argv[3:]:
    key, value = argument.split("=", 1)
    command[key] = value
(documents / "command.json").write_text(json.dumps(command))
for _ in range(120):
    try:
        response = json.loads((documents / "response.json").read_text())
        if response["id"] == command["id"]:
            print(json.dumps(response, indent=2))
            sys.exit(0 if response["result"] == "ok" else 1)
    except (OSError, ValueError):
        pass
    time.sleep(0.5)
raise SystemExit("XCTest command timed out")
