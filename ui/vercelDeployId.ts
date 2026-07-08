/** Vercel deployment id from the build environment (`EXPO_PUBLIC_VERCEL_DEPLOYMENT_ID`). */
export function getVercelDeploymentId(): string | null {
  const raw = process.env.EXPO_PUBLIC_VERCEL_DEPLOYMENT_ID?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** Monotonic deploy counter stamped in Postgres on each Vercel build (`EXPO_PUBLIC_DEPLOY_VERSION`). */
export function getDeployVersion(): number | null {
  const raw = process.env.EXPO_PUBLIC_DEPLOY_VERSION?.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
