# Limitations & roadmap

Current, honest status of the implementation.

## Supported and tested

- Schema parser/validator/printer (round-trip), introspection metadata reader
  and type mapper, SQL dialect, where/order/statement compilers, the read
  pipeline with relation stitching, and core nested writes — all covered by the
  unit/integration suite in `test/` (runs without a database).

## Known limitations

- **`updateMany`** is scalar-only (atomic operators allowed), like Prisma;
  nested relation writes are rejected with a clear error.
- **`cursor`** supports a single unique field; multi-field cursors throw.
- **`distinct`** de-duplicates in memory (and therefore paginates in memory),
  rather than via a SQL window function.
- **`createMany`** inserts row-by-row (one statement each) inside the
  transaction; it does not batch into a single multi-row INSERT.
- Affected-row counts for `updateMany`/`deleteMany` come from a preceding
  `COUNT(*)` (see firebird-notes.md).

## Roadmap

1. Nested writes in `updateMany`.
2. JSON path filters.
3. SQL-window-function `distinct` and multi-field cursors.
4. Optional native (Go/Rust) introspection/codegen behind the same interfaces.

## Recently completed

- **Firebird 2.1/2.5 support**: `SMALLINT` booleans and sequence+trigger
  autoincrement via a version-aware dialect (`?version=2.1`); secure **Srp** auth
  (default on FB3+) and legacy auth (`?auth=legacy`); query **logging** via the
  `log` client option.
- **Relation `_count`**: `select`/`include` `_count` (boolean or
  `{ select: { rel } }`) attaches per-relation child counts via a batched
  `GROUP BY`; typed in the generated client against to-many relations.
- **`cursor` & `distinct`**: cursor adds a `>=`/`<=` filter + ordering on a
  single unique field; distinct de-duplicates (and paginates) in memory.
- **Recursive `GetPayload`**: the generated client narrows `select`/`include`
  to arbitrary depth via a type-level registry (`$ScalarPayload`/`$RelationMap`)
  and a generic `$Payload<Model, Args>` resolver — nested relation selects,
  list-ness, and to-one nullability are all reflected in the result type.
  Verified by compile-time `@ts-expect-error` assertions in
  `examples/payload-types.ts`.
- **Atomic numeric update operators** (`increment`/`decrement`/`multiply`/
  `divide`) compiled to `"COL" = "COL" <op> ?`.
- **Composite-key relations** in `include`/`select`: parent key tuples are
  matched with `IN (...)` for single-column keys and an `OR` of AND-ed equality
  groups for composite keys (Firebird lacks a portable row-value `IN`). Nested
  writes already carried composite foreign keys. See `engine.loadRelation`.
- **Migration engine** (`ember migrate dev/deploy/status`, `ember db push`):
  diffs the schema against the live database and emits Firebird DDL. See
  [migrations.md](./migrations.md).
