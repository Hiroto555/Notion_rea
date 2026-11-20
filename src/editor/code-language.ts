import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);
export const codeLanguages = lowlight.listLanguages().sort();
export const HighlightedCodeBlock = CodeBlockLowlight.configure({
  // Unlabelled or unfamiliar fences remain plain text. Guessing a language
  // would run every grammar on every edit to these existing documents.
  lowlight: {
    ...lowlight,
    highlightAuto: (code: string) => lowlight.highlight("plaintext", code),
  },
});
