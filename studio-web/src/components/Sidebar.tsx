import type { StudioModel, StudioView } from "../types";

interface Props {
  models: StudioModel[];
  counts: Record<string, number | undefined>;
  selected: string | null;
  view: StudioView;
  onSelect: (name: string) => void;
  onView: (view: StudioView) => void;
}

const TOOLS: { view: StudioView; label: string; icon: string }[] = [
  { view: "visualizer", label: "Visualizer", icon: "◳" },
  { view: "console", label: "Console", icon: "›_" },
  { view: "sql", label: "SQL", icon: "⌘" },
];

export function Sidebar({ models, counts, selected, view, onSelect, onView }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">◆</span> EmberStudio
      </div>
      <nav>
        <div className="nav-group">Studio</div>
        {TOOLS.map((t) => (
          <button
            key={t.view}
            className={view === t.view ? "model active" : "model"}
            onClick={() => onView(t.view)}
          >
            <span className="model-name">
              <span className="tool-icon">{t.icon}</span> {t.label}
            </span>
          </button>
        ))}
        <div className="nav-group">Tables</div>
        {models.map((m) => (
          <button
            key={m.name}
            className={view === "data" && m.name === selected ? "model active" : "model"}
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
