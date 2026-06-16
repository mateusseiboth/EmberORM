import type { StudioModel } from "../types";

interface Props {
  models: StudioModel[];
  counts: Record<string, number | undefined>;
  selected: string | null;
  onSelect: (name: string) => void;
}

export function Sidebar({ models, counts, selected, onSelect }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">◆</span> EmberStudio
      </div>
      <nav>
        {models.map((m) => (
          <button
            key={m.name}
            className={m.name === selected ? "model active" : "model"}
            onClick={() => onSelect(m.name)}
          >
            <span className="model-name">{m.name}</span>
            <span className="model-count">{counts[m.name] ?? "·"}</span>
          </button>
        ))}
        {models.length === 0 && <p className="empty">No models in schema.</p>}
      </nav>
    </aside>
  );
}
