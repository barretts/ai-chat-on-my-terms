# Phone conversation layout and desktop focus controls

## Phone

Screens narrower than 600 pixels use React Native Paper's standard phone components and light/dark surfaces. Short touch screens retain the phone layout in landscape. A single app bar holds Menu, the conversation title and selected connection, History, and New chat. Tap the connection name to choose another model or service. App navigation opens in a side drawer; the plus beside Message opens a bottom sheet for writing options, attachments, web search, and reading linked pages.

The transcript occupies the main screen. The composer stays at the bottom with Message and Send or Stop. Unconfigured chats provide a Connect a model action. Assistant responses use the available reading width; user messages use rounded bubbles. Copy and Read aloud have larger touch targets. The app retains its native safe-area and keyboard-avoidance wrapper.

Phone overlays close when reopening the app. Theme and connection choices persist; closing the message-tools sheet preserves selected tools for the current composer. A small count beside the plus indicates selected web tools. Without a connection, drafting remains available and Send explains that a model is needed.

Connections offers This PC, OpenRouter, and Other presets, with optional connection details folded. Settings uses standard segments and disclosure rows. Library prioritizes conversation search and opening conversations, while folder management is folded. Models starts with the suggested phone model; technical details and alternatives are folded. The Voices panel has one main action for the selected voice. Active download progress and cancellation remain outside model disclosures.

Phone typography uses the iOS system family on iOS, `system-ui` in the browser, and `sans-serif` on Android. Reading text is 17 points with a 25-point line height, regular body weight, semibold headings, and explicit paragraph spacing. Native font rendering handles smoothing. Browser photographs at 3× density help inspect glyphs without mistaking a 1× capture for native font quality.

## Desktop

Use the square button at the right of the cobalt title bar to focus the conversation. It folds the desktop menu, status and task bars, chat settings, and composer tools together. Press it again to show all controls.

The arrow beside the conversation title toggles chat settings independently. The plus/minus button beside Message toggles writing tools independently. History, New, Message, Send, and Stop remain available in focus mode. A number beside the composer plus indicates selected web tools; collapsing them preserves their selection.

Desktop layout preferences are saved in the app database and restored after reopening. On both layouts, research activity and sources have separate disclosures on each response, collapsed initially. Research errors remain visible while activity details are folded.

## Visual review before checks

The design was reviewed against official App Store screenshots for [ChatGPT](https://apps.apple.com/us/app/chatgpt/id6448311069), [Claude](https://apps.apple.com/us/app/claude-by-anthropic/id6473753684), and [Perplexity](https://apps.apple.com/us/app/perplexity-ask-anything/id1668000334), plus Apple's guidance for [buttons](https://developer.apple.com/design/human-interface-guidelines/buttons), [layout](https://developer.apple.com/design/human-interface-guidelines/layout), and [sheets](https://developer.apple.com/design/human-interface-guidelines/sheets). Reference photographs are in `tmp/phone-design-references/`.

Screens were photographed and visually inspected before automated checks, as requested. The primary viewport is 440×956 at 3× density (1320×2868 pixels), matching the physical pixel dimensions in [Apple's iPhone 17 Pro Max specifications](https://support.apple.com/en-us/125091). Browser photographs simulate a 62-pixel top and 34-pixel bottom safe area; these are allowances rather than native device measurements.

The latest screen gallery is in `tmp/phone-design-accepted-review/`. Final reading, reduced typing space, landscape, small-phone, and dark reading photographs are in `tmp/phone-conversation-accepted-v2/`. Review led to another pass on grouped navigation, integrated composing, system fonts, paragraph rhythm, rounded fields, settings, library, models, and voices. The final conversation pass also corrected a composer that retained excess height after sending.

## Verification

The first Paper redesign expanded the configured default conversation area from 312 pixels to about 812 without simulated insets, or 716 with them. Its historical photographs are in `tmp/iphone-17-paper-audit/`; the original layout is in `tmp/iphone-17-ui-audit/`. The current design received further polish after that first pass.

The focused UI suite covers 440×956, 390×844, 320×568, desktop focus persistence, and web research. It exercises connection setup, sending, stopping a pending response, history, new chat, selected tools, saved dark mode, sources after reload, and service failures. The browser assertions require conversation space exceeding 70% of the full viewport for configured phone chats, visible Send/Stop, and at least 44-pixel main action targets. The first redesign's historical results are in `tmp/paper-phone-ui-final/` and `tmp/paper-desktop-ui-verified/`.

After accepting the current visual design, all six focused checks passed in 55.5 seconds with no failures, skips, or flaky results. The report is `tmp/phone-ui-accepted-focused-20260929-1/report.json`. Model and web responses were isolated fixtures; this run downloaded no weights and made no paid calls. Mobile TypeScript also passed. Native source review corrected horizontal safe-area handling and made pickers announce their selected values.

These are browser checks of shared screens. Physical iPhone interaction requires installing the new native preview.

## Signed iPhone preview

[Build 6](https://expo.dev/accounts/barrett/projects/locallab/builds/e6df90a6-89e8-4cec-a68e-6cb95554d90e) finished successfully at 2026-09-29 04:59:05 UTC. It is an internal signed Release build for the registered iPhone, version 0.1.0, build number 6, and includes the finished phone design. Open its page in Safari on that iPhone to install it. Build 5 predates the final typography and secondary-screen polish.

Build submission, completion status, artifact check, and the source snapshot are recorded in `tmp/iphone-build6/`. The IPA download returned HTTP 200 and is 24,220,254 bytes. App and UI sources were checked against the submitted snapshot and had no changes after upload. Native compilation and signing succeeded; this does not establish physical keyboard behavior, audio output, or inference performance.
