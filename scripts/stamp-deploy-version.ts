import dotenv from "dotenv";
import path from "path";
import { neon } from "@neondatabase/serverless";

const cwd = process.cwd();
dotenv.config({ path: path.join(cwd, ".env") });
dotenv.config({ path: path.join(cwd, ".env.local") });

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString || process.env.SKIP_DB_MIGRATE === "1") {
    process.stdout.write("0\n");
    return;
  }

  const sql = neon(connectionString);
  const rows = await sql`
    UPDATE app_deploy_version
    SET version = version + 1
    WHERE id = 1
    RETURNING version
  `;
  const version = rows[0]?.version ?? 0;
  process.stdout.write(`${version}\n`);
}

void main().catch((err) => {
  console.error("[deploy-version] stamp failed", err);
  process.exit(1);
});
