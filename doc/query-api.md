# Query API

All operations are available as `db.<model>.<operation>(args)`. With the
generated client every argument and return type is model-specific.

## Reads

```ts
db.user.findMany({
  where,            // filter (see below)
  select,           // pick scalar fields and/or relations
  include,          // load relations (typed in the result)
  orderBy,          // { field: "asc" | "desc" } or an array for tie-breakers
  take, skip,       // pagination (FIRST / SKIP)
  cursor,           // cursor-based pagination (single unique field)
  distinct,         // de-duplicate on the given scalar fields
});

db.user.findFirst(args);          // first match or null
db.user.findFirstOrThrow(args);   // throws RecordNotFoundError
db.user.findUnique({ where });    // by @id / @unique
db.user.findUniqueOrThrow({ where });
```

`select` narrows the returned scalar fields (and may also pull relations);
`include` keeps all scalars and adds relations. Both narrow the **static type**
of the result in the generated client.

**`cursor`** takes a single unique scalar field (`{ id: 100 }`). It adds a
`>=`/`<=` filter relative to the ordering on that field (ascending by default,
or the direction from `orderBy`) and orders by it, so SQL starts at the cursor
row; combine with `skip`/`take`. **`distinct`** de-duplicates on the listed
scalar fields, keeping the first row per combination in the current order;
because de-duplication happens in memory, `take`/`skip` are also applied in
memory when `distinct` is used.

## Filtering (`where`)

```ts
{
  // scalar shorthand → equals
  email: "a@b.com",
  // operators
  age: { gte: 18, lt: 65 },
  name: { contains: "ana", mode: "insensitive" },
  id: { in: [1, 2, 3] },
  deletedAt: null,                  // IS NULL
  // boolean composition
  AND: [{ active: true }, { role: "ADMIN" }],
  OR: [ ... ],
  NOT: { ... },
  // relation filters → EXISTS subqueries
  posts: { some: { published: true } },
  profile: { is: { verified: true } },   // to-one shorthand: profile: { verified: true }
}
```

Operators: `equals`, `not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`,
`contains`, `startsWith`, `endsWith`, `mode: "insensitive"`.
Relation operators: `some`, `every`, `none` (to-many); `is`, `isNot` (to-one).
`contains/startsWith/endsWith` escape `% _ \` and emit `LIKE ... ESCAPE '\'`.

## Writes

```ts
db.user.create({ data: { email, name, posts: { create: [{ title }] } } });
db.user.createMany({ data: [ ... ] });
db.user.update({ where: { id }, data: { name: "x" } });
db.user.updateMany({ where, data });
db.user.upsert({ where, create, update });
db.user.delete({ where: { id } });
db.user.deleteMany({ where });
```

### Nested writes

- **Owning side** (the model holding the FK) — resolved *before* the row is
  written: `connect`, `create`, `connectOrCreate`, and on update `disconnect`.
- **Child side** (one-to-many / back relation) — written *after* the parent:
  `create`, `connect`, `set`, `disconnect`, `delete`.

### Scalar update operators

Direct assignment, `{ set }`, and on numeric fields the atomic operators
`increment` / `decrement` / `multiply` / `divide` (compiled to
`"COL" = "COL" <op> ?`):

```ts
db.post.update({
  where: { id },
  data: { views: { increment: 1 }, score: { multiply: 2 }, title: { set: "x" } },
});
```

## Aggregation

```ts
db.post.count({ where });

db.post.aggregate({
  where,
  _count: true,                 // or { field: true }
  _sum: { views: true },
  _avg: { views: true },
  _min: { views: true },
  _max: { views: true },
});
// → { _count: { _all }, _sum: { views }, ... }

db.post.groupBy({
  by: ["authorId"],
  _count: { id: true },
  _sum: { views: true },
  orderBy,
});
```

## Transactions

```ts
// interactive: every call on tx shares one transaction
await db.$transaction(async (tx) => {
  const u = await tx.user.create({ data: { email } });
  await tx.profile.create({ data: { userId: u.id } });
});

// sequential: array of thunks, run in order in one transaction
await db.$transaction([
  (tx) => tx.user.update({ where: { id: 1 }, data: { name: "a" } }),
  (tx) => tx.user.update({ where: { id: 2 }, data: { name: "b" } }),
]);
```

## Raw

```ts
await db.$queryRaw`SELECT * FROM USERS WHERE ID = ${id}`;   // parameterized
await db.$executeRaw`UPDATE USERS SET NAME = ${name} WHERE ID = ${id}`;
await db.$queryRawUnsafe("SELECT * FROM USERS WHERE ID = ?", id);
```

Tagged-template values become `?` parameters automatically.
