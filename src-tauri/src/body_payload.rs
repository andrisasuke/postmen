pub const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanRule {
    // Double-quoted JSON strings with JSON escape handling. A raw newline ends
    // a malformed string so an unfinished quote cannot hide later comments.
    JsonRequest,
    // Legacy raw import tolerance: single-quoted literals, // text and unclosed
    // blocks are kept or warned about rather than treated as JSON syntax.
    RawImport,
}

pub struct CleanedBody {
    pub text: String,
    pub removed_comments: usize,
    pub unterminated_comment: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonCleanupPolicy {
    // Send and Generate cURL use the old masked bytes when active JSON is invalid.
    Transport,
    // Export Collection keeps the stored body unless a valid clean copy exists.
    Export,
}

#[derive(Debug, PartialEq, Eq)]
pub enum JsonCleanupBody {
    NotTriggered,
    Formatted(String),
    Masked(String),
    Invalid,
    Unterminated,
}

// One trigger, validation, and formatting path serves Send, Generate cURL, and
// Export. Caller policy only decides how invalid or unfinished bodies behave.
pub fn clean_json_body(raw: &str, policy: JsonCleanupPolicy) -> JsonCleanupBody {
    let cleaned = strip_block_comments(raw, ScanRule::JsonRequest);
    if cleaned.unterminated_comment {
        return JsonCleanupBody::Unterminated;
    }
    let padded = has_padded_blank_line(&cleaned.text);
    if cleaned.removed_comments == 0 && !padded {
        return JsonCleanupBody::NotTriggered;
    }
    if serde_json::from_str::<serde::de::IgnoredAny>(&cleaned.text).is_err() {
        return match policy {
            JsonCleanupPolicy::Transport => JsonCleanupBody::Masked(cleaned.text),
            JsonCleanupPolicy::Export => JsonCleanupBody::Invalid,
        };
    }
    match format_json(&cleaned.text, true).or_else(|| format_json(&cleaned.text, false)) {
        Some(formatted) => JsonCleanupBody::Formatted(formatted),
        None => match policy {
            JsonCleanupPolicy::Transport => JsonCleanupBody::Masked(cleaned.text),
            JsonCleanupPolicy::Export => JsonCleanupBody::Invalid,
        },
    }
}

// A whitespace-padded blank line is a legacy import fingerprint: complete block
// comments were replaced with spaces. The origin is not stored, so the same
// rule intentionally applies to authored bodies that contain such lines.
pub fn has_padded_blank_line(text: &str) -> bool {
    let mut padding = false;
    let mut content = false;
    let mut after_cr = false;
    for byte in text.bytes() {
        match byte {
            b' ' | b'\t' => {
                if !content {
                    padding = true;
                }
                after_cr = false;
            }
            // CR is a line separator. A following LF belongs to the same CRLF
            // separator and must not evaluate the already-reset line again.
            b'\r' => {
                if padding && !content {
                    return true;
                }
                padding = false;
                content = false;
                after_cr = true;
            }
            b'\n' => {
                if after_cr {
                    after_cr = false;
                } else {
                    if padding && !content {
                        return true;
                    }
                    padding = false;
                    content = false;
                }
            }
            _ => {
                content = true;
                after_cr = false;
            }
        }
    }
    padding && !content
}

pub fn needs_json_cleanup(text: &str) -> bool {
    text.contains("/*") || has_padded_blank_line(text)
}

// Remove only complete block comments outside strings for the selected request
// or import rules. Whitespace keeps tokens separated (1/*comment*/2 must not
// become 12), line endings and byte positions intact. Never parse/re-serialize
// the payload or echo it in diagnostics.
pub fn strip_block_comments(raw: &str, rule: ScanRule) -> CleanedBody {
    let bytes = raw.as_bytes();
    let json = rule == ScanRule::JsonRequest;
    let mut output = String::with_capacity(raw.len());
    let mut index = 0;
    let mut copied_until = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut removed_comments = 0;
    let mut unterminated_comment = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(delimiter) = quote {
            if json && matches!(byte, b'\r' | b'\n') {
                // Invalid JSON string: a backslash escape cannot cross a line
                // break. Resume after the line break so an unfinished block is
                // not hidden from Send or Generate cURL.
                quote = None;
                escaped = false;
            } else if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == delimiter {
                quote = None;
            }
            index += 1;
            continue;
        }
        if byte == b'"' || (!json && byte == b'\'') {
            quote = Some(byte);
            index += 1;
            continue;
        }
        if !json && byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            // Raw imports keep line-comment text literal, but quotes and block
            // markers within one are not syntax. This also leaves unquoted
            // http:// text alone. JSON requests do not recognize // at all.
            while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
                index += 1;
            }
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            let Some(end) = raw[index + 2..].find("*/") else {
                // Do not guess where an unfinished comment ends and discard
                // the remaining payload. Keep it and let the caller warn or reject.
                unterminated_comment = true;
                break;
            };
            let end = index + 2 + end + 2;
            output.push_str(&raw[copied_until..index]);
            for byte in &bytes[index..end] {
                output.push(match byte {
                    b'\r' => '\r',
                    b'\n' => '\n',
                    _ => ' ',
                });
            }
            removed_comments += 1;
            index = end;
            copied_until = end;
            continue;
        }
        index += 1;
    }
    output.push_str(&raw[copied_until..]);
    CleanedBody {
        text: output,
        removed_comments,
        unterminated_comment,
    }
}

