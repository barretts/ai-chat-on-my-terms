//! T116 (AU-04, AU-05) — desktop CLI equivalent of the typed
//! deep-link automation family (`locallab://shortcut/...`).
//!
//! Same strictness contract as the TypeScript side in
//! `@locallab/automation`: unknown actions, unknown or duplicated
//! parameters, over-long or percent-encoded values all refuse, so a
//! malformed or untrusted link can never execute anything or smuggle
//! a secret (card smoke 2). The canonical serialization is
//! byte-identical to the TS `serializeIntent` for every declared
//! action — the two test suites assert the same fixture strings.

use std::fmt;

/// Per-action validated payload (AU-04).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShortcutAction {
    Ask {
        q: String,
        model_class: Option<String>,
    },
    Search {
        q: String,
    },
    Voice,
    Summarize {
        model_class: Option<String>,
    },
    Translate {
        lang: String,
        model_class: Option<String>,
    },
    News {
        read: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutError {
    pub kind: &'static str,
}

impl fmt::Display for ShortcutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "shortcut-url-{}", self.kind)
    }
}

impl std::error::Error for ShortcutError {}

fn malformed() -> ShortcutError {
    ShortcutError { kind: "malformed" }
}

const MAX_QUERY_PAIRS: usize = 8;
const MAX_IMPORT_CHARS: usize = 20000;

fn is_model_class(v: &str) -> bool {
    let bytes = v.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'.' || *c == b'-')
}

fn is_lang(v: &str) -> bool {
    let bytes = v.as_bytes();
    if bytes.len() < 2 || bytes.len() > 8 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes[1..].iter().all(|c| c.is_ascii_lowercase() || *c == b'-')
}

fn is_query_text(v: &str, max_chars: usize) -> bool {
    let n = v.chars().count();
    n >= 1 && n <= max_chars && !v.contains('%')
}

/// Parse `locallab://shortcut/<action>?params` into a validated
/// action, or a malformed error.
pub fn parse_shortcut_url(url: &str) -> Result<ShortcutAction, ShortcutError> {
    let rest = url
        .strip_prefix("locallab://shortcut/")
        .ok_or_else(malformed)?;
    let (action, query) = match rest.split_once('?') {
        Some((a, q)) => (a, Some(q)),
        None => (rest, None),
    };
    if action.is_empty()
        || !action
            .chars()
            .all(|c| c.is_ascii_lowercase() || c == '-')
    {
        return Err(malformed());
    }
    let mut pairs: Vec<(&str, &str)> = Vec::new();
    if let Some(raw) = query {
        if !raw.is_empty() {
            for pair in raw.split('&') {
                let (k, v) = pair.split_once('=').ok_or_else(malformed)?;
                if k.is_empty() {
                    return Err(malformed());
                }
                if pairs.iter().any(|(ek, _)| *ek == k) {
                    return Err(malformed());
                }
                pairs.push((k, v));
            }
            if pairs.len() > MAX_QUERY_PAIRS {
                return Err(malformed());
            }
        }
    }
    let allowed: &[&str] = match action {
        "ask" => &["q", "modelClass"],
        "search" => &["q"],
        "voice" => &[],
        "summarize" => &["modelClass"],
        "translate" => &["lang", "modelClass"],
        "news" => &["read"],
        _ => return Err(malformed()),
    };
    if pairs.iter().any(|(k, _)| !allowed.contains(k)) {
        return Err(malformed());
    }
    let param = |name: &str| {
        pairs
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| *v)
    };
    let opt_model_class = match param("modelClass") {
        Some(v) if is_model_class(v) => Some(v.to_string()),
        Some(_) => return Err(malformed()),
        None => None,
    };
    match action {
        "ask" => {
            let q = param("q").ok_or_else(malformed)?;
            if !is_query_text(q, 2000) {
                return Err(malformed());
            }
            Ok(ShortcutAction::Ask {
                q: q.to_string(),
                model_class: opt_model_class,
            })
        }
        "search" => {
            let q = param("q").ok_or_else(malformed)?;
            if !is_query_text(q, 200) {
                return Err(malformed());
            }
            Ok(ShortcutAction::Search { q: q.to_string() })
        }
        "voice" => Ok(ShortcutAction::Voice),
        "summarize" => Ok(ShortcutAction::Summarize {
            model_class: opt_model_class,
        }),
        "translate" => {
            let lang = param("lang").ok_or_else(malformed)?;
            if !is_lang(lang) {
                return Err(malformed());
            }
            Ok(ShortcutAction::Translate {
                lang: lang.to_string(),
                model_class: opt_model_class,
            })
        }
        "news" => {
            let read = match param("read") {
                Some("true") => true,
                Some("false") | None => false,
                Some(_) => return Err(malformed()),
            };
            Ok(ShortcutAction::News { read })
        }
        _ => Err(malformed()),
    }
}

