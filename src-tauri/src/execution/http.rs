use super::models::{ExecutionResult, ResponseHeader};
use crate::{
    db::{repository as repo, Database},
    error::{AppError, AppResult},
    models::RequestDoc,
};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE},
    Client, Method, Url,
};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

pub const PREVIEW_LIMIT: usize = 1024 * 1024;
pub const UPLOAD_LIMIT: u64 = 100 * 1024 * 1024;

pub fn client() -> AppResult<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.error("Redirect limit exceeded");
            }
            if !["http", "https"].contains(&attempt.url().scheme())
                || (attempt
                    .previous()
                    .last()
                    .is_some_and(|u| u.scheme() == "https")
                    && attempt.url().scheme() == "http")
                || !attempt.url().username().is_empty()
                || attempt.url().password().is_some()
            {
                return attempt.error("Unsafe redirect rejected");
            }
            // Do not forward user-supplied secret headers to another origin.
            // Show the 3xx response instead; the user can explicitly request it.
            if attempt
                .previous()
                .last()
                .is_some_and(|u| u.origin() != attempt.url().origin())
            {
                return attempt.stop();
            }
            attempt.follow()
        }))
        .gzip(true)
        .deflate(true)
        .brotli(true)
        .no_proxy()
        .build()
        .map_err(|_| {
            AppError::new(
                "HTTP_INIT_ERROR",
                "The secure HTTP client could not be initialized.",
            )
        })
}
pub fn compose_url(doc: &RequestDoc) -> AppResult<Url> {
    let raw = doc.url.trim();
    if raw.starts_with("//") || raw.contains('\\') {
        return Err(AppError::invalid(
            "Use an absolute HTTP(S) URL without backslashes.",
        ));
    }
    let mut url = Url::parse(raw).map_err(|_| {
        AppError::invalid(
            "Enter an absolute HTTP(S) URL, or use <<api_url>> from the selected environment.",
        )
    })?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::invalid(
            "Use an HTTP(S) URL without embedded credentials.",
        ));
    }
    url.set_fragment(None);
    for row in doc
        .params
        .iter()
        .filter(|r| r.enabled && !r.name.is_empty())
    {
        url.query_pairs_mut().append_pair(&row.name, &row.value);
    }
    Ok(url)
}
pub fn headers(doc: &RequestDoc) -> AppResult<HeaderMap> {
    let mut headers = HeaderMap::new();
    for row in doc
        .headers
        .iter()
        .filter(|r| r.enabled && !r.name.is_empty())
    {
        let name = HeaderName::from_bytes(row.name.as_bytes())
            .map_err(|_| AppError::invalid("Invalid HTTP header name."))?;
        if [
            "host",
            "content-length",
            "transfer-encoding",
            "connection",
            "upgrade",
            "trailer",
            "proxy-authorization",
            "proxy-connection",
            "te",
        ]
        .contains(&name.as_str())
        {
            return Err(AppError::invalid("Host, proxy and transport/framing headers are managed by the HTTP client. Disable those custom headers."));
        }
        if doc.body_kind == "multipart" && name == CONTENT_TYPE {
            continue;
        }
        let value = HeaderValue::from_bytes(row.value.as_bytes()).map_err(|_| {
            AppError::invalid("Invalid HTTP header value; newlines are not allowed.")
        })?;
        headers.append(name, value);
    }
    if doc.body_kind == "json" && !headers.contains_key(CONTENT_TYPE) {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    Ok(headers)
}
pub(super) fn is_tls_error(error: &(dyn std::error::Error + 'static), depth: usize) -> bool {
    if depth > 16 {
        return false;
    }
    if error.is::<rustls::Error>() {
        return true;
    }
    // io::Error::source skips the wrapped error itself. hyper-rustls nests
    // an io::Error around tokio-rustls's io::Error, so inspect get_ref too.
    if let Some(inner) = error
        .downcast_ref::<std::io::Error>()
        .and_then(|e| e.get_ref())
    {
        return is_tls_error(inner, depth + 1);
    }
    error
        .source()
        .is_some_and(|source| is_tls_error(source, depth + 1))
}
fn request_error(error: reqwest::Error) -> AppError {
    // Never interpolate reqwest errors: they can include URLs and credentials.
    let tls = is_tls_error(&error, 0);
    if error.is_timeout() {
        AppError::new("TIMEOUT", "The request timed out.")
    } else if error.is_redirect() {
        AppError::new(
            "REDIRECT_ERROR",
            "The redirect limit was exceeded or an unsafe redirect was rejected.",
        )
    } else if tls {
        AppError::new(
            "TLS_ERROR",
            "TLS negotiation or certificate verification failed. TLS verification remains enabled.",
        )
    } else if error.is_connect() {
        AppError::new("CONNECTION_ERROR","Connection failed. Check the address, DNS/network and TLS certificate trust. TLS verification remains enabled.")
    } else if error.is_decode() {
        AppError::new(
            "DECODE_ERROR",
            "The response compression could not be decoded.",
        )
    } else if error.is_body() {
        AppError::new(
            "BODY_ERROR",
            "The request or response stream could not be read.",
        )
    } else {
        AppError::new("NETWORK_ERROR", "The HTTP request could not be completed.")
    }
}
pub fn decode(bytes: &[u8], content_type: &str, truncated: bool) -> (String, String, bool) {
    let kind = content_type.to_ascii_lowercase();
    let binary = !(kind.is_empty()
        || kind.starts_with("text/")
        || ["json", "xml", "javascript", "x-www-form-urlencoded", "svg"]
            .iter()
            .any(|s| kind.contains(s)));
    let label = kind.split(';').skip(1).find_map(|part| {
        part.trim()
            .strip_prefix("charset=")
            .map(|s| s.trim_matches(['\"', '\'']).trim())
    });
    let encoding = label
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let bytes = if truncated && encoding == encoding_rs::UTF_8 {
        match std::str::from_utf8(bytes) {
            Err(e) if e.error_len().is_none() => &bytes[..e.valid_up_to()],
            _ => bytes,
        }
    } else {
        bytes
    };
    let (body, _, _) = encoding.decode(bytes);
    (body.into_owned(), encoding.name().into(), binary)
}
pub async fn send(
    client: Client,
    db: Database,
    execution_id: &str,
    doc: RequestDoc,
) -> AppResult<ExecutionResult> {
    let lookup = doc.clone();
    let files = tokio::task::spawn_blocking(move || {
        db.run(|conn| repo::execution_resources(conn, &lookup))
    })
    .await
    .map_err(|_| {
        AppError::new(
            "INTERNAL_ERROR",
            "The storage worker stopped before sending.",
        )
    })??;
    let url = compose_url(&doc)?;
    let mut builder = client
        .request(
            Method::from_bytes(doc.method.as_bytes())
                .map_err(|_| AppError::invalid("Invalid method."))?,
            url,
        )
        .headers(headers(&doc)?);
    if doc.body_kind == "json" {
        builder = builder.body(doc.body.clone());
    }
    if doc.body_kind == "multipart" {
        let files: HashMap<String, PathBuf> = files.into_iter().collect();
        let mut form = reqwest::multipart::Form::new();
        let mut total = 0u64;
        for field in doc
            .form_data
            .iter()
            .filter(|r| r.enabled && !r.name.is_empty())
        {
            if field.kind == "text" {
                form = form.text(field.name.clone(), field.value.clone());
                continue;
            }
            let id = field.attachment_id.as_ref().ok_or_else(|| {
                AppError::new(
                    "FILE_UNAVAILABLE",
                    "Choose a file for each enabled multipart file field.",
                )
            })?;
            let path = files.get(id).ok_or_else(|| {
                AppError::new(
                    "FILE_UNAVAILABLE",
                    "A selected file is no longer registered. Choose it again.",
                )
            })?;
            let file = tokio::fs::File::open(path).await.map_err(|_| {
                AppError::new(
                    "FILE_UNAVAILABLE",
                    "A selected file was moved, removed, or is unreadable. Choose it again.",
                )
            })?;
            let meta = file.metadata().await.map_err(|_| {
                AppError::new("FILE_UNAVAILABLE", "A selected file cannot be inspected.")
            })?;
            total = total.saturating_add(meta.len());
            if !meta.is_file() || total > UPLOAD_LIMIT {
                return Err(AppError::new("UPLOAD_LIMIT","Multipart file uploads are limited to 100 MiB total and must be regular files."));
            }
            let filename = path
                .file_name()
                .ok_or_else(|| AppError::invalid("Invalid attachment filename."))?
                .to_string_lossy()
                .into_owned();
            let part = reqwest::multipart::Part::stream_with_length(
                reqwest::Body::wrap_stream(ReaderStream::new(file.take(meta.len()))),
                meta.len(),
            )
            .file_name(filename);
            form = form.part(field.name.clone(), part);
        }
        builder = builder.multipart(form);
    }
    let mut response = builder.send().await.map_err(request_error)?;
    let mut result = ExecutionResult::empty(execution_id, &doc.id);
    result.status = Some(response.status().as_u16());
    result.status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("Unknown")
        .into();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let mut header_bytes = 0usize;
    for (name, value) in response.headers() {
        header_bytes = header_bytes.saturating_add(name.as_str().len() + value.as_bytes().len());
        if header_bytes > 65536 || result.headers.len() >= 1000 {
            result.headers_truncated = true;
            break;
        }
        result.headers.push(ResponseHeader {
            name: name.to_string(),
            value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        let available = PREVIEW_LIMIT - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(available)]);
        if chunk.len() > available {
            result.truncated = true;
            break;
        }
    }
    result.preview_bytes = bytes.len();
    (result.body, result.body_encoding, result.binary) =
        decode(&bytes, &content_type, result.truncated);
    Ok(result)
}
