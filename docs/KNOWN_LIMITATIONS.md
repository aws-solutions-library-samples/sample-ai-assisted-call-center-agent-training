# Known Limitations

## Nova Sonic 55-Second Audio Timeout

Amazon Nova Sonic requires audio bytes or interactive content to be sent at least every **55 seconds** during a bidirectional streaming session. If no audio or content is received within that window, Nova Sonic terminates the session with a `ValidationException`:

```
ValidationException: Timed out waiting for audio bytes or interactive content.
Please ensure gaps between audio bytes and interactive content are less than 55 seconds.
```

### What this affects

- **Web UI sessions**: If a trainee stays silent or idle for over 55 seconds, the session will be disconnected.
- **Test script** (`scripts/test_scenario.py`): If Nova Sonic's response takes long enough that the next `agent.send()` call exceeds the 55-second gap, the session will fail. Scenarios with many long turns are more susceptible.
- **Amazon Connect integration**: Long hold times or extended silence during a call may trigger this timeout.

### Workarounds

- Keep conversation turns concise — shorter representative/customer exchanges reduce the risk of hitting the timeout.
- In the test script, the `--delay` flag controls the pause *between* turns but cannot prevent timeouts caused by long model response times.
- There is no client-side configuration to extend this limit; it is enforced server-side by the Nova Sonic service.

---

## Nova Sonic 8-Minute Session Limit

Nova Sonic enforces an approximately **8-minute maximum** per bidirectional stream connection. When this limit is reached, the service terminates the stream with a `ModelTimeoutException`.

### How it's handled

The Strands `BidiAgent` SDK restarts the connection **proactively**, before Nova Sonic's limit is reached:

1. `BedrockNovaSonicModel` schedules a restart **7 minutes** into each connection, leaving headroom below the limit. A `bidi_connection_warning` event is emitted about 10 seconds beforehand.
2. When the restart fires, the agent waits up to 10 seconds for the current turn to finish so the swap lands between turns rather than mid-sentence.
3. A `bidi_connection_restart` event is emitted, the old connection is closed, and a new one is opened with the conversation history replayed as text.
4. Audio sent during the swap is held until the new connection is ready rather than dropped.

If the service still terminates a connection early, the agent restarts it reactively the same way (`bidi_connection_restart` with `reason: "timeout"`).

Nova Sonic reports token usage cumulatively per connection, so the counts reset on every restart (and, in duo sessions, on every character handoff). The agent server adds each connection's totals to a running baseline, so the session's recorded `token_usage` covers all connections.

### Known gaps in the auto-restart

- **No UI indication**: The frontend receives `bidi_connection_warning` and `bidi_connection_restart` events but does not display anything; the conversation simply pauses briefly. If a restart cuts off a turn anyway (`turn_interrupted: true` on the restart event), that turn isn't answered on the new connection and the trainee has to repeat themselves.
- **Conversation history is text-only**: On restart, prior turns are replayed as text, not audio. The model loses audio context (tone, emotion, accent nuances) from before the restart.
- **History size cap**: Replayed history is capped at 50 KB per message and 200 KB total; in very long sessions the oldest turns are dropped from the model's context.

---

## Nova Sonic Region Availability

Nova Sonic (`amazon.nova-2-sonic-v1:0`) is only available in specific AWS regions (e.g., `us-west-2`, `us-east-1`, `eu-north-1`). All runtime code reads the region from environment variables (`AWS_REGION`, `AWS_DEFAULT_REGION`, or `VITE_AWS_REGION`) and falls back to `us-west-2` as a default. Deploying to another region requires setting the appropriate env vars and verifying Nova Sonic availability in that region.

---

## Nova Sonic Concurrent Connection Limit

Nova Sonic allows a maximum of **20 concurrent bidirectional stream connections per AWS account**. Each active training session — whether via the Web UI or Amazon Connect — consumes one connection.

### What this means

- With 20 trainees in simultaneous sessions, the 21st session will fail to start.
- The auto-restart (see above) closes the old connection before opening the new one, so it does not consume an extra connection.
- This is a service quota enforced by AWS and cannot be increased through configuration. Contact AWS support to request a quota increase if needed.

---

## Nova Sonic Voice and Language Constraints

Nova Sonic provides **16 voices** across **7 languages**: English, French, Italian, German, Spanish, Portuguese, and Hindi.

| Constraint | Detail |
|---|---|
| Polyglot voices (speak all supported languages) | Only `matthew` and `tiffany` |
| Hindi-capable voices | Only `kiara` and `arjun` |
| Other non-English voices | Can speak their native language or English only — no cross-language support (e.g., `ambre` speaks French or English, not Spanish) |

The full voice registry is defined in `src/voices.py`.

---

## Nova Sonic Audio Format Constraints

Nova Sonic's bidirectional stream only supports uncompressed PCM audio:

| Direction | Format | Sample Rate | Channels |
|---|---|---|---|
| Input (microphone) | PCM 16-bit | 16,000 Hz | Mono |
| Output (playback) | PCM 16-bit | 24,000 Hz | Mono |

Compressed formats (Opus, MP3, AAC, etc.) are **not supported** over the bidirectional stream. The browser must capture raw PCM from the microphone and decode PCM for playback via the Web Audio API.

---

## Amazon Connect Post-Call Processing Delay

After a training call ends on Amazon Connect, it may take up to **6 minutes** before the session appears in the Connect admin UI. This delay is caused by the EventBridge event delivery pipeline — Connect publishes contact events to EventBridge, which triggers the post-call Lambda for scoring and storage. The delay is inherent to the EventBridge integration and cannot be reduced through configuration.
