import { describe, expect, it } from "vitest";
import { CurlImportError, parseCurl, validateRequestUrl } from "./curl-import";

describe("cURL text import (never executes a command)", () => {
  it("keeps an absolute URL, duplicate query parameters and duplicate headers", () => {
    const { content } = parseCurl("curl 'https://example.test/users?a=1&a=2' -H 'X-Test: first' -H 'X-Test: second'");
    expect(content.method).toBe("GET");
    expect(content.url).toBe("https://example.test/users");
    expect(content.params.map(row => [row.name, row.value])).toEqual([["a", "1"], ["a", "2"]]);
    expect(content.params.every(row => row.enabled && row.description === "")).toBe(true);
    expect(content.params[0]?.id).not.toBe(content.params[1]?.id);
    expect(content.headers.map(row => [row.name, row.value])).toEqual([["X-Test", "first"], ["X-Test", "second"]]);
    expect(content.headers[0]?.id).not.toBe(content.headers[1]?.id);
    expect(content.bodyKind).toBe("none");
  });
  it("imports Chrome-style line continuation, inline JSON and an explicit method", () => {
    const source = "curl 'https://example.test/users' \\\n -X PATCH \\\n -H 'Content-Type: application/json' \\\n --data-raw '{\"name\":\"日本語\",\"enabled\":true}'";
    const { content } = parseCurl(source);
    expect(content.method).toBe("PATCH");
    expect(content.body).toBe('{"name":"日本語","enabled":true}');
    expect(content.bodyKind).toBe("json");
    expect(content.headers).toHaveLength(1);
  });
  it("supports attached flags, equals arguments and empty literal payloads", () => {
    const { content } = parseCurl("curl --url=https://example.test -XPOST -H'X-Test: yes' --data-raw=''");
    expect(content.method).toBe("POST");
    expect(content.bodyKind).toBe("json");
    expect(content.body).toBe("");
  });
  it("uses JSON defaults without overriding explicit content/accept headers", () => {
    const { content } = parseCurl("curl https://example.test --json '{' --json '}' -H 'Accept: text/plain'");
    expect(content.body).toBe("{}");
    expect(content.headers.map(row => [row.name, row.value])).toEqual([["Accept", "text/plain"], ["Content-Type", "application/json"]]);
  });
  it("preserves inline form encoding rather than converting the text to JSON", () => {
    const { content } = parseCurl("curl https://example.test -d 'a=1' --data-urlencode 'q=hello world'");
    expect(content.method).toBe("POST");
    expect(content.body).toBe("a=1&q=hello%20world");
    expect(content.headers[0]?.value).toBe("application/x-www-form-urlencoded");
  });
  it("moves GET data to the query without a request body", () => {
    const { content } = parseCurl("curl -G 'https://example.test/?a=1#frag' --data-urlencode 'q=two words' -d 'a=2'");
    expect(content.method).toBe("GET");
    expect(content.url).toBe("https://example.test/#frag");
    expect(content.params.map(row => [row.name, row.value])).toEqual([["a", "1"], ["q", "two words"], ["a", "2"]]);
    expect(content.bodyKind).toBe("none");
    expect(content.body).toBe("");
  });
  it("supports literal text forms and warns about regenerated multipart headers", () => {
    const { content, warnings } = parseCurl("curl https://example.test -F 'note=hello' --form-string 'literal=@file;hello' -H 'Content-Type: multipart/form-data'");
    expect(content.method).toBe("POST");
    expect(content.bodyKind).toBe("multipart");
    expect(content.formData.map(row => row.value)).toEqual(["hello", "@file;hello"]);
    expect(content.headers).toHaveLength(0);
    expect(warnings.join(" ")).toContain("boundary");
  });
  it("imports the weather query into an editable Params row", () => {
    const { content } = parseCurl("curl 'http://wttr.in?format=j1'");
    expect(content.url).toBe("http://wttr.in");
    expect(content.params.map(row => [row.name, row.value])).toEqual([["format", "j1"]]);
    const sent = new URL(content.url);
    for (const row of content.params) sent.searchParams.append(row.name, row.value);
    expect(sent.searchParams.getAll("format")).toEqual(["j1"]);
  });
  it("decodes query fields once and preserves duplicate names, blanks, Unicode and literal delimiters", () => {
    const { content, warnings } = parseCurl("curl 'https://example.test/path?q=hello+world&q=%E6%97%A5%E6%9C%AC%E8%AA%9E&empty=&flag&encoded=a%26b%3Dc%2Bd&percent=%2520&key%20name=value#section'");
    expect(content.url).toBe("https://example.test/path#section");
    expect(content.params.map(row => [row.name, row.value])).toEqual([
      ["q", "hello world"], ["q", "日本語"], ["empty", ""], ["flag", ""],
      ["encoded", "a&b=c+d"], ["percent", "%20"], ["key name", "value"],
    ]);
    expect(warnings.join(" ")).toContain("normalized");
    const sent = new URL(content.url);
    for (const row of content.params) sent.searchParams.append(row.name, row.value);
    expect([...sent.searchParams]).toEqual(content.params.map(row => [row.name, row.value]));
  });
  it("does not treat fragment text as query parameters", () => {
    const { content } = parseCurl("curl 'https://example.test/path#section?not=query'");
    expect(content.url).toBe("https://example.test/path#section?not=query");
    expect(content.params).toEqual([]);
  });
  it("imports query alongside a POST body without moving body fields to Params", () => {
    const { content } = parseCurl("curl 'https://example.test/users?active=1' -d 'name=Andri'");
    expect(content.url).toBe("https://example.test/users");
    expect(content.method).toBe("POST");
    expect(content.params.map(row => [row.name, row.value])).toEqual([["active", "1"]]);
    expect(content.body).toBe("name=Andri");
  });
  it("rejects unrepresentable or oversized query tables visibly", () => {
    for (const query of ["=value", "q=%FF", "q=%ZZ"]) {
      expect(() => parseCurl(`curl 'https://example.test/?${query}'`)).toThrow(CurlImportError);
    }
    expect(() => parseCurl(`curl 'https://example.test/?${Array.from({ length: 501 }, () => "a=1").join("&")}'`)).toThrow("500");
  });
  it("supports basic authentication and literal cookies", () => {
    const { content } = parseCurl("curl https://example.test -u 'user:password' -b 'a=1' -b 'b=2'");
    expect(content.headers.map(row => row.value)).toEqual(["Basic dXNlcjpwYXNzd29yZA==", "a=1; b=2"]);
  });
  it("supports POSIX escaped apostrophes, double quotes and ANSI-C ASCII escapes", () => {
    expect(parseCurl("curl https://example.test -d 'it'\\''s fine'").content.body).toBe("it's fine");
    expect(parseCurl(String.raw`curl https://example.test -d "say \"hello\""`).content.body).toBe('say "hello"');
    expect(parseCurl("curl https://example.test --data-raw $'line1\\nline2\\t\\x21'").content.body).toBe("line1\nline2\t!");
  });
  it("keeps shell-like text inside single-quoted data completely literal", () => {
    const { content } = parseCurl("curl https://example.test --data-raw '$(echo nope); `nope` | > $VALUE'");
    expect(content.body).toBe("$(echo nope); `nope` | > $VALUE");
  });
  it("accepts HEAD and presentation flags without extra requests", () => {
    expect(parseCurl("curl -I -sS --compressed https://example.test").content.method).toBe("HEAD");
  });
  it.each([
    "https://example.test", "curl", "curl https://example.test https://other.test",
    "curl 'https://example.test", "curl https://example.test --request",
    "curl https://example.test -k", "curl https://example.test --proxy http://proxy.test",
    "curl https://example.test --config local.conf", "curl https://example.test --data @file",
    "curl https://example.test -F 'upload=@file'", "curl https://example.test -b cookies.txt",
    "curl https://example.test; echo nope", "curl https://example.test | echo nope",
    "curl https://example.test $(echo nope)", "curl \"$BASE/path\"", "curl `nope`",
    "curl file:///tmp/example", "curl https://user:password@example.test",
    "curl https://example.test --request TRACE", "curl https://example.test -H 'Host: other.test'",
    "curl https://example.test -d value -F note=hello", "curl -I https://example.test -d body",
    "curl https://example.test --header $'X-Test: injected\\nvalue'",
  ])("rejects unsupported/unsafe syntax: %s", source => {
    expect(() => parseCurl(source)).toThrow(CurlImportError);
  });
});

describe("new HTTP request URL validation", () => {
  it("allows a blank initial URL and rejects relative URLs", () => {
    expect(validateRequestUrl("")).toBe("");
    expect(validateRequestUrl("https://example.test/users")).toBe("https://example.test/users");
    expect(() => validateRequestUrl("/users")).toThrow();
  });
  it.each(["ftp://example.test", "//other.test", "https://example.test/a b", "https://example.test/\\oops"])("rejects %s", url => {
    expect(() => validateRequestUrl(url)).toThrow();
  });
});
