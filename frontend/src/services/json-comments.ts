import { jsonLanguage } from "@codemirror/lang-json";
import type { Tree } from "@lezer/common";
import {
  FORMAT_DEPTH_LIMIT,
  FORMAT_OUTPUT_LIMIT,
  formatResponse,
} from "./response-format";

export interface BlockCommentRange {
  from: number;
  to: number;
}
export interface BlockCommentScan {
  comments: BlockCommentRange[];
  unterminated: number | null;
  maxDepth: number;
}
export interface JsonBodyFormat {
  body: string;
  json: boolean;
  limited: boolean;
  unterminated: boolean;
}
export interface JsonDiagnostic {
  from: number;
  to: number;
  message: string;
}
export interface JsonDiagnosticDetail {
  line: number;
  column: number;
  context: string;
  pointer: number;
  endOfInput: boolean;
}

const CONTEXT_LIMIT = 60;

function isLineBreak(code: number) {
  return code === 10 || code === 13;
}

// Fira Code renders CJK and emoji glyphs two cells wide. Count cells so the
// caret stays under the offending character while columns stay UTF-16 based,
// matching the editor's diagnostic offsets.
function monospaceWidth(text: string) {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (
      code === 0x200d ||
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0xfe00 && code <= 0xfe0f)
    )
      continue;
    width +=
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x1f900 && code <= 0x1f9ff) ||
        (code >= 0x20000 && code <= 0x3fffd))
        ? 2
        : 1;
  }
  return width;
}

// Count line breaks as CodeMirror does (CRLF is one break) so the display
// location matches the editor line numbers even in the original, unmasked
// document.
function linePosition(text: string, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (index + 1 < offset && text.charCodeAt(index + 1) === 10) index++;
      line++;
      lineStart = index + 1;
    } else if (code === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, lineStart };
}

// Present the diagnostic offset as 1-based line/column plus a bounded source
// excerpt. The excerpt keeps the pointer aligned for tabs and wide characters.
export function describeJsonDiagnostic(
  text: string,
  diagnostic: JsonDiagnostic,
): JsonDiagnosticDetail {
  const length = text.length;
  const endOfInput = diagnostic.from >= length;
  let offset = Math.max(0, Math.min(diagnostic.from, length));
  if (endOfInput) {
    while (offset > 0 && isLineBreak(text.charCodeAt(offset - 1))) offset--;
  }
  const { line, lineStart } = linePosition(text, offset);
  let lineEnd = offset;
  while (lineEnd < length && !isLineBreak(text.charCodeAt(lineEnd))) lineEnd++;
  const lineText = text.slice(lineStart, lineEnd).replace(/\t/g, " ");
  const pointerIndex = Math.max(
    0,
    Math.min(offset - lineStart, lineText.length),
  );
  let context = lineText;
  let pointer = monospaceWidth(lineText.slice(0, pointerIndex));
  if (lineText.length > CONTEXT_LIMIT) {
    const start = Math.min(
      Math.max(0, pointerIndex - Math.floor(CONTEXT_LIMIT / 2)),
      lineText.length - CONTEXT_LIMIT,
    );
    const prefix = start > 0 ? "…" : "";
    const suffix = start + CONTEXT_LIMIT < lineText.length ? "…" : "";
    pointer = monospaceWidth(prefix + lineText.slice(start, pointerIndex));
    context =
      prefix + lineText.slice(start, start + CONTEXT_LIMIT) + suffix;
  }
  return {
    line,
    column: offset - lineStart + 1,
    context,
    pointer,
    endOfInput,
  };
}

type ActiveKind = "open" | "close" | "colon" | "comma" | "scalar";
interface ActiveLeaf {
  kind: ActiveKind;
  from: number;
  to: number;
  text: string;
}
interface SeenItem {
  kind: ActiveKind | "comment";
  from: number;
  to: number;
  text: string;
}

