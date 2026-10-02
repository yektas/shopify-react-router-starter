import db from "../db.server";
import { array, object, optional, safeParse, string } from "valibot";
import {
  getShopifyAppPricingConfig,
  readActiveSubscription,
  type FetchLike,
  type ShopifyAppPricingConfig,
} from "./shopify-app-pricing.server";

interface AdminGraphqlClient {
  graphql(query: string): Promise<Response>;
}

const ShopIdResponseSchema = object({
  data: optional(
    object({
      shop: optional(object({ id: optional(string()) })),
    }),
  ),
  errors: optional(array(object({ message: optional(string()) }))),
});

const SHOP_ID_QUERY = ["#graphql", "query BillingShopId {", "  shop { id }", "}"].join("\n");

export interface BillingState {
  shop: string;
  activeSubscription: boolean;
  planItemHandles: string[];
  planItemDescriptions: string[];
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  lastReconciledAt: Date | null;
  billingUnavailableSince: Date | null;
}

export type BillingReconciliation =
  | {
      configured: false;
      state: BillingState | null;
      missingPartnerApiSettings: string[];
      billingUnavailable: false;
    }
  | {
      configured: true;
      state: BillingState | null;
      missingPartnerApiSettings: [];
      billingUnavailable: boolean;
    };

export class BillingEntitlementError extends Error {}

export class BillingConfigurationError extends Error {}

export class BillingUnavailableError extends Error {}

export async function getBillingState(shop: string) {
  const state = await db.appBillingState.findUnique({ where: { shop } });

  return state ? toBillingState(state) : null;
}

export async function reconcileBillingState(input: {
  shop: string;
  admin: AdminGraphqlClient;
  config?: ShopifyAppPricingConfig;
  fetcher?: FetchLike;
  now?: Date;
}): Promise<BillingReconciliation> {
  const config = input.config ?? getShopifyAppPricingConfig();
  const current = await getBillingState(input.shop);

  if (!config.partnerApi) {
    return {
      configured: false,
      state: current,
      missingPartnerApiSettings: config.missingPartnerApiSettings,
      billingUnavailable: false,
    };
  }

  const now = input.now ?? new Date();

  try {
    const shopResponse = await input.admin.graphql(SHOP_ID_QUERY);

    const shopPayloadResult = safeParse(ShopIdResponseSchema, await shopResponse.json());

    if (!shopPayloadResult.success) {
      throw new Error("Shopify Admin API returned an invalid shop response");
    }

    const shopPayload = shopPayloadResult.output;
    const adminError = shopPayload.errors?.[0]?.message;
    const shopId = shopPayload.data?.shop?.id;

    if (!shopResponse.ok || adminError || !shopId) {
      throw new Error(adminError || "Shopify Admin API did not return the shop ID");
    }

    const subscription = await readActiveSubscription(
      shopId,
      input.shop,
      config.partnerApi,
      input.fetcher,
    );

    const state = await db.appBillingState.upsert({
      where: { shop: input.shop },
      create: billingStateData(input.shop, subscription, now),
      update: billingStateData(input.shop, subscription, now),
    });

    return {
      configured: true,
      state: toBillingState(state),
      missingPartnerApiSettings: [],
      billingUnavailable: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Shopify App Pricing reconciliation failed", {
      shop: input.shop,
      message,
    });

    if (current) {
      const state = await db.appBillingState.update({
        where: { shop: input.shop },
        data: {
          billingUnavailableSince: current.billingUnavailableSince ?? now,
        },
      });

      return {
        configured: true,
        state: toBillingState(state),
        missingPartnerApiSettings: [],
        billingUnavailable: true,
      };
    }

    return {
      configured: true,
      state: null,
      missingPartnerApiSettings: [],
      billingUnavailable: true,
    };
  }
}

export async function requirePlanHandle(input: {
  shop: string;
  admin: AdminGraphqlClient;
  allowedPlanHandles: readonly string[];
}): Promise<BillingState> {
  const allowedHandles = new Set(input.allowedPlanHandles);

  if (allowedHandles.size === 0) {
    throw new Error("At least one allowed Shopify App Pricing plan handle is required");
  }

  const result = await reconcileBillingState(input);

  if (!result.configured) {
    throw new BillingConfigurationError("Shopify App Pricing Partner API is not configured");
  }

  if (result.billingUnavailable) {
    throw new BillingUnavailableError("Shopify App Pricing could not verify the current plan.");
  }

  const state = result.state;

  const eligible = Boolean(
    state?.activeSubscription && state.planItemHandles.some((handle) => allowedHandles.has(handle)),
  );

  if (!eligible || !state) {
    throw new BillingEntitlementError("This feature requires an eligible app plan.");
  }

  return state;
}

export async function markBillingUninstalled(shop: string) {
  await db.appBillingState.updateMany({
    where: { shop },
    data: {
      activeSubscription: false,
      planItemHandlesJson: "[]",
      planItemDescriptionsJson: "[]",
      trialEndsAt: null,
      currentPeriodEnd: null,
      lastReconciledAt: null,
      billingUnavailableSince: null,
    },
  });
}

function billingStateData(
  shop: string,
  subscription: Awaited<ReturnType<typeof readActiveSubscription>>,
  now: Date,
) {
  return {
    shop,
    activeSubscription: Boolean(subscription),
    planItemHandlesJson: JSON.stringify(subscription?.items.map((item) => item.handle) ?? []),
    planItemDescriptionsJson: JSON.stringify(
      subscription?.items.flatMap((item) => (item.description ? [item.description] : [])) ?? [],
    ),
    trialEndsAt: subscription?.trialEndsAt ? new Date(subscription.trialEndsAt) : null,
    currentPeriodEnd: subscription?.currentBillingCycle?.endTime
      ? new Date(subscription.currentBillingCycle.endTime)
      : null,
    lastReconciledAt: now,
    billingUnavailableSince: null,
  };
}

function toBillingState(state: {
  shop: string;
  activeSubscription: boolean;
  planItemHandlesJson: string;
  planItemDescriptionsJson: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  lastReconciledAt: Date | null;
  billingUnavailableSince: Date | null;
}): BillingState {
  return {
    shop: state.shop,
    activeSubscription: state.activeSubscription,
    planItemHandles: parseStringArray(state.planItemHandlesJson),
    planItemDescriptions: parseStringArray(state.planItemDescriptionsJson),
    trialEndsAt: state.trialEndsAt,
    currentPeriodEnd: state.currentPeriodEnd,
    lastReconciledAt: state.lastReconciledAt,
    billingUnavailableSince: state.billingUnavailableSince,
  };
}

function parseStringArray(value: string): string[] {
  try {
    const result = safeParse(array(string()), JSON.parse(value));

    return result.success ? result.output : [];
  } catch {
    return [];
  }
}
