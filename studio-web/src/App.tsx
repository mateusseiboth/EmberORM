import { useCallback, useEffect, useMemo, useState, type UIEvent } from "react";
import * as api from "./api";
import type { Row, SortOrder, StudioModel, StudioSchema, StudioView } from "./types";
import { parseInput } from "./values";
import { Sidebar } from "./components/Sidebar";
import { DataGrid } from "./components/DataGrid";
import { FilterBar } from "./components/FilterBar";
import { RowForm } from "./components/RowForm";
import { SqlConsole } from "./components/SqlConsole";
import { QueryLog } from "./components/QueryLog";
import { Visualizer } from "./components/Visualizer";

const PAGE_SIZES = [25, 50, 100, 250];

export function App() {
  const [schema, setSchema] = useState<StudioSchema | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [view, setView] = useState<StudioView>("data");
  const [selected, setSelected] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number | undefined>>({});

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [infinite, setInfinite] = useState(false);
  // In infinite mode this is the rolling row window (skip is always 0).
  const [limit, setLimit] = useState(50);
  const [sort, setSort] = useState<{ field: string; order: SortOrder } | null>(null);
  const [where, setWhere] = useState<Record<string, unknown> | undefined>();
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const model: StudioModel | undefined = useMemo(
    () => schema?.models.find((m) => m.name === selected) ?? undefined,
    [schema, selected],
  );

  // Load schema once.
  useEffect(() => {
    api
      .getSchema()
      .then((s) => {
        setSchema(s);
        setSelected(s.models[0]?.name ?? null);
      })
      .catch((e) => setFatal(e instanceof Error ? e.message : String(e)));
  }, []);

  // Refresh row counts for the sidebar whenever the schema loads.
  useEffect(() => {
    if (!schema) return;
    for (const m of schema.models) {
      api
        .count(m.name)
        .then((r) => setCounts((c) => ({ ...c, [m.name]: r.count })))
        .catch(() => setCounts((c) => ({ ...c, [m.name]: undefined })));
    }
  }, [schema]);

  const load = useCallback(async () => {
    if (!model) return;
    setLoading(true);
    try {
      const args: api.FindManyArgs = infinite
        ? { skip: 0, take: limit }
        : { skip: page * pageSize, take: pageSize };
      if (where) args.where = where;
      if (sort) args.orderBy = { [sort.field]: sort.order };
      const [list, c] = await Promise.all([
        api.findMany(model.name, args),
        api.count(model.name, where),
      ]);
      setRows(list.rows);
      setTotal(c.count);
      setCounts((prev) => ({ ...prev, [model.name]: c.count }));
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [model, page, pageSize, infinite, limit, sort, where]);

  useEffect(() => {
    if (view === "data") void load();
  }, [load, view]);

  function resetWindow() {
    setPage(0);
    setLimit(pageSize);
  }

  function selectModel(name: string) {
    setView("data");
    setSelected(name);
    setSort(null);
    setWhere(undefined);
    setRows([]);
    resetWindow();
  }

  function changePageSize(size: number) {
    setPageSize(size);
    setPage(0);
    setLimit(size);
  }

  function toggleSort(field: string) {
    resetWindow();
    setSort((s) =>
      s?.field === field
        ? { field, order: s.order === "asc" ? "desc" : "asc" }
        : { field, order: "asc" },
    );
  }

  /** Grow the infinite window when the grid is scrolled near its bottom. */
  function onGridScroll(e: UIEvent<HTMLDivElement>) {
    if (!infinite || loading || rows.length >= total) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      setLimit((l) => l + pageSize);
    }
  }

  /** Build a primary-key `where` from a row. */
  function pkWhere(m: StudioModel, row: Row): Record<string, unknown> {
    const w: Record<string, unknown> = {};
    for (const key of m.primaryKey) w[key] = row[key];
    return w;
  }

  async function editCell(row: Row, fieldName: string, raw: string) {
    if (!model) return;
    const field = model.fields.find((f) => f.name === fieldName);
    if (!field) return;
    const value = parseInput(field, raw, true);
    if (value === undefined) return;
    await api.updateRow(model.name, pkWhere(model, row), { [fieldName]: value });
    await load();
  }

  async function deleteRow(row: Row) {
    if (!model) return;
    await api.deleteRow(model.name, pkWhere(model, row));
    await load();
  }

  function followRelation(target: string, lookup: Record<string, unknown>) {
    const eq: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(lookup)) eq[k] = { equals: v };
    setView("data");
    setSelected(target);
    setSort(null);
    setWhere(eq);
    resetWindow();
  }

  if (fatal) return <div className="fatal">Error: {fatal}</div>;
  if (!schema) return <div className="loading">Loading schema…</div>;

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="app">
      <Sidebar
        models={schema.models}
        counts={counts}
        selected={selected}
        view={view}
        onSelect={selectModel}
        onView={setView}
      />
      <main className="content">
        {view === "visualizer" && (
          <Visualizer schema={schema} onOpenModel={selectModel} />
        )}
        {view === "console" && <QueryLog />}
        {view === "sql" && <SqlConsole models={schema.models} />}
        {view === "data" &&
          (model ? (
            <>
              <header className="toolbar">
                <h1>{model.name}</h1>
                <FilterBar
                  model={model}
                  onApply={(w) => {
                    resetWindow();
                    setWhere(w);
                  }}
                />
                <div className="spacer" />
                <button className="primary" onClick={() => setCreating(true)}>
                  + Add record
                </button>
              </header>
              <DataGrid
                model={model}
                rows={rows}
                sort={sort}
                onScroll={onGridScroll}
                onSort={toggleSort}
                onEdit={editCell}
                onDelete={deleteRow}
                onFollowRelation={followRelation}
              />
              <footer className="pager">
                <span>
                  {total} row{total === 1 ? "" : "s"}
                  {where ? " (filtered)" : ""}
                  {loading ? " · loading…" : ""}
                </span>
                <div className="spacer" />
                <label className="pager-control">
                  rows
                  <select
                    value={pageSize}
                    onChange={(e) => changePageSize(Number(e.target.value))}
                  >
                    {PAGE_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="pager-control">
                  <input
                    type="checkbox"
                    checked={infinite}
                    onChange={(e) => {
                      setInfinite(e.target.checked);
                      resetWindow();
                    }}
                  />
                  infinite scroll
                </label>
                {infinite ? (
                  <span>
                    {rows.length} / {total}
                  </span>
                ) : (
                  <>
                    <button disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>
                      ‹ Prev
                    </button>
                    <span>
                      {page + 1} / {pages}
                    </span>
                    <button
                      disabled={page + 1 >= pages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next ›
                    </button>
                  </>
                )}
              </footer>
              {creating && (
                <RowForm
                  model={model}
                  schema={schema}
                  onClose={() => setCreating(false)}
                  onSubmit={async (data) => {
                    await api.createRow(model.name, data);
                    await load();
                  }}
                />
              )}
            </>
          ) : (
            <div className="loading">Select a model.</div>
          ))}
      </main>
    </div>
  );
}
