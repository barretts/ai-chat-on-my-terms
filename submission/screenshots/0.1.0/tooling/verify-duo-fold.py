#!/usr/bin/env python3
"""Exercise the inspected Device Hub pose controls; never changes display power or geometry."""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

udid = sys.argv[1]
tooling = Path(__file__).resolve().parent
output = tooling.parent / "evidence" / "duo-fold"
output.mkdir(parents=True, exist_ok=True)
draft = "Fold42"
steps = []

def command(action, **arguments):
    data = json.loads(subprocess.check_output([sys.executable, str(tooling / "command.py"),
        udid, action, *[f"{key}={value}" for key, value in arguments.items()]], text=True))
    assert data["result"] == "ok", data["result"]
    return data["tree"]

def pose(label):
    # Use Device Hub's named accessibility action rather than changing display power.
    script = r'''ObjC.import('ApplicationServices'); ObjC.import('Foundation'); ObjC.import('AppKit');
const applications = $.NSWorkspace.sharedWorkspace.runningApplications;
let pid = null;
for (let i=0;i<Number(applications.count);i++) {
 const item=applications.objectAtIndex(i);
 if (ObjC.unwrap(item.bundleIdentifier)==='com.apple.dt.Devices') pid=Number(item.processIdentifier);
}
if (!pid) throw Error('Device Hub is not running');
const app=$.AXUIElementCreateApplication(pid); $.AXUIElementSetMessagingTimeout(app,1);
function attr(n,k){let r=Ref();return $.AXUIElementCopyAttributeValue(n,$(k),r)===0?r[0]:null;}
function text(v){if(!v)return '';try{return ObjC.unwrap(ObjC.castRefToObject(v));}catch(e){return '';}}
let pressed=false,count=0;
function walk(n,d){if(pressed || d>12 || count++>700)return;
 if(text(attr(n,'AXRole'))==='AXButton' && text(attr(n,'AXDescription'))===POSE_LABEL) {
  const code=$.AXUIElementPerformAction(n,$('AXPress'));if(code!==0)throw Error('AXPress failed: '+code);pressed=true;return;
 }
 const children=attr(n,'AXChildren');if(children){const a=ObjC.castRefToObject(children);for(let i=0;i<Number(a.count);i++)walk(a.objectAtIndex(i),d+1);}
}
const wins=ObjC.castRefToObject(attr(app,'AXWindows'));
for(let i=0;i<Number(wins.count);i++){const win=wins.objectAtIndex(i);if(String(text(attr(win,'AXTitle'))).includes('AI Chat Capture Duo Fresh'))walk(win,0);}
if(!pressed)throw Error('Pose control not found');'''.replace("POSE_LABEL", json.dumps(label))
    subprocess.run(["osascript", "-l", "JavaScript", "-e", script], check=True)
    time.sleep(2)

def focus_input():
    tree = command("tree")
    field = next(line for line in tree.splitlines() if "TextView," in line and "Message" in line)
    rect = re.search(r"\{\{([-\d.]+), ([-\d.]+)\}, \{([-\d.]+), ([-\d.]+)\}\}", field)
    window = re.search(r"Window \(Main\).*?\{\{.*?\}, \{([-\d.]+), ([-\d.]+)\}\}", tree)
    assert rect and window, "Missing inspected composer/window geometry"
    x, y, width, height = map(float, rect.groups())
    window_width, window_height = map(float, window.groups())
    # Refocus at the inspected current trailing edge: element hit points can be stale
    # immediately after a physical display transition in Xcode's simulator.
    command("tapPoint", x=str((x + width - 8) / window_width),
            y=str((y + height / 2) / window_height))

def inspect(name, display):
    tree = command("tree")
    assert draft in tree, f"Draft lost in {name}"
    assert "The first version is ready" in tree, f"Conversation changed in {name}"
    bounds = re.search(r"Window \(Main\).*?\{\{.*?\}, \{(.*?)\}\}", tree)
    steps.append({"pose": name, "draftRetained": True, "savedResponsePresent": True,
                  "windowSizePoints": bounds.group(1) if bounds else None, "display": display})
    subprocess.run([sys.executable, str(tooling / "capture.py"), udid, display,
                    str(output / f"{name}.png")], check=True)
    return tree

command("rotate", orientation="portrait")
focus_input()
# Tap the real keyboard delete key: synthetic control characters are unreliable
# after a Duo display transition, even while the field reports keyboard focus.
for _ in range(40):
    tree = command("tree")
    field = next(line for line in tree.splitlines() if "TextView," in line and "Message" in line)
    if "value:" not in field:
        break
    command("tap", label="delete")
else:
    raise AssertionError("Existing draft could not be cleared")
command("type", text=draft)
command("tap", label="Open chat menu")
command("tap", label="Close chat menu")
inspect("outer-before-opening", "primary")
pose("Open")
inspect("inner-open-default", "primary-1")
pose("Rotate Right")
inspect("inner-open-rotated", "primary-1")
pose("Partially Open")
inspect("half-open-rotated", "primary-1")
pose("Rotate Right")
inspect("half-open-default", "primary-1")
pose("Closed")
command("rotate", orientation="portrait")
inspect("outer-after-closing", "primary")
# Resynchronize XCTest orientation with Device Hub before keyboard cleanup.
command("rotate", orientation="landscapeLeft")
command("rotate", orientation="portrait")
focus_input()
for _ in range(len(draft)):
    command("tap", label="delete")
# Physical pose changes can leave the cached AX snapshot stale. Refresh it
# through explicit orientation events before asserting cleanup.
command("rotate", orientation="landscapeLeft")
command("rotate", orientation="portrait")
command("tap", label="Open chat menu")
tree = command("tap", label="Close chat menu")
assert draft not in tree, "Verification draft not cleared"
report = {"device": udid, "result": "passed", "steps": steps, "draftCleared": True,
          "controlMethod": "Device Hub named accessibility pose buttons; no screenConfig power/geometry mutation"}
(output / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
