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

The tag push triggers the `release.yml` workflow, which builds the Linux bundles (deb/rpm), builds the universal macOS app, signs every code object with `Developer ID Application: YOUR_NAME (YOUR_TEAM_ID)`, notarizes and staples the app and DMG, verifies the publication-ready DMG, computes its checksum, uploads all artifacts to the GitHub Release, then updates `vbasky/homebrew-tap` and the AUR package.
Any signing, notarization, verification, packaged runtime, checksum, or GitHub upload failure fails the workflow and stops before the Homebrew and AUR updates.
The generated Homebrew Cask quits Hatch during upgrade and relaunches it after installation only when the app was already running before uninstall started.

Maintainers must keep these repository secrets provisioned from the canonical secure owners:

- `MAC_DEVELOPER_ID_CERT_P12` - base64 of the password-protected Developer ID Application certificate and private key for Team `YOUR_TEAM_ID`.
- `MAC_DEVELOPER_ID_CERT_PASSWORD` - the p12 export password.
- `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, and `APP_STORE_CONNECT_API_KEY` - the App Store Connect API credentials used by `notarytool`; the API key is base64-encoded p8 content.
- `HOMEBREW_TAP_TOKEN` - write access to `vbasky/homebrew-tap` for the final cask update.

Never commit or print credential contents. Missing or malformed secrets fail the real release job; pull-request CI remains secret-free and validates the release config through `tests/release-config.test.ts`.
Maintainers must also keep the `HATCH_UMAMI_WEBSITE_ID` GitHub Actions repository variable configured for packaged-release telemetry; it is intentionally a variable rather than a secret because the id is baked into the app and sent in Umami payloads.

To release, push the tag and require the `release.yml` workflow's macOS job to pass. Do not upload artifacts or update the tap by hand.
For a post-release check of exactly the downloaded artifact on macOS:

```sh
VERSION=x.y.z # Replace with the released version (no leading v).
TAG="v${VERSION}"
mkdir -p verify-hatch/mount

gh release download "$TAG" --pattern "Hatch-v${VERSION}.dmg" --dir verify-hatch
DMG="$PWD/verify-hatch/Hatch-v${VERSION}.dmg"
hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$PWD/verify-hatch/mount"
trap 'hdiutil detach "$PWD/verify-hatch/mount" >/dev/null' EXIT
APP="$PWD/verify-hatch/mount/Hatch.app"

test "$(plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")" = \
  "com.hatch.app"
test "$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist")" = \
  "$VERSION"
codesign --verify --deep --strict --verbose=4 "$APP"
SIGNATURE="$(codesign -d --verbose=4 "$APP" 2>&1)"
grep -Fq 'Identifier=com.hatch.app' <<<"$SIGNATURE"
grep -Fq 'TeamIdentifier=YOUR_TEAM_ID' <<<"$SIGNATURE"
grep -Fq 'Authority=Developer ID Application: YOUR_NAME (YOUR_TEAM_ID)' <<<"$SIGNATURE"
grep -Eq '^CodeDirectory .*flags=.*runtime' <<<"$SIGNATURE"
grep -Eq '^Timestamp=.+$' <<<"$SIGNATURE"
spctl --assess --type execute --verbose=4 "$APP"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
lipo "$APP/Contents/MacOS/hatch" -verify_arch arm64 x86_64

hdiutil detach "$PWD/verify-hatch/mount"
trap - EXIT
```

The expected Gatekeeper result is `accepted` with source `Notarized Developer ID`. The workflow runs these checks, plus per-bundle and per-Mach-O identity, hardened-runtime, and timestamp checks, against the mounted publication-ready DMG before upload.

## Questions

Open an issue if something is unclear.
