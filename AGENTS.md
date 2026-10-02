# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## Working Preferences

- Keep changes focused and follow the existing project structure.
- Keep route components together unless they become hard to read or contain reusable, meaningful logic. Avoid adding folders or one-off component files by default.
- Treat the Shopify dev server as already running. If `.agent/dev.log` exists, read it when debugging before starting another process.
- Do not spawn subagents unless requested.

## Styling

- Use Polaris web components for embedded app structure and standard Shopify controls where they fit.
- Use Tailwind CSS v4 utilities for custom layouts and the shared stylesheet at `app/styles/global.css`; avoid introducing another styling system without a shared need.
- Keep the visual treatment restrained: neutral surfaces, clear text hierarchy, subtle borders, and semantic status colors.
- Keep custom layouts responsive, provide visible keyboard-focus states, and respect reduced-motion preferences.
- Use tabular numerals for prices, counts, and other changing numeric values.
- Keep Inter as the app UI font through the existing Shopify CDN stylesheet. Introduce another font only for content with a specific typographic need.


## Linting and formatting

- After making code changes, run `npx oxlint --fix`, then run `npx oxfmt`.
- Before finishing, run `npx oxlint --deny-warnings --format=agent`.
