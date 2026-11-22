// Decode only the POSIX word syntax emitted by the cURL generator. Tests never
// start a shell or execute generated commands.
#[derive(Debug)]
struct Token {
    text: String,
    from: usize,
    to: usize,
    quoted: bool,
}

fn scan_tokens(code: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < code.len() {
        let character = code[index..].chars().next().expect("non-empty suffix");
        if character.is_whitespace() {
            index += character.len_utf8();
            continue;
        }
        if character == '\\' && code[index + 1..].starts_with('\n') {
            index += 2;
            continue;
        }
        let from = index;
        let mut text = String::new();
        let mut started = false;
        while index < code.len() {
            let character = code[index..].chars().next().expect("non-empty suffix");
            if character.is_whitespace() {
                break;
            }
            if character == '\'' {
                started = true;
                index += character.len_utf8();
                let mut closed = false;
                while index < code.len() {
                    let quoted = code[index..].chars().next().expect("non-empty suffix");
                    if quoted == '\'' {
                        index += quoted.len_utf8();
                        closed = true;
                        break;
                    }
                    text.push(quoted);
                    index += quoted.len_utf8();
                }
                if !closed {
                    return Err("unterminated POSIX single quote".into());
                }
                continue;
            }
            if character == '\\' && code[index + 1..].starts_with('\n') {
                index += 2;
                continue;
            }
            if character == '\\' {
                let Some(escaped) = code[index + 1..].chars().next() else {
                    return Err("incomplete POSIX escape".into());
                };
                text.push(escaped);
                index += 1 + escaped.len_utf8();
                started = true;
                continue;
            }
            text.push(character);
            index += character.len_utf8();
            started = true;
        }
        if started {
            tokens.push(Token {
                text,
                from,
                to: index,
                quoted: code.as_bytes().get(from) == Some(&b'\''),
            });
        }
    }
    Ok(tokens)
}

fn require_newline(code: &str, token: &Token) -> Result<(), String> {
    if code.as_bytes().get(token.to) == Some(&b'\n') {
        Ok(())
    } else {
        Err("expected one command per stdin group line".into())
    }
}

fn token_raw<'a>(code: &'a str, token: &Token) -> &'a str {
    &code[token.from..token.to]
}

fn option_token(token: &Token, name: &str) -> bool {
    !token.quoted && token.text == name
}

fn validate_curl_tail(tokens: &[Token], stdin: bool) -> Result<(), String> {
    let Some(first) = tokens.first() else {
        return Err("curl command is missing".into());
    };
    if first.quoted || first.text != "--globoff" {
        return Err("unexpected cURL command prefix".into());
    }
    let raw_flags = tokens
        .iter()
        .filter(|token| option_token(token, "--data-raw"))
        .count();
    let stdin_flags = tokens
        .iter()
        .filter(|token| option_token(token, "--data-binary"))
        .count();
    let (expected_flag, expected_value, actual_flags) = if stdin {
        ("--data-binary", "@-", stdin_flags)
    } else {
        ("--data-raw", "payload", raw_flags)
    };
    if actual_flags != 1 {
        return Err(format!("expected one {expected_flag} flag"));
    }
    let unexpected_flags = if stdin { raw_flags } else { stdin_flags };
    if unexpected_flags != 0 {
        return Err("conflicting cURL body flags".into());
    }
    let Some((index, _)) = tokens
        .iter()
        .enumerate()
        .rev()
        .find(|(_, token)| option_token(token, expected_flag))
    else {
        return Err(format!("missing {expected_flag} flag"));
    };
    let Some(value) = tokens.get(index + 1) else {
        return Err(format!("missing {expected_flag} value"));
    };
    if stdin && (!value.quoted || value.text != expected_value) {
        return Err("curl must read the stdin payload with @-".into());
    }
    if !stdin && !value.quoted {
        return Err("data-raw payload must be one quoted argument".into());
    }
    if index + 2 != tokens.len() {
        return Err("unexpected tokens after the cURL body flag".into());
    }
    Ok(())
}

pub(crate) fn arguments(code: &str) -> Vec<String> {
    scan_tokens(code)
        .expect("generated POSIX command")
        .into_iter()
        .map(|token| token.text)
        .collect()
}

pub(crate) fn printf_chunks(code: &str) -> Result<Vec<String>, String> {
    let tokens = scan_tokens(code)?;
    let Some(open) = tokens.first() else {
        return Err("empty generated command".into());
    };
    if token_raw(code, open) != "{" {
        return Err("large cURL payload must use a stdin group".into());
    }
    require_newline(code, open)?;
    let mut chunks = Vec::new();
    let mut index = 1;
    loop {
        let Some(token) = tokens.get(index) else {
            return Err("unterminated stdin group".into());
        };
        if code[token.from..].starts_with("} | curl") {
            index += 3;
            break;
        }
        if token_raw(code, token) != "printf" {
            return Err("only printf commands are allowed in the stdin group".into());
        }
        index += 1;
        let Some(format) = tokens.get(index) else {
            return Err("missing printf format".into());
        };
        if token_raw(code, format) != "'%s'" {
            return Err("printf must use the exact %s format".into());
        }
        index += 1;
        let Some(chunk) = tokens.get(index) else {
            return Err("missing printf payload".into());
        };
        let raw = token_raw(code, chunk);
        if !raw.starts_with('\'') || !raw.ends_with('\'') {
            return Err("printf payload must be one quoted argument".into());
        }
        require_newline(code, chunk)?;
        chunks.push(chunk.text.clone());
        index += 1;
    }
    if chunks.is_empty() {
        return Err("stdin group has no payload chunks".into());
    }
    let Some(separator) = tokens.get(index - 3) else {
        return Err("missing stdin pipe".into());
    };
    if token_raw(code, separator) != "}" {
        return Err("invalid stdin group separator".into());
    }
    let Some(pipe) = tokens.get(index - 2) else {
        return Err("missing stdin pipe".into());
    };
    if token_raw(code, pipe) != "|" {
        return Err("invalid stdin pipe".into());
    }
    let Some(curl) = tokens.get(index - 1) else {
        return Err("missing curl command".into());
    };
    if token_raw(code, curl) != "curl" {
        return Err("stdin group must pipe into curl".into());
    }
    validate_curl_tail(&tokens[index..], true)?;
    Ok(chunks)
}

pub(crate) fn curl_payload_result(code: &str) -> Result<Vec<u8>, String> {
    let tokens = scan_tokens(code)?;
    let Some(first) = tokens.first() else {
        return Err("empty generated command".into());
    };
    if token_raw(code, first) == "{" {
        return Ok(printf_chunks(code)?
            .into_iter()
            .flat_map(String::into_bytes)
            .collect());
    }
    if token_raw(code, first) != "curl" {
        return Err("generated command must start with curl".into());
    }
    validate_curl_tail(&tokens[1..], false)?;
    let payload = tokens
        .last()
        .expect("validated data-raw payload")
        .text
        .clone();
    Ok(payload.into_bytes())
}

pub(crate) fn curl_payload(code: &str) -> Vec<u8> {
    curl_payload_result(code).expect("generated cURL payload")
}
