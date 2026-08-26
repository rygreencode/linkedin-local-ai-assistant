#!/usr/bin/env python3
"""Register the Ollama launcher with Chrome as a native messaging host.

Run once after loading the extension:

    python3 native/install_host.py

An unpacked extension's ID is derived from its absolute folder path, so this
script computes it rather than asking you to copy it. Pass an ID explicitly if
you ever publish or pin one:

    python3 native/install_host.py <extension-id>

Re-run this if you move the extension folder — the ID changes with the path.
"""
import hashlib
import json
import os
import shutil
import sys

HOST_NAME = "com.ryangreen.ollama_launcher"
HERE = os.path.dirname(os.path.abspath(__file__))
EXT_DIR = os.path.dirname(HERE)
SOURCE_SCRIPT = os.path.join(HERE, "ollama_launcher.py")

# Chrome cannot exec a host script out of ~/Downloads, ~/Desktop or ~/Documents:
# those are TCC-protected, the exec fails, and Chrome reports only "Native host
# has exited". Install a copy somewhere unprotected and point the manifest there.
INSTALL_DIR = os.path.expanduser("~/Library/Application Support/LinkedInAIAssistant")
HOST_SCRIPT = os.path.join(INSTALL_DIR, "ollama_launcher.py")

TARGET_DIRS = [
    "~/Library/Application Support/Google/Chrome/NativeMessagingHosts",
    "~/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts",
    "~/Library/Application Support/Chromium/NativeMessagingHosts",
    "~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
]


def unpacked_extension_id(path):
    """Chrome derives an unpacked extension's ID from the SHA-256 of its path:
    the first 16 bytes, each nibble mapped onto a-p."""
    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def install_script():
    """Copy the host out of the extension folder and pin the interpreter.

    Chrome spawns the host with a minimal PATH, so `/usr/bin/env python3` may
    miss a Homebrew interpreter; write the resolved path into the shebang."""
    python = shutil.which("python3") or sys.executable
    os.makedirs(INSTALL_DIR, exist_ok=True)
    with open(SOURCE_SCRIPT) as f:
        lines = f.readlines()
    lines[0] = f"#!{python}\n"
    with open(HOST_SCRIPT, "w") as f:
        f.writelines(lines)
    os.chmod(HOST_SCRIPT, 0o755)
    return python


def main():
    ext_id = sys.argv[1] if len(sys.argv) > 1 else unpacked_extension_id(EXT_DIR)
    python = install_script()

    manifest = {
        "name": HOST_NAME,
        "description": "Starts a local Ollama server for the LinkedIn AI Assistant",
        "path": HOST_SCRIPT,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"],
    }

    written = []
    for d in TARGET_DIRS:
        parent = os.path.expanduser(os.path.dirname(d.replace("/NativeMessagingHosts", "")))
        if not os.path.isdir(parent):
            continue
        target_dir = os.path.expanduser(d)
        os.makedirs(target_dir, exist_ok=True)
        target = os.path.join(target_dir, f"{HOST_NAME}.json")
        with open(target, "w") as f:
            json.dump(manifest, f, indent=2)
        written.append(target)

    print(f"Extension folder : {EXT_DIR}")
    print(f"Extension ID     : {ext_id}")
    print(f"Interpreter      : {python}")
    print(f"Host script      : {HOST_SCRIPT}")
    print(f"  (copied from   : {SOURCE_SCRIPT})")
    if written:
        print("Registered with  :")
        for w in written:
            print(f"  {w}")
        print("\nDone. Reload the extension at chrome://extensions, then open the popup.")
        print(f"Verify the ID above matches the one Chrome shows. If not, re-run:")
        print(f"  python3 {os.path.relpath(__file__, os.getcwd())} <id-from-chrome>")
    else:
        print("\nNo Chrome profile directory found — nothing registered.")
        sys.exit(1)


if __name__ == "__main__":
    main()
