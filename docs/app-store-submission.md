# App Store submission preparation

Prepared October 19, 2026. Status: **local preparation in progress; not ready to submit**.
No live build, upload, App Store Connect change, or review submission is authorized by this document.

## Release identity and build

- Product: AI Chat on My Terms. Preserve bundle ID `app.locallab.mobile`, scheme `locallab`, EAS project `barrett/locallab`, project ID `15eddc95-17b4-4c17-9371-c26c8db770cf`.
- Current marketing version: `0.1.0`; local build number: `21`. Confirm the intended public version and the highest uploaded build number before creating the candidate. The production profile increments the local build number; reserve a unique number for each upload.
- `apps/mobile/eas.json` now has a separate `production` store-distribution profile, Release configuration, no development client, and no inherited preview endpoint.
- `apps/mobile/app.config.js` rejects nonempty `EXPO_PUBLIC_STRATA_*` variables in store builds. These are developer defaults; public Expo variables are embedded in the bundle and must never contain production secrets. Remove them from local `.env` files and the EAS production environment before building. Customers enter their own credentials in the app.
- Preview build 21 used ad hoc signing. It is not an App Store candidate. Its successful compilation does not certify this checkout or device behavior.
- Local Xcode reports 27.1. The selected cloud image and the resulting archive SDK still require verification.

After explicit authorization for a live EAS build, run from `apps/mobile`:

```sh
pnpm dlx eas-cli@24.8.0 build --platform ios --profile production
```

Do not auto-submit. Preserve the source commit, exact working-tree diff, resolved Expo config, EAS build ID, version/build, signing/export method, SDK, and artifact checksum with the candidate. Review the archive's privacy report and entitlements. Upload to App Store Connect and submit for review only after separate authorization.

## Blocking acceptance work

| Gate | Required evidence |
| --- | --- |
| First launch and core chat | On a clean physical iPhone, download/import a licensed supported GGUF, run a chat in airplane mode, cancel generation, background/resume, relaunch, and confirm saved history. T158 remains open. |
| Cloud AI disclosure | Before the first outbound request, name the selected provider and disclose the conversation context, attachments, and other content sent. Obtain explicit permission; test decline and provider changes. Adding a key or choosing a model alone is not evidence that this gate is met. Existing pairing/analytics consent does not certify cloud AI consent. |
| Privacy policy | Publish an accessible policy and add an accessible in-app link. Identify the operator/contact, data flows by feature, third-party providers, retention/deletion, credentials, diagnostics, and consent withdrawal. No approved public URL was established during this preparation. |
| App Privacy answers | Inventory the actual archive and every SDK/service. Reconcile chat/attachments/audio, identifiers, diagnostics, analytics, optional accounts and backup against Apple's collection definitions. Do not choose “Data Not Collected” solely because chat history is stored locally. |
| Working release scope | `plans/status/README.md` has unfinished native integration and release gates. Exercise every reachable screen; complete or remove unavailable actions from the shipping scope. Do not advertise MLX, iCloud/USB sync, hosted accounts, subscriptions, or widgets without candidate-specific evidence. |
| StoreKit/accounts | Root composition currently supplies no billing client or native purchase adapter. If the release is free and accountless, verify no unusable purchase/login paths are exposed. If accounts or paid features ship, finish native purchase/restore and account deletion and test them with the matching backend. |
| iPad | `supportsTablet` is true. Test the candidate on iPad, including keyboard, rotation/layout, attachments, and split view where supported, and provide iPad screenshots. Make an explicit product decision before changing supported device families. |
| Permissions/security | Verify camera, photo, microphone, speech, local-network and Face ID purpose strings against actual native flows. Inspect Bonjour declarations if discovery ships. Verify required-reason APIs and SDK privacy manifests in the generated archive; do not invent manifest reasons. |
| Content and rights | Confirm model redistribution/download licenses, app icon rights, AI-content safeguards/reporting where applicable, and an accurate age-rating questionnaire. |
| Export compliance | Assess cryptography in the complete app, including custom remote crypto. No `ITSAppUsesNonExemptEncryption=false` assertion was added without an assessment. |
| Store record | Confirm the Apple team, existing App Store Connect app record, agreements, territories, price, copyright owner, support contact/URL, privacy URL, and review contact. No live account state was checked. |
| Release candidate | Produce store-signed archive, validate, upload with authorization, wait for Apple processing, then test that exact build through TestFlight. Check launch without Metro or the developer's LAN. |

## Proposed English listing

Draft only; approve after acceptance establishes these behaviors. Apple name/subtitle limits are 30 characters.

- Name: **AI Chat on My Terms**
- Subtitle: **Your phone. Your models.**
- Keywords: `chat,offline,local,models,assistant,privacy,ollama,lmstudio`
- Promotional text: Choose where your AI runs: on your iPhone, on your own model server, or with a provider you configure.

