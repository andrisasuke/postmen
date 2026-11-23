import { describe, expect, it } from "vitest";
import { jsonLanguage } from "@codemirror/lang-json";
import {
  describeJsonDiagnostic,
  formatJsonBody,
  jsonCommentDiagnostics,
  maskBlockComments,
  scanBlockComments,
} from "./json-comments";

const sample = `{
  /*
  "name": "versi lama",
  "number": 0
  */
  "name": "test/* */",
  "number": 1
}`;
const active = { name: "test/* */", number: 1 };

function comments(text: string) {
  return scanBlockComments(text).comments.map((comment) =>
    text.slice(comment.from, comment.to),
  );
}
function compact(text: string) {
  return maskBlockComments(text).replace(/\s+/g, "");
}
const leafNames: Record<string, true> = {
  "{": true,
  "}": true,
  "[": true,
  "]": true,
  ":": true,
  ",": true,
  PropertyName: true,
  String: true,
  Number: true,
  True: true,
  False: true,
  Null: true,
};
function sequence(text: string) {
  const parts: { from: number; text: string }[] = [];
  jsonLanguage.parser.parse(maskBlockComments(text)).iterate({
    enter(node) {
      if (leafNames[node.name])
        parts.push({ from: node.from, text: text.slice(node.from, node.to) });
    },
  });
  for (const comment of scanBlockComments(text).comments)
    parts.push({
      from: comment.from,
      text: text.slice(comment.from, comment.to),
    });
  return parts.sort((left, right) => left.from - right.from).map((part) => part.text);
}

