#!/usr/bin/env python3
"""Verify real draft retention and keyboard layout through native device rotations."""
import json
import re
import subprocess
import sys
from pathlib import Path

udid, family = sys.argv[1:]
tooling = Path(__file__).resolve().parent
root = tooling.parent
output = root / "evidence" / family
output.mkdir(parents=True, exist_ok=True)
steps = []

def command(action, **arguments):
    value = json.loads(subprocess.check_output([
        sys.executable, str(tooling / "command.py"), udid, action,
        *[f"{key}={value}" for key, value in arguments.items()],
    ], text=True))
    assert value["result"] == "ok", value["result"]
    return value["tree"]

def capture(name):
    subprocess.run([sys.executable, str(tooling / "capture.py"), udid,
                    "primary", str(output / f"{name}.png")], check=True)

def record(name, tree):
    bounds = re.search(r"Window \(Main\).*?\{\{.*?\}, \{(.*?)\}\}", tree)
    steps.append({"step": name, "windowSizePoints": bounds.group(1) if bounds else None,
                  "draftRetained": draft in tree,
                  "keyboardPresent": "Keyboard," in tree,
                  "savedResponsePresent": "The first version is ready" in tree})

tree = command("tree")
if "label: 'Return to conversation'" in tree:
    tree = command("tap", label="Return to conversation")
if "The first version is ready" not in tree:
    if "label: 'Open chat menu'" in tree:
        command("tap", label="Open chat menu")
    elif "label: 'Show all controls'" in tree:
        command("tap", label="Show all controls")
    command("tap", label="Library")
    command("tap", label="Open A clearer project update")
    tree = command("tree")
assert "The first version is ready" in tree, "Imported project update did not reopen"
draft = "Resize42"
command("tap", label="advanced-composer-input")
command("type", text="\x7f" * 100)
tree = command("type", text=draft)
assert draft in tree, "Draft missing before rotation"
record("portrait-keyboard", tree)
capture("portrait-keyboard")
for orientation in ("landscapeLeft", "landscapeRight", "portrait"):
    tree = command("rotate", orientation=orientation)
    assert draft in tree, f"Draft lost after {orientation}"
    assert "The first version is ready" in tree, f"Saved conversation changed after {orientation}"
    record(orientation, tree)
    capture(orientation)
command("tap", label="advanced-composer-input")
command("type", text="\x7f" * len(draft))
tree = command("tree")
if "label: 'Hide keyboard'" in tree:
    tree = command("tap", label="Hide keyboard")
else:
    command("tap", label="Open chat menu")
    tree = command("tap", label="Close chat menu")
assert draft not in tree, "Verification draft was not cleared"
report = {"device": udid, "family": family, "result": "passed", "steps": steps,
          "draftCleared": True, "finalOrientation": "portrait"}
(output / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
