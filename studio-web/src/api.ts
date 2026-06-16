import type { LoggedQuery, QueryResult, Row, SortOrder, StudioSchema } from "./types";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export async function getSchema(): Promise<StudioSchema> {
  const res = await fetch("/api/schema");
  if (!res.ok) throw new Error(`Failed to load schema (${res.status})`);
  return (await res.json()) as StudioSchema;
}

export interface FindManyArgs {
  where?: Record<string, unknown>;
  orderBy?: Record<string, SortOrder>;
  skip?: number;
  take?: number;
}

export function findMany(model: string, args: FindManyArgs): Promise<{ rows: Row[] }> {
  return post(`${model}/findMany`, args);
}

export function count(
  model: string,
  where?: Record<string, unknown>,
): Promise<{ count: number }> {
  return post(`${model}/count`, { where });
}

export function createRow(model: string, data: Row): Promise<{ row: Row }> {
  return post(`${model}/create`, { data });
}

export function updateRow(
  model: string,
  where: Record<string, unknown>,
  data: Row,
): Promise<{ row: Row }> {
  return post(`${model}/update`, { where, data });
}

export function deleteRow(
  model: string,
  where: Record<string, unknown>,
): Promise<{ row: Row }> {
  return post(`${model}/delete`, { where });
}

export function runQuery(sql: string): Promise<QueryResult> {
  return post("query", { sql });
}

export async function getLog(): Promise<{ queries: LoggedQuery[] }> {
  const res = await fetch("/api/log");
  if (!res.ok) throw new Error(`Failed to load query log (${res.status})`);
  return (await res.json()) as { queries: LoggedQuery[] };
}
