"""The Groq client: a disk cache, a token budget, and a cost log.

Groq speaks the OpenAI wire format, so `openai.OpenAI` with a different
`base_url` is the whole integration. Everything else in this file exists because
the free tier throttles hard and the account has a two dollar ceiling:

- **Disk cache keyed on (model, prompt).** A re-run of the same sweep costs
  nothing, which matters because most of development is re-running the sweep.
- **A token budget per minute**, default 8000, with a matching concurrency of
  two. Both are overridable from the runner.
- **A JSONL log of every call**: tokens in, tokens out, dollars, latency. A
  score you cannot cost is a score you cannot repeat.
- **The prompt and the model's own reasoning, kept with the answer.** A review
  you cannot read the thinking behind is a review you have to take on trust.

One thing the model itself forces. `openai/gpt-oss-120b` is a reasoning model:
the response carries `reasoning` before `content`, and a tight `max_tokens`
spends the whole budget thinking and returns empty `content`. So the floor is
2000 completion tokens and the answer is read from `content`, never from
`reasoning` — which is kept alongside it, because on a review tool the argument
matters as much as the verdict.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".cache" / "llm"
LOG_PATH = ROOT / "results" / "calls.jsonl"

#: Groq's published price for openai/gpt-oss-120b, dollars per million tokens.
PRICE_IN = 0.15
PRICE_OUT = 0.60

MIN_COMPLETION_TOKENS = 2000


def load_env(path: Path = ROOT / ".env") -> None:
    """Read .env without a dependency, and never overwrite a real environment."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


@dataclass
class Usage:
    calls: int = 0
    cached: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    seconds: float = 0.0

    @property
    def dollars(self) -> float:
        return (self.tokens_in * PRICE_IN + self.tokens_out * PRICE_OUT) / 1_000_000

    def as_dict(self) -> dict:
        return {
            "calls": self.calls,
            "cached": self.cached,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "dollars": round(self.dollars, 5),
            "seconds": round(self.seconds, 1),
        }


class TokenBudget:
    """A rolling one-minute token allowance, shared across threads."""

    def __init__(self, tokens_per_minute: int) -> None:
        self.limit = tokens_per_minute
        self._spent: list[tuple[float, int]] = []
        self._lock = threading.Lock()

    def take(self, tokens: int) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                self._spent = [(t, n) for t, n in self._spent if now - t < 60]
                used = sum(n for _, n in self._spent)
                if used + tokens <= self.limit or not self._spent:
                    self._spent.append((now, tokens))
                    return
                wait = 60 - (now - self._spent[0][0]) + 0.1
            time.sleep(max(0.1, wait))


