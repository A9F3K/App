import { execSync } from "node:child_process";

function readDeployVersion(): string {
  const output = execSync("npx tsx scripts/stamp-deploy-version.ts", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return line && line.length > 0 ? line : "0";
}

const deployVersion = readDeployVersion();
const env = {
  ...process.env,
  EXPO_PUBLIC_DEPLOY_VERSION: deployVersion,
  EXPO_PUBLIC_VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID?.trim() ?? "",
};

console.log(
  `[vercel-export] EXPO_PUBLIC_DEPLOY_VERSION=${deployVersion} deploymentId=${env.EXPO_PUBLIC_VERCEL_DEPLOYMENT_ID || "(none)"}`,
);

execSync("npx expo export -p web --output-dir .vercel/output/static", {
  env,
  stdio: "inherit",
});
