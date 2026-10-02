import { createHash, createHmac, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { array, nullable, object, optional, parse, string, type InferOutput } from "valibot";

import db from "../db.server";

type OpsEventType = "app.installed" | "app.uninstalled";

export interface ShopProfile {
  name?: string | null;
  ownerName?: string | null;
  email?: string | null;
  countryCode?: string | null;
  currencyCode?: string | null;
  ianaTimezone?: string | null;
  shopifyPlan?: string | null;
}

interface OpsEvent {
  id: string;
  app: string;
  type: OpsEventType;
  shop: string;
  occurredAt: string;
  shopProfile?: ShopProfile;
}

type AdminGraphqlClient = Pick<AdminApiContext, "graphql">;

export const AppUninstalledWebhookPayloadSchema = object({
  name: optional(nullable(string())),
  shop_owner: optional(nullable(string())),
  email: optional(nullable(string())),
  country_code: optional(nullable(string())),
  currency: optional(nullable(string())),
  iana_timezone: optional(nullable(string())),
  plan_display_name: optional(nullable(string())),
});

export type AppUninstalledWebhookPayload = InferOutput<typeof AppUninstalledWebhookPayloadSchema>;

const ShopProfileGraphqlResponseSchema = object({
  data: optional(
    object({
      shop: optional(
        nullable(
          object({
            name: optional(nullable(string())),
            shopOwnerName: optional(nullable(string())),
            contactEmail: optional(nullable(string())),
            shopAddress: optional(
              nullable(
                object({
                  countryCodeV2: optional(nullable(string())),
                }),
              ),
            ),
            currencyCode: optional(nullable(string())),
            ianaTimezone: optional(nullable(string())),
            plan: optional(
              nullable(
                object({
                  publicDisplayName: optional(nullable(string())),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  ),
  errors: optional(
    nullable(
      array(
        object({
          message: optional(nullable(string())),
        }),
      ),
    ),
  ),
});

export async function markAppInstalled(shop: string): Promise<boolean> {
  const installedAt = new Date();

  try {
    await db.opsInstallation.create({ data: { shop, installedAt } });

    return true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
  }

  const reinstalled = await db.opsInstallation.updateMany({
    where: { shop, uninstalledAt: { not: null } },
    data: { installedAt, uninstalledAt: null },
  });

  return reinstalled.count > 0;
}

export async function markAppUninstalled(shop: string): Promise<void> {
  const uninstalledAt = new Date();
  await db.opsInstallation.upsert({
    where: { shop },
    create: { shop, uninstalledAt },
    update: { uninstalledAt },
  });
}

export async function notifyAppInstalled(
  shop: string,
  accessToken: string,
  admin?: AdminGraphqlClient,
): Promise<void> {
  const app = configuredAppId();

  if (!app || !notifierConfigured()) return;

  let shopProfile: ShopProfile | undefined;

  if (admin) {
    try {
      shopProfile = await queryShopProfile(admin);
    } catch (error) {
      console.error("Shop profile enrichment failed", {
        shop,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  const event: OpsEvent = {
    id: lifecycleEventId(app, "app.installed", shop, accessToken),
    app,
    type: "app.installed",
    shop,
    occurredAt: new Date().toISOString(),
  };

  if (shopProfile) event.shopProfile = shopProfile;

  await sendOpsEvent(event);
}

export async function notifyAppUninstalled(
  shop: string,
  webhookId: string | null,
  payload: AppUninstalledWebhookPayload | undefined,
): Promise<void> {
  const app = configuredAppId();

  if (!app || !notifierConfigured()) return;

  const event: OpsEvent = {
    id: lifecycleEventId(app, "app.uninstalled", shop, webhookId ?? randomUUID()),
    app,
    type: "app.uninstalled",
    shop,
    occurredAt: new Date().toISOString(),
  };

  if (payload) event.shopProfile = shopProfileFromUninstallPayload(payload);

  await sendOpsEvent(event);
}

export async function queryShopProfile(admin: AdminGraphqlClient): Promise<ShopProfile> {
  const response = await admin.graphql(`#graphql
    query OpsLifecycleShopProfile {
      shop {
        name
        shopOwnerName
        contactEmail
        shopAddress { countryCodeV2 }
        currencyCode
        ianaTimezone
        plan { publicDisplayName }
      }
    }
  `);

  if (!response.ok) {
    throw new Error(`Admin GraphQL returned HTTP ${response.status}`);
  }

  const body = parse(ShopProfileGraphqlResponseSchema, await response.json());

  if ((body.errors?.length ?? 0) > 0 || !body.data?.shop) {
    throw new Error("Admin GraphQL shop profile response was incomplete");
  }

  const shop = body.data.shop;

  return {
    name: shop.name ?? null,
    ownerName: shop.shopOwnerName ?? null,
    email: shop.contactEmail ?? null,
    countryCode: shop.shopAddress?.countryCodeV2 ?? null,
    currencyCode: shop.currencyCode ?? null,
    ianaTimezone: shop.ianaTimezone ?? null,
    shopifyPlan: shop.plan?.publicDisplayName ?? null,
  };
}

export function shopProfileFromUninstallPayload(
  payload: AppUninstalledWebhookPayload,
): ShopProfile {
  return {
    name: payload.name ?? null,
    ownerName: payload.shop_owner ?? null,
    email: payload.email ?? null,
    countryCode: payload.country_code ?? null,
    currencyCode: payload.currency ?? null,
    ianaTimezone: payload.iana_timezone ?? null,
    shopifyPlan: payload.plan_display_name ?? null,
  };
}

export async function sendOpsEvent(event: OpsEvent): Promise<"sent" | "disabled" | "failed"> {
  const endpoint = process.env.OPS_NOTIFIER_URL?.trim();
  const secret = process.env.OPS_NOTIFIER_SECRET?.trim();

  if (!endpoint || !secret) return "disabled";

  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1_000));

  const signature = `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ops-App": event.app,
        "X-Ops-Signature": signature,
        "X-Ops-Timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      throw new Error(`Ops notifier returned HTTP ${response.status}`);
    }

    return "sent";
  } catch (error) {
    console.error("Ops notification delivery failed", {
      app: event.app,
      eventId: event.id,
      type: event.type,
      message: error instanceof Error ? error.message : "Unknown error",
    });

    return "failed";
  }
}

function notifierConfigured(): boolean {
  return Boolean(process.env.OPS_NOTIFIER_URL?.trim() && process.env.OPS_NOTIFIER_SECRET?.trim());
}

function configuredAppId(): string | undefined {
  const appId = process.env.OPS_NOTIFIER_APP_ID?.trim();

  return appId || undefined;
}

function lifecycleEventId(
  app: string,
  type: OpsEventType,
  shop: string,
  deduplicationKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${shop}:${deduplicationKey}`)
    .digest("hex")
    .slice(0, 32);

  return `${app}:${type}:${digest}`;
}
