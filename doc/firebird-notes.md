# Firebird-specific notes & gotchas

## Identifier casing (important)

Firebird folds **unquoted** identifiers to UPPER CASE when objects are created,
but compares **quoted** identifiers case-sensitively. EmberORM always quotes
identifiers (to preserve introspected names and avoid accidental folding).

Consequence — a field without `@map` resolves to its **UPPER-CASED** name:

```prisma
model User {
  email String      // physical column → "EMAIL"
  createdAt DateTime @map("CREATED_AT")  // physical column → "CREATED_AT"
}
```

If a table was created with a quoted, lower/mixed-case column (e.g. `"email"`),
you **must** use `@map("email")`. `ember db pull` always emits explicit `@map`
/`@@map` whenever the idiomatic Ember name differs from the stored name, so
introspected schemas are always exact. See `fieldColumn`/`modelTable` in
`src/ast/index.ts`.

## Pagination

Firebird uses `SELECT FIRST <n> SKIP <m> ...` (the keywords come *after*
`SELECT`, `FIRST` before `SKIP`). EmberORM maps `take` → `FIRST` and `skip` →
`SKIP` in `FirebirdDialect.paginationClause`. For nested to-many `include`s,
`take`/`skip` are applied per-parent in memory (a single batched query can't
paginate per group), see `engine.loadRelation`.

## Transactions

Every operation runs inside a transaction (project rule + node-firebird's model).
`FirebirdDriver.transaction` acquires a pooled connection, starts a transaction
at `READ_COMMITTED` (configurable), commits on success and rolls back on any
thrown error. Nested `transaction()` calls reuse the active one via
`AsyncLocalStorage`, so `client.$transaction(fn)` composes: any delegate call
inside `fn` joins the same transaction automatically.

Introspection uses `READ_COMMITTED_READ_ONLY`.

## RETURNING

Firebird supports `INSERT/UPDATE/DELETE ... RETURNING`. EmberORM uses
`INSERT ... RETURNING <id cols>` to read generated identity/primary keys back
after a create. For `updateMany`/`deleteMany` it issues a `SELECT COUNT(*)` with
the same `WHERE` (inside the same transaction) to report `{ count }`, because
DSQL does not expose an affected-row count portably.

## Type mapping (introspection)

`src/introspect/type-map.ts` maps `RDB$FIELD_TYPE` codes to scalar types and a
`@db.*` native type:

| Firebird                        | Ember scalar | Native            |
| ------------------------------- | ------------ | ----------------- |
| SMALLINT / INTEGER              | `Int`        | `SmallInt`/`Integer` |
| BIGINT (INT64)                  | `BigInt`     | `BigInt`          |
| numeric/decimal (scale < 0)     | `Decimal`    | `Decimal(p, s)`   |
| FLOAT / DOUBLE PRECISION        | `Float`      | `Float`/`DoublePrecision` |
| BOOLEAN                         | `Boolean`    | `Boolean`         |
| CHAR / VARCHAR                  | `String`     | `Char(n)`/`VarChar(n)` |
| DATE / TIME / TIMESTAMP         | `DateTime`   | `Date`/`Time`/`Timestamp` |
| BLOB sub_type 1 (text)          | `String`     | `Text`            |
| BLOB (binary)                   | `Bytes`      | `Blob`            |

Defaults are parsed from `RDB$DEFAULT_SOURCE` (`CURRENT_TIMESTAMP` → `now()`,
literals → literal); identity columns become `@default(autoincrement())`.

## Value coercion

node-firebird returns DATE/TIMESTAMP as `Date`; booleans and numerics can arrive
as `0/1`/strings depending on version. `src/query/coerce.ts` normalizes every
returned value to the JS type implied by the field (`Boolean`, `Int`, `BigInt`,
`Decimal`, `DateTime`, `Json`, `Bytes`). `blobAsText` is enabled so text blobs
come back as strings.