// Only double-quoted JSON strings protect comment markers. Raw newlines end
// an invalid string so a missing quote cannot hide comments for the rest of
// the document. Complete blocks end at the first following */.
export function scanBlockComments(text: string): BlockCommentScan {
  const comments: BlockCommentRange[] = [];
  let unterminated: number | null = null;
  let maxDepth = 0;
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const character = text.charCodeAt(index);
    if (character === 34) {
      index++;
      let escaped = false;
      while (index < text.length) {
        const next = text.charCodeAt(index);
        if (next === 10 || next === 13) {
          index++;
          break;
        }
        if (escaped) {
          escaped = false;
          index++;
          continue;
        }
        if (next === 92) {
          escaped = true;
          index++;
          continue;
        }
        if (next === 34) {
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (character === 47 && text.charCodeAt(index + 1) === 42) {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) {
        unterminated = index;
        break;
      }
      comments.push({ from: index, to: end + 2 });
      index = end + 2;
      continue;
    }
    if (character === 123 || character === 91) {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    } else if (character === 125 || character === 93) {
      depth--;
    }
    index++;
  }
  return { comments, unterminated, maxDepth };
}

// Replacing every UTF-16 unit except CR/LF keeps parser and diagnostic offsets
// identical to the editor document while making comments behave as whitespace.
export function maskBlockComments(
  text: string,
  scan = scanBlockComments(text),
): string {
  if (scan.comments.length === 0) return text;
  let output = "";
  let index = 0;
  for (const comment of scan.comments) {
    output += text.slice(index, comment.from);
    output += text.slice(comment.from, comment.to).replace(/[^\r\n]/g, " ");
    index = comment.to;
  }
  output += text.slice(index);
  return output;
}

const leafKinds: Record<string, ActiveKind> = {
  "{": "open",
  "[": "open",
  "}": "close",
  "]": "close",
  ":": "colon",
  ",": "comma",
  PropertyName: "scalar",
  String: "scalar",
  Number: "scalar",
  True: "scalar",
  False: "scalar",
  Null: "scalar",
};

function offsetFromMessage(message: string, text: string): number | null {
  const position = /at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(
    message,
  );
  if (position) {
    const offset = Number(position[1]);
    return offset <= text.length ? offset : null;
  }
  const lineColumn = /at line (\d+) column (\d+)$/.exec(message);
  if (!lineColumn) return null;
  const line = Number(lineColumn[1]);
  const column = Number(lineColumn[2]);
  if (line < 1 || column < 1) return null;
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return null;
    offset = next + 1;
  }
  const target = offset + column - 1;
  return target <= text.length ? target : null;
}

// JSON.parse validates the active payload without JavaScript recursion. Its
// explicit SyntaxError offset is preferred; Lezer error nodes remain the
// fallback for engines that do not expose a readable position.
export function jsonCommentDiagnostics(text: string): JsonDiagnostic[] {
  const scan = scanBlockComments(text);
  if (scan.unterminated !== null) {
    return [
      {
        from: scan.unterminated,
        to: Math.min(scan.unterminated + 2, text.length),
        message: "Unclosed block comment. Add */ to close it.",
      },
    ];
  }
  const masked = maskBlockComments(text, scan);
  try {
    JSON.parse(masked);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON.";
    const position = offsetFromMessage(message, masked);
    if (position !== null) {
      return [
        {
          from: position,
          to: position < text.length ? position + 1 : position,
          message,
        },
      ];
    }
    const errors: JsonDiagnostic[] = [];
    jsonLanguage.parser.parse(masked).iterate({
      enter(node) {
        if (node.type.isError) {
          errors.push({
            from: node.from,
            to: Math.min(text.length, Math.max(node.to, node.from + 1)),
            message,
          });
          return false;
        }
      },
    });
    return errors.length ? [errors[0]!] : [{ from: 0, to: 0, message }];
  }
}

class FormatLimitError extends Error {}

function matchingPair(open: string, close: string) {
  return (
    (open === "{" && close === "}") || (open === "[" && close === "]")
  );
}

