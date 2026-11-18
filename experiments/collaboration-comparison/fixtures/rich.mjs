const text = (value, marks) =>
  marks ? { type: "text", text: value, marks } : { type: "text", text: value };

const paragraph = (id, content) => ({
  type: "paragraph",
  attrs: { id },
  content,
});

export function simpleDocument() {
  return {
    type: "doc",
    content: [paragraph("p1", [text("abc")]), paragraph("p2", [text("xyz")])],
  };
}

export function richDocument() {
  return {
    type: "doc",
    schemaVersion: 2,
    content: [
      {
        type: "heading",
        attrs: { id: "h-intro", level: 2 },
        content: [text("Rich "), text("blocks", [{ type: "bold" }])],
      },
      {
        type: "paragraph",
        attrs: { id: "p-marks" },
        content: [
          text("plain "),
          text("bold", [{ type: "bold" }]),
          text(" "),
          text("italic", [{ type: "italic" }]),
          text(" "),
          text("strike", [{ type: "strike" }]),
          text(" "),
          text("underline", [{ type: "underline" }]),
          text(" "),
          text("code", [{ type: "code" }]),
          text(" "),
          text("link", [
            {
              type: "link",
              attrs: { href: "https://example.com/folio" },
            },
          ]),
          { type: "hardBreak" },
          text("after break"),
        ],
      },
      {
        type: "blockquote",
        attrs: { id: "quote" },
        content: [paragraph("p-quote", [text("Quoted text")])],
      },
      {
        type: "bulletList",
        attrs: { id: "bullets" },
        content: [
          {
            type: "listItem",
            attrs: { id: "bullet-1" },
            content: [paragraph("p-bullet-1", [text("First bullet")])],
          },
          {
            type: "listItem",
            attrs: { id: "bullet-2" },
            content: [paragraph("p-bullet-2", [text("Second bullet")])],
          },
        ],
      },
      {
        type: "orderedList",
        attrs: { id: "numbers" },
        content: [
          {
            type: "listItem",
            attrs: { id: "number-1" },
            content: [paragraph("p-number-1", [text("First item")])],
          },
          {
            type: "listItem",
            attrs: { id: "number-2" },
            content: [paragraph("p-number-2", [text("Second item")])],
          },
        ],
      },
      {
        type: "taskList",
        attrs: { id: "tasks" },
        content: [
          {
            type: "taskItem",
            attrs: { id: "task-1", checked: true },
            content: [paragraph("p-task-1", [text("Done task")])],
          },
          {
            type: "taskItem",
            attrs: { id: "task-2", checked: false },
            content: [paragraph("p-task-2", [text("Open task")])],
          },
        ],
      },
      {
        type: "codeBlock",
        attrs: { id: "code", language: "js" },
        content: [text("const x = 1;")],
      },
      { type: "horizontalRule", attrs: { id: "rule" } },
      {
        type: "image",
        attrs: {
          id: "image",
          src: "https://example.com/folio.png",
          alt: "Folio",
          title: "Folio",
        },
      },
      {
        type: "details",
        attrs: { id: "details", open: true },
        content: [
          {
            type: "detailsSummary",
            attrs: { id: "details-summary" },
            content: [text("Details summary")],
          },
          {
            type: "detailsContent",
            attrs: { id: "details-content" },
            content: [paragraph("p-details", [text("Details body")])],
          },
        ],
      },
      {
        type: "callout",
        attrs: { id: "callout", tone: "tip" },
        content: [paragraph("p-callout", [text("Callout body")])],
      },
      {
        type: "table",
        attrs: { id: "table" },
        content: [
          {
            type: "tableRow",
            attrs: { id: "row-1" },
            content: [
              {
                type: "tableHeader",
                attrs: { id: "header-1" },
                content: [paragraph("p-header-1", [text("A")])],
              },
              {
                type: "tableHeader",
                attrs: { id: "header-2" },
                content: [paragraph("p-header-2", [text("B")])],
              },
            ],
          },
          {
            type: "tableRow",
            attrs: { id: "row-2" },
            content: [
              {
                type: "tableCell",
                attrs: { id: "cell-1" },
                content: [paragraph("p-cell-1", [text("1")])],
              },
              {
                type: "tableCell",
                attrs: { id: "cell-2" },
                content: [paragraph("p-cell-2", [text("2")])],
              },
            ],
          },
        ],
      },
    ],
  };
}
