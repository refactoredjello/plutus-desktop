import { defineConfig } from 'drizzle-kit'

// Orchestrator only: `npm run db:generate -- --name <what>` after editing src/db/schema.ts,
// then review the SQL. Never edit an applied migration.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
})
