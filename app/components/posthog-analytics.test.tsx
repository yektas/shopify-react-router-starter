import { describe, expect, it } from "vitest";

import {
  capturePostHogPageView,
  initializePostHogSession,
  type PostHogAnalyticsClient,
} from "./posthog-analytics";

const config = {
  apiKey: "phc_key",
  apiHost: "https://eu.i.posthog.com",
  shop: { domain: "snowdevil.myshopify.com", name: "Snowdevil" },
};

interface PostHogCalls {
  initializedWith: string[];
  apiHosts: string[];
  resets: number;
  identifiedDomains: string[];
  identifiedNames: Array<string | undefined>;
  capturedEvents: string[];
  distinctId: string;
}

function createPostHogClient(distinctId = "") {
  const calls: PostHogCalls = {
    initializedWith: [],
    apiHosts: [],
    resets: 0,
    identifiedDomains: [],
    identifiedNames: [],
    capturedEvents: [],
    distinctId,
  };

  const client = {
    init(apiKey, options) {
      calls.initializedWith.push(apiKey);
      calls.apiHosts.push(options?.api_host ?? "");
    },
    get_distinct_id() {
      return calls.distinctId;
    },
    reset() {
      calls.resets += 1;
      calls.distinctId = "";
    },
    identify(domain, properties) {
      calls.identifiedDomains.push(domain);
      calls.identifiedNames.push(properties?.shop_name);
      calls.distinctId = domain;
    },
    capture(event) {
      calls.capturedEvents.push(event);
    },
  } satisfies PostHogAnalyticsClient;

  return { client, calls };
}

describe("PostHogAnalytics", () => {
  it("initializes, identifies the shop, and captures the first pageview", () => {
    const { client, calls } = createPostHogClient(config.shop.domain);

    const isReady = initializePostHogSession(
      client,
      config.apiKey,
      config.apiHost,
      config.shop.domain,
      config.shop.name,
      false,
    );

    capturePostHogPageView(client, isReady);

    expect(calls.initializedWith).toEqual(["phc_key"]);
    expect(calls.apiHosts).toEqual(["https://eu.i.posthog.com"]);
    expect(calls.identifiedDomains).toEqual(["snowdevil.myshopify.com"]);
    expect(calls.identifiedNames).toEqual(["Snowdevil"]);
    expect(calls.capturedEvents).toEqual(["$pageview"]);
  });

  it("resets before identifying a different shop", () => {
    const { client, calls } = createPostHogClient("previous.myshopify.com");

    initializePostHogSession(
      client,
      config.apiKey,
      config.apiHost,
      config.shop.domain,
      config.shop.name,
      false,
    );

    expect(calls.resets).toBe(1);
    expect(calls.identifiedDomains).toEqual(["snowdevil.myshopify.com"]);
  });

  it("does not initialize or capture when analytics is disabled", () => {
    const { client, calls } = createPostHogClient();

    const isReady = initializePostHogSession(
      client,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );

    capturePostHogPageView(client, isReady);

    expect(calls.initializedWith).toEqual([]);
    expect(calls.identifiedDomains).toEqual([]);
    expect(calls.capturedEvents).toEqual([]);
  });
});
