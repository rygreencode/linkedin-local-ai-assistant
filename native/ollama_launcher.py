#!/opt/homebrew/bin/python3
"""Native messaging host: lets the extension start a local Ollama server.

Chrome speaks a simple framed protocol on stdin/stdout — 4-byte little-endian
length, then that many bytes of JSON. Chrome spawns this with a minimal
environment, so binaries are located explicitly rather than trusted to PATH.

Accepted commands:
  {"cmd": "status"}  -> is the server answering on the configured port?
  {"cmd": "start"}   -> spawn `ollama serve` detached, with OLLAMA_ORIGINS set
  {"cmd": "stop"}    -> terminate a server this host started
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ORIGINS = "chrome-extension://*"
DEFAULT_ENDPOINT = "http://localhost:11434"
LOG_PATH = os.path.expanduser("~/Library/Logs/lla-ollama.log")
PID_PATH = os.path.expanduser("~/.cache/lla-ollama.pid")
SEARCH_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", os.path.expanduser("~/.local/bin")]


def trace(msg):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    except OSError:
        pass


def find_ollama():
    found = shutil.which("ollama", path=os.pathsep.join(SEARCH_PATHS + [os.environ.get("PATH", "")]))
    return found


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(payload):
    data = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def is_up(endpoint, timeout=1.0):
    try:
        with urllib.request.urlopen(f"{endpoint}/api/tags", timeout=timeout) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError):
        return False


def start(endpoint):
    if is_up(endpoint):
        return {"ok": True, "already": True, "message": "Ollama was already running."}

    binary = find_ollama()
    if not binary:
        return {
            "ok": False,
            "error": "Could not find the `ollama` binary. Install it with `brew install ollama`, "
            "or add its directory to SEARCH_PATHS in ollama_launcher.py.",
        }

    env = dict(os.environ)
    env["OLLAMA_ORIGINS"] = ORIGINS
    # Bind where the extension expects to find it, not just the default port.
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.hostname:
        env["OLLAMA_HOST"] = f"{parsed.hostname}:{parsed.port or 11434}"
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(PID_PATH), exist_ok=True)

    # start_new_session detaches the server from this host process, which exits
    # as soon as it has replied to Chrome.
    with open(LOG_PATH, "ab") as log:
        log.write(f"\n=== lla start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode())
        proc = subprocess.Popen(
            [binary, "serve"],
            env=env,
            stdout=log,
            stderr=log,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )

    with open(PID_PATH, "w") as f:
        f.write(str(proc.pid))

    # Give it a moment to bind the port so the popup can report truthfully.
    deadline = time.time() + 12
    while time.time() < deadline:
        if is_up(endpoint):
            return {"ok": True, "pid": proc.pid, "message": "Ollama started.", "log": LOG_PATH}
        if proc.poll() is not None:
            tail = ""
            try:
                with open(LOG_PATH, "r", errors="replace") as f:
                    tail = f.read()[-400:]
            except OSError:
                pass
            return {"ok": False, "error": f"ollama serve exited immediately (code {proc.returncode}). {tail}"}
        time.sleep(0.4)

    return {"ok": False, "error": f"Started ollama (pid {proc.pid}) but it did not answer within 12s. See {LOG_PATH}."}


def stop():
    try:
        with open(PID_PATH) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return {"ok": False, "error": "No server recorded as started by this extension."}
    try:
        os.kill(pid, 15)
    except ProcessLookupError:
        _forget_pid()
        return {"ok": True, "message": "Already stopped."}
    except PermissionError:
        return {"ok": False, "error": f"Not permitted to stop pid {pid}."}
    _forget_pid()
    trace(f"stopped pid {pid}")
    return {"ok": True, "message": f"Stopped pid {pid}."}


def _forget_pid():
    try:
        os.remove(PID_PATH)
    except OSError:
        pass


def main():
    trace(f"host invoked (argv={sys.argv[1:]}, cwd={os.getcwd()})")
    msg = read_message()
    trace(f"received {msg!r}")
    if msg is None:
        return
    endpoint = msg.get("endpoint") or DEFAULT_ENDPOINT
    cmd = msg.get("cmd")
    if cmd == "status":
        send_message({"ok": True, "running": is_up(endpoint), "binary": find_ollama()})
    elif cmd == "start":
        send_message(start(endpoint))
    elif cmd == "stop":
        send_message(stop())
    else:
        send_message({"ok": False, "error": f"Unknown command: {cmd!r}"})


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # never die silently; Chrome shows nothing on a crash
        trace(f"FATAL {type(exc).__name__}: {exc}")
        try:
            send_message({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        except Exception:
            pass
