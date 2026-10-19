# Troubleshooting AI Chat on My Terms

Errors show the failed operation, available cause details, and the next step. Use **Copy error** to copy the complete message. Long chat errors scroll within the text area; the action buttons stay visible.

Server errors include the HTTP status, content type, and complete response body, including structured responses with no message field. Credentials are redacted. If reading the body fails or times out, the received content is shown with an explicit **incomplete** label and the read failure. Response bodies stay in the visible error and clipboard; they are not saved in the trace log.

## Persona and context limits

Markdown, XML, quotes, backslashes, and Unicode are valid in Persona prompts. They are sent as JSON text; you do not need to remove their formatting.

The app automatically reads the selected compatible server's active context limit. **Chat menu → Settings → Advanced model controls → Context window** shows the detected value and **From server**. The limit is checked again before each message, so restarting the same model with a different context size takes effect on the next send. Your PC's NInfer server reports `65536` (64K).

An explicit Global, Model, Persona, or This chat setting takes priority over the automatic default. Use **Reset this value** to return that scope to the inherited value. Requests remain capped at the server's reported limit. Automatic defaults belong to the exact connection and selected model; they are never saved into your shared presets.

Detection uses the server's configured `max_model_len` or a matching llama.cpp model's active `n_ctx`, rather than its nominal training window. If the server does not expose a supported limit, cannot be reached, or takes more than 3.5 seconds to respond, the automatic fallback is 4,096 tokens; set **Context window** manually to the supported server window. The input budget also reserves space for the response and, when enabled, web research.

The local NInfer change is recorded in [the server patch](../patches/ninfer-context-metadata.patch); it adds active context metadata to both model-list and model-detail responses, with schema tests and serving documentation.

If the Persona/instructions and current message cannot fit, the app shows the estimated token requirement and available input budget before contacting the server. It preserves your draft and instructions. Shorten the Persona or message, increase the context window to match your model, or lower **Maximum output tokens**, then retry. Compacting history cannot shrink the current Persona or message.

For a local OpenAI-compatible server, choose **Local server** with its `/v1` API base. The **OpenAI** connection uses an HTTPS `/responses` endpoint.

## Record a trace on your iPhone

1. Open **Settings → Troubleshooting → Trace log**, or **More tools → Trace log**.
2. Turn on **Record trace log**.
3. Return to the screen that failed and repeat the action.
4. Open Trace log and choose **Export log** to save or share `locallab-trace.json`. **Copy log** also works.
5. Turn recording off when finished. Use **Clear log** to remove stored events.

The recording preference and up to 250 recent events are saved locally and survive app restarts. The log contains operation times, server origins, HTTP status codes, durations, and error categories. It excludes API keys, request headers, URL paths and queries, chat messages, and response bodies. Trace exports are created only when you choose Export or Copy; nothing is uploaded automatically.

The browser preview keeps API keys only in tab memory. After a reload, enter the key again in Connections or Web research. The installed iPhone app uses system secure storage.