Description draft:

> Choose the model and connection that fit your conversation.
>
> Download a supported model for on-device chat, connect to your own model server, or configure a supported cloud provider with your own API key. Keep conversations together and switch connections when your needs change.
>
> On-device chat requires a compatible model download and enough device memory and storage. Remote connections require access to your server or provider. Cloud providers may charge separately for API use. AI responses can be inaccurate; check important information.

Do not add planned features to this description. Final screenshots must come from the exact candidate and contain no personal conversations, keys, or private endpoints. Capture supported iPhone and iPad sizes: first launch/setup, offline conversation, provider selection, saved conversations, and attachment flow only when verified.

## Review notes to finish after device acceptance

Explain how to reach a working core conversation without the developer's home LAN. Provide exact supported model download steps and device requirements, and a reliable review route. If any reviewed feature requires credentials, arrange appropriate review access through App Store Connect; never put personal API keys in source or listing copy. Explain optional provider charges and where cloud-data consent appears. Identify any account, purchase, or external-server requirements accurately.

## Verification record

- Source inspection: mobile app config, EAS profiles, default connection seed, root providers, build 21 record, remaining-work ledger.
- Store configuration regression check: `node --test tests/release/store-config.test.cjs`.
- Record local typecheck/export results below after running them. Native archive validation, physical-device acceptance, SDK privacy report, screenshots, App Store Connect state, TestFlight, and App Review remain unverified.

## Apple references checked October 19, 2026

