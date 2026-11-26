# Contributing to Ladder

Thanks for your interest. Ladder is young and maintained by one person, so the process is light.

## Issues

Bug reports and ideas are welcome as GitHub issues. For a bug, include your macOS version, the Ladder version (Ladder → About Ladder), the agent involved and the steps to reproduce it. Never paste tokens, keys or the contents of credential files.

## Pull requests

Open an issue before a large change, so we can agree on the approach first. Small fixes can go straight to a pull request.

1. Branch from `development`; pull requests target `development` too (`main` is what the website deploys from).
2. Set up and run the app as described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
3. Before opening the pull request:
   ```bash
   pnpm --filter @ladder/desktop typecheck
   pnpm --filter @ladder/desktop build
   ```
   and `pnpm --filter @ladder/website build` if you touched the website.
4. For interface changes, attach a screenshot, and check light and dark themes.

## Conventions

- **Product and design rules** are in [`app/PRODUCT.md`](app/PRODUCT.md) and [`app/DESIGN.md`](app/DESIGN.md). Read them before changing a behavior or the interface.
- **User-facing text** is English inside `t('…')`; add the Italian entry in `app/desktop/src/shared/locales/it` with the exact English text as key. If you don't speak Italian, say so in the pull request and it will be added.
- **No em dashes** in user-facing text.
- **Comments** in English, short, explaining why or a non-obvious behavior. Some older files still have Italian comments that are being translated.
- **Child processes** start from `cleanEnv()` (`app/desktop/src/shared/env.ts`), so inherited `ANTHROPIC_*` and `CLAUDE*` variables never reach them. Ladder never reads or logs credentials; the only secret it stores is the Linear API key, encrypted in the Keychain.
- **Commit messages** in English: imperative title, short, no final period (e.g. `Add auto-updates from ladder-releases`), with an optional bulleted body.

The `CLAUDE.md` files describe the same rules for coding agents working on the repository.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), as stated in section 5 of the license.
