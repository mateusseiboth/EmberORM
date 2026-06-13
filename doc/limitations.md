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
- **Composite-key relations** are resolved for writes, but `include` of a
  relation joined on more than one column throws (single-column keys only). The
  batched-IN path needs a composite `(a,b) IN (...)` strategy.
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

1. Composite-key `include` and `(a,b) IN (...)` batching.
2. Full `GetPayload` select narrowing in the generator.
3. Numeric atomic update operators and JSON path filters.
4. `cursor`/`distinct` pushdown.
5. A migration engine (`ember migrate`) diffing schema ↔ database.
6. Optional native (Go/Rust) introspection/codegen behind the same interfaces.
