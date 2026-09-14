// Offline suggestions, not validation or an exhaustive HTTP registry.
// Keep client-owned transport/proxy headers out: execution/http.rs rejects them.
const mediaTypes = [
  "application/json", "application/problem+json", "application/ld+json",
  "application/xml", "application/x-www-form-urlencoded", "application/octet-stream",
  "application/graphql", "application/graphql-response+json", "application/pdf",
  "application/zip", "application/x-ndjson", "application/cbor", "application/msgpack",
  "multipart/form-data", "text/plain", "text/html", "text/xml", "text/csv",
  "text/event-stream", "image/png", "image/jpeg", "image/webp", "image/svg+xml",
] as const;

export const HEADER_NAMES: readonly string[] = [
  "A-IM", "Accept", "Accept-Charset", "Accept-Datetime", "Accept-Encoding",
  "Accept-Language", "Accept-Patch", "Accept-Post", "Accept-Ranges",
  "Access-Control-Request-Headers", "Access-Control-Request-Method",
  "Authorization", "Cache-Control", "Content-Disposition", "Content-Encoding",
  "Content-Language", "Content-Location", "Content-MD5", "Content-Range", "Content-Type",
  "Cookie", "Date", "Depth", "Destination", "Digest", "DNT", "Expect", "Forwarded",
  "From", "Idempotency-Key", "If", "If-Match", "If-Modified-Since", "If-None-Match",
  "If-Range", "If-Unmodified-Since", "Last-Event-ID", "Link", "Lock-Token",
  "Max-Forwards", "Origin", "Overwrite", "Pragma", "Prefer", "Priority", "Range",
  "Referer", "Sec-CH-UA", "Sec-CH-UA-Mobile", "Sec-CH-UA-Platform",
  "Sec-Fetch-Dest", "Sec-Fetch-Mode", "Sec-Fetch-Site", "Sec-Fetch-User",
  "Timeout", "Traceparent", "Tracestate", "Upgrade-Insecure-Requests", "User-Agent",
  "Want-Digest", "X-API-Key", "X-Client-ID", "X-Correlation-ID", "X-CSRF-Token",
  "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-HTTP-Method-Override",
  "X-Request-ID", "X-Requested-With", "X-XSRF-Token",
].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const languages = ["en", "en-US", "en-GB", "id", "id-ID", "fr", "de", "es", "ja", "ko", "zh-CN"];
const values: Readonly<Record<string, readonly string[]>> = {
  accept: [...mediaTypes, "*/*", "application/*", "text/*", "image/*"],
  "accept-charset": ["utf-8", "iso-8859-1", "*"],
  "accept-encoding": ["gzip", "deflate", "br", "identity", "gzip, deflate, br", "*"],
  "accept-language": [...languages, "en-US,en;q=0.9", "id-ID,id;q=0.9,en;q=0.8", "*"],
  "accept-patch": ["application/json-patch+json", "application/merge-patch+json"],
  "accept-post": mediaTypes,
  "accept-ranges": ["bytes", "none"],
  "access-control-request-headers": ["authorization", "content-type", "authorization, content-type", "x-api-key"],
  "access-control-request-method": methods,
  authorization: ["Bearer ", "Basic ", "Digest "],
  "cache-control": ["no-cache", "no-store", "max-age=0", "max-age=3600", "max-stale", "min-fresh=60", "no-transform", "only-if-cached"],
  "content-disposition": ["inline", "attachment"],
  "content-encoding": ["gzip", "deflate", "br"],
  "content-language": languages,
  "content-type": [...mediaTypes, "application/json; charset=utf-8", "text/plain; charset=utf-8"],
  depth: ["0", "1", "infinity"],
  dnt: ["0", "1"],
  expect: ["100-continue"],
  "if-match": ["*"],
  "if-none-match": ["*"],
  "max-forwards": ["0", "10", "70"],
  overwrite: ["T", "F"],
  pragma: ["no-cache"],
  prefer: ["return=minimal", "return=representation", "respond-async", "wait=10", "handling=strict", "handling=lenient"],
  priority: ["u=0", "u=1", "u=3", "u=7", "u=3, i"],
  range: ["bytes=0-", "bytes=0-1023", "bytes=-1024"],
  "sec-ch-ua-mobile": ["?0", "?1"],
  "sec-ch-ua-platform": ['"macOS"', '"Windows"', '"Linux"', '"Android"', '"iOS"'],
  "sec-fetch-dest": ["empty", "document", "image", "script", "style", "font"],
  "sec-fetch-mode": ["cors", "no-cors", "same-origin", "navigate"],
  "sec-fetch-site": ["same-origin", "same-site", "cross-site", "none"],
  "sec-fetch-user": ["?1"],
  timeout: ["Infinite", "Second-60", "Second-3600"],
  "upgrade-insecure-requests": ["1"],
  "want-digest": ["sha-256", "sha-512"],
  "x-forwarded-proto": ["http", "https"],
  "x-http-method-override": methods,
  "x-requested-with": ["XMLHttpRequest"],
};
const noSuggestions: readonly string[] = [];

export function headerValueSuggestions(name: string): readonly string[] {
  const key = name.trim().toLowerCase();
  return Object.hasOwn(values, key) ? values[key]! : noSuggestions;
}
