# EmberORM for VSCode

Language support for EmberORM `.ember` schema files — a Prisma-like editing
experience for the Firebird ORM.

## Features

- **Syntax highlighting** for models, enums, datasource/generator blocks,
  fields, scalar & native (`@db.*`) types, attributes, functions and comments.
- **Diagnostics** — schema is parsed and validated as you type (or on save);
  parse and validation errors are shown inline with precise locations.
- **Formatting** — `Format Document` re-prints the canonical schema (the same
  output as `ember format`): aligned columns, fixed indentation, and — exactly
  like Prisma — **auto-completes the missing side of a relation**. Declare the
  owning side (`author User @relation(fields: [authorId], references: [id])`)
  and formatting adds `posts Post[]` to `User`; declare a list (`posts Post[]`)
  and it adds the owning field + scalar FK to `Post`.
- **Format on save** — the extension registers itself as the default formatter
  for `.ember` and enables `editor.formatOnSave`, so saving fixes indentation
  and inserts the parent-side relation automatically.
- **Completion** — block keywords, scalar types, `@`/`@@` attributes, `@db.*`
  native types, and default functions (`now()`, `autoincrement()`, …).
- **Hover** — short docs for keywords and scalar types.
- **Commands** — `Ember: Format schema`, `Ember: Generate client`,
  `Ember: Pull database schema`, `Ember: Validate schema`.

## Build

```bash
npm install
npm run build      # bundles to out/extension.js
```

Press `F5` in VSCode to launch an Extension Development Host. Open any `.ember`
file to activate.

## Settings

- `ember.validateOnType` (default `true`) — validate while typing vs on save.
- `ember.cliPath` (default `npx ember`) — command used by the generate / db pull
  commands.
