import { describe, expect, it } from "vitest";
import { HEADER_NAMES, headerValueSuggestions } from "./header-suggestions";

describe("offline header suggestions", () => {
  it("offers Content headers and Cookie for Co without forbidden transport headers", () => {
    const names = HEADER_NAMES.filter(name => name.toLowerCase().startsWith("co"));
    expect(names).toContain("Content-Type");
    expect(names).toContain("Content-Encoding");
    expect(names).toContain("Cookie");
    for (const name of ["host", "content-length", "transfer-encoding", "connection", "upgrade", "trailer", "proxy-authorization", "proxy-connection", "te"])
      expect(HEADER_NAMES.map(item => item.toLowerCase())).not.toContain(name);
    expect(new Set(HEADER_NAMES).size).toBe(HEADER_NAMES.length);
  });
  it("looks up value suggestions by trimmed, case-insensitive header name", () => {
    expect(headerValueSuggestions(" CONTENT-TYPE ")).toContain("application/json");
    expect(headerValueSuggestions("Accept")).toContain("*/*");
    expect(headerValueSuggestions("Authorization")).toContain("Bearer ");
    expect(headerValueSuggestions("Accept-Encoding")).toContain("gzip");
  });
  it("does not invent values or credentials for custom, dynamic or inherited property names", () => {
    for (const name of ["X-Custom", "X-API-Key", "Cookie", "<<header_name>>", "toString", "constructor", "__proto__", ""])
      expect(headerValueSuggestions(name)).toEqual([]);
  });
});
