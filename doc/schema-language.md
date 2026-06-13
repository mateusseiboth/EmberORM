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
| `@default(...)`      | `autoincrement()`, `now()`, `uuid()`, `cuid()`, literal, enum value |
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

## Validation

`ember validate` (and every load) checks: unique model/field names, known field
types, relation field references, and that every model has a primary key.
Errors are reported together with file/line positions.
