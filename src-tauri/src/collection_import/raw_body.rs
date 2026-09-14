pub(super) struct CleanedBody {
    pub text: String,
    pub removed_comments: usize,
    pub unterminated_comment: bool,
}

// Remove only complete block comments outside quoted strings. Whitespace keeps
// tokens separated (1/*comment*/2 must not become 12), line endings and byte
// positions intact. Never parse/re-serialize the payload or echo it in diagnostics.
pub(super) fn strip_block_comments(raw: &str) -> CleanedBody {
    let bytes = raw.as_bytes();
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
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == delimiter {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'"' | b'\'') {
            quote = Some(byte);
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            // Line comments stay literal, but quotes/block markers within one
            // are not syntax. This also leaves unquoted http:// text alone.
            while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
                index += 1;
            }
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            let Some(end) = raw[index + 2..].find("*/") else {
                // Do not guess where an unfinished comment ends and discard
                // the remaining payload. Keep it and let the importer warn.
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
