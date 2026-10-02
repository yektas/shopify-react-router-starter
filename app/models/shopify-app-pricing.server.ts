import { array, nullable, object, optional, parse, string } from "valibot";

const DEFAULT_PARTNER_API_VERSION = "2026-07";

const SHOP_DOMAIN_PATTERN = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/i;

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

const PARTNER_API_VERSION_PATTERN = /^\d{4}-(01|04|07|10)$/;

const SHOP_GID_PATTERN = /^gid:\/\/shopify\/Shop\/\d+$/;

const APP_GID_PATTERN = /^gid:\/\/shopify\/App\/\d+$/;

type Environment = Readonly<Record<string, string | undefined>>;

export interface PartnerApiConfig {
  apiVersion: string;
  appId: string;
  organizationId: string;
  accessToken: string;
}

export interface ShopifyAppPricingConfig {
  appHandle: string | null;
  partnerApi: PartnerApiConfig | null;
  missingPartnerApiSettings: string[];
}

export interface ManagedSubscription {
  shop: { id: string; myshopifyDomain: string };
  trialEndsAt: string | null;
  currentBillingCycle: { startTime: string; endTime: string } | null;
  items: Array<{ handle: string; description: string | null }>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ActiveSubscriptionResponseSchema = object({
  data: optional(
    nullable(
      object({
        activeSubscription: optional(
          nullable(
            object({
              shop: object({ id: string(), myshopifyDomain: string() }),
              trialEndsAt: nullable(string()),
              currentBillingCycle: nullable(object({ startTime: string(), endTime: string() })),
              items: array(
                object({
                  handle: string(),
                  description: nullable(string()),
                }),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
  errors: optional(nullable(array(object({ message: optional(nullable(string())) })))),
});

export const ACTIVE_SUBSCRIPTION_QUERY = [
  "#graphql",
  "query ActiveSubscription($appId: ID!, $shopId: ID!) {",
  "  activeSubscription(appId: $appId, shopId: $shopId) {",
  "    shop { id myshopifyDomain }",
  "    trialEndsAt",
  "    currentBillingCycle { startTime endTime }",
  "    items { handle description }",
  "  }",
  "}",
].join("\n");

export function getShopifyAppPricingConfig(
  env: Environment = process.env,
): ShopifyAppPricingConfig {
  const appHandle = env.SHOPIFY_APP_HANDLE?.trim().toLowerCase() || null;

  if (appHandle && !HANDLE_PATTERN.test(appHandle)) {
    throw new Error("SHOPIFY_APP_HANDLE is not a valid Shopify app handle");
  }

  const requiredSettings = [
    "SHOPIFY_PARTNER_ORGANIZATION_ID",
    "SHOPIFY_PARTNER_APP_ID",
    "SHOPIFY_PARTNER_API_TOKEN",
  ] as const;

  const hasAnyPartnerSetting = requiredSettings.some((name) => env[name]?.trim());

  const missingPartnerApiSettings = hasAnyPartnerSetting
    ? requiredSettings.filter((name) => !env[name]?.trim())
    : [...requiredSettings];

  if (missingPartnerApiSettings.length > 0) {
    return { appHandle, partnerApi: null, missingPartnerApiSettings };
  }

  const organizationId = env.SHOPIFY_PARTNER_ORGANIZATION_ID!.trim();
  const appId = env.SHOPIFY_PARTNER_APP_ID!.trim();
  const accessToken = env.SHOPIFY_PARTNER_API_TOKEN!.trim();

  const apiVersion = env.SHOPIFY_PARTNER_API_VERSION?.trim() || DEFAULT_PARTNER_API_VERSION;

  if (!/^\d+$/.test(organizationId)) {
    throw new Error("SHOPIFY_PARTNER_ORGANIZATION_ID must be a numeric organization ID");
  }

  if (!APP_GID_PATTERN.test(appId)) {
    throw new Error("SHOPIFY_PARTNER_APP_ID must be a Shopify App GID");
  }

  if (!PARTNER_API_VERSION_PATTERN.test(apiVersion)) {
    throw new Error("SHOPIFY_PARTNER_API_VERSION must use a quarterly YYYY-MM version");
  }

  return {
    appHandle,
    partnerApi: { apiVersion, appId, organizationId, accessToken },
    missingPartnerApiSettings: [],
  };
}

export function buildShopifyHostedPricingUrl(shop: string, appHandle: string): string {
  const storeHandle = shop.trim().match(SHOP_DOMAIN_PATTERN)?.[1];

  if (!storeHandle) {
    throw new Error("Cannot build pricing URL from an invalid shop domain");
  }

  const normalizedAppHandle = appHandle.trim().toLowerCase();

  if (!HANDLE_PATTERN.test(normalizedAppHandle)) {
    throw new Error("Cannot build pricing URL from an invalid Shopify app handle");
  }

  return (
    "https://admin.shopify.com/store/" +
    storeHandle +
    "/charges/" +
    normalizedAppHandle +
    "/pricing_plans"
  );
}

export async function readActiveSubscription(
  shopId: string,
  expectedShop: string,
  config: PartnerApiConfig,
  fetchImpl: FetchLike = fetch,
): Promise<ManagedSubscription | null> {
  if (!SHOP_GID_PATTERN.test(shopId)) {
    throw new Error("Partner API subscription lookup requires a Shopify Shop GID");
  }

  const endpoint =
    "https://partners.shopify.com/" +
    encodeURIComponent(config.organizationId) +
    "/api/" +
    config.apiVersion +
    "/graphql.json";

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.accessToken,
    },
    body: JSON.stringify({
      query: ACTIVE_SUBSCRIPTION_QUERY,
      variables: { appId: config.appId, shopId },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const payload = parse(ActiveSubscriptionResponseSchema, await response.json());

  const errors = payload.errors?.flatMap((error) => (error.message ? [error.message] : [])) ?? [];

  if (!response.ok || errors.length > 0) {
    throw new Error(errors.join(", ") || "Shopify Partner API returned HTTP " + response.status);
  }

  if (!payload.data || !("activeSubscription" in payload.data)) {
    throw new Error("Shopify Partner API response omitted activeSubscription");
  }

  const subscription = payload.data.activeSubscription ?? null;

  if (!subscription) return null;

  if (
    subscription.shop?.id !== shopId ||
    subscription.shop?.myshopifyDomain?.trim().toLowerCase() !== expectedShop.trim().toLowerCase()
  ) {
    throw new Error("Shopify subscription did not match the authenticated shop");
  }

  if (subscription.items.some((item) => item.handle.length === 0)) {
    throw new Error("Shopify subscription items are invalid");
  }

  validateOptionalDate(subscription.trialEndsAt, "trial end");

  if (subscription.currentBillingCycle) {
    const start = validateDate(subscription.currentBillingCycle.startTime, "billing cycle start");

    const end = validateDate(subscription.currentBillingCycle.endTime, "billing cycle end");

    if (end <= start) {
      throw new Error("Shopify billing cycle dates are invalid");
    }
  }

  return subscription;
}

function validateOptionalDate(value: string | null, label: string) {
  if (value !== null) validateDate(value, label);
}

function validateDate(value: string, label: string) {
  const date = new Date(value);

  if (!value || Number.isNaN(date.getTime())) {
    throw new Error("Shopify " + label + " date is invalid");
  }

  return date;
}
