#!/usr/bin/env python3
"""Generate config.local.json from .env.

A Chrome extension cannot read a .env file: there is no filesystem access from a
content script or service worker. So .env is a build-time source, and this script
compiles it into config.local.json, which the extension's service worker fetches
out of its own package on install.

Both .env and config.local.json are gitignored. Run this after editing .env:

    python3 scripts/apply_env.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ENV_PATH = os.path.join(ROOT, ".env")
OUT_PATH = os.path.join(ROOT, "config.local.json")

# .env key -> settings key the extension understands.
KEY_MAP = {
    "BOOKING_LINK": "bookingLink",
    "OLLAMA_ENDPOINT": "endpoint",
    "OLLAMA_MODEL": "model",
    "USER_NAME": "name",
    "USER_COMPANY": "company",
}


def parse_env(path):
    values = {}
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.strip().strip("'\"")
            if value:
                values[key.strip()] = value
    return values


def main():
    if not os.path.exists(ENV_PATH):
        print(f"No .env found at {ENV_PATH}")
        print("Copy .env.example to .env and put your own values in it.")
        sys.exit(1)

    env = parse_env(ENV_PATH)
    unknown = sorted(set(env) - set(KEY_MAP))
    config = {KEY_MAP[k]: v for k, v in env.items() if k in KEY_MAP}

    with open(OUT_PATH, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")

    print(f"Wrote {OUT_PATH}")
    for k, v in config.items():
        print(f"  {k}: {v}")
    if unknown:
        print(f"Ignored unrecognised keys: {', '.join(unknown)}")
    if not config:
        print("\n.env had no recognised values — nothing will be seeded.")
    else:
        print("\nReload the extension at chrome://extensions to apply.")
        print("These seed a setting only if you have never set it yourself.")


if __name__ == "__main__":
    main()
