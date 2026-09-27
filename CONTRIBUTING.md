# Contributing

Thanks for wanting to contribute.
One rule up front:

**Human-authored pull requests targeting `main` must be raised through [`no-mistakes`](https://github.com/vbasky/no-mistakes).**
We require this to reduce the maintainer's burden of reviewing and merging contributions.

`no-mistakes` puts a local git proxy in front of your real remote.
Pushing through it runs an AI-driven review, test, lint, and CI pipeline in an isolated worktree, forwards the push upstream only after every check passes, and opens a clean PR automatically.

A GitHub Actions check named `PR must be raised via no-mistakes` runs on PRs targeting `main` and fails if the body is missing the deterministic signature that no-mistakes writes, or if the structured pipeline attestation does not show `review`, `test`, and `document` as completed.
Known automation accounts are exempt so dependency and release automation can keep working.
Regular contributor PRs without the signature and attestation will not be reviewed or merged.

## Workflow

Fork routing requires `no-mistakes` v1.30.1 or newer.
This repository's required check also needs `no-mistakes` >= 1.46.0 so the PR body includes structured pipeline step attestation.

1. Fork the repo, then clone the parent repo or set your local `origin` back to the parent repo (`git@github.com:vbasky/hatch.git`).
2. Create a branch and make your changes.
3. Initialize or refresh the gate with your fork as the push target: `no-mistakes init --fork-url git@github.com:<you>/hatch.git`.
4. Commit your changes.
5. Push through the gate instead of pushing to `origin`: `git push no-mistakes`.
6. Run `no-mistakes` to attach to the pipeline, watch findings, and auto-fix or review as needed.
7. Once the pipeline passes, it pushes the branch to your fork and opens the PR against this repo for you.

See the [no-mistakes quick start](https://vbasky.github.io/no-mistakes/start-here/quick-start/) for the full first-run walkthrough.

## Repo Conventions

- Use `pnpm` with the pinned version from `packageManager`.
- Tests live in `tests/` at the repo root.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before pushing.
- Run `pnpm generate:contracts` and commit `extensions/hatch-env.d.ts` after changing extension-facing types or `src/shared/extension-contract-names.ts`.
- Run `pnpm package:mac` when changing packaging, runtime paths, extension compilation, native dependencies, or release behavior.
- Local `pnpm package:mac` builds produce `Hatch.app` with bundle id `com.hatch.app`; they are ad-hoc signed and not notarized.
- Follow the universal native-dependency, build-only esbuild exclusion, and packaged runtime verification constraints in [`docs/development.md`](docs/development.md#packaging).
- Keep `pnpm-lock.yaml` changes with dependency changes.
- Do not commit generated build output, release artifacts, runtime caches, or dev extension workspaces.
- See `AGENTS.md` for architecture notes, extension workspace rules, and agent-specific constraints.

## Release Notes

Releases are cut by pushing a version tag (`v*.*.*`, matching your other projects' convention). Before tagging:

1. Bump the version in `package.json` and `src-tauri/Cargo.toml`.
2. Update `CHANGELOG.md` with the new version's notes (conventional-commit style).
3. Commit, then tag: `git tag v0.2.0 && git push origin v0.2.0`.

The tag push triggers the `release.yml` workflow, which builds the Linux bundles (deb/rpm) and uploads all artifacts to the GitHub Release.
Any packaged runtime, checksum, or GitHub upload failure fails the workflow.

macOS distribution (signed DMG, Homebrew tap) and the AUR package are dropped from the release plans for now. The corresponding `release.yml` steps are stale: do not upload artifacts or update any tap by hand in the meantime.

Never commit or print credential contents. Missing or malformed secrets fail the real release job; pull-request CI remains secret-free and validates the release config through `tests/release-config.test.ts`.
Maintainers must also keep the `HATCH_UMAMI_WEBSITE_ID` GitHub Actions repository variable configured for packaged-release telemetry; it is intentionally a variable rather than a secret because the id is baked into the app and sent in Umami payloads.

## Questions

Open an issue if something is unclear.
