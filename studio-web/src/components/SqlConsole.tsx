import { useState } from "react";
import * as api from "../api";
import type { QueryResult, StudioModel } from "../types";
import { displayValue } from "../values";
import { SqlEditor } from "./SqlEditor";

interface Props {
  models: StudioModel[];
}

/**
 * Raw SQL surface: a CodeMirror editor over `/api/query`. Reads render in a
 * results grid; writes report the affected-row count.
 */
export function SqlConsole({ models }: Props) {
  const [sql, setSql] = useState("SELECT * FROM ");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await api.runQuery(sql));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="sql-view">
      <div className="sql-toolbar">
        <button className="primary" disabled={running} onClick={() => void run()}>
          {running ? "Running…" : "Run ▸"}
        </button>
        <span className="muted">⌘/Ctrl + Enter · Ctrl + Space to complete</span>
      </div>
      <SqlEditor value={sql} models={models} onChange={setSql} onRun={() => void run()} />
      <div className="sql-result">
        {error && <div className="banner error">{error}</div>}
        {!error && result && <ResultGrid result={result} />}
      </div>
    </div>
  );
}

function ResultGrid({ result }: { result: QueryResult }) {
  if (result.rows === undefined) {
    return <p className="result-note">Statement executed · {result.rowCount} row(s) affected.</p>;
  }
  const columns = result.columns ?? [];
  if (result.rows.length === 0) {
    return <p className="result-note">0 rows.</p>;
  }
  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>
                  <span className={row[c] == null ? "null" : undefined}>
                    {row[c] == null ? "NULL" : displayValue(row[c])}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
