import { useEffect, useState } from "react";
import type { StudioModel } from "../types";

interface Props {
  model: StudioModel;
  onApply: (where: Record<string, unknown> | undefined) => void;
}

/** Operators exposed in structured mode, keyed by the engine condition they build. */
const OPERATORS = [
  "equals",
  "not",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;
type Operator = (typeof OPERATORS)[number];

/**
 * Filter bar with two modes:
 *  - structured: field + operator + value, building a `WhereInput` condition.
 *  - raw: a JSON `WhereInput` object passed straight to the engine (supports
 *    AND/OR/NOT and any operator combination).
 */
export function FilterBar({ model, onApply }: Props) {
  const scalars = model.fields.filter((f) => f.kind !== "object");
  const [raw, setRaw] = useState(false);
  const [fieldName, setFieldName] = useState(scalars[0]?.name ?? "");
  const [op, setOp] = useState<Operator>("contains");
  const [value, setValue] = useState("");
  const [rawText, setRawText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset when switching models.
  useEffect(() => {
    setFieldName(scalars[0]?.name ?? "");
    setValue("");
    setRawText("");
    setError(null);
  }, [model.name]);

  function applyStructured() {
    const field = scalars.find((f) => f.name === fieldName);
    if (!field || value.trim() === "") {
      onApply(undefined);
      return;
    }
    onApply({ [fieldName]: { [op]: value } });
  }

  function applyRaw() {
    const text = rawText.trim();
    if (text === "") {
      setError(null);
      onApply(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      setError(null);
      onApply(parsed);
    } catch {
      setError("Invalid JSON");
    }
  }

  function clear() {
    setValue("");
    setRawText("");
    setError(null);
    onApply(undefined);
  }

  if (raw) {
    return (
      <div className="filter-bar raw">
        <textarea
          className="raw-where"
          placeholder='{"AND":[{"name":{"contains":"a"}}]}'
          value={rawText}
          spellCheck={false}
          onChange={(e) => setRawText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && applyRaw()}
        />
        <button onClick={applyRaw}>Filter</button>
        <button className="ghost" onClick={() => setRaw(false)} title="Use field filter">
          fields
        </button>
        {error && <span className="error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="filter-bar">
      <select value={fieldName} onChange={(e) => setFieldName(e.target.value)}>
        {scalars.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name}
          </option>
        ))}
      </select>
      <select value={op} onChange={(e) => setOp(e.target.value as Operator)}>
        {OPERATORS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <input
        placeholder="filter value…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && applyStructured()}
      />
      <button onClick={applyStructured}>Filter</button>
      <button className="ghost" onClick={() => setRaw(true)} title="Raw WhereInput (JSON)">
        raw
      </button>
      {value && (
        <button className="ghost" onClick={clear}>
          Clear
        </button>
      )}
    </div>
  );
}