describe("request JSON block comments", () => {
  it("finds complete blocks only outside double-quoted strings", () => {
    const scan = scanBlockComments(sample);
    expect(scan.unterminated).toBeNull();
    expect(scan.comments).toHaveLength(1);
    expect(sample.slice(scan.comments[0]!.from, scan.comments[0]!.to)).toBe(
      '/*\n  "name": "versi lama",\n  "number": 0\n  */',
    );
    expect(comments("'/*single*/' // /*line*/")).toEqual([
      "/*single*/",
      "/*line*/",
    ]);
    const escaped = String.raw`{"key":"say \"/* literal */\"","value":/* remove */1}`;
    const escapedScan = scanBlockComments(escaped);
    expect(escapedScan.comments).toHaveLength(1);
    expect(
      escaped.slice(escapedScan.comments[0]!.from, escapedScan.comments[0]!.to),
    ).toBe("/* remove */");
  });

  it("marks only an unclosed opening marker", () => {
    const text = '{"a":1}/* complete *//* unfinished';
    const scan = scanBlockComments(text);
    expect(comments(text)).toEqual(["/* complete */"]);
    expect(scan.unterminated).toBe(text.lastIndexOf("/*"));
  });

  it("ends a malformed JSON string at a newline before recognizing comments", () => {
    const raw = '"unfinished\n/* remove */1';
    expect(comments(raw)).toEqual(["/* remove */"]);
    expect(maskBlockComments(raw)).not.toContain("/* remove */");
  });

  it("ends broken strings before escaped LF and CRLF line breaks", () => {
    for (const lineBreak of ["\n", "\r\n"]) {
      const prefix = '"broken\\';
      const complete = `${prefix}${lineBreak}/* complete */"`;
      expect(comments(complete)).toEqual(["/* complete */"]);
      const unfinished = `${prefix}${lineBreak}/* unfinished`;
      expect(scanBlockComments(unfinished).unterminated).toBe(
        unfinished.indexOf("/*"),
      );
    }
    expect(
      comments(String.raw`{"s":"line\n quote\" slash\\ /* literal */"}`),
    ).toEqual([]);
  });

  it("masks complete comments without merging tokens or removing line endings", () => {
    const raw = "{\r\n  /* 日\n  private */\n  \"n\": 1/* note */2\r\n}";
    const masked = maskBlockComments(raw);
    expect(masked).toHaveLength(raw.length);
    expect(masked).not.toContain("/*");
    expect(masked).not.toContain("private");
    expect(masked).not.toContain("12");
    expect(masked.includes("1 ")).toBe(true);
    expect(masked.split(/\r\n|\r|\n/).length).toBe(
      raw.split(/\r\n|\r|\n/).length,
    );
  });

  it("validates with JSON.parse at original offsets, including deep JSON", () => {
    expect(jsonCommentDiagnostics(sample)).toEqual([]);

    const missingComma = '{\n/* multiline\ncomment */\n"a":1\n"b":2\n}';
    const diagnostic = jsonCommentDiagnostics(missingComma)[0];
    expect(diagnostic?.from).toBeGreaterThanOrEqual(
      missingComma.indexOf("1") + 1,
    );
    expect(diagnostic?.from).toBeLessThanOrEqual(
      missingComma.indexOf('"b"'),
    );
    expect(diagnostic?.message).toBeTruthy();

    const separated = '{"n":1/* note */2}';
    const separatedDiagnostic = jsonCommentDiagnostics(separated)[0];
    expect(separatedDiagnostic?.from).toBe(separated.indexOf("2"));

    const deep = "/* top */" + "[".repeat(5000) + "0" + "]".repeat(5000);
    expect(jsonCommentDiagnostics(deep)).toEqual([]);
  });

  it("uses the explicit SyntaxError offset for escaped-comment errors", () => {
    const invalid = String.raw`/* note */{"a":"ok\u12z4"}`;
    const diagnostic = jsonCommentDiagnostics(invalid)[0];
    expect(diagnostic?.from).toBe(invalid.indexOf("z"));
    expect(diagnostic?.to).toBe(invalid.indexOf("z") + 1);
  });

  it("does not read position-like body snippets as parser offsets", () => {
    for (const invalid of ["/**/@at position 0", "/**/@at line 1 column 1"]) {
      const diagnostic = jsonCommentDiagnostics(invalid)[0];
      expect(diagnostic?.from).toBe(invalid.indexOf("@"));
    }
  });

  it("keeps literal markers in keys and values with escaped quote and backslash", () => {
    const markers = String.raw`{"na/*me*/":"back\\slash say \"/*lue*/\"","n":1}`;
    expect(comments(markers)).toEqual([]);
    expect(jsonCommentDiagnostics(markers)).toEqual([]);
    expect(JSON.parse(maskBlockComments(markers))).toEqual({
      "na/*me*/": 'back\\slash say "/*lue*/"',
      n: 1,
    });
    expect(jsonCommentDiagnostics('{"s":"/* unterminated marker"}')).toEqual([]);
  });

  it("reports the unclosed block instead of hiding it in the linter", () => {
    const text = '{"a":1}/* unfinished';
    const diagnostic = jsonCommentDiagnostics(text)[0];
    expect(diagnostic?.from).toBe(text.indexOf("/*"));
    expect(diagnostic?.message).toContain("Unclosed block comment");
  });

  it("formats active JSON while preserving comment text, order and relative position", () => {
    const formatted = formatJsonBody(sample);
    expect(formatted.json).toBe(true);
    expect(formatted.limited).toBe(false);
    expect(formatted.unterminated).toBe(false);
    expect(formatted.body).toContain('"name": "versi lama"');
    expect(formatted.body).toContain('"name": "test/* */"');
    expect(formatted.body).toContain('"number": 1');
    expect(JSON.parse(maskBlockComments(formatted.body))).toEqual(active);

    const inline = formatJsonBody('{"a":/* before */1,"b":2/* after */}').body;
    expect(inline.indexOf("/* before */")).toBeGreaterThan(
      inline.indexOf('"a":'),
    );
    expect(inline.indexOf("/* before */")).toBeLessThan(inline.indexOf("1"));
    expect(inline.indexOf("/* after */")).toBeGreaterThan(inline.indexOf("2"));
    expect(JSON.parse(maskBlockComments(inline))).toEqual({ a: 1, b: 2 });

    const multiline = '{\n/* exact\n  spacing */\n"a":1\n}';
    expect(formatJsonBody(multiline).body).toContain("/* exact\n  spacing */");
  });

  it("keeps adjacent comments and end-of-document comments in source order", () => {
    const adjacent = '{"a":1,\n/* first */ /* second */"b":2}';
    const formattedAdjacent = formatJsonBody(adjacent);
    expect(formattedAdjacent.json).toBe(true);
    expect(comments(formattedAdjacent.body)).toEqual([
      "/* first */",
      "/* second */",
    ]);
    expect(compact(formattedAdjacent.body)).toBe(compact(adjacent));

    const trailing = '{"a":1} /* first */\n/* second */';
    const formattedTrailing = formatJsonBody(trailing);
    expect(comments(formattedTrailing.body)).toEqual([
      "/* first */",
      "/* second */",
    ]);
    expect(compact(formattedTrailing.body)).toBe(compact(trailing));

    const leading = '/* first */\n/* second */\n{"a":1}';
    const formattedLeading = formatJsonBody(leading);
    expect(comments(formattedLeading.body)).toEqual([
      "/* first */",
      "/* second */",
    ]);
    expect(compact(formattedLeading.body)).toBe(compact(leading));

    const indented = '{"a":1,\n/* line one\n    line two */\n"b":2}';
    const formattedIndented = formatJsonBody(indented).body;
    expect(formattedIndented).toContain("/* line one\n    line two */");
    expect(comments(formattedIndented)).toEqual([
      "/* line one\n    line two */",
    ]);
  });

  it("keeps every comment between the same active tokens", () => {
    for (const source of [
      '{"a":1/* between */,"b":2}',
      '{"a":1,\n/* first */ /* second */"b":2}',
      '{"a":/* before */1/* after */,"b":2}',
      '/* first */\n{"a":1} /* last */',
    ]) {
      const formatted = formatJsonBody(source);
      expect(formatted.json).toBe(true);
      expect(sequence(formatted.body)).toEqual(sequence(source));
      expect(comments(formatted.body)).toEqual(comments(source));
    }
  });

  it("keeps strings and escaped quotes literal during formatting", () => {
    const raw = String.raw`{"text":"say \"/* marker */\"","n":1}`;
    const formatted = formatJsonBody(raw);
    expect(formatted.json).toBe(true);
    expect(formatted.body).toContain(String.raw`"say \"/* marker */\""`);
    expect(JSON.parse(maskBlockComments(formatted.body))).toEqual({
      text: 'say "/* marker */"',
      n: 1,
    });
  });

  it("keeps the original text when formatting is unsafe or invalid", () => {
    const unclosed = '{"a":1}/* unfinished';
    expect(formatJsonBody(unclosed)).toEqual({
      body: unclosed,
      json: false,
      limited: false,
      unterminated: true,
    });
    const invalid = '{"a":1 /* note */ "b":2}';
    expect(formatJsonBody(invalid)).toEqual({
      body: invalid,
      json: false,
      limited: false,
      unterminated: false,
    });
    const deep = "/* comment */" + "[".repeat(65) + "0" + "]".repeat(65);
    expect(formatJsonBody(deep)).toEqual({
      body: deep,
      json: false,
      limited: true,
      unterminated: false,
    });
  });

  it("checks active depth before Lezer recovery", () => {
    const source = (depth: number) =>
      "/* note */" +
      "[".repeat(depth) +
      `"[]{}/*x*/"` +
      "]".repeat(depth);
    const atLimit = formatJsonBody(source(64));
    expect(atLimit.json).toBe(true);
    expect(atLimit.limited).toBe(false);
    for (const depth of [65, 3000]) {
      const body = source(depth);
      expect(formatJsonBody(body)).toEqual({
        body,
        json: false,
        limited: true,
        unterminated: false,
      });
    }
  });

  it("bounds actual formatted output before exceeding the existing limit", () => {
    const comments = Array.from({ length: 20_000 }, () => "/*c*/").join("\n");
    const source = "[".repeat(64) + comments + "0" + "]".repeat(64);
    expect(source.length).toBeLessThan(2 * 1024 * 1024);
    expect(formatJsonBody(source)).toEqual({
      body: source,
      json: false,
      limited: true,
      unterminated: false,
    });
  });

  it("measures Unicode formatted output in UTF-8 bytes", () => {
    const source = "/*" + "日".repeat(699_046) + "*/\n[1,2]";
    // Formatting would add 7 bytes and reach 2_097_155, so it must abort.
    expect(new TextEncoder().encode(source).length).toBe(2_097_148);
    expect(formatJsonBody(source)).toEqual({
      body: source,
      json: false,
      limited: true,
      unterminated: false,
    });
  });

  it("bounds flat arrays whose formatted output exceeds the limit", () => {
    const values = Array.from({ length: 500_000 }, () => "0").join(",");
    const source = `/*c*/[${values}]`;
    expect(source.length).toBeLessThan(2 * 1024 * 1024);
    expect(formatJsonBody(source)).toEqual({
      body: source,
      json: false,
      limited: true,
      unterminated: false,
    });
  });

  it("accepts the 2 MiB boundary after a final standalone comment", () => {
    const boundary = (contentBytes: number, fill: string) => {
      const width = new TextEncoder().encode(fill).length;
      const content =
        fill.repeat(Math.floor(contentBytes / width)) +
        "a".repeat(contentBytes % width);
      return `[1,2]\n/*${content}*/`;
    };
    const cases = [
      { content: 2_097_134, expected: 2_097_151, accepted: true },
      { content: 2_097_135, expected: 2_097_152, accepted: true },
      { content: 2_097_136, expected: 2_097_153, accepted: false },
    ];
    for (const { content, expected, accepted } of cases) {
      const source = boundary(content, "😀");
      const result = formatJsonBody(source);
      if (!accepted) {
        expect(result).toEqual({
          body: source,
          json: false,
          limited: true,
          unterminated: false,
        });
        continue;
      }
      expect(result.json).toBe(true);
      expect(result.limited).toBe(false);
      expect(new TextEncoder().encode(result.body).length).toBe(expected);
      expect(result.body.endsWith("*/")).toBe(true);
      expect(result.body.endsWith("\n")).toBe(false);
    }
    const ascii = formatJsonBody(boundary(2_097_135, "a"));
    expect(ascii.json).toBe(true);
    expect(new TextEncoder().encode(ascii.body).length).toBe(2_097_152);
  });

  it("formats small output from near-2 MiB source whitespace", () => {
    const source = "/* c */" + " ".repeat(2 * 1024 * 1024 - 14) + "[1,2]";
    const formatted = formatJsonBody(source);
    expect(formatted.json).toBe(true);
    expect(formatted.limited).toBe(false);
    expect(formatted.body).toContain("/* c */");
    expect(formatted.body).toContain("[\n  1,\n  2\n]");
  });

  it("leaves JSON without comments on the existing formatter path", () => {
    const raw = '{"name":"test","n":1}';
    expect(formatJsonBody(raw)).toEqual({
      body: JSON.stringify(JSON.parse(raw), null, 2),
      json: true,
      limited: false,
      unterminated: false,
    });
  });
});