@dataclass
class Client:
    model: str = ""
    temperature: float = 0.0
    max_tokens: int = 4000
    concurrency: int = 2
    tpm: int = 8000
    #: Which repeat of the sweep this is. Folded into the cache key so trial 2
    #: asks the model again rather than replaying trial 1 — without it, running
    #: the sweep five times measures the cache and reports zero variance.
    #: Trial 0 keeps the pre-trials key, so the published run still replays.
    trial: int = 0
    cache_dir: Path = CACHE_DIR
    log_path: Path = LOG_PATH
    usage: Usage = field(default_factory=Usage)

    def __post_init__(self) -> None:
        load_env()
        self.model = self.model or os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
        self.max_tokens = max(self.max_tokens, MIN_COMPLETION_TOKENS)
        self._budget = TokenBudget(self.tpm)
        self._gate = threading.Semaphore(self.concurrency)
        self._lock = threading.Lock()
        self._client = None

    # ------------------------------------------------------------------ setup

    @property
    def api(self):
        if self._client is None:
            from openai import OpenAI

            key = os.environ.get("GROQ_API_KEY", "")
            if not key:
                raise RuntimeError(
                    "GROQ_API_KEY is not set. Copy .env.example to .env and fill it in. "
                    "Steps 1 to 11 of the build order need no key at all."
                )
            self._client = OpenAI(
                api_key=key,
                base_url=os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
                max_retries=3,
            )
        return self._client

    # ------------------------------------------------------------------ cache

    #: Bumped when the stored payload gains a field, so old entries miss rather
    #: than replay without it. v2 added `reasoning`, `prompt` and `system`.
    CACHE_FORMAT = "v2"

    def cache_key(self, prompt: str, label: str) -> str:
        blob = (
            f"{self.CACHE_FORMAT}\n{self.model}\n{self.temperature}\n"
            f"{self.max_tokens}\n{label}\n{prompt}"
        )
        if self.trial:
            blob = f"trial{self.trial}\n{blob}"
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:24]

    def _cached(self, key: str) -> dict | None:
        path = self.cache_dir / f"{key}.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None

    def _store(self, key: str, payload: dict) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        (self.cache_dir / f"{key}.json").write_text(
            json.dumps(payload, indent=1), encoding="utf-8"
        )

    # ------------------------------------------------------------------- call

    def complete(self, prompt: str, label: str = "", system: str = "") -> dict:
        """Return {"text", "cached", "tokens_in", "tokens_out", "seconds"}."""
        key = self.cache_key(prompt + "\n\n" + system, label)
        hit = self._cached(key)
        if hit is not None:
            with self._lock:
                self.usage.calls += 1
                self.usage.cached += 1
            return {**hit, "cached": True}

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        # A rough estimate is enough for the budget; the real count comes back
        # in the response and the next caller sees it in the rolling window.
        self._budget.take(len(prompt) // 4 + self.max_tokens // 4)
        started = time.monotonic()
        with self._gate:
            response = self.api.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
            )
        elapsed = time.monotonic() - started

        choice = response.choices[0].message
        # The answer is `content`. `reasoning` is the model thinking out loud
        # before it — kept because it is worth reading, never used as the answer.
        text = (choice.content or "").strip()
        payload = {
            "text": text,
            "reasoning": (getattr(choice, "reasoning", None) or "").strip(),
            "prompt": prompt,
            "system": system,
            "tokens_in": response.usage.prompt_tokens if response.usage else 0,
            "tokens_out": response.usage.completion_tokens if response.usage else 0,
            "seconds": round(elapsed, 2),
            "model": self.model,
            "label": label,
        }
        if text:
            self._store(key, payload)  # an empty answer is a failure, not a result

        with self._lock:
            self.usage.calls += 1
            self.usage.tokens_in += payload["tokens_in"]
            self.usage.tokens_out += payload["tokens_out"]
            self.usage.seconds += elapsed
            # Inside the lock: two threads appending to the same file can
            # interleave a line, and a cost log with a torn row is worse than
            # none because it looks fine.
            self._log(payload)
        return {**payload, "cached": False}

    def json(self, prompt: str, label: str = "", system: str = "") -> tuple[dict, dict]:
        """A completion parsed as JSON. Returns (parsed, call info)."""
        info = self.complete(prompt, label=label, system=system)
        return parse_json(info["text"]), info

    # -------------------------------------------------------------------- log

    def _log(self, payload: dict) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            **{k: payload[k] for k in ("model", "label", "tokens_in", "tokens_out", "seconds")},
            "dollars": round(
                (payload["tokens_in"] * PRICE_IN + payload["tokens_out"] * PRICE_OUT) / 1e6, 6
            ),
            "chars_out": len(payload["text"]),
        }
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row) + "\n")


_FENCE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.I)


def parse_json(text: str) -> dict:
    """Pull a JSON object out of a reply that may be wrapped in prose or a fence."""
    if not text:
        return {}
    fenced = _FENCE.search(text)
    candidate = fenced.group(1) if fenced else text
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(candidate[start : end + 1])
        except json.JSONDecodeError:
            return {}
    return {}


if __name__ == "__main__":
    import sys

    sys.path.insert(0, str(ROOT))
    from console import utf8

    utf8()
    client = Client()
    reply = client.complete(
        "Reply with the single word: ready.", label="smoke"
    )
    print(f"model {client.model}")
    print(f"reply {reply['text'][:80]!r}")
    print(f"usage {client.usage.as_dict()}")
