"""The research agent: read the datasheet, and only believe what it says.

Every part in a KiCad schematic can carry a datasheet URL, and on this board
five of them do - the buck, the LDO, the MCU, the Darlington array and the
crystal. This fetches those documents, caches them, pulls text out, and extracts
a small set of parameters with regexes that must actually match. Nothing is
typed in by hand and nothing is inferred: a parameter either has a line of the
datasheet behind it or it is absent.

WHY THE OUTPUT FEEDS RULES RATHER THAN PROMPTS

The obvious use is to paste a design brief into the reviewers' context. This
project has a measurement saying that is the wrong move. Offering the reviewers
one extra claim kind - `trace_undersized` - for a quantity the data did not
contain produced twelve fabricated findings on a clean board out of thirty-six,
and deleting that one word halved the noise. More context about what a part
*should* have is more surface to invent against.

So a fact earns its place here by making a *check* possible. The datasheet says
the TPS563208 wants 0.1 uF between VBST and SW; that is a question about this
netlist with a yes or no answer, and `harness/checks.py` can ask it for free and
get it right every time. Facts that cannot become a check are still recorded -
they are the honest input to a thermal or power-integrity stage, if one is ever
built on data that supports it - but they are not handed to a model to riff on.

WHAT IS DELIBERATELY NOT HERE

No thermal resistance, no junction temperature, no current budget. Those exist
in the datasheets, and the extraction below could pull them. They are left out
because the *board* carries no current, no load and no ambient, so a thermal
figure from the datasheet cannot be combined with anything to produce a real
answer. The missing half is on the board's side, not the datasheet's.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

CACHE = ROOT / ".cache" / "datasheets"
#: Marks a page boundary inside the extracted text.
_PAGE_BREAK = "\x0c<<PAGE>>"
#: Bumped when the shape of a cached fact changes, so records written by an
#: earlier extractor are re-read instead of served without provenance.
FACTS_FORMAT = "2"
TIMEOUT = 30
#: Plain urllib gets 403 from several vendor CDNs; this is the smallest header
#: set that gets a PDF back from TI and ST.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; pcb-eval/1.0; +https://github.com/PrathamMehta08/pcb-eval)",
    "Accept": "application/pdf,*/*",
}


def _key(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:20]


def fetch(url: str, *, offline: bool = False) -> bytes | None:
    """The datasheet bytes, cached on disk. None when it cannot be had.

    Cached by URL hash, so a sweep re-reads from disk and the network is touched
    once per document ever. `offline=True` never reaches for the network, which
    is what the test suite uses: no acceptance check may depend on a vendor's
    web server being up.
    """
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{_key(url)}.pdf"
    if path.exists():
        return path.read_bytes()
    if offline:
        return None
    try:
        request = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return None
    if not body.startswith(b"%PDF"):
        return None
    path.write_bytes(body)
    return body


def text_of(pdf: bytes, pages: int = 12) -> str:
    """The first `pages` pages as text. Specifications live near the front."""
    import io

    logging.getLogger("pypdf").setLevel(logging.ERROR)
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf))
    out = []
    for page in reader.pages[:pages]:
        try:
            out.append(page.extract_text() or "")
        except Exception:
            continue
    # A sentinel rather than a page number, so a page break cannot be confused
    # with a line of the document.
    return f"\n{_PAGE_BREAK}\n".join(out)


#: Each extractor is (name, pattern, reader, the evaluator it enables). A
#: parameter appears in the facts only when its pattern matches, and the line it
#: matched is kept beside it, so every number here can be traced to the page it
#: came from.
#:
#: `enables` is what makes research worth doing. A fact that no check can consume
#: is prose, and prose in a prompt is surface to invent against; a fact that
#: names its evaluator becomes a yes-or-no question about this netlist.
EXTRACTORS = (
    (
        "vin_range_v",
        re.compile(r"Supply input voltage range\s+([\d.]+)\s+([\d.]+)\s*V", re.I),
        lambda m: {"min": float(m.group(1)), "max": float(m.group(2))},
        "rail_within_input_range",
    ),
    (
        "bootstrap_cap",
        re.compile(
            r"(VBST|BOOT)\b[^\n]*?Connect\s+([\d.]+)\s*[µu]F\s+capacitor between", re.I
        ),
        lambda m: {"value_uf": float(m.group(2)), "pin": m.group(1).upper()},
        "required_external_part",
    ),
    (
        "enable_needs_pullup",
        re.compile(r"\bEN\b[^\n]*?must be pulled up", re.I),
        lambda m: True,
        None,
    ),
    (
        "output_current_a",
        re.compile(r"\b([\d.]+)\s*A\s+(?:Synchronous )?Step-Down", re.I),
        lambda m: float(m.group(1)),
        None,
    ),
    (
        "thermal",
        re.compile(
            r"(?:R\s*th\s*JA|RthJA|Theta\s*JA|Junction-to-ambient[^\n]*?)\D{0,40}?([\d.]+)\s*(?:C|\u00b0C)\s*/\s*W",
            re.I,
        ),
        lambda m: {"theta_ja_c_per_w": float(m.group(1))},
        "junction_temp",
    ),
)


def _confidence(line: str, match: re.Match, wrapped: bool) -> str:
    """How much the quote actually pins the number down.

    Datasheet thermal tables put one row across several package columns -
    "RthJA 88.6 66.7 95.2 123.1" - and a regex that takes a number from such a
    row has picked a column, not a value. The quote is real and the reading is a
    guess, which is the shape of error this project rejects everywhere else, so
    it is labelled rather than hidden: a line carrying three or more numbers
    where one was wanted is `low`, and `junction_temp` refuses to compute from
    a low-confidence thermal figure.
    """
    numbers = re.findall(r"\d+\.\d+|\d{2,}", line)
    if len(numbers) >= 3:
        return "low"
    return "medium" if wrapped else "high"


#: A heading in a datasheet: short, mostly capitals or numbered like "5.3".
_HEADING = re.compile(r"^(?:\d+(?:\.\d+)*\s+)?[A-Z][A-Za-z /()-]{4,60}$")


def _search_lines(pattern: re.Pattern, text: str):
    """Where a pattern matches: the line, its page, and the heading above it.

    Matching is scoped to one line, or a line joined with the one after it.
    Datasheet tables wrap - "Connect 0.1 uF capacitor between" ends one line and
    "VBST and SW" begins the next - and two lines is enough for that while still
    narrow enough that the quote genuinely contains the number. The first
    version of this searched the whole document flattened to one string, matched
    across unrelated paragraphs, and produced values whose quotes did not
    support them: fabricated evidence, from the component whose purpose is to
    stop that.

    Page and section come from walking the text in order, so a fact can be
    traced to a place in the document rather than merely to a sentence.
    """
    page = 1
    section = ""
    lines = text.split("\n")
    for i, raw in enumerate(lines):
        if raw == _PAGE_BREAK:
            page += 1
            continue
        line = raw.strip()
        if not line:
            continue
        if _HEADING.match(line):
            section = line
        match = pattern.search(line)
        if match:
            return match, line, page, section, False
        nxt = next((l.strip() for l in lines[i + 1 : i + 3] if l.strip() and l != _PAGE_BREAK), "")
        if nxt:
            joined = line + " " + nxt
            match = pattern.search(joined)
            if match:
                return match, joined, page, section, True
    return None


def study(part: str, url: str, *, offline: bool = False) -> dict:
    """What the datasheet says about one part, cached as JSON beside the PDF."""
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / f"{_key(url)}.json"
    if out.exists():
        cached = json.loads(out.read_text(encoding="utf-8"))
        # An older record has no page or section on its facts. Re-read rather
        # than serve provenance that was never captured.
        if cached.get("format") == FACTS_FORMAT:
            return cached

    pdf = fetch(url, offline=offline)
    if pdf is None:
        return {"part": part, "source": url, "facts": {}, "status": "unavailable"}

    text = text_of(pdf)
    facts = {}
    for name, pattern, read, enables in EXTRACTORS:
        hit = _search_lines(pattern, text)
        if hit is None:
            continue
        match, line, page, section, wrapped = hit
        facts[name] = {
            "page": page,
            "section": section,
            # About the extraction, never about the engineering: the datasheet
            # is not in doubt, the reading of it is. `high` matched inside one
            # line; `medium` needed two joined, which is where a wrapped table
            # row can pick up a neighbour's number.
            "confidence": _confidence(line, match, wrapped),
            "enables": enables,
            "value": read(match),
            # The line the number came out of. The first version searched the
            # whole document flattened to one string, which matched patterns
            # across unrelated paragraphs and produced values whose quotes did
            # not support them - the same fabricated-evidence failure this
            # project rejects findings for. A fact is worth no more than the
            # line behind it, so the match has to happen inside one.
            "quote": " ".join(line.split())[:200],
        }
    record = {
        "part": part,
        "format": FACTS_FORMAT,
        "source": url,
        "sha256": hashlib.sha256(pdf).hexdigest()[:16],
        "facts": facts,
        "status": "read",
    }
    out.write_text(json.dumps(record, indent=1), encoding="utf-8")
    return record


#: Descriptions that mark a part as active silicon worth a datasheet fetch.
SIGNIFICANT = re.compile(
    r"regulat|converter|\bMCU\b|microcontroller|driver|sensor|transceiver|"
    r"memory|flash|eeprom|\bADC\b|\bDAC\b|\bPHY\b|amplifier|comparator|"
    r"reference|oscillator|controller|switch mode|step-down|step-up|LDO",
    re.I,
)
POWER_TYPES = {"power_in", "power_out", "open_collector", "tri_state"}
PASSIVE_PREFIX = ("R", "C", "L", "FB", "TP", "H", "Y")


def _pins_of(board: dict) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for net in board["nets"]:
        for node in net["nodes"]:
            out.setdefault(node["ref"], []).append({**node, "net": net["name"]})
    return out


def triage(board: dict) -> list[dict]:
    """Which parts are worth a datasheet, and why. First rule that matches wins.

    Fetching is cheap but not free, and a datasheet for a 10k resistor buys
    nothing: the fact worth knowing about a passive is its value, which the
    netlist already carries. So research is spent on parts whose behaviour is
    not deducible from the schematic - active silicon, anything that sources or
    switches, anything bridging power domains.

    A passive is researched only when a researched part's own rules name it, and
    that happens through the converter rather than through the capacitor: the
    TPS563208's datasheet is what says a 0.1 uF part belongs between VBST and SW.
    """
    from harness.checks import is_ground, is_rail

    pins = _pins_of(board)
    out = []
    for comp in board["components"]:
        ref = comp["ref"]
        mine = pins.get(ref, [])
        rails = {
            p["net"] for p in mine if is_rail(p["net"]) and not is_ground(p["net"])
        }
        why = None
        if len(mine) >= 6:
            why = f"{len(mine)} pins"
        elif re.match(r"^(U|S|IC|Q)\d", ref):
            why = f"designator {ref[0]}"
        elif any(base_type(p.get("type", "")) in POWER_TYPES for p in mine):
            why = "carries a power or driver pin"
        elif SIGNIFICANT.search(f"{comp.get('description', '')} {comp.get('value', '')}"):
            why = "description names an active part"
        elif len(rails) > 1:
            why = f"sits on {len(rails)} distinct rails"
        if why is None:
            continue
        if ref.startswith(PASSIVE_PREFIX) and len(mine) <= 2:
            # A two-pin passive never qualifies on its own, whatever it matched.
            continue
        out.append({**comp, "why": why})
    return out


def base_type(pintype: str) -> str:
    """`bidirectional+no_connect` is still a bidirectional pin."""
    return str(pintype or "").split("+", 1)[0]


def major_parts(board: dict) -> list[dict]:
    """Triaged parts that also carry a datasheet URL to fetch."""
    return [
        c
        for c in triage(board)
        if (c.get("datasheet") or "").strip().lower().startswith("http")
    ]


def brief(board: dict, *, offline: bool = True) -> dict[str, dict]:
    """Everything the datasheets say about this board's parts, keyed by ref.

    Offline by default. A scored sweep must not depend on a vendor CDN being
    reachable, so the network is opened deliberately by whoever populates the
    cache, and every run after that reads from disk.
    """
    out = {}
    for part in major_parts(board):
        record = study(part["value"], part["datasheet"].strip(), offline=offline)
        if record.get("facts"):
            out[part["ref"]] = record
    return out


if __name__ == "__main__":
    from console import utf8

    utf8()
    board = json.loads((ROOT / "boards" / "stm32-good.json").read_text(encoding="utf-8"))
    online = "--offline" not in sys.argv
    print(f"{len(major_parts(board))} parts carry a datasheet URL")
    for part in major_parts(board):
        record = study(part["value"], part["datasheet"].strip(), offline=not online)
        status = record.get("status")
        print(f"\n{part['ref']:<4} {part['value']:<22} {status}")
        for name, fact in record.get("facts", {}).items():
            print(f"       {name} = {fact['value']}")
            print(f"         from: {fact['quote'][:96]}")
