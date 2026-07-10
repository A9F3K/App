/** Vercel deployment id from the build environment (`EXPO_PUBLIC_VERCEL_DEPLOYMENT_ID`). */
export function getVercelDeploymentId(): string | null {
  const raw = process.env.EXPO_PUBLIC_VERCEL_DEPLOYMENT_ID?.trim();
  if (!raw || raw.length === 0) return null;
  const withoutPrefix = raw.startsWith("dpl_") ? raw.slice(4) : raw;
  return withoutPrefix.length > 0 ? withoutPrefix : null;
}

/** Monotonic deploy counter stamped in Postgres on each Vercel build (`EXPO_PUBLIC_DEPLOY_VERSION`). */
export function getDeployVersion(): number | null {
  const raw = process.env.EXPO_PUBLIC_DEPLOY_VERSION?.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
