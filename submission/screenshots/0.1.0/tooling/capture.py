#!/usr/bin/env python3
"""Capture a simulator framebuffer and remove an entirely opaque alpha channel losslessly."""
from datetime import datetime, timezone
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image

udid, display, output = sys.argv[1:]
output = Path(output)
output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="ai-chat-framebuffer-") as temporary:
    raw = Path(temporary) / "framebuffer.png"
    command = ["xcrun", "simctl", "io", udid, "screenshot", f"--display={display}", "--mask=black", str(raw)]
    subprocess.run(command, check=True)
    with Image.open(raw) as frame:
        frame.load()
        assert any(high - low > 15 for low, high in frame.convert("RGB").getextrema()), "Blank simulator framebuffer; verify the active display before capture"
        if "A" in frame.getbands():
            assert frame.getchannel("A").getextrema() == (255, 255), "Unexpected transparent pixels"
        frame.convert("RGB").save(output)
    record = {"capturedAtUTC": datetime.now(timezone.utc).isoformat(), "file": output.name, "simulatorUDID": udid, "display": display,
              "rawFramebufferSHA256": hashlib.sha256(raw.read_bytes()).hexdigest(),
              "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
              "conversion": "Removed entirely opaque alpha channel; RGB pixels unchanged"}
    output.with_suffix(".capture.json").write_text(json.dumps(record, indent=2) + "\n")
print(output)
