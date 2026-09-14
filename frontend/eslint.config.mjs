import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import ts from "typescript-eslint";

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs["flat/essential"],
  {
    files: ["**/*.vue"],
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
  // TypeScript checks undefined names (including DOM types) in TS and Vue SFCs.
  {
    files: ["**/*.ts", "**/*.vue"],
    rules: { "no-undef": "off", "vue/multi-word-component-names": "off" },
  },
);