describe("JSON diagnostic detail", () => {
  function at(text: string, needle: string) {
    const from = text.indexOf(needle);
    expect(from).toBeGreaterThanOrEqual(0);
    return describeJsonDiagnostic(text, {
      from,
      to: from + needle.length,
      message: "Invalid JSON.",
    });
  }

  it("reports the 1-based line and line excerpt around the offset", () => {
    const text = '{\n  "bad": kk\n}';
    const detail = at(text, "kk");
    expect(detail.line).toBe(2);
    expect(detail.column).toBe(10);
    expect(detail.context).toBe('  "bad": kk');
    expect(detail.context[detail.pointer]).toBe("k");
    expect(detail.endOfInput).toBe(false);
  });

  it("keeps original line numbers after multi-line block comments", () => {
    const text = '{\n/* first\n   second */\n"a": 1\n"b": kk\n}';
    const detail = at(text, "kk");
    expect(detail.line).toBe(5);
    expect(detail.context).toBe('"b": kk');
    expect(detail.context[detail.pointer]).toBe("k");
  });

  it("counts CRLF as one line break", () => {
    const text = '{\r\n  "a": 1\r\n  bad: 2\r\n}';
    const detail = at(text, "bad");
    expect(detail.line).toBe(3);
    expect(detail.column).toBe(3);
    expect(detail.context).toBe("  bad: 2");
  });

  it("keeps the pointer on Unicode lines", () => {
    const text = '{\n  "日": kk\n}';
    const detail = at(text, "kk");
    expect(detail.line).toBe(2);
    expect(detail.context).toBe('  "日": kk');
    expect(detail.pointer).toBe(text.split("\n")[1]!.indexOf("k"));
    expect(detail.context[detail.pointer]).toBe("k");
  });

  it("points at the offending token after emoji and ZWJ keys", () => {
    for (const key of ["🚀", "👨‍👩‍👧"]) {
      const text = `{"${key}": kk}`;
      const diagnostic = jsonCommentDiagnostics(text)[0]!;
      const detail = describeJsonDiagnostic(text, diagnostic);
      expect(detail.line).toBe(1);
      expect(detail.column).toBe(diagnostic.from + 1);
      // The caret is inserted inline before the indexed character, so the
      // rendered alignment is independent of glyph widths (rocket is two
      // cells in Fira Code, the ZWJ family one glyph).
      expect(detail.pointer).toBe(diagnostic.from);
      expect(detail.context[detail.pointer]).toBe("k");
    }
  });

  it("marks the end of input on the last relevant line", () => {
    for (const text of ['{\n  "a": 1', '{\n  "a": 1\n', '{\n  "a": 1\n\n']) {
      const detail = describeJsonDiagnostic(text, {
        from: text.length,
        to: text.length,
        message: "Unexpected end of JSON input",
      });
      expect(detail.endOfInput).toBe(true);
      expect(detail.line).toBe(2);
      expect(detail.context).toBe('  "a": 1');
      expect(detail.pointer).toBe(detail.context.length);
      expect(detail.column).toBe(detail.context.length + 1);
    }
    const empty = describeJsonDiagnostic("", {
      from: 0,
      to: 0,
      message: "Unexpected end of JSON input",
    });
    expect(empty).toMatchObject({
      line: 1,
      column: 1,
      context: "",
      pointer: 0,
      endOfInput: true,
    });
  });

  it("bounds long lines and keeps the caret on the error", () => {
    const line = "x".repeat(200) + "bad";
    const text = `{"a":1}\n${line}`;
    const detail = at(text, "bad");
    expect(detail.line).toBe(2);
    expect(detail.context.length).toBeLessThanOrEqual(62);
    expect(detail.context.startsWith("…")).toBe(true);
    expect(detail.context[detail.pointer]).toBe("b");
  });

  it("describes parser diagnostics from the original document", () => {
    const invalid = '{\n/* note\n   spanning */\n"a": 1,\n"b": kk\n}';
    const diagnostic = jsonCommentDiagnostics(invalid)[0]!;
    const detail = describeJsonDiagnostic(invalid, diagnostic);
    expect(detail.line).toBe(5);
    expect(detail.context).toBe('"b": kk');
    expect(detail.context[detail.pointer]).toBe("k");
  });

  it("describes unclosed block comments and end-of-input errors", () => {
    const unclosed = '{\n"a": 1\n/* unfinished';
    const unclosedDiagnostic = jsonCommentDiagnostics(unclosed)[0]!;
    const unclosedDetail = describeJsonDiagnostic(unclosed, unclosedDiagnostic);
    expect(unclosedDetail.line).toBe(3);
    expect(unclosedDetail.context).toBe("/* unfinished");
    expect(unclosedDetail.context[unclosedDetail.pointer]).toBe("/");

    const truncated = '{\n  "a": 1';
    const eofDetail = describeJsonDiagnostic(
      truncated,
      jsonCommentDiagnostics(truncated)[0]!,
    );
    expect(eofDetail.line).toBe(2);
    expect(eofDetail.endOfInput).toBe(true);
    expect(eofDetail.context).toBe('  "a": 1');
  });
});
