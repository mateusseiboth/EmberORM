# Migrations

EmberORM ships a migration engine that diffs your `.ember` schema against the
**live database** (via introspection) and emits Firebird DDL. There is no shadow
database — the current state is read directly from the connected database.

## Commands

```bash
ember migrate dev --name add_posts   # diff, write a migration file, apply it
ember migrate deploy                 # apply all pending migration files
ember migrate status                 # list applied vs pending migrations
ember db push                        # apply the diff directly (no file)
ember migrate dev --log              # also print each SQL statement as it runs
```

All commands resolve the connection from `--url`, the schema's `datasource`, or
`DATABASE_URL`.

Pass `--log` to `migrate dev`, `migrate deploy`, or `db push` to echo every
generated statement (prefixed with `-- step n/total`) right before it executes —
useful for debugging a DDL error. When a step fails, the error always names the
offending statement and step number, regardless of `--log`.

### Server version detection

The DDL dialect must match the engine (e.g. `BOOLEAN` vs `SMALLINT`, `IDENTITY`
vs generator+trigger, `ALTER COLUMN ... SET NOT NULL` vs a catalog update on
2.1/2.5). When the connection URL omits `?version=`, the migrator now queries the
live server (`ENGINE_VERSION`) and picks the matching dialect automatically. An
explicit `?version=` in the URL always wins.

## How it works

```
desired (.ember)  ─┐
                   ├─ diffSchemas ─→ SchemaDiff ─ planMigration ─→ DDL[]
current (db pull) ─┘
```

- **`migrate dev`** computes the diff, writes
  `ember/migrations/<timestamp>_<name>/migration.sql`, applies every statement
  in one transaction, and records the migration in `_EMBER_MIGRATIONS`.
- **`migrate deploy`** replays on-disk migrations that are not yet recorded
  (each in its own transaction) — use this in CI/production.
- **`migrate status`** compares on-disk migrations with the history table.
- **`db push`** applies the diff immediately without creating a file — handy for
  prototyping.

The history table `_EMBER_MIGRATIONS` (`ID`, `CHECKSUM`, `STEPS`, `APPLIED_AT`)
is created automatically and always excluded from the diff.

> **Firebird gotcha — DDL and DML must not share a transaction.** Firebird does
> not expose uncommitted DDL to DML in the same transaction: a table `CREATE`d
> inside a transaction is reported as `Table unknown` (SQL error -204) to any
> `INSERT`/`SELECT` issued before that transaction commits. Because of this the
> history table is created in its own committed transaction (`Migrator.ensureHistory`)
> *before* the migration DDL is applied and the row is inserted into
> `_EMBER_MIGRATIONS`. On a freshly zeroed database, running the CREATE and the
> bookkeeping INSERT/SELECT in one transaction fails with
> `Table unknown, _EMBER_MIGRATIONS`.

## What the diff covers

| Change                                   | Supported |
| ---------------------------------------- | --------- |
| Create table (cols, identity PK)         | ✅        |
| Drop table                               | ✅        |
| Add / drop column                        | ✅        |
| Alter column type                        | ✅        |
| Set / drop `NOT NULL`                     | ✅        |
| Add autoincrement to an existing column  | ✅ (seq + trigger on FB 2.x) |
| Add `UNIQUE` (single & composite)        | ✅        |
| Add foreign key (incl. composite)        | ✅        |
| Create index / unique on new tables      | ✅        |
| Drop constraints / non-constraint indexes on existing tables | ⚠️ not emitted |
| Column / table renames                   | ⚠️ seen as drop + add |
| Enums                                    | n/a (Firebird has no enum type) |

DDL ordering is always safe: drops → create tables → alter columns →
constraints → indexes → **foreign keys last**, so referenced tables and columns
always exist first.

### Round-trip idempotency gotchas (Firebird 2.x)

Two traps make `migrate dev` emit phantom statements on every run unless handled,
because Firebird 2.1/2.5 don't represent these the way the schema does:

- **Trigger-based autoincrement.** Pre-3.0 engines have no native `IDENTITY`, so
  `@default(autoincrement())` is emulated with a `SEQUENCE` + `BEFORE INSERT`
  trigger. `RDB$IDENTITY_TYPE` doesn't exist there, so introspection instead
  scans `RDB$TRIGGERS` (`RDB$TRIGGER_TYPE = 1`) for a body assigning
  `NEW."COL" = GEN_ID(...)`/`NEXT VALUE FOR ...` and folds it back into the
  column as autoincrement. Adding autoincrement to an **existing** column is a
  `changedColumns` entry (`identityAdded`), not an `addedColumn`, and the planner
  emits the sequence + trigger for it.
- **Nullable-declared PK columns.** A primary-key column is NOT NULL in every SQL
  engine — Firebird enforces it even when the column is declared `Int?`. So the
  diff treats any PK member as required (and introspection marks it required),
  otherwise it forever tries to "drop NOT NULL" on PK columns (a no-op the engine
  ignores and the next diff re-emits).

`migrate dev` also writes the `migration.sql` file **only after** the apply +
history-insert transaction succeeds. Writing it first left an orphan migration
folder on a failed apply, which the next run could not distinguish from a real
migration — so it re-diffed and produced a second identical migration.

## Type mapping (schema → DDL)

Native `@db.*` types are emitted verbatim (`VarChar(n)`, `Char(n)`, `Decimal(p,s)`,
`Text` → `BLOB SUB_TYPE TEXT`, …). Without a native type, scalars default to:
`String→VARCHAR(255)`, `Int→INTEGER`, `BigInt→BIGINT`, `Float→DOUBLE PRECISION`,
`Decimal→DECIMAL(18,4)`, `Boolean→BOOLEAN`, `DateTime→TIMESTAMP`,
`Bytes→BLOB SUB_TYPE BINARY`, `Json→BLOB SUB_TYPE TEXT`.

`@default(autoincrement())` becomes `GENERATED BY DEFAULT AS IDENTITY` on
Firebird 3+, or a `CREATE SEQUENCE` + `BEFORE INSERT` trigger on Firebird
2.1/2.5 (`?version=2.1`). `Boolean` is `BOOLEAN` on 3+ and `SMALLINT` on 2.x.
`@default(now())` becomes `DEFAULT CURRENT_TIMESTAMP`; literal defaults map to
`DEFAULT <value>`.

Migration files separate statements with a `--> statement-breakpoint` line
(not `;`), so PSQL bodies such as the 2.x autoincrement trigger survive a
round-trip through the `.sql` file.

## Caveats

- Diffing against the live DB means **renames look like drop+add** — review
  generated SQL before applying in production, and hand-edit the `migration.sql`
  when you need a non-destructive rename.
- Dropping a column/table that participates in a constraint may require dropping
  the constraint first; the safe-subset planner does not auto-drop existing
  constraints on altered tables.
- Firebird has no `RESTRICT`; it is emitted as `NO ACTION`.
