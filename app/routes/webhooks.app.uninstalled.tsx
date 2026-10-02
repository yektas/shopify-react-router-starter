import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { safeParse } from "valibot";
import { markBillingUninstalled } from "../models/billing.server";
import {
  AppUninstalledWebhookPayloadSchema,
  markAppUninstalled,
  notifyAppUninstalled,
} from "../models/ops-notifier.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhookId = request.headers.get("x-shopify-webhook-id");
  const { payload, shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  await markBillingUninstalled(shop);
  await markAppUninstalled(shop);
  const profilePayload = safeParse(AppUninstalledWebhookPayloadSchema, payload);
  await notifyAppUninstalled(
    shop,
    webhookId,
    profilePayload.success ? profilePayload.output : undefined,
  );

  return new Response();
};
