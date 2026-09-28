# SQLite migration entry points

Native and Expo code imports `@locallab/schema/embedded`:

```ts
import {
  migrateEmbeddedSQLite,
  type SQLiteMigrationDatabase,
} from "@locallab/schema/embedded";

await migrateEmbeddedSQLite(adapter);
```

`SQLiteMigrationDatabase` requires `exec(sql)`, `all<T>(sql)`, and
`transaction<T>(work)`. The transaction adapter must acquire a SQLite write lock,
such as `BEGIN IMMEDIATE`, and keep every callback query on that locked connection.
Enable foreign keys outside transactions. The shared runner does this before it
opens its first write transaction.

The embedded import graph contains static SQL and pure TypeScript. It does not
import the URL registry, evaluate `import.meta.url`, or read the filesystem.
Its relative imports omit file extensions so Metro resolves the TypeScript source
files directly; Node tooling uses the package's `tsx` scripts. The graph check
also verifies that every relative import resolves to an existing source file.
Node/server code retains `@locallab/schema/migrations`, whose adapter additionally
loads each registered SQL URL. Both paths call `applySQLiteMigrations` and share
ledger validation, transaction ordering, and rollback behavior.

## Regenerating native SQL

The coordinator registers immutable numeric SQL versions in `full.ts` and the
extension registry modules. After changing that registered chain, run:

```powershell
pnpm --filter @locallab/schema generate:embedded
pnpm --filter @locallab/schema check:embedded
pnpm --filter @locallab/schema test
```

`generate-embedded.ts` is Node-only build tooling. It reads the registered SQL,
normalizes line endings, and writes `embedded-data.generated.ts`. A source parity
test rejects stale generated data. The generator also derives the immutable core
baseline metadata from real SQLite. Generated constants are not hand edited.

## Adopting the prior unversioned app database

The old first-run app created the six immutable core tables and three named
indexes without a migration ledger. `migrateEmbeddedSQLite` can adopt that schema.
Inside one write transaction, it verifies exact normalized table SQL/constraints,
column metadata, foreign keys, implicit and named indexes, indexed columns,
foreign key integrity, and SQLite integrity. It then stamps version 1 and applies
later registered SQL without rewriting any core DDL.

A fresh database follows the normal version 1 migration. Partial tables, altered
constraints, missing/changed/additional core indexes, and invalid foreign keys are
rejected before creating a ledger. Feature tables on separate names remain intact;
the historical fixtures and populated reopen test cover chat history, managed
blobs, attachments, and generation lifecycle records.

Versioned databases validate their contiguous permanent ledger names and apply
only later entries. The migration SQL executes unchanged. Each migration's DDL
and ledger insertion share a transaction, so failure rolls both back. An unknown
or mismatched applied version is an error, not a reason to overwrite the schema.

These checks use real SQLite on Windows. They do not certify physical iPhone or
Mac execution; native adapter/bundle and device proof belong to host integration.
