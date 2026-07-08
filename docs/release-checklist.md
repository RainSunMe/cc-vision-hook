# Release checklist

Before tagging a new release:

- [ ] Run `bun run ci` (typecheck + test + build) locally.
- [ ] Run `npm pack --dry-run` and confirm `dist/`, `README.md`, `README.zh-CN.md`,
      `LICENSE`, `CHANGELOG.md` are all included and no stray files leaked in.
- [ ] `npm pack` + install the tarball in a scratch directory, verify `cvh`/`cc-vision-hook`
      bin commands run.
- [ ] Scan for leaked secrets, API keys, or internal URLs (`grep -rn` the diff).
- [ ] Update `README.md` / `README.zh-CN.md` if user-facing behavior changed.
- [ ] Confirm `CHANGELOG.md` (via `bun run version-packages`) accurately describes the
      release.
- [ ] Tag `vX.Y.Z` and push.
- [ ] Watch the `Release` GitHub Action to completion.
- [ ] Verify `npm install -g cc-vision-hook@X.Y.Z` works from a clean machine/container.
- [ ] Verify `npx cc-vision-hook@X.Y.Z doctor` runs without crashing.
