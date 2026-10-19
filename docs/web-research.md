# Web search and page fetching

Explicit requests now work with both switches off. Examples:

- `What changed in Expo? (check web)` searches for the question and reads result pages.
- `Check the web` after a substantive question researches that previous question.
- `Read https://docs.expo.dev/` reads the page without a search request.

The original user message remains unchanged in the model request. Search uses a cleaned, bounded query. Negated/offline requests, quoted examples and code do not automatically activate research. The composer also has two optional switches, both off by default:

- **Web search** searches the selected service using the current message, then reads the first two result pages using Jina Reader. The model receives up to five sources, using actual page excerpts where reading succeeds and search snippets for the other results.
- **Read linked pages** reads up to two public links from the current message using Jina Reader, even when search is off. Explicit links take precedence over automatically selected search-result pages. Some desktop layouts call this **Fetch pages**.

Ask directly, or turn on the desired switches and send. Source links appear in the assistant response and survive reopening the conversation. Stop cancels research as well as generation. Settings apply to the current conversation session and reset when the screen is recreated; they are not a global permission to browse.

Research runs before generation and works with local models that do not support function calls. It does not install a browser, run JavaScript from a page, access signed-in pages, or give the model autonomous browsing. Results are bounded excerpts. Model answers can still be wrong; the source links allow checking the evidence.

## Services and privacy

Public search sends only the current question (or the previous substantive user question for a bare follow-up), cleaned and limited to 500 characters to DuckDuckGo's HTML search. If HTML returns verification, an unreadable format, or a service/network error, it tries DuckDuckGo Lite within the same 20-second deadline. These are the two [official non-JavaScript search versions](https://safe.duckduckgo.com/duckduckgo-help-pages/features/non-javascript). An empty result or rate limit is not retried. Page fetching sends public links to [Jina Reader](https://jina.ai/reader/) and requests its documented JSON format so the app can check the original page's status as well as Reader's HTTP status. Neither path uses a model provider API key. The rest of the conversation, saved provider credentials, and attachment bytes are not sent to these services. Search and fetching require internet, even when inference happens on the iPhone or a local PC.

Public search and page reading need no API key. DuckDuckGo can request browser verification, and either public service can impose rate limits or refuse a page. Those failures are shown in chat. If a search result cannot be read, the model can still use its search snippet; the tool result explains the failed read. A failed direct link does not discard other successful pages. A failed search does not prevent reading explicit links. The model receives a limitation notice and each source is labeled as a search snippet or an actual page excerpt. If every retrieval fails, there are no results, or only titles without snippets are available, generation stops with a recoverable message rather than claiming web evidence was found. Known browser challenges, sign-in/security gates, and Reader's original-page error status are not accepted as evidence.

## Optional supported search API

