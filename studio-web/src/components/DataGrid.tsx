import { useState, type UIEvent } from "react";
import type { Row, SortOrder, StudioModel } from "../types";
import { displayValue, editValue } from "../values";

interface Props {
  model: StudioModel;
  rows: Row[];
  sort: { field: string; order: SortOrder } | null;
  onSort: (field: string) => void;
  onEdit: (row: Row, field: string, raw: string) => Promise<void>;
  onDelete: (row: Row) => Promise<void>;
  onFollowRelation: (targetModel: string, where: Record<string, unknown>) => void;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
}

export function DataGrid({
  model,
  rows,
  sort,
  onSort,
  onEdit,
  onDelete,
  onFollowRelation,
  onScroll,
}: Props) {
  const [editing, setEditing] = useState<{ rowIdx: number; field: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Columns: scalars + enums inline; relations shown as a link to the target.
  const columns = model.fields.filter((f) => !f.isList);

  async function commit(row: Row) {
    const cell = editing;
    setEditing(null);
    if (!cell) return;
    try {
      await onEdit(row, cell.field, draft);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="grid-wrap" onScroll={onScroll}>
      {error && <div className="banner error">{error}</div>}
      <table className="grid">
        <thead>
          <tr>
            {columns.map((f) => (
              <th
                key={f.name}
                className={f.kind === "object" ? "rel" : undefined}
                onClick={() => f.kind !== "object" && onSort(f.name)}
                title={f.kind === "object" ? "relation" : `${f.type}${f.isId ? " · id" : ""}`}
              >
                {f.name}
                {sort?.field === f.name && <span className="caret">{sort.order === "asc" ? " ▲" : " ▼"}</span>}
              </th>
            ))}
            <th className="actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {columns.map((f) => {
                if (f.kind === "object") {
                  return (
                    <td key={f.name} className="rel">
                      <RelationCell field={f} row={row} onFollow={onFollowRelation} />
                    </td>
                  );
                }
                const isEditing = editing?.rowIdx === rowIdx && editing.field === f.name;
                const editable = !f.isId && !f.isGenerated;
                return (
                  <td
                    key={f.name}
                    className={editable ? "editable" : undefined}
                    onDoubleClick={() => {
                      if (!editable) return;
                      setEditing({ rowIdx, field: f.name });
                      setDraft(editValue(row[f.name]));
                    }}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commit(row)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commit(row);
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                    ) : (
                      <span className={row[f.name] == null ? "null" : undefined}>
                        {row[f.name] == null ? "NULL" : displayValue(row[f.name])}
                      </span>
                    )}
                  </td>
                );
              })}
              <td className="actions">
                <button
                  className="icon danger"
                  title="Delete row"
                  onClick={() => {
                    if (confirm("Delete this row? This cannot be undone.")) {
                      void onDelete(row).catch((e) =>
                        setError(e instanceof Error ? e.message : String(e)),
                      );
                    }
                  }}
                >
                  🗑
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty" colSpan={columns.length + 1}>
                No rows.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function RelationCell({
  field,
  row,
  onFollow,
}: {
  field: { name: string; type: string; relation?: { fields?: string[]; references?: string[] } };
  row: Row;
  onFollow: (targetModel: string, where: Record<string, unknown>) => void;
}) {
  const fks = field.relation?.fields ?? [];
  const refs = field.relation?.references ?? [];
  // Only the FK-holding side can build a lookup into the related model.
  if (fks.length === 0 || fks.length !== refs.length) {
    return <span className="muted">{field.type}</span>;
  }
  const where: Record<string, unknown> = {};
  let hasValue = false;
  fks.forEach((fk, i) => {
    const value = row[fk];
    if (value != null) hasValue = true;
    where[refs[i] as string] = value;
  });
  if (!hasValue) return <span className="null">NULL</span>;
  return (
    <button className="link" onClick={() => onFollow(field.type, where)}>
      {field.type} →
    </button>
  );
}