function utf8Length(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function treeHasErrors(tree: Tree) {
  let errors = false;
  tree.iterate({
    enter(node) {
      if (node.type.isError) {
        errors = true;
        return false;
      }
    },
  });
  return errors;
}

// Stream active leaves and comments in source order. Only one active lookahead
// and the next comment range are retained, so work and allocation stay
// proportional to the emitted result instead of the whole document.
function formatItems(
  body: string,
  tree: Tree,
  comments: BlockCommentRange[],
): string {
  const cursor = tree.topNode.cursor();
  const nextLeaf = (): ActiveLeaf | null => {
    while (cursor.next()) {
      const kind = leafKinds[cursor.name];
      if (!kind) continue;
      return {
        kind,
        from: cursor.from,
        to: cursor.to,
        text: body.slice(cursor.from, cursor.to),
      };
    }
    return null;
  };
  let current = nextLeaf();
  let next = nextLeaf();
  let commentIndex = 0;
  let previous: SeenItem | null = null;

  const chunks: string[] = [];
  let outputBytes = 0;
  let lineStart = true;
  let pendingNewline = false;
  let endsWhitespace = false;
  let lastWasComment = false;
  let level = 0;

  const write = (chunk: string) => {
    if (chunk.length === 0) return;
    const bytes = utf8Length(chunk);
    if (outputBytes + bytes > FORMAT_OUTPUT_LIMIT)
      throw new FormatLimitError();
    chunks.push(chunk);
    outputBytes += bytes;
    const last = chunk.charCodeAt(chunk.length - 1);
    lineStart = last === 10;
    endsWhitespace =
      last === 32 || last === 9 || last === 10 || last === 13;
  };
  const append = (chunk: string) => {
    if (pendingNewline) {
      pendingNewline = false;
      write("\n");
    }
    write(chunk);
  };
  const newline = () => {
    if (!lineStart) pendingNewline = true;
  };
  const atLineStart = () => lineStart || pendingNewline;
  const indent = () => {
    if (atLineStart()) append("  ".repeat(level));
    else if (lastWasComment) append(" ");
  };

  const emitComment = (
    comment: BlockCommentRange,
    nextActive: ActiveLeaf | null,
  ) => {
    const between = previous ? body.slice(previous.to, comment.from) : "";
    const sourceBreak = between.includes("\n") || between.includes("\r");
    const punctuation =
      nextActive?.kind === "comma" || nextActive?.kind === "colon";
    const text = body.slice(comment.from, comment.to);
    if (atLineStart() || (sourceBreak && !punctuation)) {
      newline();
      indent();
      append(text);
      newline();
    } else {
      if (!atLineStart() && !endsWhitespace) append(" ");
      append(text);
    }
    lastWasComment = true;
    previous = { kind: "comment", from: comment.from, to: comment.to, text };
  };
  const emitCommentsBefore = (
    limit: number,
    nextActive: ActiveLeaf | null,
  ) => {
    while (commentIndex < comments.length) {
      const comment = comments[commentIndex]!;
      if (comment.from >= limit) break;
      commentIndex++;
      emitComment(comment, nextActive);
    }
  };
  const emitActive = (leaf: ActiveLeaf, lookahead: ActiveLeaf | null) => {
    if (leaf.kind === "open") {
      indent();
      append(leaf.text);
      const nextComment = comments[commentIndex];
      const commentBetween =
        nextComment !== undefined &&
        (lookahead === null || nextComment.from < lookahead.from);
      const empty =
        lookahead !== null &&
        lookahead.kind === "close" &&
        matchingPair(leaf.text, lookahead.text) &&
        !commentBetween;
      if (!empty) {
        level++;
        newline();
      }
      lastWasComment = false;
      return;
    }
    if (leaf.kind === "close") {
      const empty =
        previous?.kind === "open" &&
        matchingPair(previous.text, leaf.text);
      if (!empty) {
        if (level > 0) level--;
        newline();
        indent();
      }
      append(leaf.text);
      lastWasComment = false;
      return;
    }
    if (leaf.kind === "comma") {
      append(",");
      newline();
      lastWasComment = false;
      return;
    }
    if (leaf.kind === "colon") {
      append(": ");
      lastWasComment = false;
      return;
    }
    indent();
    append(leaf.text);
    lastWasComment = false;
  };

  while (current !== null) {
    emitCommentsBefore(current.from, current);
    emitActive(current, next);
    previous = current;
    current = next;
    next = nextLeaf();
  }
  emitCommentsBefore(Number.POSITIVE_INFINITY, null);
  return chunks.join("");
}

export function formatJsonBody(body: string): JsonBodyFormat {
  const scan = scanBlockComments(body);
  if (scan.unterminated !== null)
    return { body, json: false, limited: false, unterminated: true };
  if (scan.comments.length === 0)
    return { ...formatResponse(body), unterminated: false };
  if (scan.maxDepth > FORMAT_DEPTH_LIMIT)
    return { body, json: false, limited: true, unterminated: false };
  const masked = maskBlockComments(body, scan);
  const tree = jsonLanguage.parser.parse(masked);
  if (treeHasErrors(tree))
    return { body, json: false, limited: false, unterminated: false };
  try {
    return {
      body: formatItems(body, tree, scan.comments),
      json: true,
      limited: false,
      unterminated: false,
    };
  } catch (error) {
    if (error instanceof FormatLimitError)
      return { body, json: false, limited: true, unterminated: false };
    throw error;
  }
}
