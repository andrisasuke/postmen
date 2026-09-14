import type { NewRequestContent } from "../types/data";
import { newRow } from "../types/data";
import { methods, type HttpMethod } from "../types/shell";

export class CurlImportError extends Error {}
const fail = (message: string): never => { throw new CurlImportError(message); };
export const hasControlCharacters = (value: string) => [...value].some(char => {
  const code = char.charCodeAt(0);
  return code < 32 || (code >= 127 && code <= 159);
});

export function emptyRequestContent(): NewRequestContent {
  return { method: "GET", url: "", bodyKind: "none", body: "", params: [], headers: [], formData: [] };
}

// A text lexer, NOT a shell. No eval, subprocess, file access, environment
// expansion, command substitution or network requests are used by this importer.
function tokenize(source: string): string[] {
  if (source.length > 1024 * 1024 || new TextEncoder().encode(source).length > 1024 * 1024) fail("The cURL command is limited to 1 MiB.");
  if (source.includes("\0")) fail("The cURL command contains a null character.");
  const tokens: string[] = [];
  let token = "", started = false, quote: "single" | "double" | "ansi" | null = null;
  const push = () => {
    if (started) tokens.push(token);
    if (tokens.length > 4096) fail("The cURL command has too many arguments.");
    token = ""; started = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quote === "single") {
      if (char === "'") quote = null;
      else token += char;
      continue;
    }
    if (quote === "ansi") {
      if (char === "'") { quote = null; continue; }
      if (char !== "\\") { token += char; continue; }
      const escape = source[++i];
      const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"' };
      if (escape && escape in simple) token += simple[escape];
      else if (escape === "u" || escape === "x") {
        const length = escape === "u" ? 4 : 2;
        const hex = source.slice(i + 1, i + 1 + length);
        if (hex.length !== length || !/^[a-f\d]+$/i.test(hex)) fail("Invalid escaped character in cURL text.");
        const code = parseInt(hex, 16);
        if (!code) fail("Null bytes cannot be imported.");
        if ((escape === "x" && code > 127) || (code >= 0xd800 && code <= 0xdfff))
          fail("Use literal Unicode instead of non-ASCII byte or surrogate escapes.");
        token += String.fromCharCode(code); i += length;
      } else fail("Unsupported escape in cURL text. Use literal text or JSON escapes inside single quotes.");
      continue;
    }
    if (char === "\\") {
      const next = source[++i];
      if (next === undefined) fail("The cURL command ends with an incomplete escape.");
      if (next === "\n") continue;
      if (next === "\r" && source[i + 1] === "\n") { i++; continue; }
      started = true;
      // POSIX double quotes only remove backslashes before these characters.
      token += quote === "double" && !['"', "\\", "$", "`"].includes(next!) ? `\\${next}` : next!;
      continue;
    }
    if (char === '"') {
      quote = quote === "double" ? null : "double"; started = true; continue;
    }
    if (quote === null && char === "'") { quote = "single"; started = true; continue; }
    if (quote === null && char === "$" && source[i + 1] === "'") {
      quote = "ansi"; started = true; i++; continue;
    }
    if (char === "`" || (char === "$" && /[\w({?*#@!$-]/.test(source[i + 1] ?? "")))
      fail("Shell variables and command substitution are not supported. Paste literal values instead.");
    if (quote === null && /[;&|<>]/.test(char)) fail("Paste one cURL command, without shell operators or redirection.");
    if (quote === null && /\s/.test(char)) { push(); continue; }
    token += char; started = true;
  }
  if (quote) fail("A quoted value in the cURL command is not closed.");
  push();
  return tokens;
}

export function validateRequestUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return ""; // An ordinary HTTP request may start with an empty URL.
  if (new TextEncoder().encode(trimmed).length > 8192 || hasControlCharacters(trimmed) || trimmed.includes(" ") || trimmed.includes("\\"))
    fail("Use a URL up to 8192 bytes without spaces, control characters or backslashes.");
  let parsed: URL;
  try { parsed = new URL(trimmed); }
  catch { return fail("Enter an absolute HTTP(S) URL."); }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || trimmed.startsWith("//"))
    fail("Use HTTP(S) without embedded credentials. Put authentication in a header instead.");
  return trimmed;
}

export function parseCurl(source: string): { content: NewRequestContent; warnings: string[] } {
  const tokens = tokenize(source.trim());
  if (!["curl", "curl.exe"].includes(tokens.shift() ?? "")) fail("Paste a command beginning with curl.");
  const content = emptyRequestContent();
  const warnings: string[] = ["Sending uses PostMen's TLS verification, timeout and redirect policy, not a cURL process."];
  let url: string | undefined, explicitMethod: HttpMethod | undefined, head = false, get = false;
  let bodyMode: "data" | "json" | "form" | null = null, basic: string | undefined;
  const chunks: string[] = [];
  const cookies: string[] = [];
  let literalUrls = false;
  const setUrl = (value: string) => {
    if (url !== undefined) fail("Import one request at a time; multiple URLs are not supported.");
    url = value;
  };
  const mode = (value: typeof bodyMode) => {
    if (bodyMode && bodyMode !== value) fail("Mixed body modes are not supported. Use data, JSON, or form fields separately.");
    bodyMode = value;
  };
  const header = (value: string) => {
    const colon = value.indexOf(":");
    const empty = colon < 0 && value.endsWith(";");
    if (colon < 1 && !empty) fail("Headers must use 'Name: value'. Header files are not supported.");
    const name = empty ? value.slice(0, -1) : value.slice(0, colon);
    const text = empty ? "" : value.slice(colon + 1).trim();
    if (!/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name) || /[\r\n\0]/.test(text)) fail("Invalid header name or value.");
    if (["host", "content-length", "transfer-encoding", "connection", "upgrade", "trailer", "proxy-authorization", "proxy-connection", "te"].includes(name.toLowerCase()))
      fail("Host, proxy and transport/framing headers are managed by PostMen. Remove these custom headers before importing.");
    if (!empty && !text) fail("cURL header suppression (Name:) is not supported. Use Name; to import an empty header.");
    content.headers.push({ ...newRow(), name, value: text });
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (literalUrls) { setUrl(token); continue; }
    if (token === "--") { literalUrls = true; continue; }
    if (!token.startsWith("-")) { setUrl(token); continue; }
    let flag = token, attached: string | undefined;
    if (token.startsWith("--") && token.includes("=")) {
      const index = token.indexOf("="); flag = token.slice(0, index); attached = token.slice(index + 1);
    } else if (/^-[XHdbuAF]/.test(token) && token.length > 2) {
      flag = token.slice(0, 2); attached = token.slice(2);
    }
    const argument = () => {
      const value = attached ?? tokens[++i];
      if (value === undefined || (attached === undefined && value.startsWith("--"))) fail("A cURL option is missing its value.");
      return value!;
    };
    if (flag === "--url") setUrl(argument());
    else if (["-X", "--request"].includes(flag)) {
      const value = argument();
      if (!methods.includes(value as HttpMethod)) fail("Supported methods: GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS.");
      explicitMethod = value as HttpMethod;
    } else if (["-H", "--header"].includes(flag)) header(argument());
    else if (["-u", "--user"].includes(flag)) {
      basic = argument();
      if (!basic.includes(":")) fail("Basic authentication needs an explicit username:password; interactive prompts are not supported.");
    } else if (["-b", "--cookie"].includes(flag)) {
      const value = argument();
      if (!value.includes("=")) fail("Cookie files are not supported. Paste a literal Cookie header instead.");
      cookies.push(value);
    } else if (["-A", "--user-agent"].includes(flag)) header(`User-Agent: ${argument()}`);
    else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json"].includes(flag)) {
      mode(flag === "--json" ? "json" : "data");
      let value = argument();
      if (flag !== "--data-raw" && value.startsWith("@")) fail("Reading body data from files/stdin is not supported. Paste the body directly.");
      if (flag === "--data-urlencode") {
        const index = value.indexOf("=");
        if (index < 0 && value.includes("@")) fail("File-based URL-encoded data is not supported.");
        value = index < 0 ? encodeURIComponent(value) : index === 0 ? encodeURIComponent(value.slice(1)) : `${value.slice(0, index)}=${encodeURIComponent(value.slice(index + 1))}`;
      }
      chunks.push(value);
    } else if (["-F", "--form", "--form-string"].includes(flag)) {
      mode("form");
      const value = argument(), index = value.indexOf("=");
      if (index < 1) fail("Form fields must use name=value.");
      const text = value.slice(index + 1);
      if (flag !== "--form-string" && (/^[@<]/.test(text) || text.includes(";")))
        fail("File uploads and extended form attributes are not imported. Select files in the Body editor after creating a request.");
      content.formData.push({ ...newRow(), name: value.slice(0, index), value: text, kind: "text", attachmentId: null });
    } else {
      if (attached !== undefined) fail("Unexpected value on a cURL flag.");
      if (["-I", "--head"].includes(flag)) head = true;
      else if (["-G", "--get"].includes(flag)) get = true;
      else if (["-L", "--location"].includes(flag)) warnings.push("PostMen follows same-origin redirects only. Cross-origin redirects remain visible as 3xx responses.");
      else if (["--compressed", "--silent", "--show-error", "--verbose", "--include", "--globoff", "-g"].includes(flag) || /^-[sSvi]+$/.test(flag)) { /* Transport/display defaults; no shell side effects. */ }
      else fail("This cURL option is not supported. Import URL, method, headers, inline body or text form fields only; TLS-disable, proxy, file and execution options are not accepted.");
    }
  }
  if (!url) fail("The cURL command needs one HTTP(S) URL.");
  content.url = validateRequestUrl(url!);
  if (get && (bodyMode === "form" || bodyMode === "json")) fail("--get with JSON or multipart data is not supported.");
  if (head && bodyMode && !get) fail("HEAD with a request body is not supported.");
  if (head && explicitMethod && explicitMethod !== "HEAD") fail("Combining --head with a different --request method is not supported.");
  content.method = explicitMethod ?? (head ? "HEAD" : get ? "GET" : bodyMode ? "POST" : "GET");
  const hasHeader = (name: string) => content.headers.some(row => row.name.toLowerCase() === name.toLowerCase());
  if (basic !== undefined && !hasHeader("Authorization")) {
    const bytes = new TextEncoder().encode(basic);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    header(`Authorization: Basic ${btoa(binary)}`);
  }
  if (cookies.length && !hasHeader("Cookie")) header(`Cookie: ${cookies.join("; ")}`);
  const body = chunks.join(bodyMode === "json" ? "" : "&");
  if (get && chunks.length) {
    const parsed = new URL(content.url);
    parsed.search = parsed.search ? `${parsed.search}&${body}` : body;
    content.url = validateRequestUrl(parsed.toString());
  } else if (bodyMode === "form") {
    content.bodyKind = "multipart";
    if (hasHeader("Content-Type")) {
      content.headers = content.headers.filter(row => row.name.toLowerCase() !== "content-type");
      warnings.push("Multipart Content-Type and boundary are generated by PostMen when sending.");
    }
  } else if (bodyMode) {
    content.bodyKind = "json"; // Existing raw-text body editor; text is never reserialized.
    content.body = body;
    if (!hasHeader("Content-Type")) header(`Content-Type: ${bodyMode === "json" ? "application/json" : "application/x-www-form-urlencoded"}`);
    if (bodyMode === "json" && !hasHeader("Accept")) header("Accept: application/json");
  }
  // Query rows are the only source of imported query parameters at Send.
  // Leaving the same query in the URL would append every parameter twice.
  const queryStart = content.url.indexOf("?");
  const fragmentStart = content.url.indexOf("#");
  if (queryStart >= 0 && (fragmentStart < 0 || queryStart < fragmentStart)) {
    const rawQuery = content.url.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
    try { decodeURIComponent(rawQuery.replace(/\+/g, " ")); }
    catch { fail("Query parameters must use valid percent-encoded UTF-8 before importing into Params."); }
    for (const [name, value] of new URLSearchParams(rawQuery)) {
      if (!name) fail("Query parameters without a name cannot be represented in the Params table.");
      content.params.push({ ...newRow(), name, value });
    }
    content.url = content.url.slice(0, queryStart) + (fragmentStart < 0 ? "" : content.url.slice(fragmentStart));
    if (content.params.length) warnings.push("Query parameters are moved to Params and encoded when sending. Raw query spelling (such as %20 versus + or flag versus flag=) may be normalized; review signed URLs before sending.");
  }
  if (content.params.length > 500 || content.headers.length > 500 || content.formData.length > 500) fail("At most 500 parameters, headers or form fields per table can be imported.");
  if (new TextEncoder().encode(content.body).length > 2 * 1024 * 1024) fail("The imported body exceeds the 2 MiB saved body limit.");
  if ([...content.params, ...content.headers, ...content.formData].some(row => new TextEncoder().encode(row.name).length > 8192 || new TextEncoder().encode(row.value).length > 65536))
    fail("An imported parameter, header or form field exceeds the saved value limit.");
  return { content, warnings: [...new Set(warnings)] };
}
