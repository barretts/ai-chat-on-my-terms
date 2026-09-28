# Shared HTTP transport

`createHttpTransport` accepts the runtime's Fetch implementation. Mobile callers
can inject `expo/fetch`; desktop callers can inject the desktop Fetch runtime.
The package has no Expo or Node runtime dependency and can be contract-tested with
a fake Fetch implementation.

Every target origin must be listed exactly in `authorizedOrigins`. Wildcards,
credentials embedded in URLs, and unlisted hosts are rejected. HTTP is rejected
unless the exact origin is also listed in `cleartextLanOrigins`; applications
should only populate that list after explicit local-network authorization. A
cross-origin redirect is always rejected before another request is made, even
when both origins are authorized, so request credentials cannot be forwarded.
Same-origin redirects are followed with a bounded count.

`streamSse` incrementally decodes UTF-8, handles split lines and multi-line data,
ignores heartbeat comments, bounds event size, and continues to observe timeout
and caller cancellation until the body ends. Transport failures use
`HttpTransportError` codes and contain no URL, header, or credential values.

## Host integration

The application resolves credentials from its SecretStore immediately before a
request and passes them only in request headers. It must not put credentials in
URLs, logs, fixtures, or errors. Apps must provide their own exact native network
policy: iOS ATS exceptions only for explicitly authorized local HTTP hosts,
Android Network Security Config cleartext exceptions only for those hosts, and
desktop firewall/permission behavior appropriate to the companion listener.
Do not enable blanket arbitrary-load or cleartext traffic exceptions. The TypeScript
origin check is defense in depth; it does not replace operating-system policy or
local-network permission prompts.
