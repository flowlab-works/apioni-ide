// CodeMirror 6 editor: syntax highlighting, line numbers, and a near-black theme
// matching the terminal. Kept lightweight (CM6 tree-shakes) for snappy startup.
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { basicSetup } from "codemirror";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { syntaxHighlighting } from "@codemirror/language";

import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";

/** Pick a CodeMirror language extension from a file path's extension. */
function languageFor(path: string): Extension | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true });
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "py":
    case "pyw":
      return python();
    case "json":
    case "jsonc":
      return json();
    case "html":
    case "htm":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "md":
    case "markdown":
      return markdown();
    case "rs":
      return rust();
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
      return cpp();
    case "java":
      return java();
    case "php":
      return php();
    case "sql":
      return sql();
    case "xml":
    case "svg":
    case "plist":
      return xml();
    case "yaml":
    case "yml":
      return yaml();
    default:
      return null;
  }
}

// Near-black editor chrome (token colors come from oneDarkHighlightStyle).
const apioniTheme = EditorView.theme(
  {
    "&": { backgroundColor: "#0c0c0e", color: "#d4d4d4", height: "100%" },
    ".cm-scroller": {
      fontFamily: "ui-monospace, Menlo, Monaco, 'SF Mono', monospace",
      fontSize: "13px",
      lineHeight: "1.5",
    },
    ".cm-content": { caretColor: "#4a9eff" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#4a9eff" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "#264f78",
    },
    ".cm-gutters": {
      backgroundColor: "#0c0c0e",
      color: "#545862",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "#ffffff08" },
    ".cm-activeLineGutter": { backgroundColor: "#ffffff0a", color: "#7a7e86" },
    ".cm-foldPlaceholder": {
      backgroundColor: "#1c1d22",
      border: "none",
      color: "#7a7e86",
    },
    "&.cm-editor.cm-focused": { outline: "none" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "#4a9eff33",
      outline: "1px solid #4a9eff55",
    },
  },
  { dark: true },
);

export interface EditorHandle {
  view: EditorView;
  getValue(): string;
  getSelection(): string;
  selectAll(): void;
  find(): void;
  focus(): void;
  destroy(): void;
}

/** Mount a CodeMirror editor into `parent`. `onChange` fires on user edits. */
export function createEditor(
  parent: HTMLElement,
  doc: string,
  path: string,
  onChange: () => void,
): EditorHandle {
  const lang = languageFor(path);
  const extensions: Extension[] = [
    basicSetup,
    keymap.of([indentWithTab]),
    apioniTheme,
    syntaxHighlighting(oneDarkHighlightStyle),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange();
    }),
  ];
  if (lang) extensions.push(lang);

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions }),
  });
  return {
    view,
    getValue: () => view.state.doc.toString(),
    getSelection: () => {
      const r = view.state.selection.main;
      return view.state.sliceDoc(r.from, r.to);
    },
    selectAll: () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }),
    find: () => {
      view.focus();
      openSearchPanel(view);
    },
    destroy: () => view.destroy(),
    focus: () => view.focus(),
  };
}
