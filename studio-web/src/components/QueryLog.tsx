import { useEffect, useState } from "react";
import * as api from "../api";
import type { LoggedQuery } from "../types";

/**
 * Read-only Console: streams the statements the engine has executed (polled
 * from `/api/log`). Mirrors Prisma Studio's query log — newest first.
 */
export function QueryLog() {
  const [queries, setQueries] = useState<LoggedQuery[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;
    let active = true;
    const tick = () =>
      api
        .getLog()
        .then((r) => active && setQueries(r.queries))
        .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    void tick();
    const id = setInterval(tick, 1500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [live]);

  const ordered = [...queries].reverse();

  return (
    <div className="console-view">
      <div className="sql-toolbar">
        <strong>Query log</strong>
        <span className="muted">{queries.length} statement(s)</span>
        <div className="spacer" />
        <button className={live ? "primary" : undefined} onClick={() => setLive((v) => !v)}>
          {live ? "● Live" : "Paused"}
        </button>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="console-log">
        {ordered.length === 0 && <p className="result-note">No queries yet.</p>}
        {ordered.map((q, i) => (
          <div className="log-entry" key={`${q.at}-${i}`}>
            <div className="log-meta">
              <span className="log-time">{new Date(q.at).toLocaleTimeString()}</span>
              <span className="log-stat">{q.durationMs.toFixed(1)} ms</span>
              <span className="log-stat">{q.rowCount} rows</span>
            </div>
            <pre className="log-sql">{q.sql}</pre>
            {q.params.length > 0 && (
              <div className="log-params">params: {JSON.stringify(q.params)}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
