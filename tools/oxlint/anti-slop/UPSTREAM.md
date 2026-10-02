# Anti-slop plugin provenance

- Source repository: <https://github.com/dmmulroy/anti-slop>.
- Source revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.
- Source assets: `src/` at the recorded revision, excluding upstream `*.test.ts` files as in the upstream installer.
- Installed plugin paths: `tools/oxlint/anti-slop/index.ts` and its adjacent `rules/`, `shared/`, `vendor/`, and `effect/` directories.
- Intentional configuration: the generic plugin is enabled. The bundled Effect plugin remains unregistered because this repository has no direct `effect` dependency and Effect rules were not requested.
