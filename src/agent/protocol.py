"""WebSocket message handling between the frontend and Strands BidiAgent.

The frontend speaks the Strands bidi protocol directly. Two adjustments are
needed because the transport is JSON:
- Inbound audio carries base64 in source.bytes; BidiAgent expects raw bytes.
- Outbound events may hold values JSON can't encode (e.g. exceptions).
"""

import base64
import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


def to_agent_input(message: dict) -> Optional[dict]:
    """Convert a frontend WebSocket message into a BidiAgent.send() input.

    Accepts {"audio_delta": {"format": ..., "source": {"bytes": "<base64>"}}}
    and {"text": "..."}. Returns None for anything else.
    """
    if "audio_delta" in message:
        audio = message["audio_delta"]
        return {
            "audio_delta": {
                "format": audio.get("format", "pcm"),
                "source": {"bytes": base64.b64decode(audio["source"]["bytes"])},
            }
        }

    if "text" in message:
        return {"text": message["text"]}

    logger.debug(f"Ignoring unsupported client message: {list(message)}")
    return None


def to_client_event(event: dict) -> Optional[dict[str, Any]]:
    """Make a BidiAgent output event safe to send as JSON.

    Returns None for untyped internal events (e.g. ToolResultMessageEvent).
    """
    if "type" not in event:
        return None
    return json.loads(json.dumps(event, default=str))
