/**
 * Example usage of the generated EmberORM client.
 * Run `ember generate` first; this file type-checks against ../generated.
 */
import { EmberClient } from "../generated";

const db = new EmberClient({
  datasourceUrl: "firebird://SYSDBA:masterkey@localhost:3050//var/lib/firebird/app.fdb",
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
