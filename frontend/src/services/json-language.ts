import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  Language,
  LanguageSupport,
  LRLanguage,
} from "@codemirror/language";
import { jsonLanguage } from "@codemirror/lang-json";
import { Parser, type Input, type TreeFragment } from "@lezer/common";
import { maskBlockComments, scanBlockComments } from "./json-comments";

const base = LRLanguage.define({
  name: "json",
  parser: jsonLanguage.parser,
  languageData: {
    closeBrackets: { brackets: ["[", "{", '"'] },
    indentOnInput: /^\s*[}\]]$/,
    commentTokens: { block: { open: "/*", close: "*/" } },
  },
});

// The Lezer JSON grammar has no comment tokens. Masking complete comments as
// whitespace before parsing keeps brace matching, indentation and folding tied
// to the active JSON while offsets stay aligned with the editor document.
// Fragments describe the raw document; closing or reopening a comment changes
// the masked text without a matching raw change, so old fragments are unsafe.
class CommentMaskingParser extends Parser {
  constructor(private readonly inner: Parser) {
    super();
  }
  createParse(
    input: Input,
    _fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ) {
    return this.inner.startParse(
      maskBlockComments(input.read(0, input.length)),
      [],
      ranges,
    );
  }
}
const maskedParser = new CommentMaskingParser(base.parser);
const language = new Language(base.data, maskedParser, [], "json");

const commentMark = Decoration.mark({ class: "cm-comment" });
function commentDecorations(view: EditorView) {
  const builder = new RangeSetBuilder<Decoration>();
  for (const comment of scanBlockComments(view.state.doc.toString()).comments)
    builder.add(comment.from, comment.to, commentMark);
  return builder.finish();
}
const commentHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = commentDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = commentDecorations(update.view);
    }
  },
  { decorations: (value) => value.decorations },
);

export function jsonCommentSupport() {
  return new LanguageSupport(language, commentHighlight);
}
