import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { jsonCommentSupport } from "./json-language";

describe("comment-masked JSON parser", () => {
  it("does not reuse raw-document fragments after opening or closing a long comment", () => {
    const support = jsonCommentSupport();
    const prefix =
      "[0,/*" + "0,".repeat(1000) + "[5," + "0,".repeat(2500) + "8]";
    const openDoc = prefix + ",2]";
    const insertAt = openDoc.length - 2;
    const initial = EditorState.create({
      doc: openDoc,
      extensions: [support],
    });
    ensureSyntaxTree(initial, initial.doc.length, 10000);

    const closed = initial.update({
      changes: { from: insertAt, insert: "*/" },
    }).state;
    const closedTree = ensureSyntaxTree(closed, closed.doc.length, 10000);
    const freshClosed = support.language.parser.parse(closed.doc.toString());
    expect(closedTree).not.toBeNull();
    expect(closedTree!.toString()).toBe(freshClosed.toString());
    expect((closedTree!.toString().match(/Number/g) ?? []).length).toBe(2);
    expect(syntaxTree(closed.update({}).state).toString()).toBe(
      freshClosed.toString(),
    );

    const reopened = closed.update({
      changes: { from: insertAt, to: insertAt + 2 },
    }).state;
    const reopenedTree = ensureSyntaxTree(
      reopened,
      reopened.doc.length,
      10000,
    );
    const freshReopened = support.language.parser.parse(
      reopened.doc.toString(),
    );
    expect(reopenedTree).not.toBeNull();
    expect(reopenedTree!.toString()).toBe(freshReopened.toString());
    expect(syntaxTree(reopened.update({}).state).toString()).toBe(
      freshReopened.toString(),
    );
    expect(reopenedTree!.toString()).not.toBe(closedTree!.toString());
  });
});