fn json_escape(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for c in v.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Canonical JSON form, byte-identical to TS `serializeIntent`.
pub fn serialize_intent(action: &ShortcutAction) -> String {
    let name = match action {
        ShortcutAction::Ask { .. } => "ask",
        ShortcutAction::Search { .. } => "search",
        ShortcutAction::Voice => "voice",
        ShortcutAction::Summarize { .. } => "summarize",
        ShortcutAction::Translate { .. } => "translate",
        ShortcutAction::News { .. } => "news",
    };
    let mut out = format!("{{\"action\":\"{name}\"");
    match action {
        ShortcutAction::Ask { q, model_class } => {
            out.push_str(",\"q\":");
            out.push_str(&json_escape(q));
            if let Some(m) = model_class {
                out.push_str(",\"modelClass\":");
                out.push_str(&json_escape(m));
            }
        }
        ShortcutAction::Search { q } => {
            out.push_str(",\"q\":");
            out.push_str(&json_escape(q));
        }
        ShortcutAction::Voice => {}
        ShortcutAction::Summarize { model_class } => {
            if let Some(m) = model_class {
                out.push_str(",\"modelClass\":");
                out.push_str(&json_escape(m));
            }
        }
        ShortcutAction::Translate { lang, model_class } => {
            out.push_str(",\"lang\":");
            out.push_str(&json_escape(lang));
            if let Some(m) = model_class {
                out.push_str(",\"modelClass\":");
                out.push_str(&json_escape(m));
            }
        }
        ShortcutAction::News { read } => {
            out.push_str(",\"read\":");
            out.push_str(if *read { "true" } else { "false" });
        }
    }
    out.push('}');
    out
}

/// Same services the desktop UI invokes (menu-bar search, ask, etc.).
pub trait ShortcutServices {
    fn ask(&mut self, q: &str, model_class: Option<&str>);
    fn search(&mut self, q: &str);
    fn voice(&mut self);
    fn summarize(&mut self, text: &str, model_class: Option<&str>);
    fn translate(&mut self, text: &str, lang: &str);
    fn news(&mut self, read: bool);
    fn voice_permission(&self) -> &'static str;
    fn shared_import(&self) -> Option<String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    Done,
    Refused(&'static str),
    ReviewRequired(&'static str),
}

/// Step 3: sensitive Share Sheet imports and unavailable voice
/// permission require an interactive foreground confirmation; nothing
/// sensitive runs from a background launch.
pub fn run_shortcut(
    services: &mut impl ShortcutServices,
    url: &str,
    foreground: bool,
) -> RunOutcome {
    let action = match parse_shortcut_url(url) {
        Ok(a) => a,
        Err(_) => return RunOutcome::Refused("malformed"),
    };
    match action {
        ShortcutAction::Ask { q, model_class } => {
            services.ask(&q, model_class.as_deref());
            RunOutcome::Done
        }
        ShortcutAction::Search { q } => {
            services.search(&q);
            RunOutcome::Done
        }
        ShortcutAction::Voice => match services.voice_permission() {
            "denied" => RunOutcome::Refused("voice-denied"),
            "granted" => {
                services.voice();
                RunOutcome::Done
            }
            _ => RunOutcome::ReviewRequired("voice-permission"),
        },
        ShortcutAction::Summarize { model_class } => {
            match reviewed_import(services, foreground) {
                Some(text) => {
                    services.summarize(&text, model_class.as_deref());
                    RunOutcome::Done
                }
                None if foreground => RunOutcome::Refused("no-import"),
                None => RunOutcome::ReviewRequired("share-import"),
            }
        }
        ShortcutAction::Translate { lang, .. } => {
            match reviewed_import(services, foreground) {
                Some(text) => {
                    services.translate(&text, &lang);
                    RunOutcome::Done
                }
                None if foreground => RunOutcome::Refused("no-import"),
                None => RunOutcome::ReviewRequired("share-import"),
            }
        }
        ShortcutAction::News { read } => {
            services.news(read);
            RunOutcome::Done
        }
    }
}

fn reviewed_import(services: &mut impl ShortcutServices, foreground: bool) -> Option<String> {
    if !foreground {
        return None;
    }
    let text = services.shared_import()?;
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_IMPORT_CHARS {
        return None;
    }
    Some(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    struct Spy {
        calls: Rc<RefCell<Vec<String>>>,
        voice_perm: &'static str,
        shared: Option<String>,
    }

    impl ShortcutServices for Spy {
        fn ask(&mut self, q: &str, model_class: Option<&str>) {
            self.calls
                .borrow_mut()
                .push(format!("ask:{q}:{}", model_class.unwrap_or("-")));
        }
        fn search(&mut self, q: &str) {
            self.calls.borrow_mut().push(format!("search:{q}"));
        }
        fn voice(&mut self) {
            self.calls.borrow_mut().push("voice".to_string());
        }
        fn summarize(&mut self, text: &str, model_class: Option<&str>) {
            self.calls
                .borrow_mut()
                .push(format!("summarize:{}:{}", text.trim().chars().count(), model_class.unwrap_or("-")));
        }
        fn translate(&mut self, text: &str, lang: &str) {
            self.calls
                .borrow_mut()
                .push(format!("translate:{}:{lang}", text.trim().chars().count()));
        }
        fn news(&mut self, read: bool) {
            self.calls.borrow_mut().push(format!("news:{read}"));
        }
        fn voice_permission(&self) -> &'static str {
            self.voice_perm
        }
        fn shared_import(&self) -> Option<String> {
            self.shared.clone()
        }
    }

    fn spy(voice_perm: &'static str, shared: Option<&str>) -> (Spy, Rc<RefCell<Vec<String>>>) {
        let calls = Rc::new(RefCell::new(Vec::new()));
        (
            Spy {
                calls: Rc::clone(&calls),
                voice_perm,
                shared: shared.map(str::to_string),
            },
            calls,
        )
    }

    #[test]
    fn every_action_parses_and_serializes_byte_identically_to_ts() {
        let cases = [
            (
                "locallab://shortcut/ask?q=what+is+the+weather&modelClass=q4-small",
                "{\"action\":\"ask\",\"q\":\"what+is+the+weather\",\"modelClass\":\"q4-small\"}",
            ),
            (
                "locallab://shortcut/search?q=hi",
                "{\"action\":\"search\",\"q\":\"hi\"}",
            ),
            ("locallab://shortcut/voice", "{\"action\":\"voice\"}"),
            ("locallab://shortcut/summarize", "{\"action\":\"summarize\"}"),
            (
                "locallab://shortcut/translate?lang=de",
                "{\"action\":\"translate\",\"lang\":\"de\"}",
            ),
            (
                "locallab://shortcut/news?read=true",
                "{\"action\":\"news\",\"read\":true}",
            ),
            ("locallab://shortcut/news", "{\"action\":\"news\",\"read\":false}"),
        ];
        for (url, golden) in cases {
            let parsed = parse_shortcut_url(url).expect("valid url must parse");
            assert_eq!(serialize_intent(&parsed), golden, "golden: {url}");
        }
    }

    #[test]
    fn malformed_and_untrusted_urls_refuse() {
        for url in [
            "locallab://shortcut/execute?cmd=rm",
            "locallab://shortcut/ask",
            "locallab://shortcut/ask?q=hi&token=sk-live-secret",
            "locallab://shortcut/ask?q=100%2520bytes",
            "lmmini://shortcut/ask?q=hi",
            "https://example.com/shortcut/ask?q=hi",
            "locallab://shortcut/ask?q=hi&lang=de",
            "locallab://shortcut/translate",
            "locallab://shortcut/voice?q=sneaky",
            "locallab://shortcut/ask?q=hi&lang=de&q=again",
            "locallab://shortcut/news?read=maybe",
        ] {
            assert_eq!(
                parse_shortcut_url(url),
                Err(malformed()),
                "expected refusal: {url}"
            );
        }
    }

    #[test]
    fn every_action_invokes_the_same_service_as_the_ui() {
        let (mut s, calls) = spy("granted", None);
        assert_eq!(
            run_shortcut(&mut s, "locallab://shortcut/ask?q=hello", true),
            RunOutcome::Done
        );
        assert_eq!(
            run_shortcut(&mut s, "locallab://shortcut/search?q=hi", false),
            RunOutcome::Done
        );
        assert_eq!(
            run_shortcut(&mut s, "locallab://shortcut/voice", false),
            RunOutcome::Done
        );
        assert_eq!(
            run_shortcut(&mut s, "locallab://shortcut/news?read=true", false),
            RunOutcome::Done
        );
        assert_eq!(
            *calls.borrow(),
            vec!["ask:hello:-", "search:hi", "voice", "news:true"]
        );
    }

    #[test]
    fn untrusted_url_executes_nothing_at_all() {
        let (mut s, calls) = spy("granted", None);
        assert_eq!(
            run_shortcut(
                &mut s,
                "locallab://shortcut/ask?q=hi&token=sk-live-secret",
                true
            ),
            RunOutcome::Refused("malformed")
        );
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn share_imports_need_interactive_foreground_review() {
        let (mut s, calls) = spy("granted", Some("  text shared from another app  "));
        assert_eq!(
            run_shortcut(&mut s, "locallab://shortcut/summarize", false),
            RunOutcome::ReviewRequired("share-import")
        );
        assert!(calls.borrow().is_empty());
        assert_eq!(
            run_shortcut(&mut s, "locallab://shortcut/summarize", true),
            RunOutcome::Done
        );
        assert_eq!(*calls.borrow(), vec!["summarize:28:-"]);

        let (mut s2, calls2) = spy("granted", None);
        assert_eq!(
            run_shortcut(&mut s2, "locallab://shortcut/translate?lang=de", true),
            RunOutcome::Refused("no-import")
        );
        assert!(calls2.borrow().is_empty());
    }

    #[test]
    fn voice_permission_states_gate_the_microphone() {
        let (mut s, calls) = spy("undetermined", None);
        assert_eq!(
            run_shortcut(&mut s, "locallab://shortcut/voice", false),
            RunOutcome::ReviewRequired("voice-permission")
        );
        let (mut s2, calls2) = spy("denied", None);
        assert_eq!(
            run_shortcut(&mut s2, "locallab://shortcut/voice", true),
            RunOutcome::Refused("voice-denied")
        );
        assert!(calls.borrow().is_empty() && calls2.borrow().is_empty());
    }

    #[test]
    fn cli_entry_round_trips_validated_intents() {
        // Desktop CLI shape: argv after `locallab-companion shortcut`
        // is the same deep-link family; stdout carries the canonical
        // intent JSON so scripts can pipe it.
        let argv = ["ask", "what+is+the+weather", "q4-small"];
        let url = format!(
            "locallab://shortcut/{}?q={}{}",
            argv[0],
            argv[1],
            if argv.len() > 2 {
                format!("&modelClass={}", argv[2])
            } else {
                String::new()
            }
        );
        let parsed = parse_shortcut_url(&url).expect("cli url must parse");
        assert_eq!(
            serialize_intent(&parsed),
            "{\"action\":\"ask\",\"q\":\"what+is+the+weather\",\"modelClass\":\"q4-small\"}"
        );
    }
}
