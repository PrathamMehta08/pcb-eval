"""UTF-8 stdout, because the KiCad Python on Windows defaults to cp1252.

Edit labels carry arrows (`→`) and degree signs, which the console then refuses
to print, turning a passing run into a traceback about codecs. Every entry point
calls `utf8()` first.
"""

from __future__ import annotations

import sys


def utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
