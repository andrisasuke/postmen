import { describe, it, expect } from "vitest";
import { formatResponse } from "./response-format";
describe("bounded inert response formatting", () => {
  it("formats JSON without misinterpreting quoted brackets or escapes", () => {
    const value = { name: "日本語", text: String.fromCharCode(123,91,92,34) };
    expect(formatResponse(JSON.stringify(value))).toEqual({
      body: JSON.stringify(value, null, 2),
      json: true,
      limited: false,
    });
  });
  it("leaves HTML, invalid JSON, truncated and binary data as inert raw text", () => {
    for (const body of ["<script>alert(1)</script>", "{invalid"])
      expect(formatResponse(body)).toEqual({
        body,
        json: false,
        limited: false,
      });
    expect(formatResponse('{"ok":true}', true).json).toBe(false);
    expect(formatResponse("123", false, true).json).toBe(false);
  });
  it("rejects pathological depth before pretty-print allocation", () => {
    const body = "[".repeat(1000) + "0" + "]".repeat(1000);
    expect(formatResponse(body)).toEqual({ body, json: false, limited: true });
  });
  it("bounds expansion for wide nested documents", () => {
    const body =
      "[".repeat(32) + JSON.stringify(Array(50000).fill(1)) + "]".repeat(32);
    expect(formatResponse(body).limited).toBe(true);
  });
});
