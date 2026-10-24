#!/usr/bin/env python3
"""Capture the agreed six real native screens after fixture import; no app state injection."""
import json
import re
import subprocess
import sys
from pathlib import Path

udid, family = sys.argv[1:]
tooling = Path(__file__).resolve().parent
root = tooling.parent
phone = family != "ipad"
output = root / "en-US" / family

def command(action, **arguments):
    result = json.loads(subprocess.check_output([sys.executable, str(tooling / "command.py"),
        udid, action, *[f"{key}={value}" for key, value in arguments.items()]], text=True))
    assert result["result"] == "ok", result["result"]
    return result["tree"]

def wait_for(text):
    for _ in range(6):
        tree = command("tree")
        if text in tree:
            return tree
    raise AssertionError(f"Native screen never showed {text}")

def navigate(label):
    tree = command("tree")
    if phone:
        command("tap", label="Open chat menu")
    elif "label: 'Show all controls'" in tree:
        command("tap", label="Show all controls")
    return command("tap", label=label)

def capture(name):
    subprocess.run([sys.executable, str(tooling / "capture.py"), udid, "primary",
                    str(output / f"{name}.png")], check=True)

def focus():
    if not phone:
        tree = command("tree")
        if "label: 'Focus conversation'" in tree:
            command("tap", label="Focus conversation")

def frame_y(tree, label, role="Button"):
    pattern = rf"{role},[^\n]*?\{{\{{[-\d.]+, ([-\d.]+)\}},[^\n]*?label: '{re.escape(label)}'"
    result = re.search(pattern, tree)
    assert result, f"Missing {label} in accessibility tree"
    return float(result.group(1))

def height(tree):
    result = re.search(r"Window \(Main\).*?\{\{.*?\}, \{[-\d.]+, ([-\d.]+)\}\}", tree)
    assert result, "Missing native window geometry"
    return float(result.group(1))

subprocess.run(["xcrun", "simctl", "ui", udid, "appearance", "light"], check=True)
tree = command("tree")
if "advanced-composer-input" not in tree:
    if "label: 'Return to conversation'" in tree:
        command("tap", label="Return to conversation")
    else:
        command("tap", label="Back to chat" if "label: 'Back to chat'" in tree else "Open chat")
wait_for("advanced-composer-input")
navigate("Library")
command("tap", label="Open Weekend in Kyoto")
wait_for("A weekend at your own pace")
if phone:
    command("swipeDown")
focus()
capture("01-conversation")
if phone:
    navigate("Models")
else:
    tree = command("tree")
    if "label: 'Show all controls'" in tree:
        command("tap", label="Show all controls")
    command("tap", label="Open models")
wait_for("Phone models")
capture("02-models")
command("tap", label="Back to chat" if phone else "Open chat")
navigate("Connections")
wait_for("Provider connection editor")
capture("03-connections")
navigate("Library")
wait_for("Open Learn something new")
if family == "duo-outer":
    command("drag", fromY="0.8", toY="0.60")
capture("04-conversations")
navigate("Settings")
if phone:
    for _ in range(8):
        tree = command("tree")
        y = frame_y(tree, "Response settings")
        h = height(tree)
        if 100 < y < h - 140:
            break
        if -h < y < 2 * h:
            shift = (h * 0.3 - y) / h
            command("drag", fromY="0.6", toY=str(max(0.2, min(0.85, 0.6 + shift))))
        else:
            command("swipeUp" if y > h - 140 else "swipeDown")
    else:
        raise AssertionError("Response settings could not be reached")
    command("tap", label="Response settings")
    label, role, fraction = "Response settings", "Button", 0.23
else:
    label, role, fraction = "Temperature", "StaticText", 0.24
    for _ in range(8):
        tree = command("tree")
        y, h = frame_y(tree, label, role), height(tree)
        if 310 < y < h - 160:
            break
        command("swipeUp" if y > h - 160 else "swipeDown")
    else:
        raise AssertionError("Temperature control could not be reached")
for _ in range(3):
    tree = command("tree")
    y, h = frame_y(tree, label, role), height(tree)
    difference = h * fraction - y
    if abs(difference) < 18:
        break
    command("drag", fromY="0.6", toY=str(max(0.2, min(0.85, 0.6 + difference / h))))
wait_for("Maximum output tokens" if phone else "Temperature")
if phone and "Keyboard," in command("tree"):
    command("tap", label="Open chat menu")
    command("tap", label="Close chat menu")
capture("05-controls")
navigate("Library")
command("tap", label="Open A clearer project update")
wait_for("The first version is ready")
focus()
subprocess.run(["xcrun", "simctl", "ui", udid, "appearance", "dark"], check=True)
command("tree")
if phone:
    command("swipeDown")
capture("06-dark-conversation")
subprocess.run(["xcrun", "simctl", "ui", udid, "appearance", "light"], check=True)
print(f"Completed six native captures for {family}")
