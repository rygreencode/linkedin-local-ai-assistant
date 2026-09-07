#!/usr/bin/env python3
"""Flag bare function calls with no definition anywhere in the extension.

`node --check` only validates syntax, so a call to a function that was deleted
passes cleanly and fails at runtime instead. Content scripts share one global
scope, so definitions are pooled across all of src/ before checking.

    python3 scripts/check_refs.py
"""
import os
import re
import sys

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")

# Anything resolved by the platform rather than by our own code.
KNOWN = {
    # language
    "Array","Boolean","Date","Error","Function","JSON","Map","Math","Number","Object",
    "Promise","RegExp","Set","String","Symbol","URL","WeakMap","parseInt","parseFloat",
    "isNaN","encodeURIComponent","decodeURIComponent","structuredClone",
    # browser
    "document","window","fetch","setTimeout","clearTimeout","setInterval","clearInterval",
    "requestAnimationFrame","cancelAnimationFrame","alert","confirm","getComputedStyle",
    "MutationObserver","InputEvent","KeyboardEvent","Event","CustomEvent","DOMParser",
    "AbortController","AbortSignal","CSS","importScripts","checkVisibility",
    # ours, by convention
    "chrome","globalThis","LLA","catch","if","for","while","switch","function","return",
    "typeof","new","await","super","this","async","of","in","do","else","try",
}


def strip_noise(text):
    """Blank out comments and string literals with a single left-to-right scan.

    Regex passes cannot do this: stripping // comments first eats the tail of any
    line containing a URL inside a template literal — including its closing
    backtick — after which the unterminated template swallows whatever follows.
    """
    out = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if ch == "/" and nxt == "/":
            while i < n and text[i] != "\n":
                i += 1
        elif ch == "/" and nxt == "*":
            i += 2
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                i += 1
            i += 2
        elif ch in "\"'`":
            quote = ch
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == quote:
                    i += 1
                    break
                if quote != "`" and text[i] == "\n":
                    break  # unterminated single-line string; do not run away
                i += 1
            out.append(" ")
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def bound_names(text):
    """Parameters and destructured bindings — locally defined, not dangling."""
    names = set()
    for params in re.findall(r"function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)", text):
        names.update(re.findall(r"[A-Za-z_$][\w$]*", params))
    for params in re.findall(r"\(([^()]*)\)\s*=>", text):
        names.update(re.findall(r"[A-Za-z_$][\w$]*", params))
    names.update(re.findall(r"catch\s*\(\s*([A-Za-z_$][\w$]*)", text))
    names.update(re.findall(r"\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)", text))
    return names

DECL = [
    re.compile(r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\("),
    re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()"),
    re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*=>"),
]
CALL = re.compile(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(")


def main():
    files = sorted(f for f in os.listdir(SRC) if f.endswith(".js"))
    sources = {f: open(os.path.join(SRC, f)).read() for f in files}

    defined = set()
    for text in sources.values():
        clean = strip_noise(text)
        for pattern in DECL:
            defined.update(pattern.findall(clean))
        defined.update(bound_names(clean))
        defined.update(re.findall(r"\b([A-Za-z_$][\w$]*)\s*=>", clean))

    problems = []
    for name, text in sources.items():
        for call in set(CALL.findall(strip_noise(text))):
            if call in defined or call in KNOWN or call[0].isupper():
                continue
            problems.append((name, call))

    if problems:
        print("Calls with no definition found:")
        for f, c in sorted(problems):
            print(f"  {f}: {c}()")
        sys.exit(1)
    print(f"OK — {len(files)} files, {len(defined)} definitions, no dangling calls.")


if __name__ == "__main__":
    main()
