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

/** Map the studio schema to lang-sql's completion schema (table → columns). */
function completionSchema(models: StudioModel[]): SQLNamespace {
  const out: SQLNamespace = {};
  for (const m of models) {
    out[m.name] = m.fields.filter((f) => f.kind !== "object").map((f) => f.name);
  }
  return out;
}

/**
 * CodeMirror 6 SQL editor. Provides syntax highlighting and schema-aware
 * autocompletion (Ctrl+Space, via `basicSetup`'s completion keymap). Cmd/Ctrl
 * +Enter runs the statement.
 */
export function SqlEditor({ value, models, onChange, onRun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
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
          EditorView.theme({
            "&": { backgroundColor: "transparent", height: "100%" },
            ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, monospace" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => view.destroy();
    // Rebuild only when the completion schema (models) changes.
  }, [models]);

  return <div className="sql-editor" ref={host} />;
}
