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

**`cursor`** accepts one or more scalar fields (`{ id: 100 }` or
`{ createdAt, id }`). It expands to a lexicographic keyset comparison
(`(f1..fn) >=/<= (v1..vn)` per each field's `orderBy` direction, default asc) as
an `OR` of `AND` groups, so SQL starts at the cursor row; combine with
`skip`/`take`. **`distinct`** de-duplicates on the listed scalar fields. On
Firebird 3+ it is pushed to SQL with `ROW_NUMBER() OVER (PARTITION BY …)` and
pagination stays in SQL; on Firebird 2.1/2.5 it de-duplicates (and paginates) in
memory.

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

### JSON filters

`Json` fields are stored as text (Firebird has no JSON type). Supported filters
operate on the serialized value:

```ts
{ meta: { equals: { plan: "pro" } } }       // exact serialized match
{ meta: { not: null } }
{ meta: { string_contains: "premium" } }    // LIKE on the JSON text
{ meta: { string_starts_with: "{" } }
{ meta: { string_ends_with: "}" } }
```

`path`-based filtering is **not supported** on Firebird (no JSON SQL functions)
and throws a clear error — filter in application code or via a generated column.

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

## Relation counts (`_count`)

Count related rows alongside a query via `select`/`include`:

```ts
const users = await db.user.findMany({
  include: { _count: { select: { posts: true } } },
});
users[0]._count.posts; // number

// _count: true counts every to-many relation
await db.user.findMany({ include: { _count: true } });
```

Counts are loaded with one batched `GROUP BY` query per relation and default to
`0` for parents with no children. The generated client types `_count` to the
requested to-many relations.

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

## omit, createManyAndReturn, fluent API

```ts
// omit — inverse of select (return everything except the listed fields)
await db.user.findMany({ omit: { passwordHash: true } });

// createManyAndReturn — bulk insert that returns the rows
const rows = await db.post.createManyAndReturn({ data: [ ... ] });

// fluent API — traverse a relation from a unique/first read
const posts = await db.user.findUnique({ where: { id } }).posts();
const author = await db.post.findUnique({ where: { id } }).author();   // chainable
```

## groupBy having

```ts
db.post.groupBy({
  by: ["authorId"],
  _sum: { views: true },
  having: {
    authorId: { gt: 0 },          // condition on a group column
    views: { _sum: { gt: 100 } }, // condition on SUM(views)
  },
});
```

## Client Extensions (`$extends`)

`$extends` returns a new client (the original is unchanged) and accepts four
categories — `result`, `model`, `query`, `client`:

```ts
const xdb = db.$extends({
  result: {
    user: {
      fullName: {
        needs: { firstName: true, lastName: true },
        compute: (u) => `${u.firstName} ${u.lastName}`,
      },
    },
  },
  model: {
    user: { findByEmail(email: string) { return this.findFirst({ where: { email } }); } },
  },
  query: {
    user: {
      findMany: ({ args, query }) => query({ ...args, where: { ...args.where, active: true } }),
    },
  },
  client: { $health: () => "ok" },
});
```

## Middleware & events

```ts
db.$use(async (params, next) => {
  const start = Date.now();
  const result = await next(params);
  console.log(params.action, Date.now() - start);
  return result;
});

db.$on("query", (e) => console.log(e.sql, e.durationMs));
```
