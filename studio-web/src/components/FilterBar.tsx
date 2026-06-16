import { useEffect, useState } from "react";
import type { StudioModel } from "../types";

interface Props {
  model: StudioModel;
  onApply: (where: Record<string, unknown> | undefined) => void;
}

/**
 * Single-field filter. Builds a `WhereInput` condition: `contains` for strings,
 * `equals` for everything else.
 */
export function FilterBar({ model, onApply }: Props) {
  const scalars = model.fields.filter((f) => f.kind !== "object");
  const [fieldName, setFieldName] = useState(scalars[0]?.name ?? "");
  const [value, setValue] = useState("");

  // Reset when switching models.
  useEffect(() => {
    setFieldName(scalars[0]?.name ?? "");
    setValue("");
  }, [model.name]);

  function apply() {
    const field = scalars.find((f) => f.name === fieldName);
    if (!field || value.trim() === "") {
      onApply(undefined);
      return;
    }
    const cond = field.type === "String" ? { contains: value } : { equals: value };
    onApply({ [fieldName]: cond });
  }

  function clear() {
    setValue("");
    onApply(undefined);
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
      <input
        placeholder="filter value…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply()}
      />
      <button onClick={apply}>Filter</button>
      {value && (
        <button className="ghost" onClick={clear}>
          Clear
        </button>
      )}
    </div>
  );
}
