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
  StarterKit.configure({
    blockquote: false,
    link: { openOnClick: false, protocols: ["folio-page", "folio-asset"] },
  }),
  Placeholder.configure({ placeholder: "考えを書き留める…  / でコマンド" }),
  TaskList,
  TaskItem.configure({
    nested: true,
    HTMLAttributes: { "data-type": "taskItem" },
  }),
  Quote,
  Toggle.configure({ persist: true }),
  DetailsContent,
  DetailsSummary,
  Image.configure({ allowBase64: true }),
  Markdown,
];

export const documentSchema = getSchema(extensions());
