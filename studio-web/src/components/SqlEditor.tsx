import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { sql, type SQLNamespace } from "@codemirror/lang-sql";
import type { StudioModel } from "../types";

interface Props {
  value: string;
  models: StudioModel[];
  onChange: (value: string) => void;
  onRun: () => void;
}

/**
 * Map the studio schema to lang-sql's completion namespace, keyed by the
 * *database* names (`@map` / `@@map`), not the Ember model/field names — those
 * are what raw SQL must reference. Names are inserted unquoted: Firebird
 * resolves unquoted identifiers case-insensitively, whereas quoting a name that
 * doesn't match the stored case verbatim fails with "Table unknown".
 */
function completionSchema(models: StudioModel[]): SQLNamespace {
  const out: Record<string, SQLNamespace> = {};
  for (const m of models) {
    out[m.dbName] = m.fields
      .filter((f) => f.kind !== "object")
      .map((f) => f.dbName);
  }
  return out;
}

/** Dark theme tuned to the studio palette, incl. the autocomplete tooltip. */
const darkTheme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "#e6e9ef", height: "100%" },
    ".cm-content": { caretColor: "#ff7849" },
    ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, monospace" },
    ".cm-gutters": { backgroundColor: "#161922", color: "#8a93a6", border: "none" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.03)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(255,120,73,0.25)",
    },
    ".cm-tooltip": {
      backgroundColor: "#1c2030",
      border: "1px solid #262b3a",
      color: "#e6e9ef",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      maxHeight: "16em",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "#ff7849",
      color: "#1a0e08",
    },
    ".cm-completionIcon": { color: "#8a93a6" },
    ".cm-completionMatchedText": { color: "#ffb088", textDecoration: "none" },
  },
  { dark: true },
);

/**
 * CodeMirror 6 SQL editor: syntax highlighting + schema-aware autocompletion
 * (Ctrl+Space, via basicSetup's completion keymap). Cmd/Ctrl+Enter runs.
 */
export function SqlEditor({ value, models, onChange, onRun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  // Keep the latest callbacks reachable from the (statically built) editor.
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          // Registered before basicSetup so Mod-Enter wins over default bindings.
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                onRunRef.current();
                return true;
              },
            },
          ]),
          basicSetup,
          sql({ schema: completionSchema(models), upperCaseKeywords: true }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          darkTheme,
        ],
      }),
    });
    return () => view.destroy();
    // Rebuild only when the completion schema (models) changes.
  }, [models]);

  return <div className="sql-editor" ref={host} />;
}
