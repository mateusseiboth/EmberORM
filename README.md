# EmberORM

A **Prisma-like ORM for Firebird**, written in TypeScript. Schema language,
database introspection (`db pull`), generated typed client, and an object-based
query API (`where`, `select`, `include`, `orderBy`, aggregations, transactions).

```bash
npm install ember-orm
```

## Quick start

```bash
# 1. scaffold a schema
npx ember init

# 2. point it at your database
export DATABASE_URL="firebird://SYSDBA:masterkey@localhost:3050//var/lib/firebird/app.fdb"

# 3. import an existing database into the schema
npx ember db pull

# 4. generate the typed client
npx ember generate
```

```ts
import { EmberClient } from "./generated";

const db = new EmberClient();
await db.$connect();

const users = await db.user.findMany({
  where: { active: true, email: { endsWith: "@acme.com" } },
  include: { posts: { where: { published: true } } },
  orderBy: { createdAt: "desc" },
  take: 20,
});

await db.$transaction(async (tx) => {
  const u = await tx.user.create({ data: { email: "a@b.com", name: "Ada" } });
  await tx.post.create({ data: { title: "Hi", author: { connect: { id: u.id } } } });
});
```

## Schema example

```prisma
datasource db {
  provider = "firebird"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "ember-client-js"
  output   = "../generated"
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.VarChar(255)
  name      String?
  posts     Post[]
  createdAt DateTime @default(now()) @map("CREATED_AT")

  @@map("USERS")
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  author   User   @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId Int    @map("AUTHOR_ID")
}
```

## Feature overview

| Area              | Supported                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| Reads             | `findMany`, `findFirst(OrThrow)`, `findUnique(OrThrow)`                    |
| Writes            | `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete(Many)`  |
| Aggregation       | `count`, `aggregate` (`_count/_sum/_avg/_min/_max`), `groupBy`             |
| Filtering         | `equals/not/in/notIn/lt/lte/gt/gte/contains/startsWith/endsWith`, `mode`  |
| Boolean logic     | `AND` / `OR` / `NOT`                                                       |
| Relation filters  | `some` / `every` / `none` / `is` / `isNot` (compiled to `EXISTS`)         |
| Relations         | `include` & nested `select` (batched, Prisma-style stitching)             |
| Nested writes     | `connect`, `create`, `connectOrCreate`, `disconnect`, `set`, `delete`     |
| Pagination        | `take` / `skip` (`FIRST` / `SKIP`)                                         |
| Transactions      | interactive `$transaction(fn)` and sequential `$transaction([...])`       |
| Raw               | `$queryRaw`, `$executeRaw`, `*Unsafe` variants                            |
| Migrations        | `ember migrate dev / deploy / status`, `ember db push` (schema↔DB diff)   |
| Extensions        | `$extends` (result/model/query/client), `$use` middleware, `$on` events    |
| Fluent API        | relation traversal: `db.user.findUnique(...).posts()`                       |
| More ops          | `omit`, `createManyAndReturn`, groupBy `having`                            |
| Counts            | relation `_count` in `select`/`include`                                    |
| Versions          | Firebird 2.1 / 2.5 / 3 / 4 / 5 (`?version=`), Srp & legacy auth            |
| Logging           | `log: true` or a `QueryEvent` callback                                     |
| Tooling           | `ember init / db pull / generate / format / validate`                     |

## Editor support

A VSCode extension lives in [`editors/vscode`](./editors/vscode) — a Prisma-like
experience for `.ember` files: syntax highlighting, as-you-type diagnostics
(via the real parser/validator), canonical formatting, completion (keywords,
types, `@`/`@@` attributes, `@db.*` native types, default functions), hover, and
commands for generate / db pull / validate.

```bash
cd editors/vscode && npm install && npm run build   # then press F5 in VSCode
```

Editor tooling consumes the driver-free `ember-orm/editor` entry point (schema
parser, validator, printer — no database driver).

## Documentation

See [`/doc`](./doc) for the architecture, schema language, query API, and the
Firebird-specific notes (identifier casing, transactions, pagination).

## Safety

Every value is bound as a parameter (`?`) — identifiers are quoted and values are
never string-interpolated. Every operation runs inside a transaction.
