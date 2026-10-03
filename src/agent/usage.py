"""Nova Sonic token usage tracking across connection restarts.

Nova Sonic reports usage as cumulative totals for the current connection.
Those counts reset whenever a new connection opens: on Strands' scheduled
restart (~every 7 minutes) and, in duo sessions, on every character handoff.
"""

_KEYS = {"input_tokens": "inputTokens", "output_tokens": "outputTokens", "total_tokens": "totalTokens"}


class NovaSonicUsage:
    """Accumulates session token totals from bidi output events."""

    def __init__(self) -> None:
        self._finished = dict.fromkeys(_KEYS, 0)  # connections that have ended
        self._current = dict.fromkeys(_KEYS, 0)  # cumulative totals of the open connection

    def on_event(self, event: dict) -> None:
        """Update totals from a bidi_usage or bidi_connection_restart event."""
        event_type = event.get("type")
        if event_type == "bidi_connection_restart":
            self.end_connection()
        elif event_type == "bidi_usage":
            self._current = {key: event.get(field, 0) for key, field in _KEYS.items()}

    def end_connection(self) -> None:
        """Fold the open connection's totals into the session totals."""
        for key in _KEYS:
            self._finished[key] += self._current[key]
        self._current = dict.fromkeys(_KEYS, 0)

    def totals(self) -> dict[str, int]:
        """Session totals across all connections so far."""
        return {key: self._finished[key] + self._current[key] for key in _KEYS}
