"""Run inside the locked slot. Xcode's command line tools supply Python 3."""
import base64
import contextlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import select
import signal
import subprocess
import sys
import tempfile
import time
from xml.etree import ElementTree


def output(*args):
    return subprocess.check_output(args, text=True, timeout=60).strip()


class Bridge:
    def __init__(self, process):
        self.process = process
        self.sequence = 0
        self.buffer = b""

    def send(self, message):
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", **message}) + "\n").encode())

    def request(self, method, params, timeout=60):
        self.sequence += 1
        self.send(dict(id=self.sequence, method=method, params=params))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b"\n" not in self.buffer:
                if not select.select([self.process.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                    break
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError("Xcode MCP bridge closed its connection")
                self.buffer += chunk
                continue
            line, self.buffer = self.buffer.split(b"\n", 1)
            message = json.loads(line)
            if "method" in message or message.get("id") != self.sequence:
                continue
            if "error" in message:
                raise RuntimeError(message["error"])
            return message["result"]
        raise TimeoutError("Xcode MCP timed out during " + str(params.get("name", method)))

    def call(self, name, args, timeout=60):
        result = self.request("tools/call", dict(name=name, arguments=args), timeout)
        if result.get("isError"):
            raise RuntimeError(result.get("content"))
        return result["structuredContent"] if "structuredContent" in result else json.loads(result["content"][0]["text"])


def workspace_settings_path(project):
    workspace = project / "project.xcworkspace" if project.suffix == ".xcodeproj" else project
    user = pwd.getpwuid(os.getuid()).pw_name
    path = workspace / "xcuserdata" / (user + ".xcuserdatad") / "WorkspaceSettings.xcsettings"
    if not path.resolve().is_relative_to(project) or path.is_symlink():
        raise ValueError("Workspace settings must be inside the slot project")
    return path


def replace(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        file.write(content)
        os.fchmod(file.fileno(), mode)
    os.replace(file.name, path)


def remember(marker, record):
    replace(marker, json.dumps(record).encode())


@contextlib.contextmanager
def connect(developer):
    service = developer / "Library/Xcode/Agents/Xcode Service.app/Contents/MacOS/Xcode Service"
    processes = [line.strip().split(None, 1) for line in output("ps", "-axo", "pid=,comm=").splitlines()]
    ids = [row[0] for row in processes if len(row) == 2 and row[1] == str(service)]
    if len(ids) != 1:
        raise RuntimeError("Could not identify the headless Xcode Service for " + str(developer))
    proc = subprocess.Popen(["xcrun", "mcpbridge"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0,
                            env={**os.environ, "DEVELOPER_DIR": str(developer), "MCP_XCODE_PID": ids[0]},
                            start_new_session=True)
    try:
        bridge = Bridge(proc)
        bridge.request("initialize", dict(protocolVersion="2025-03-26", capabilities={},
                                          clientInfo=dict(name="xcslot", version="1")))
        bridge.send(dict(method="notifications/initialized"))
        yield bridge
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def open_workspace(bridge, project):
    opened = bridge.call("XcodeOpenWorkspace", dict(path=str(project)))
    if Path(opened["workspacePath"]).resolve() != project:
        raise RuntimeError("Xcode opened a different workspace")
    return opened


build_started = False

def run_build(bridge, opened, scheme, destination):
    global build_started
    target = dict(workspaceIdentifier=opened["workspaceIdentifier"])
    if opened.get("activeScheme") != scheme:
        selected = bridge.call("XcodeSwitchScheme", {**target, "schemeName": scheme})
        if selected.get("activeSchemeName") != scheme:
            raise ValueError("Xcode did not select scheme " + scheme)
    choices = bridge.call("XcodeListRunDestinations", target)["destinations"]
    if destination is None:
        matches = [d for d in choices if d["isGenericDevice"] and
                   d["platformIdentifier"] == "com.apple.platform.iphonesimulator"]
    else:
        matches = [d for d in choices if d["displayTitle"] == destination]
    if len(matches) != 1:
        raise ValueError("Select a unique destination: " + ", ".join(d["displayTitle"] for d in choices))
    if not matches[0].get("isActive"):
        title = matches[0]["displayTitle"]
        chosen = bridge.call("XcodeSwitchRunDestination", {**target, "displayTitle": title})
        if chosen.get("activeDestinationDisplayTitle") != title:
            raise ValueError("Xcode did not select destination " + title)
    build_started = True
    result = bridge.call("BuildProject", target, timeout=3600)
    print(result["buildResult"])
    for error in result["errors"]:
        print(f"{error.get('filePath', '')}:{error.get('lineNumber', '')}: error: {error['message']}")
    if result.get("fullLogPath"):
        print("Build log: " + result["fullLogPath"])
    return 0 if result["buildResult"] == "The project built successfully." and not result["errors"] else 65


def status(developer):
    return json.loads(subprocess.check_output(["xcrun", "mcp-server", "status", "--format", "json"],
                      env={**os.environ, "DEVELOPER_DIR": str(developer)}, timeout=60))


def close_workspace(slot, marker):
    record = json.loads(marker.read_text())
    project = Path(record["project"]).resolve()
    if not project.is_relative_to(slot):
        raise ValueError("Workspace does not belong to the slot")
    developer = Path(record["launcher"]).parents[2]
    state = status(developer)
    if state.get("running"):
        # An unresponsive service can omit openWorkspaces. Leave its slot intact on that error.
        if any(Path(w["path"]).resolve() == project for w in state["openWorkspaces"]):
            with connect(developer) as bridge:
                opened = open_workspace(bridge, project)
                bridge.call("XcodeCloseWorkspace", dict(workspaceIdentifier=opened["workspaceIdentifier"]))
            # The tool can acknowledge closing before the workspace registry has removed it.
            deadline = time.monotonic() + 5
            while True:
                current = status(developer)
                if not current.get("running") or not any(Path(w["path"]).resolve() == project for w in current["openWorkspaces"]):
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("Xcode did not close the slot workspace")
                time.sleep(0.05)
    if project.exists():
        settings = workspace_settings_path(project)
        if record["original"] is None:
            settings.unlink(missing_ok=True)
        else:
            replace(settings, base64.b64decode(record["original"]), record["mode"])
    marker.unlink()


def main():
    if sys.argv[1] == "--close":
        slot = Path(sys.argv[2]).resolve()
        close_workspace(slot, slot.parent / "headless-session.json")
        return 0
    slot = Path(os.environ["XCSLOT_SLOT_DIR"]).resolve()
    marker = slot.parent / "headless-session.json"
    project = Path(sys.argv[1]).resolve(strict=True)
    if not project.is_relative_to(slot) or project.suffix not in (".xcodeproj", ".xcworkspace"):
        raise ValueError("Choose an .xcodeproj or .xcworkspace inside the mirrored checkout")
    data = os.environ["XCSLOT_DERIVED_DATA"]
    launcher = output("xcrun", "--find", "mcp-server")
    developer = Path(launcher).parents[2]
    if marker.exists():
        record = json.loads(marker.read_text())
        if (record["project"], record["data"], record["launcher"]) != (str(project), data, launcher):
            raise ValueError("The slot's previous workspace must be closed first")
    else:
        # A malformed project can leave the headless service waiting on an invisible alert.
        if project.suffix == ".xcodeproj":
            output("xcrun", "xcodeproj", "target", "list", "--project", str(project))
        elif ElementTree.parse(project / "contents.xcworkspacedata").getroot().tag != "Workspace":
            raise ValueError("Invalid Xcode workspace document")
        settings = workspace_settings_path(project)
        original = settings.read_bytes() if settings.exists() else None
        record = dict(project=str(project), data=data, launcher=launcher, ready=False,
                      original=base64.b64encode(original).decode() if original is not None else None,
                      mode=settings.stat().st_mode & 0o777 if original is not None else 0o600)
        values = plistlib.loads(original) if original is not None else {}
        values.update(DerivedDataLocationStyle="AbsolutePath", DerivedDataCustomLocation=data)
        remember(marker, record)
        replace(settings, plistlib.dumps(values), record["mode"])
    record["ready"] = False
    remember(marker, record)
    try:
        state = status(developer)
        if not state.get("permission", {}).get("enabled"):
            raise RuntimeError("Enable Apple's headless Xcode service before running mcp-build")
        if not state.get("running"):
            output("xcrun", "mcp-server", "open", "--format", "json", str(project))
        with connect(developer) as bridge:
            opened = open_workspace(bridge, project)
            required = {"BuildProject", "XcodeOpenWorkspace", "XcodeCloseWorkspace",
                        "XcodeSwitchScheme", "XcodeListRunDestinations", "XcodeSwitchRunDestination"}
            provided = {tool["name"] for tool in bridge.request("tools/list", {})["tools"]}
            if not required.issubset(provided):
                raise RuntimeError("Xcode MCP is missing required headless build tools")
            code = run_build(bridge, opened, sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
        if code == 0 and os.environ.get("XCSLOT_MCP_KEEP_OPEN") == "1":
            record["ready"] = True
            remember(marker, record)
        return code
    finally:
        if not record["ready"]:
            close_workspace(slot, marker)


def interrupt(signum, frame):
    raise SystemExit(128 + signum)


for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(sig, interrupt)
try:
    sys.exit(main())
except (OSError, ValueError, RuntimeError, KeyError, ElementTree.ParseError, subprocess.SubprocessError) as error:
    print("xcslot: headless Xcode: " + str(error), file=sys.stderr)
    # Only a failure before the build action was sent can trigger a different runner.
    sys.exit(79 if build_started else 78)
