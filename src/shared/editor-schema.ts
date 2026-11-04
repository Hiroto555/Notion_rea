import {
  SimpleTable,
  SimpleTableRow,
  SimpleTableCell,
  SimpleTableHeader,
} from "../editor/simple-table";
import { Callout } from "../editor/callout";
import Paragraph from "@tiptap/extension-paragraph";
import Heading from "@tiptap/extension-heading";
// Rich Markdown is readable HTML. Preserve authored whitespace inside its
// paragraphs, while container indentation remains insignificant HTML spacing.
const FolioParagraph = Paragraph.extend({
  parseHTML() {
    return [
      {
        tag: "p",
        getAttrs: (element) =>
          element.closest("aside[data-folio-callout], table") ? null : false,
        preserveWhitespace: "full" as const,
      },
      ...(this.parent?.() ?? []),
    ];
  },
});
const FolioHeading = Heading.extend({
  parseHTML() {
    return [
      ...this.options.levels.map((level) => ({
        tag: `h${level}`,
        getAttrs: (element: HTMLElement) =>
          element.closest("aside[data-folio-callout]") ? { level } : false,
        preserveWhitespace: "full" as const,
      })),
      ...(this.parent?.() ?? []),
    ];
  },
});
import { BlockIdentity } from "../editor/block-identity";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  Details,
  DetailsContent,
  DetailsSummary,
} from "@tiptap/extension-details";
import Image from "@tiptap/extension-image";
const FolioDetailsSummary = DetailsSummary.extend({
  parseHTML() {
    return [
      {
        tag: "summary",
        getAttrs: (element: HTMLElement) =>
          element.closest("aside[data-folio-callout]") ? null : false,
        preserveWhitespace: "full" as const,
      },
      ...(this.parent?.() ?? []),
    ];
  },
});
import { Markdown } from "@tiptap/markdown";
import { InputRule, wrappingInputRule } from "@tiptap/core";
import Blockquote from "@tiptap/extension-blockquote";
const Quote = Blockquote.extend({
  addInputRules() {
    return [wrappingInputRule({ find: /^\|\s$/, type: this.type })];
  },
});
const Toggle = Details.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^>\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).setDetails().run();
        },
      }),
    ];
  },
});
import { getSchema } from "@tiptap/core";
export const extensions = () => [
  BlockIdentity,
  Callout,
  SimpleTable,
  SimpleTableRow,
  SimpleTableCell,
  SimpleTableHeader,
  StarterKit.configure({
    blockquote: false,
    paragraph: false,
    heading: false,
    link: { openOnClick: false, protocols: ["folio-page", "folio-asset"] },
  }),
  FolioParagraph,
  FolioHeading,
  Placeholder.configure({ placeholder: "考えを書き留める…  / でコマンド" }),
  TaskList,
  TaskItem.configure({
    nested: true,
    HTMLAttributes: { "data-type": "taskItem" },
  }),
  Quote,
  Toggle.configure({ persist: true }),
  DetailsContent,
  FolioDetailsSummary,
  Image.configure({ allowBase64: true }),
  Markdown,
];

export const documentSchema = getSchema(extensions());
