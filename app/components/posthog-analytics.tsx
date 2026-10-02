import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { posthog } from "posthog-js";

import type { PostHogConfig } from "../lib/posthog";

export interface PostHogAnalyticsClient {
  capture(event: "$pageview"): void;
  get_distinct_id(): string;
  identify(domain: string, properties: { shop_name: string | undefined }): void;
  init(
    apiKey: string,
    options: {
      api_host: string;
      capture_pageview: false;
      person_profiles: "identified_only";
    },
  ): void;
  reset(): void;
}

export function initializePostHogSession(
  client: PostHogAnalyticsClient,
  apiKey: string | undefined,
  apiHost: string | undefined,
  shopDomain: string | undefined,
  shopName: string | undefined,
  isReady: boolean,
): boolean {
  if (!apiKey || !apiHost) return false;

  if (!isReady) {
    client.init(apiKey, {
      api_host: apiHost,
      capture_pageview: false,
      person_profiles: "identified_only",
    });
  }

  if (shopDomain) {
    if (client.get_distinct_id() !== shopDomain) {
      client.reset();
    }

    client.identify(shopDomain, { shop_name: shopName });
  }

  return true;
}

export function capturePostHogPageView(client: PostHogAnalyticsClient, isReady: boolean): void {
  if (isReady) client.capture("$pageview");
}

export function PostHogAnalytics({ config }: { config: PostHogConfig | null }) {
  const apiKey = config?.apiKey;
  const apiHost = config?.apiHost;
  const shopDomain = config?.shop.domain;
  const shopName = config?.shop.name;
  const ready = useRef(false);
  const location = useLocation();

  useEffect(() => {
    if (!apiKey || !apiHost) return;

    ready.current = initializePostHogSession(
      posthog,
      apiKey,
      apiHost,
      shopDomain,
      shopName,
      ready.current,
    );
  }, [apiKey, apiHost, shopDomain, shopName]);

  useEffect(() => {
    capturePostHogPageView(posthog, ready.current);
  }, [location.pathname, location.search]);

  return null;
}