// Format validated JSON. Compact output fits when indentation would make the
// expanded body exceed the request size limit.
fn format_json(mut text: &str, pretty: bool) -> Option<String> {
    let mut output = String::new();
    let mut previous = 0;
    let mut depth = 0;
    loop {
        text = text.trim_ascii_start();
        let Some(&first) = text.as_bytes().first() else {
            return Some(output);
        };
        let end = match first {
            b'{' | b'}' | b'[' | b']' | b',' | b':' => 1,
            b'"' => {
                let mut escaped = false;
                text.bytes().enumerate().skip(1).find_map(|(index, byte)| {
                    if escaped {
                        escaped = false;
                    } else if byte == b'\\' {
                        escaped = true;
                    } else if byte == b'"' {
                        return Some(index + 1);
                    }
                    None
                })?
            }
            _ => text
                .bytes()
                .position(|byte| byte.is_ascii_whitespace() || matches!(byte, b',' | b'}' | b']'))
                .unwrap_or(text.len()),
        };
        let closing = matches!(first, b'}' | b']');
        if closing {
            depth -= 1;
        }
        let empty = matches!((previous, first), (b'{', b'}') | (b'[', b']'));
        let newline = pretty && !empty && (closing || matches!(previous, b'{' | b'[' | b','));
        let space = pretty && previous == b':';
        let padding = if newline {
            1 + 2 * depth
        } else {
            usize::from(space)
        };
        if output.len() + padding + end > MAX_REQUEST_BODY_BYTES {
            return None;
        }
        if newline {
            output.push('\n');
            output.extend(std::iter::repeat_n(' ', 2 * depth));
        } else if space {
            output.push(' ');
        }
        output.push_str(&text[..end]);
        if matches!(first, b'{' | b'[') {
            depth += 1;
        }
        previous = first;
        text = &text[end..];
    }
}

// The effective Content-Type may include parameters and casing variations.
// Valid `type/subtype` JSON media types opt into cleanup. A comma outside a
// quoted parameter represents multiple field values and is ambiguous even
// when one of those values looks like JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonMediaType {
    NotJson,
    Json,
    Ambiguous,
}

fn media_token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

fn has_unquoted_comma(value: &[u8]) -> bool {
    let mut quoted = false;
    let mut escaped = false;
    for &byte in value {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else if byte == b'"' {
            quoted = true;
        } else if byte == b',' {
            return true;
        }
    }
    false
}

