# EmberORM for VSCode

Language support for EmberORM `.ember` schema files — a Prisma-like editing
experience for the Firebird ORM, powered by a dedicated **language server**.

## Features

- **Syntax highlighting** for models, enums, datasource/generator blocks,
  fields, scalar & native (`@db.*`) types, attributes, functions and comments.
- **Diagnostics** — schema is parsed and validated as you type via the real
  parser/validator; parse and validation errors are shown inline with precise
  locations.
- **Formatting** — `Format Document` re-prints the canonical schema (same output
  as `ember format`): aligned columns, fixed indentation, and — exactly like
  Prisma — **auto-completes the missing side of a relation**. Declare the owning
  side (`author User @relation(fields: [authorId], references: [id])`) and
  formatting adds `posts Post[]` to `User`; declare a list (`posts Post[]`) and
  it adds the owning field + scalar FK to `Post`.
- **Format on save** — the extension is the default `.ember` formatter and
  enables `editor.formatOnSave`, so saving fixes indentation and inserts the
  parent-side relation automatically.
- **Go to Definition** — jump from a model/enum reference (e.g. a relation
  field's type) to its declaration.
- **Find All References** & **Rename Symbol** — rename a model, enum or field
  and update every reference in the file.
- **Outline / Document Symbols** — models, enums and their fields in the
  breadcrumb and outline view.
- **Completion** — context-aware: block keywords, scalar types **and model/enum
  names in type position**, `@`/`@@` attributes, `@db.*` native types, and
  default functions (`now()`, `autoincrement()`, …).
- **Hover** — docs for keywords, scalar types and model/enum declarations.
- **Code actions** — “complete relations & format” quick fix.
- **Commands** — `Ember: Format schema`, `Ember: Generate client`,
  `Ember: Pull database schema`, `Ember: Validate schema`.

## Architecture

A thin client (`out/extension.js`) launches a Node language server
(`out/server.js`) implementing the LSP. The server reuses EmberORM's driver-free
`ember-orm/editor` (parser, validator, printer, relation completion) for
diagnostics/formatting, and a text-based position index for navigation, rename
and symbols.

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
