/**
 * Compile-time assertions for the recursive GetPayload narrowing.
 * This file only type-checks; the `@ts-expect-error` lines FAIL the build if a
 * non-selected field is wrongly considered present (i.e. they prove narrowing
 * actually removes fields). Verified by the gencheck tsconfig.
 */
import { EmberClient } from "../generated";

const db = new EmberClient({ datasourceUrl: "firebird://SYSDBA:masterkey@localhost:3050//x.fdb" });

async function selectNarrowing() {
  const rows = await db.user.findMany({
    select: { id: true, posts: { select: { title: true } } },
  });
  const id: number = rows[0]!.id;
  const title: string = rows[0]!.posts[0]!.title;
  void id;
  void title;
  // email was not selected:
  // @ts-expect-error - 'email' is not part of the narrowed select payload
  rows[0]!.email;
  // content was not selected on the nested post:
  // @ts-expect-error - 'content' is not part of the nested select payload
  rows[0]!.posts[0]!.content;
}

async function includeNarrowing() {
  const rows = await db.user.findMany({
    include: { posts: { include: { author: true } }, profile: true },
  });
  // include keeps all scalars:
  const email: string = rows[0]!.email;
  // nested include resolves the related model:
  const authorId: number = rows[0]!.posts[0]!.author.id;
  // optional to-one relation is nullable:
  const profile = rows[0]!.profile;
  const bio: string | null | undefined = profile?.bio;
  void email;
  void authorId;
  void bio;
}

async function defaultPayload() {
  const user = await db.user.findUnique({ where: { id: 1 } });
  // no select/include => scalar-only payload (relations absent):
  const email: string = user!.email;
  // @ts-expect-error - relations are not present without include/select
  user!.posts;
  void email;
}

void selectNarrowing;
void includeNarrowing;
void defaultPayload;
