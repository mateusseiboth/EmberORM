import type { StudioModel, StudioSchema } from "../types";

interface Props {
  schema: StudioSchema;
  onOpenModel: (name: string) => void;
}

/**
 * Schema overview: one card per model listing its fields, with primary keys and
 * relations highlighted. Relation fields link to their target model card.
 */
export function Visualizer({ schema, onOpenModel }: Props) {
  return (
    <div className="visualizer">
      {schema.models.map((m) => (
        <ModelCard key={m.name} model={m} onOpenModel={onOpenModel} />
      ))}
      {schema.models.length === 0 && <p className="result-note">No models in schema.</p>}
    </div>
  );
}

function ModelCard({
  model,
  onOpenModel,
}: {
  model: StudioModel;
  onOpenModel: (name: string) => void;
}) {
  return (
    <div className="erd-card">
      <button className="erd-title" onClick={() => onOpenModel(model.name)}>
        {model.name}
      </button>
      <table className="erd-fields">
        <tbody>
          {model.fields.map((f) => (
            <tr key={f.name} className={f.kind === "object" ? "erd-rel" : undefined}>
              <td className="erd-field-name">
                {f.isId && <span className="erd-pk" title="primary key">🔑</span>}
                {f.name}
              </td>
              <td className="erd-field-type">
                {f.kind === "object" ? (
                  <button className="link" onClick={() => onOpenModel(f.type)}>
                    {f.type}
                    {f.isList ? "[]" : ""} →
                  </button>
                ) : (
                  <span className="muted">
                    {f.type}
                    {f.isList ? "[]" : ""}
                    {f.isRequired ? "" : "?"}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
