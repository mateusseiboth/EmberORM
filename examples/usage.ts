/**
 * Example usage of the generated EmberORM client.
 * Run `ember generate` first; this file type-checks against ../generated.
 */
import { EmberClient } from "../generated";

const db = new EmberClient({
  // Firebird 3+ uses secure SRP auth automatically; add ?version=2.5&auth=legacy
  // for legacy Firebird 2.1/2.5 servers.
  datasourceUrl: "firebird://SYSDBA:masterkey@localhost:3050//var/lib/firebird/app.fdb",
  log: (e) => console.log(`${e.sql} (${e.durationMs}ms, ${e.rowCount} rows)`),
});

async function main() {
  await db.$connect();

  // create with a nested relation write
  const user = await db.user.create({
    data: {
      email: "ada@example.com",
      name: "Ada",
      role: "ADMIN",
      posts: {
        create: [{ title: "Hello", published: true }],
      },
    },
  });

  // findMany with where / orderBy / pagination / include (typed relations)
  const users = await db.user.findMany({
    where: {
      active: true,
      email: { endsWith: "@example.com" },
      posts: { some: { published: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    skip: 0,
    include: { posts: true, profile: true },
  });
  // include narrows the payload: posts/profile are present and typed.
  users[0]?.posts.forEach((p) => p.title.toUpperCase());

  // select narrows scalar fields
  const emails = await db.user.findMany({ select: { id: true, email: true } });
  emails.forEach((e) => e.email.length);

  // composite cursor keyset pagination + distinct + JSON text filter
  const page = await db.user.findMany({
    where: { meta: { string_contains: "premium" } },
    cursor: { createdAt: new Date(), id: 100 },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 25,
    distinct: ["email"],
  });
  void page;

  // aggregation
  const stats = await db.post.aggregate({
    where: { published: true },
    _count: true,
    _avg: { views: true },
    _max: { views: true },
  });

  // groupBy
  const grouped = await db.post.groupBy({
    by: ["authorId"],
    _count: { id: true },
    _sum: { views: true },
  });

  // atomic numeric update operators
  await db.post.update({
    where: { id: 1 },
    data: { views: { increment: 1 }, published: { set: true } },
  });

  // omit fields from the result
  const safe = await db.user.findMany({ omit: { email: true } });
  void safe;

  // createManyAndReturn
  const made = await db.post.createManyAndReturn({
    data: [{ title: "A", authorId: user.id }],
  });
  void made;

  // fluent API: traverse a relation from a unique read
  const authoredPosts = await db.user.findUnique({ where: { id: user.id } }).posts();
  authoredPosts.forEach((p) => p.title);

  // Client Extensions ($extends): add a computed result field
  const xdb = db.$extends({
    result: {
      User: {
        domain: {
          needs: { email: true },
          compute: (u) => String((u as { email: string }).email).split("@")[1],
        },
      },
    },
  });
  const u2 = await xdb.user.findFirst();
  void u2;

  // transaction (interactive): all ops share one transaction
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { name: "Ada L." } });
    await tx.post.deleteMany({ where: { authorId: user.id, published: false } });
  });

  // raw escape hatch
  const rows = await db.$queryRaw<{ TOTAL: number }>`SELECT COUNT(*) AS TOTAL FROM USERS`;

  await db.$disconnect();
  return { users, stats, grouped, rows };
}

void main;
