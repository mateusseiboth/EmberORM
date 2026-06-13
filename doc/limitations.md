# Limitations & roadmap

Current, honest status of the implementation.

## Supported and tested

- Schema parser/validator/printer (round-trip), introspection metadata reader
  and type mapper, SQL dialect, where/order/statement compilers, the read
  pipeline with relation stitching, and core nested writes — all covered by the
  unit/integration suite in `test/` (runs without a database).

## Known limitations

- **Type-level select/include narrowing** in the generated client is pragmatic:
  `include` adds the relation types; `select` maps to the selected keys' full
  types. The full Prisma conditional `GetPayload` (deep nested narrowing) is not
  reproduced.
- **`updateMany` with nested writes**: only scalar fields are applied to the
  matched set; nested relation writes in `updateMany` are not processed.
- **Scalar update operators**: `{ set }` and direct assignment are supported;
  `increment/decrement/multiply/divide` are not yet emitted as `col = col + ?`.
- **`cursor`/`distinct`** are accepted in args but not yet pushed into SQL.
- **Migrations** (`ember db push`/`migrate`) are not implemented — there is no
  migration engine. Use `db pull` against an externally-managed schema.
- **`createMany`** inserts row-by-row (one statement each) inside the
  transaction; it does not batch into a single multi-row INSERT.
- Affected-row counts for `updateMany`/`deleteMany` come from a preceding
  `COUNT(*)` (see firebird-notes.md).

## Roadmap

1. Full `GetPayload` select narrowing in the generator.
2. Numeric atomic update operators and JSON path filters.
3. `cursor`/`distinct` pushdown.
4. Optional native (Go/Rust) introspection/codegen behind the same interfaces.

## Recently completed

- **Composite-key relations** in `include`/`select`: parent key tuples are
  matched with `IN (...)` for single-column keys and an `OR` of AND-ed equality
  groups for composite keys (Firebird lacks a portable row-value `IN`). Nested
  writes already carried composite foreign keys. See `engine.loadRelation`.
- **Migration engine** (`ember migrate dev/deploy/status`, `ember db push`):
  diffs the schema against the live database and emits Firebird DDL. See
  [migrations.md](./migrations.md).