- [Submission requirements](https://developer.apple.com/app-store/submitting/): verify the SDK of the actual candidate.
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/): completeness, payments, privacy, and explicit permission for sharing data with third-party AI.
- [App Privacy details](https://developer.apple.com/app-store/app-privacy-details/): complete answers for the actual shipping app and partners.
- [Privacy manifests](https://developer.apple.com/documentation/bundleresources/privacy_manifest_files): archive-level declarations and required-reason API review.

Next action: resolve release scope and the privacy/AI-consent gates, then authorize a production build once local verification and physical-device acceptance permit it.

### Local check results

- Store configuration regression tests: **2 passed**.
- Expo public config resolved successfully with `APP_STORE_BUILD=1` and telemetry disabled.
- Changed configuration/test files passed formatting; `git diff --check` passed.
- Mobile typecheck: **failed**. Restored 111 missing local workspace dependency links without overwriting existing links. Remaining diagnostics include unresolved `zod`, missing Node types, and TypeScript errors. These results describe this local dependency setup; they do not contradict an earlier successful Expo cloud build. Reproduce with a clean locked dependency installation and retain the candidate's cloud build logs before deciding which diagnostics are release defects.
- Expo cloud remains the intended archive/signing path. A local native archive is not required when EAS produces the candidate; inspect and test that exact artifact.
- No new archive, upload, live provider request, or App Store mutation occurred.

## October 19 continuation: authorized production build and subdomain

The owner authorized the live Expo production build, preparation up to the Apple interface, and an app subdomain following the other apps' pattern. No App Review submission or public release was authorized.

- Expo browser login completed successfully.
- Production build request reached remote signing setup, then stopped because App Store signing credentials are not configured. No EAS build ID was created and no cloud compilation has started.
- Production environment reported no plain-text/sensitive variables; profile contributes `APP_STORE_BUILD=1`. No developer `STRATA` variables were reported.
- Interactive credential setup selected `production` and owner-supplied Apple ID `bsonntag@gmail.com`; secure password/2FA entry remains required. No password was requested in chat, read from a credential store, or recorded in source.
- Export compliance remains unset. Interactive build was interrupted at the classification prompt without changing the app config. After signing is configured, use the noninteractive build command to leave this question for manual Apple review rather than asserting an exemption.
- Prepared `site/public/` and `site/wrangler.jsonc` for `aichat.sosuke.com`, `/support/`, and `/privacy/`; Cloudflare browser authorization is pending. Public contact `barrett@sosuke.com` follows the existing app-site source. These URLs are proposed, not verified live.
- Prepared `submission/en-US/metadata.json`, `description.txt`, and `submission/APPLE-HANDOFF.md`. Field lengths and static internal links passed. Store configuration regression tests still pass 2/2.
- The app still needs a reachable in-app privacy link and verified cloud-AI consent; prepared website text does not implement those gates. No candidate screenshots were fabricated.

Next: finish secure Apple signing authentication and Cloudflare browser authorization, deploy and verify the site, start the already-authorized production build, retain its build record, then qualify the exact binary and finish remaining privacy/media gates. Do not submit for review.

### In-app links added

`apps/mobile/features/support/public-links.tsx` now exposes Privacy policy and Contact support from the Settings support section, including its unconfigured-service state. Browser-open failure shows the support email. Formatting and diff checks pass; native interaction and live URL verification remain pending. This supersedes the earlier statement that an in-app link still needed implementation; deployment and candidate acceptance are still required.

## Canonical host settled

The owner instructed: assume `aichat.sosuke.com` and move forward. This supersedes the Cloudflare-specific next steps above. Cloudflare is not a prerequisite. Removed the newly prepared Cloudflare deployment configuration; the site is portable static content. App links, listing fields, canonical metadata, and social-sharing artwork all use `https://aichat.sosuke.com`. Hosting/DNS remain unchanged. A portable website ZIP is prepared in `submission/website.zip`; verify the live pages before final Apple submission without reopening the hostname decision.

Production build authorization remains in effect. Apple signing authentication, candidate acceptance, cloud-AI consent verification, final privacy declarations, and actual screenshots remain outstanding.

## Secure Apple signing setup opened

At the owner's request, resumed Apple signing setup for `bsonntag@gmail.com`. Expo prompted for the password and had no reusable authenticated Apple session. Opened a visible macOS Terminal window running `credentials:configure-build --platform ios --profile production`; the owner enters password/2FA locally. On success, that same command starts the already-authorized noninteractive production build without auto-submit. Dispatch completion creates `/tmp/ai-chat-production-build-dispatched`. Do not read or log the Terminal's authentication contents. Verify the resulting build through Expo before claiming success. App Store Connect record creation, metadata changes, binary upload, review submission, and public release are not established by starting this flow.

## Production build 22 dispatched

After the owner completed the secure Apple prompts, Expo reported store-distribution production build `8aca0a1e-158a-4a22-b0ff-cd9bd8d01beb` in progress for version `0.1.0` build `22`. The local build number is now `22`. This supersedes the signing-authentication blocker above. See [production build record](builds/ios-production-22.md). App Store Connect upload, record setup and TestFlight are not established by this build dispatch.

## Build 22 failure repaired

Build 22 failed due to missing memory capabilities in its App Store profile. Both entitlements are now explicit in `app.json`, both Apple capabilities were enabled through the authenticated session, and replacement active profile `U8V37V2644` was created. Existing distribution certificate and app identity were preserved. Store config checks pass 3/3. Replacement build dispatch is in progress; final native build acceptance remains required.

## App Store Connect record created

Using the owner's authenticated Apple session, created **AI Chat on My Terms**, Apple app ID `6824682448`, bundle ID/SKU `app.locallab.mobile`, primary locale `en-US`. The app did not previously exist for this bundle ID. Added a production submit profile pinned to this app ID and Apple team `KQJWD7GN74`; no upload or review submission is implied by that configuration. The replacement candidate is production build 23.

Verified App Store Connect iOS draft setup: the app's automatically created `1.0` draft was aligned to candidate marketing version `0.1.0`, release type `MANUAL`; Apple returned `PREPARE_FOR_SUBMISSION`. Version record `a0785cdf-0e39-4bf6-aa2c-2b152bbf4387`. No review submission or automatic release was enabled.

## Build 23 successful and artifact checked

Production build `9bd18bf0-3b54-4af5-8221-643bec7f8145` finished successfully. Downloaded and inspected the 41,994,760-byte IPA; verified app identity/version/build, iOS 26.5 SDK, and embedded App Store profile with both memory entitlements. See [build 23 record](builds/ios-production-23.md) for artifact URL, SHA-256 and verification boundaries. This supersedes pending build statements above. App Store Connect record `6824682448` is prepared with a matching `0.1.0` draft and manual release; binary upload, TestFlight/device acceptance, final privacy/export declarations and screenshots remain outstanding. No review submission occurred.

## Live App Store listing populated and read back

October 19, 2026, 5:43 PM America/Chicago: saved the following directly in App Store Connect app `6824682448`, iOS version `0.1.0`, and fetched fresh Apple objects to verify the values persisted:

- Description, keywords, promotional text, marketing URL and support URL from `submission/en-US/`.
- App name, subtitle, privacy-policy URL, and primary category Productivity.
- Copyright `2026 Barrett Sonntag`; manual release retained.
- Reviewer first/last name and support email; reused the owner's existing Capture iOS reviewer phone without placing it in repository files.
- Draft review notes explaining on-device setup, optional remote provider requirements, and outstanding candidate acceptance. Notes explicitly mark this as a draft, not submitted.

Apple returned `PREPARE_FOR_SUBMISSION`. Verification receipt is local-only `.logs/app-store-listing-readback.json`. This supersedes earlier statements that listing content existed only locally. Saving these URLs does not verify the live site. Binary upload/selection, candidate screenshots, privacy/age-rating/export declarations, pricing/availability, and final device acceptance remain incomplete. No App Review submission or public release occurred.
