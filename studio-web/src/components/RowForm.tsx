import { useState } from "react";
import type { StudioModel, StudioSchema } from "../types";
import { inputKind, parseInput } from "../values";

interface Props {
  model: StudioModel;
  schema: StudioSchema;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

/** Drawer with a generated form to create a new record. */
export function RowForm({ model, schema, onSubmit, onClose }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Scalar/enum fields the user can set (skip relations and DB-generated cols).
  const editable = model.fields.filter(
    (f) => f.kind !== "object" && !f.isGenerated,
  );

  function set(name: string, value: string) {
    setValues((v) => ({ ...v, [name]: value }));
    setTouched((t) => ({ ...t, [name]: true }));
  }

  async function submit() {
    setError(null);
    const data: Record<string, unknown> = {};
    for (const f of editable) {
      const parsed = parseInput(f, values[f.name] ?? "", touched[f.name] ?? false);
      if (parsed !== undefined) data[f.name] = parsed;
    }
    setBusy(true);
    try {
      await onSubmit(data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>New {model.name}</h2>
          <button className="icon" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="drawer-body">
          {editable.map((f) => {
            const kind = inputKind(f);
            const enumDef =
              f.kind === "enum" ? schema.enums.find((e) => e.name === f.type) : undefined;
            return (
              <label key={f.name} className="field">
                <span className="field-label">
                  {f.name}
                  <em>
                    {f.type}
                    {f.isRequired ? " *" : "?"}
                  </em>
                </span>
                {kind === "checkbox" ? (
                  <input
                    type="checkbox"
                    checked={values[f.name] === "true"}
                    onChange={(e) => set(f.name, e.target.checked ? "true" : "false")}
                  />
                ) : kind === "select" && enumDef ? (
                  <select value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)}>
                    <option value="">—</option>
                    {enumDef.values.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={kind === "datetime" ? "datetime-local" : "text"}
                    value={values[f.name] ?? ""}
                    placeholder={f.hasDefault ? "(default)" : ""}
                    onChange={(e) =>
                      set(
                        f.name,
                        kind === "datetime" && e.target.value
                          ? new Date(e.target.value).toISOString()
                          : e.target.value,
                      )
                    }
                  />
                )}
              </label>
            );
          })}
          {error && <p className="error">{error}</p>}
        </div>
        <footer>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}
