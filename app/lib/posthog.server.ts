import type { PostHogConfig } from "./posthog";

interface PostHogSessionIdentity {
  shop: string;
  shopName?: string | null;
}

type PostHogEnvironment = Record<string, string | undefined>;

const API_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

const DEFAULT_API_HOST = "https://eu.i.posthog.com";

function normalizeHost(value?: string): string | null {
  const trimmed = value?.trim();

  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);

    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    return url.origin;
  } catch {
    return null;
  }
}

export function getPostHogConfig(
  session: PostHogSessionIdentity,
  env: PostHogEnvironment = process.env,
): PostHogConfig | null {
  const apiKey = env.POSTHOG_PROJECT_API_KEY?.trim();

  if (!apiKey || !API_KEY_PATTERN.test(apiKey)) return null;

  const shop = session.shop.trim().toLowerCase();

  if (!shop) return null;

  return {
    apiKey,
    apiHost: normalizeHost(env.POSTHOG_API_HOST) ?? DEFAULT_API_HOST,
    shop: {
      domain: shop,
      name: session.shopName?.trim() || shop,
    },
  };
}