**Web search settings** offers **Public search · DuckDuckGo**, **Brave Search API** and **SearXNG server**. Public search remains the default. Brave uses its [official Web Search endpoint](https://api-dashboard.search.brave.com/api-reference/web/search/get), retrieving up to five public results with description and extra snippets. It requires your own key and an active Search plan. Searches and the explicit **Test search** action use that plan's request allowance. No Brave request runs just from opening or saving settings. **SearXNG server** points at a self-hosted or otherwise trusted [SearXNG](https://docs.searxng.org/) instance: you enter its server address, and queries plus an optional access key go only to that server. An access key, when set, is stored through SecretStore bound to the instance's own origin.

The key is stored through the app's existing SecretStore, bound to `https://api.search.brave.com` and the [documented X-Subscription-Token header](https://api-dashboard.search.brave.com/documentation/guides/authentication). SQLite stores only the chosen provider and an opaque `sec_…` reference. Keys are masked and are never placed in model prompts, tool results, source metadata, or URLs. The browser keeps key material in the current tab's memory, so reloading requires entering it again; the iPhone uses system secure storage. Replacing a key writes the new secure value before changing the preference and cleans up an uncommitted value if SQLite saving fails. **Remove key** also switches the preference back to Public search.

The local preview uses a separate `/_locallab/search-api` relay. It accepts only local same-origin GET requests with the preview header, one bounded question, and the isolated search token. Its sole upstream is the fixed Brave Web Search endpoint. It drops cookies, model-provider keys and arbitrary incoming headers. Native requests use a separate Expo transport with the same fixed destination and header isolation. Brave failures are shown directly; the app does not silently send a Brave query to a different search company. Page reads continue through credential-free Jina Reader regardless of the selected search provider.

## Platform behavior

- Native iPhone/Android uses `expo/fetch` to contact the two HTTPS services, with cookies omitted. Its transport forwards only a fixed Accept header and the cancellation signal; provider keys, custom headers, and cookies are discarded.
- The Windows web preview uses `/_locallab/web` to avoid browser CORS restrictions. The relay accepts only local same-origin requests with the preview header and only the fixed DuckDuckGo/Jina destinations. It drops all incoming credentials and refuses private addresses, credential-bearing links, custom ports, and arbitrary proxy destinations.
- A separately hosted static web build needs a compatible server-side relay for sites that deny browser CORS. The local preview relay is development middleware, not a hosted backend.

Requests have a 20-second timeout through body reading, a 1 MiB response limit, and a maximum of two page fetches. The HTML/Lite search attempts share one deadline. Page excerpts are limited to 12,000 characters before being shortened further to the reserved context allowance. Context allocation prefers page excerpts and preserves complete citation URLs plus actual evidence. If the allowance cannot fit even one source, the user is asked to increase the context limit or disable web access. Web pages are explicitly marked as untrusted data in the prompt. Sources are recorded as retrieval succeeds, so cancellation or a later failure does not erase previously retrieved metadata. Research events and source metadata are stored with the response, using existing tool/source transcript parts; no model download or new native module is needed.

## Verification

Run from the repository root:

```powershell
.\tools\run-pnpm.ps1 --filter @locallab/mobile --filter @locallab/chat-integration typecheck
.\tools\run-pnpm.ps1 --filter @locallab/models-imports exec vitest run --root C:/code/cht apps/mobile/composition/chat/web-research.test.mts apps/mobile/platform/web-access.test.mts apps/mobile/composition/chat/brave-web-search.test.mts apps/mobile/platform/brave-search-fetch.test.mts
node --test tests/local-preview/web-research-proxy.test.cjs tests/local-preview/brave-search-proxy.test.cjs
$env:LOCALLAB_UI_BASE_URL = 'http://localhost:8085'
.\tools\run-pnpm.ps1 exec playwright test --config tests/ui/playwright.config.ts tests/ui/web-research.spec.ts --project phone
```

The browser tests cover evidence reaching the model, citations surviving reload, fetch without search, recoverable rate limits, no credentials on research requests, and controls fitting a 320×568 viewport. These are browser checks, not physical iPhone verification.

The September 29 reliability investigation exercised the revised client against real public services without invoking a model. It retrieved five relevant DuckDuckGo results and the live Expo documentation, recognized a genuinely empty search, rejected Reddit's HTTP-200 Reader envelope containing original-page HTTP 403, and retained the Expo excerpt when a second direct link was blocked. A captured live DuckDuckGo Lite response also parsed into real public results. A subsequent run through the updated preview relay again retrieved real search/docs evidence and retained the good page beside a blocked one, but DuckDuckGo challenged both formats on later probes. The app reported verification rather than accepting a challenge page as evidence. This establishes the public option's reliability limit and the reason for offering a supported API.

Receipts and public response captures are under `tmp/web-research-investigation/`, including `live-client-direct.json` and `live-client-relay.json`. Focused regression coverage exercises both public search formats, the shared deadline, a stalled response body, malformed and blocked Reader envelopes, mixed-link recovery, cancellation after an earlier source, bounded context evidence, native/web header isolation, Brave response parsing and sanitized errors, SQLite opaque-reference persistence, and rollback after secure/preference write failures. Brave tests use fixture keys and mocked HTTP; no user key, paid request, or live Brave API call was used. The native transport is tested with an Expo fetch adapter mock; a direct HTTPS service request from Windows does not establish an on-device iPhone run.

The Windows preview also completed real DuckDuckGo search and two Jina page reads, all returning HTTP 200. The initial OxCoder run streamed reasoning but did not finish within its 150-second observation window. A subsequent live run used the new **This PC · local coder** preset (shown as "Barrett's PC · local coder" at the time) and the endpoint's **qwen3.8-27b-sm89** model, with a five-minute generation allowance. It completed in 11 seconds, received the retrieved web context, answered with the official Expo documentation URL, and retained five source links across reload. The preset's connection and model selection also survived reload, with no browser runtime errors. The receipt is in `tmp/web-research-live.json`.

The iOS JavaScript/Hermes export succeeded with 1,719 modules; this does not establish a native iPhone run.
