# Architecture

EmberORM is layered so each concern is isolated and independently testable. The
dependency direction always points toward abstractions (DIP).

```
schema (.ember)
   │  Lexer → Parser → validator           src/schema, src/ast
   ▼
SchemaDocument (AST / DMMF-like)            src/ast
   │
   ├── generator  → typed TS client         src/generator
   ├── introspect ← RDB$ system tables      src/introspect
   │
   ▼
QueryEngine                                 src/query
   │  where/order/compiler → Sql fragments
   │  WriteProcessor       → nested writes
   │  coerce/defaults      → value mapping
   ▼
SqlDialect (Strategy)                       src/sql
   ▼
SqlDriver (interface)  →  FirebirdDriver    src/driver
   ▼
node-firebird (pool + transactions)
```

## Layers

- **`src/ast`** — `SchemaDocument`: the single in-memory source of truth.
  Pure data + helpers (`fieldColumn`, `modelTable`, `idFields`, …). No I/O.
- **`src/schema`** — `Lexer` → `Parser` → `validateSchema`, plus `printSchema`
  (AST → `.ember`) used by `db pull` and `format`. `loadSchema` resolves
  `env()` URLs.
- **`src/driver`** — `SqlDriver` abstraction and `FirebirdDriver`
  (node-firebird wrapped in promises, pooled, transactional). The engine never
  imports node-firebird directly. `createDriver` is the Factory.
- **`src/sql`** — `SqlDialect` Strategy (Firebird quoting, `FIRST`/`SKIP`,
  case-insensitivity, value coercion) and `Sql`, an accumulating fragment that
  keeps text + bound params together (the injection boundary).
- **`src/query`** — the engine:
  - `where.ts` compiles filters (operators, `AND/OR/NOT`, relation `EXISTS`),
  - `order.ts`, `compiler.ts` build `SELECT/INSERT/UPDATE/DELETE/aggregate`,
  - `relations.ts` resolves join columns for either side of a relation,
  - `writer.ts` performs nested writes (owning side before insert, child side
    after), `defaults.ts` computes JS-side defaults, `coerce.ts` maps DB values
    back to JS types,
  - `engine.ts` orchestrates reads (projection + batched relation stitching) and
    delegates writes.
- **`src/client`** — `EmberClientBase` builds one `ModelDelegate` per model and
  exposes `$connect/$disconnect/$transaction/$queryRaw`. The generated
  `EmberClient` extends it and adds strict per-model types.
- **`src/generator`** — emits the typed client (`ember generate`).
- **`src/introspect`** — reverse-engineers a `SchemaDocument` from a live DB.
- **`src/cli`** — `ember` command (`init/db pull/generate/format/validate`).

## Design decisions

- **TypeScript-only.** The codegen/introspection run in Node (like Prisma's JS
  pieces) so `npm install` needs no native toolchain and the whole pipeline is
  testable without a database. A Go/Rust engine can be added later behind the
  same `SqlDriver`/generator boundaries.
- **Relations are loaded with separate batched queries** and stitched in memory,
  rather than via JOINs. This makes nested `include`/`select` of arbitrary depth
  straightforward and avoids row-explosion parsing.
- **Defaults are computed in JS** (`now()`, `uuid()`, `cuid()`, literals) for
  identical behavior across Firebird versions; `autoincrement()` is left to the
  database and read back through `RETURNING`.
- **Aliases over relative imports** via `@ember/*` path mappings (tsconfig +
  vitest), per project conventions.
