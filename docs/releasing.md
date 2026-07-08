# Releasing

`cc-vision-hook` uses npm Trusted Publishing (OIDC) and GitHub Releases. Versioning and
`CHANGELOG.md` entries are managed by [Changesets](https://github.com/changesets/changesets).

## One-time setup

Trusted Publishing requires the package to already exist on npm, so the very first
version has to be published manually (see [Bootstrapping the first release](#bootstrapping-the-first-release)
below). After that exists:

1. On npm, go to the package's **Settings → Trusted Publisher** and add a GitHub Actions
   publisher:
   - Organization or user: `RainSunMe`
   - Repository: `cc-vision-hook`
   - Workflow filename: `release.yml` (filename only, not the full path)
   - Environment name: `npm`
   - Allowed actions: `npm publish`
2. On GitHub, create a repository **Environment** named `npm` (Settings → Environments →
   New environment). The name must match the npm configuration exactly.
3. (Recommended) Once Trusted Publishing works, go back to npm package settings →
   **Publishing access** and select "Require two-factor authentication and disallow
   tokens" so the package can no longer be published with a long-lived token.

Trusted Publishing requires npm CLI ≥ 11.5.1 and Node ≥ 22.14.0 — the release workflow
pins Node 22.14+ and force-upgrades the npm CLI before publishing to make sure both
requirements are met regardless of what `setup-node` ships by default.

## Day-to-day release steps

1. While working on a change, run `bun run changeset` and describe the change (patch /
   minor / major). Commit the generated `.changeset/*.md` file together with your code
   change.
2. When you're ready to cut a release, run `bun run version-packages`. This consumes all
   pending changesets, bumps the version in `package.json`, and writes `CHANGELOG.md`.
3. Review the generated diff, commit it, and push to `main`.
4. Tag the release and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

The `Release` workflow (triggered by the `v*` tag push) will:

1. install dependencies;
2. verify the git tag matches `package.json`'s `version` field;
3. verify that version doesn't already exist on npm;
4. run `bun run ci` (typecheck + test + build);
5. publish to npm with provenance, via Trusted Publishing — no `NPM_TOKEN` involved;
6. poll the npm registry until the new version is visible;
7. create a GitHub Release with auto-generated notes.

Pre-release versions (e.g. `0.2.0-alpha.1`) are published under the `alpha` npm dist-tag
instead of `latest`, so `npm install cc-vision-hook` never accidentally picks up an
unstable build.

## Bootstrapping the first release

Trusted Publishing can only be configured for a package that already exists on npm, so
`v0.1.0` has to go out through a manual, local `npm publish` once:

```bash
npm login              # or: npm login --auth-type=web
bun run ci              # typecheck + test + build
npm publish --access public
```

After that succeeds, follow [One-time setup](#one-time-setup) above to wire up Trusted
Publishing for every release after this one.

## Notes

- Do not use local `npm publish` for routine releases once Trusted Publishing is set up
  — always go through a tag push.
- Do not add `NPM_TOKEN` to repository secrets unless Trusted Publishing becomes
  unavailable and you need to fall back to token-based auth.
- The release workflow requires `permissions.id-token: write`.
- The GitHub Environment name (`npm`) must match the npm Trusted Publisher configuration
  exactly — this is case-sensitive.
- `package.json`'s `repository.url` must exactly match the GitHub repository URL, or npm
  will reject the OIDC exchange.
