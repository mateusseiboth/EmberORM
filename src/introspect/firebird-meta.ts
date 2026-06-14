import type { TransactionContext } from "@ember/driver";

/** Raw column metadata as read from RDB$ system tables (already trimmed). */
export interface RawColumn {
  table: string;
  name: string;
  position: number;
  fieldType: number;
  fieldSubType: number | null;
  length: number | null;
  precision: number | null;
  scale: number | null;
  notNull: boolean;
  defaultSource: string | null;
  isIdentity: boolean;
  charLength: number | null;
}

export interface RawConstraint {
  table: string;
  type: string; // PRIMARY KEY | UNIQUE | FOREIGN KEY
  name: string;
  indexName: string | null;
  columns: string[];
  // foreign key only:
  references?: { table: string; columns: string[] };
  updateRule?: string;
  deleteRule?: string;
}

const trim = (v: unknown): string => (v == null ? "" : String(v).trim());
const numOrNull = (v: unknown): number | null =>
  v == null ? null : Number(v);

/** Reads tables, columns and constraints from Firebird's metadata catalog. */
export class FirebirdMetadataReader {
  constructor(private readonly tx: TransactionContext) {}

  async tables(): Promise<string[]> {
    const rows = await this.tx.query<{ RDB$RELATION_NAME: string }>(
      `SELECT RDB$RELATION_NAME
       FROM RDB$RELATIONS
       WHERE RDB$VIEW_BLR IS NULL
         AND (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
       ORDER BY RDB$RELATION_NAME`,
    );
    return rows.map((r) => trim(r["RDB$RELATION_NAME"]));
  }

  async columns(): Promise<RawColumn[]> {
    // RDB$IDENTITY_TYPE only exists on Firebird 3.0+; selecting it on 2.1/2.5
    // raises "column unknown". Note also the alias `CHAR_LEN`: `CHAR_LENGTH`
    // (and `CHARACTER_LENGTH`) are reserved words and cannot be used unquoted.
    // RDB$DEFAULT_SOURCE is a BLOB and is CAST to VARCHAR: node-firebird 1.1.9
    // crashes the process while decoding BLOB columns in a multi-row result set
    // (TypeError: reading 'statement'), so we never fetch it as a BLOB.
    const hasIdentity = (await this.engineMajorVersion()) >= 3;
    const identitySelect = hasIdentity
      ? "rf.RDB$IDENTITY_TYPE      AS IDENTITY_TYPE,"
      : "";
    const rows = await this.tx.query<Record<string, unknown>>(
      `SELECT
         rf.RDB$RELATION_NAME      AS TABLE_NAME,
         rf.RDB$FIELD_NAME         AS FIELD_NAME,
         rf.RDB$FIELD_POSITION     AS FIELD_POSITION,
         rf.RDB$NULL_FLAG          AS NULL_FLAG,
         CAST(rf.RDB$DEFAULT_SOURCE AS VARCHAR(8191)) AS DEFAULT_SOURCE,
         ${identitySelect}
         f.RDB$FIELD_TYPE          AS FIELD_TYPE,
         f.RDB$FIELD_SUB_TYPE      AS FIELD_SUB_TYPE,
         f.RDB$FIELD_LENGTH        AS FIELD_LENGTH,
         f.RDB$CHARACTER_LENGTH    AS CHAR_LEN,
         f.RDB$FIELD_PRECISION     AS FIELD_PRECISION,
         f.RDB$FIELD_SCALE         AS FIELD_SCALE
       FROM RDB$RELATION_FIELDS rf
       JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
       JOIN RDB$RELATIONS r ON r.RDB$RELATION_NAME = rf.RDB$RELATION_NAME
       WHERE r.RDB$VIEW_BLR IS NULL
         AND (r.RDB$SYSTEM_FLAG IS NULL OR r.RDB$SYSTEM_FLAG = 0)
       ORDER BY rf.RDB$RELATION_NAME, rf.RDB$FIELD_POSITION`,
    );
    return rows.map((r) => ({
      table: trim(r.TABLE_NAME),
      name: trim(r.FIELD_NAME),
      position: Number(r.FIELD_POSITION ?? 0),
      fieldType: Number(r.FIELD_TYPE ?? 0),
      fieldSubType: numOrNull(r.FIELD_SUB_TYPE),
      length: numOrNull(r.FIELD_LENGTH),
      charLength: numOrNull(r.CHAR_LEN),
      precision: numOrNull(r.FIELD_PRECISION),
      scale: numOrNull(r.FIELD_SCALE),
      notNull: r.NULL_FLAG != null && Number(r.NULL_FLAG) === 1,
      defaultSource: r.DEFAULT_SOURCE == null ? null : trim(r.DEFAULT_SOURCE),
      isIdentity: r.IDENTITY_TYPE != null,
    }));
  }

