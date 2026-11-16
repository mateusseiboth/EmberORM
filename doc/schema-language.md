# The `.ember` schema language

A Prisma-compatible schema syntax. Files live at `ember/schema.ember` by default
(also discovered at `schema.ember` or `prisma/schema.ember`).

## Blocks

```prisma
datasource db {
  provider = "firebird"
  url      = env("DATABASE_URL")   // or a literal "firebird://..."
}

generator client {
  provider = "ember-client-js"
  output   = "../generated"
}

enum Role {
  USER
  ADMIN @map("administrator")
}

/// Doc comments (///) attach to the following model/field.
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @db.VarChar(255)
  name      String?
  role      Role     @default(USER)
  posts     Post[]
  createdAt DateTime @default(now()) @map("CREATED_AT")

  @@map("USERS")
  @@index([email])
}
```

## Field types

Scalars: `String`, `Boolean`, `Int`, `BigInt`, `Float`, `Decimal`, `DateTime`,
`Bytes`, `Json`. Modifiers: `Type?` (nullable), `Type[]` (list / to-many
relation).

## Field attributes

| Attribute            | Meaning                                             |
| -------------------- | --------------------------------------------------- |
| `@id`                | primary key                                         |
| `@unique`            | unique constraint                                   |
| `@default(...)`      | `autoincrement()`, `now()`, `uuid()`, `cuid()`, literal (`"S"`, `0`, `true`), enum value (`ADMIN`, unquoted) |
| `@updatedAt`         | set to now on every update                          |
| `@map("COL")`        | physical column name                                |
| `@db.VarChar(255)`   | native Firebird type                                |
| `@relation(...)`     | relation wiring                                     |

`@relation(fields: [localField], references: [foreignField], onDelete: Cascade,
onUpdate: NoAction)`. Referential actions: `Cascade`, `Restrict`, `NoAction`,
`SetNull`, `SetDefault`.

## Block attributes

| Attribute                       | Meaning                          |
| ------------------------------- | -------------------------------- |
| `@@id([a, b])`                  | composite primary key            |
| `@@unique([a, b])`              | composite unique constraint      |
| `@@index([a, b])`               | index                            |
| `@@map("TABLE")`                | physical table name              |
| `@@ignoreId`                    | table without a primary key (see below) |

## Identifiers

Model, field and enum names follow `[A-Za-z_][A-Za-z0-9_]*`: they cannot start
with a digit. A column such as `1VIADESCRICAO` is written as a field with a
leading `_` and the real name in `@map` (this is what `db pull` emits):

```prisma
_1viadescricao String? @map("1VIADESCRICAO")
```

## Defaults: string literal vs enum value

A quoted default is a string literal and a bare identifier is an enum value:
`ativa String @default("S")` and `role Role @default(ADMIN)`. Both are stored
in the database as text, so the DDL is `DEFAULT 'S'` / `DEFAULT 'ADMIN'`.

## Models without a primary key (`@@ignoreId`)

Every model needs `@id` or `@@id`, except one that declares `@@ignoreId`: a
legacy table that has no primary key. `ember db pull` emits it automatically
for such tables, with a `///` note:

```prisma
/// Table SIA_ANO_ALVARA has no primary key: only read and bulk operations are generated (no findUnique/create/update/upsert/delete).
model SiaAnoAlvara {
  ano     Int?
  usuario Int?

  @@ignoreId
  @@map("SIA_ANO_ALVARA")
}
```

Prisma marks such tables `@@ignore` and leaves them out of the client entirely;
EmberORM keeps them in the client with every operation that does not need to
identify a single row:

| Available                                                                 | Not generated (and rejected at runtime)                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `findMany`, `findFirst(OrThrow)`, `count`, `aggregate`, `groupBy`          | `findUnique(OrThrow)`, `create`, `createManyAndReturn`           |
| `createMany`, `updateMany`, `deleteMany`, `$queryRaw` / `$executeRaw`      | `update`, `upsert`, `delete`                                     |

Relations keep working for reads (`include`, `select`, relation filters, the
fluent API) as long as they declare `@relation(fields, references)`, which
`db pull` always does. Nested writes are limited: a parent may nest `create`
into a keyless child list, but not `connect`/`set`/`disconnect`/`delete`; a
keyless model cannot nest writes into its own children, and a to-one relation
that points to a keyless model is left out of the write inputs (write the
foreign-key field instead). `@@ignoreId` together with `@id`/`@@id` is a
validation error.

## Validation

`ember validate` (and every load) checks: unique model/field names, known field
types, relation field references, and that every model has a primary key (or
declares `@@ignoreId`). Errors are reported together with file/line positions.

## Formatting & relation auto-completion

`ember format` (and the VSCode formatter / format-on-save) re-prints the schema
with aligned columns and canonical indentation, and — like Prisma —
auto-completes the missing side of a relation:

- declare the owning side and the referenced model gains the back-relation
  (`posts Post[]`, or a nullable to-one for a 1:1 unique FK);
- declare a list (`posts Post[]`) and the element model gains the owning field
  plus its scalar foreign key;
- a bare to-one (`author User`) is upgraded to the owning side with a generated
  FK, and the other model gets the back-relation.

Relation names (`@relation("Name")`) are preserved on both sides. The operation
is idempotent — formatting an already-complete schema changes nothing.
