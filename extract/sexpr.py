"""A small recursive-descent tokenizer for KiCad s-expressions.

KiCad files are s-expressions with double-quoted strings, backslash escapes and
bare atoms. Regex cannot parse them; this can, in about sixty lines.

`parse()` returns nested lists where the head of each list is the tag name as a
plain `str`, and quoted strings are wrapped in `Str` so a quoted "1" can be told
apart from the bare atom 1 (pad numbers are quoted, layer indices are not).
"""

from __future__ import annotations


class Str(str):
    """A string that was quoted in the source."""

    __slots__ = ()


_WS = " \t\r\n"


def tokenize(text: str):
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in _WS:
            i += 1
        elif c == "(":
            yield "("
            i += 1
        elif c == ")":
            yield ")"
            i += 1
        elif c == '"':
            i += 1
            out = []
            while i < n:
                c = text[i]
                if c == "\\" and i + 1 < n:
                    nxt = text[i + 1]
                    out.append({"n": "\n", "t": "\t", "r": "\r"}.get(nxt, nxt))
                    i += 2
                elif c == '"':
                    i += 1
                    break
                else:
                    out.append(c)
                    i += 1
            yield Str("".join(out))
        else:
            start = i
            while i < n and text[i] not in _WS and text[i] not in "()":
                i += 1
            yield text[start:i]


def parse(text: str) -> list:
    """Parse the whole document and return its single top-level list.

    A KiCad file is exactly one form. Anything else — two top-level forms, an
    unclosed paren, a stray close paren, an atom outside any list — is a
    malformed file, and saying so beats quietly returning whichever form
    happened to come last.
    """
    stack: list[list] = []
    root = None
    for tok in tokenize(text):
        if tok == "(":
            node: list = []
            if stack:
                stack[-1].append(node)
            stack.append(node)
        elif tok == ")":
            if not stack:
                raise ValueError("s-expression closes a list that was never opened")
            node = stack.pop()
            if not stack:
                if root is not None:
                    raise ValueError("s-expression has more than one top-level form")
                root = node
        elif stack:
            stack[-1].append(tok)
        else:
            raise ValueError(f"atom {tok!r} outside any list")
    if stack:
        raise ValueError(f"s-expression ends with {len(stack)} list(s) still open")
    if root is None:
        raise ValueError("s-expression is empty")
    return root


def tag(node) -> str:
    """The head symbol of a node, or '' for atoms and empty lists."""
    if isinstance(node, list) and node and isinstance(node[0], str) and not isinstance(node[0], Str):
        return node[0]
    return ""


def children(node, name: str):
    """Direct children of `node` whose tag is `name`."""
    if not isinstance(node, list):
        return
    for item in node[1:]:
        if tag(item) == name:
            yield item


def child(node, name: str):
    for item in children(node, name):
        return item
    return None


def value(node, name: str, index: int = 1, default=None):
    """The `index`-th payload of the first `name` child, e.g. value(pad,'size')."""
    found = child(node, name)
    if found is None or len(found) <= index:
        return default
    return found[index]


def num(x, default=0.0) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return default