pub fn json_media_type(value: &[u8]) -> JsonMediaType {
    if has_unquoted_comma(value) {
        return JsonMediaType::Ambiguous;
    }
    let media = value
        .split(|byte| *byte == b';')
        .next()
        .unwrap_or_default()
        .trim_ascii();
    let mut parts = media.splitn(2, |byte| *byte == b'/');
    let kind = parts.next().unwrap_or_default();
    let subtype = parts.next().unwrap_or_default();
    if kind.is_empty()
        || subtype.is_empty()
        || !kind.iter().all(|byte| media_token(*byte))
        || !subtype.iter().all(|byte| media_token(*byte))
    {
        return JsonMediaType::NotJson;
    }
    let suffix = b"+json";
    let json = (kind.eq_ignore_ascii_case(b"application") && subtype.eq_ignore_ascii_case(b"json"))
        || (subtype.len() > suffix.len()
            && subtype[subtype.len() - suffix.len()..].eq_ignore_ascii_case(suffix));
    if json {
        JsonMediaType::Json
    } else {
        JsonMediaType::NotJson
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_commented_json_if_pretty_output_exceeds_the_body_limit() {
        let compact = format!("{}0{}", "[".repeat(1100), "]".repeat(1100));
        let raw = format!("/* note */{compact}");
        assert_eq!(
            clean_json_body(&raw, JsonCleanupPolicy::Transport),
            JsonCleanupBody::Formatted(compact)
        );
    }

    #[test]
    fn cleans_padded_blank_lines_but_keeps_untriggered_and_invalid_bodies() {
        let padded = "{\n   \n  \"a\":1}";
        assert!(has_padded_blank_line(padded));
        assert!(needs_json_cleanup(padded));
        assert_eq!(
            clean_json_body(padded, JsonCleanupPolicy::Transport),
            JsonCleanupBody::Formatted("{\n  \"a\": 1\n}".into())
        );

        let plain = "{\"a\":1}";
        assert!(!needs_json_cleanup(plain));
        assert_eq!(
            clean_json_body(plain, JsonCleanupPolicy::Transport),
            JsonCleanupBody::NotTriggered
        );

        let invalid = "{\n   \n \"a\":";
        assert_eq!(
            clean_json_body(invalid, JsonCleanupPolicy::Transport),
            JsonCleanupBody::Masked(invalid.into())
        );
        assert_eq!(
            clean_json_body(invalid, JsonCleanupPolicy::Export),
            JsonCleanupBody::Invalid
        );
    }

    #[test]
    fn detects_padded_blank_lines_with_cr_lf_and_crlf() {
        for line_break in ["\r", "\n", "\r\n"] {
            let padded = format!("{{{{{line_break}   {line_break}\"a\":1}}}}");
            assert!(has_padded_blank_line(&padded), "{line_break:?}");
            let content = format!("{{\"a\":\"x   y\"{line_break}}}");
            assert!(!has_padded_blank_line(&content), "{line_break:?}");
        }
        assert!(has_padded_blank_line("   "));
        assert!(!has_padded_blank_line("\n\n"));
        assert!(!has_padded_blank_line("x   "));
    }

    #[test]
    fn export_formats_only_valid_triggered_json_and_preserves_other_bodies() {
        let comment = "/* note */{\"a\":1}";
        assert_eq!(
            clean_json_body(comment, JsonCleanupPolicy::Export),
            JsonCleanupBody::Formatted("{\n  \"a\": 1\n}".into())
        );
        assert_eq!(
            clean_json_body("{\"a\":1,\n  \n\"b\":2}", JsonCleanupPolicy::Export),
            JsonCleanupBody::Formatted("{\n  \"a\": 1,\n  \"b\": 2\n}".into())
        );
        assert_eq!(
            clean_json_body("{\"a\":1}", JsonCleanupPolicy::Export),
            JsonCleanupBody::NotTriggered
        );
        assert_eq!(
            clean_json_body("/* note */{\"a\":1", JsonCleanupPolicy::Export),
            JsonCleanupBody::Unterminated
        );
        assert_eq!(
            clean_json_body("{\"a\":1}/* unfinished", JsonCleanupPolicy::Export),
            JsonCleanupBody::Unterminated
        );
        assert_eq!(
            clean_json_body("/* note */{\"a\":1} trailing", JsonCleanupPolicy::Export),
            JsonCleanupBody::Invalid
        );
    }

    #[test]
    fn flat_array_near_the_body_limit_falls_back_to_compact_json() {
        let raw = format!("/* note */[{}0]", "0,".repeat(900_000));
        assert!(raw.len() <= MAX_REQUEST_BODY_BYTES);
        let transport = clean_json_body(&raw, JsonCleanupPolicy::Transport);
        let JsonCleanupBody::Formatted(transport) = transport else {
            panic!("expected formatted JSON");
        };
        assert!(transport.len() <= MAX_REQUEST_BODY_BYTES);
        assert!(transport.starts_with('['));
        assert!(!transport.contains('\n'));
    }

    #[test]
    fn recognizes_json_media_types_with_parameters_casing_and_non_ascii_values() {
        for value in [
            "application/json",
            "APPLICATION/JSON",
            "application/json; charset=utf-8",
            " application/json ; profile=\"x\" ",
            "application/json; profile=\"café\"",
            "application/vnd.api+json",
            "application/problem+json; charset=utf-8",
            "application/vnd.api+json; profile=\"日本語\"",
            "application/vnd.api+json; profile=\"a,b\"",
            "application/json; profile=\"quote \\\" and, comma\"",
            "text/plain+json",
        ] {
            assert_eq!(
                json_media_type(value.as_bytes()),
                JsonMediaType::Json,
                "{value}"
            );
        }
        for value in [
            "",
            "text/plain",
            "application/x-json",
            "application/json-patch",
            "text/json",
            "foo+json",
            "application/+json",
            "application/json/extra",
            "application / json",
            "application",
            "/json",
        ] {
            assert_eq!(
                json_media_type(value.as_bytes()),
                JsonMediaType::NotJson,
                "{value}"
            );
        }
        for value in [
            "application/json, text/plain",
            "text/plain, application/json",
            "application/json,application/json",
            "application/json; profile=\"a\", text/plain",
        ] {
            assert_eq!(
                json_media_type(value.as_bytes()),
                JsonMediaType::Ambiguous,
                "{value}"
            );
        }
    }

    #[test]
    fn json_request_rule_recognizes_comments_after_single_quotes_and_line_text() {
        let raw = "'/*single*/' // /*line*/\n{}/*tail*/";
        let json = strip_block_comments(raw, ScanRule::JsonRequest);
        assert_eq!(json.removed_comments, 3);
        assert!(!json.text.contains("/*single*/"));
        assert!(!json.text.contains("/*line*/"));
        assert!(!json.text.contains("/*tail*/"));
        assert!(!json.unterminated_comment);

        let import = strip_block_comments(raw, ScanRule::RawImport);
        assert_eq!(import.removed_comments, 1);
        assert!(import.text.contains("/*single*/"));
        assert!(import.text.contains("/*line*/"));
        assert!(!import.text.contains("/*tail*/"));
        assert!(!import.unterminated_comment);
    }

    #[test]
    fn json_request_rule_rejects_unfinished_blocks_hidden_from_raw_import_rules() {
        for raw in ["'/* unfinished", "// /* unfinished"] {
            let json = strip_block_comments(raw, ScanRule::JsonRequest);
            assert!(json.unterminated_comment, "{raw}");
            let import = strip_block_comments(raw, ScanRule::RawImport);
            assert!(!import.unterminated_comment, "{raw}");
        }
    }

    #[test]
    fn json_request_rule_ends_malformed_strings_at_newlines() {
        let raw = "\"unfinished\n/* remove */1";
        let json = strip_block_comments(raw, ScanRule::JsonRequest);
        assert_eq!(json.removed_comments, 1);
        assert!(!json.text.contains("/* remove */"));
        assert!(!json.unterminated_comment);
        let import = strip_block_comments(raw, ScanRule::RawImport);
        assert_eq!(import.removed_comments, 0);
        assert!(import.text.contains("/* remove */"));
        assert!(!import.unterminated_comment);
    }

    #[test]
    fn json_request_rule_ends_strings_before_escaped_line_breaks() {
        for newline in ["\n", "\r\n"] {
            let complete = format!("\"broken\\{newline}/* complete */\"");
            let json = strip_block_comments(&complete, ScanRule::JsonRequest);
            assert_eq!(json.removed_comments, 1, "{newline:?}");
            assert!(!json.unterminated_comment, "{newline:?}");
            let import = strip_block_comments(&complete, ScanRule::RawImport);
            assert_eq!(import.removed_comments, 0, "{newline:?}");

            let unfinished = format!("\"broken\\{newline}/* unfinished");
            let json = strip_block_comments(&unfinished, ScanRule::JsonRequest);
            assert!(json.unterminated_comment, "{newline:?}");
            let import = strip_block_comments(&unfinished, ScanRule::RawImport);
            assert!(!import.unterminated_comment, "{newline:?}");
        }
    }

    #[test]
    fn json_request_rule_keeps_markers_inside_double_quoted_strings_literal() {
        let raw = r#"{"s":"/* unterminated marker"}"#;
        let json = strip_block_comments(raw, ScanRule::JsonRequest);
        assert_eq!(json.removed_comments, 0);
        assert!(!json.unterminated_comment);
        assert_eq!(json.text, raw);
    }

    #[test]
    fn json_request_rule_preserves_escaped_quotes_and_backslashes() {
        let raw = r#"{"text":"say \"/* literal */\"","path":"back\\slash","value":/* remove */1}"#;
        let json = strip_block_comments(raw, ScanRule::JsonRequest);
        assert_eq!(json.removed_comments, 1);
        assert!(json.text.contains(r#"/* literal */"#));
        assert!(json.text.contains(r#"back\\slash"#));
        assert!(!json.text.contains("/* remove */"));
    }
}
