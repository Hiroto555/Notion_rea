# R6 synthetic demo

Run from the final R6 validation checkout:

```sh
cd <workspace-root>/Folio-r6-20261028/validation
node scripts/r6-demo.mjs
```

The data directory is validation/output/r6-demo/data and is marked SYNTHETIC-R6-DEMO. The script refuses an unrecognized directory. It does not use the installed application's data.

Use 「列の設定」 for add/rename/type preview. The exercised demo has a migrated legacy DB, a text-to-number column conversion, an added date column, and a record body verified after restart. The exercise separately kills its owned process with a durable incomplete '-' input, resumes it, and saves the completed value.

The reproducible exercise is `node scripts/r6-demo.mjs --prepare-only` followed by `node scripts/r6-demo-exercise.mjs` on a fresh marked demo only. It refuses to re-exercise a DB already converted. Screenshots and manifest are written under output/r6-demo. Ordinary reopening preserves the already exercised demo.