  /**
   * Detect the Firebird engine major version (e.g. 2, 3, 4, 5) so version-only
   * catalog columns can be selected conditionally. Falls back to 2 (the most
   * conservative subset) if the context variable is unavailable.
   */
  private async engineMajorVersion(): Promise<number> {
    try {
      const rows = await this.tx.query<Record<string, unknown>>(
        `SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') AS V
         FROM RDB$DATABASE`,
      );
      const raw = trim(rows[0]?.V);
      const major = Number.parseInt(raw.split(".")[0] ?? "", 10);
      return Number.isFinite(major) ? major : 2;
    } catch {
      return 2;
    }
  }

  async constraints(): Promise<RawConstraint[]> {
    const rows = await this.tx.query<Record<string, unknown>>(
      `SELECT
         rc.RDB$CONSTRAINT_NAME    AS CONSTRAINT_NAME,
         rc.RDB$CONSTRAINT_TYPE    AS CONSTRAINT_TYPE,
         rc.RDB$RELATION_NAME      AS TABLE_NAME,
         rc.RDB$INDEX_NAME         AS INDEX_NAME,
         seg.RDB$FIELD_NAME        AS FIELD_NAME,
         seg.RDB$FIELD_POSITION    AS SEG_POSITION,
         refc.RDB$UPDATE_RULE      AS UPDATE_RULE,
         refc.RDB$DELETE_RULE      AS DELETE_RULE,
         refc.RDB$CONST_NAME_UQ    AS UQ_NAME
       FROM RDB$RELATION_CONSTRAINTS rc
       JOIN RDB$INDEX_SEGMENTS seg ON seg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
       LEFT JOIN RDB$REF_CONSTRAINTS refc ON refc.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
       WHERE rc.RDB$CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
       ORDER BY rc.RDB$CONSTRAINT_NAME, seg.RDB$FIELD_POSITION`,
    );

    const byName = new Map<string, RawConstraint>();
    const uqByName = new Map<string, string>(); // constraint -> referenced UQ constraint name

    for (const r of rows) {
      const name = trim(r.CONSTRAINT_NAME);
      let c = byName.get(name);
      if (!c) {
        c = {
          table: trim(r.TABLE_NAME),
          type: trim(r.CONSTRAINT_TYPE),
          name,
          indexName: r.INDEX_NAME == null ? null : trim(r.INDEX_NAME),
          columns: [],
        };
        if (c.type === "FOREIGN KEY") {
          c.updateRule = trim(r.UPDATE_RULE) || undefined;
          c.deleteRule = trim(r.DELETE_RULE) || undefined;
          uqByName.set(name, trim(r.UQ_NAME));
        }
        byName.set(name, c);
      }
      const col = trim(r.FIELD_NAME);
      if (col && !c.columns.includes(col)) c.columns.push(col);
    }

    // Resolve foreign key targets via the referenced unique/PK constraint.
    for (const c of byName.values()) {
      if (c.type !== "FOREIGN KEY") continue;
      const uqName = uqByName.get(c.name);
      if (!uqName) continue;
      const target = byName.get(uqName);
      if (target) {
        c.references = { table: target.table, columns: [...target.columns] };
      } else {
        const resolved = await this.resolveConstraintColumns(uqName);
        if (resolved) c.references = resolved;
      }
    }

    return [...byName.values()];
  }

  private async resolveConstraintColumns(
    constraintName: string,
  ): Promise<{ table: string; columns: string[] } | null> {
    const rows = await this.tx.query<Record<string, unknown>>(
      `SELECT rc.RDB$RELATION_NAME AS TABLE_NAME, seg.RDB$FIELD_NAME AS FIELD_NAME
       FROM RDB$RELATION_CONSTRAINTS rc
       JOIN RDB$INDEX_SEGMENTS seg ON seg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
       WHERE rc.RDB$CONSTRAINT_NAME = ?
       ORDER BY seg.RDB$FIELD_POSITION`,
      [constraintName],
    );
    if (rows.length === 0) return null;
    return {
      table: trim(rows[0]!.TABLE_NAME),
      columns: rows.map((r) => trim(r.FIELD_NAME)),
    };
  }
}
