import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { reconcileBillingState } from "../models/billing.server";
import {
  buildShopifyHostedPricingUrl,
  getShopifyAppPricingConfig,
} from "../models/shopify-app-pricing.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const config = getShopifyAppPricingConfig();

  const result = await reconcileBillingState({
    shop: session.shop,
    admin,
    config,
  });

  const state = result.state;

  return {
    appHandleConfigured: Boolean(config.appHandle),
    partnerApiConfigured: result.configured,
    missingPartnerApiSettings: result.missingPartnerApiSettings,
    billingUnavailable: result.billingUnavailable || Boolean(state?.billingUnavailableSince),
    activeSubscription: state?.activeSubscription ?? false,
    planDescriptions: state?.planItemDescriptions ?? [],
    trialEndsAt: state?.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: state?.currentPeriodEnd?.toISOString() ?? null,
    lastReconciledAt: state?.lastReconciledAt?.toISOString() ?? null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const { appHandle } = getShopifyAppPricingConfig();

  if (!appHandle) {
    throw new Response("Set SHOPIFY_APP_HANDLE to enable hosted pricing.", {
      status: 400,
    });
  }

  return auth.redirect(buildShopifyHostedPricingUrl(auth.session.shop, appHandle), {
    target: "_top",
  });
};

export default function PlansPage() {
  const data = useLoaderData<typeof loader>();

  const billingStatus = data.billingUnavailable
    ? "Could not verify with Shopify"
    : !data.partnerApiConfigured
      ? "Not configured"
      : data.activeSubscription
        ? "Active subscription"
        : "No active subscription";

  return (
    <s-page heading="Plans and billing" inlineSize="large">
      <s-stack gap="base">
        {!data.partnerApiConfigured ? (
          <s-banner tone="info">
            Add the Shopify Partner API settings to the server environment to check subscription
            status. Shopify App Pricing requires a public app with plans configured in the Partner
            Dashboard.
          </s-banner>
        ) : null}
        {data.billingUnavailable ? (
          <s-banner tone="warning">
            Shopify billing could not be checked. The page is showing the last successfully verified
            subscription, if available.
          </s-banner>
        ) : null}

        <s-section heading="Current subscription">
          <s-stack gap="base">
            <s-text>{billingStatus}</s-text>
            {data.planDescriptions.map((description, index) => (
              <s-text key={description + index}>{description}</s-text>
            ))}
            {data.trialEndsAt ? (
              <s-text color="subdued">Trial ends {formatDate(data.trialEndsAt)}</s-text>
            ) : null}
            {data.currentPeriodEnd ? (
              <s-text color="subdued">
                Current billing period ends {formatDate(data.currentPeriodEnd)}
              </s-text>
            ) : null}
            {data.lastReconciledAt ? (
              <s-text color="subdued">Last checked {formatDate(data.lastReconciledAt)}</s-text>
            ) : null}
            {data.appHandleConfigured ? (
              <Form method="post">
                <s-button type="submit" variant="primary">
                  Manage plan in Shopify
                </s-button>
              </Form>
            ) : (
              <s-text color="subdued">
                Set SHOPIFY_APP_HANDLE to enable Shopify-hosted plan management.
              </s-text>
            )}
          </s-stack>
        </s-section>

        {data.missingPartnerApiSettings.length > 0 ? (
          <s-section heading="Partner API setup">
            <s-text color="subdued">Configure: {data.missingPartnerApiSettings.join(", ")}.</s-text>
            <s-text color="subdued">The access token needs the Manage apps permission.</s-text>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
