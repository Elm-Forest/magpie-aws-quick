# Codemagic macOS Universal builds

The project supports Codemagic as a second build service, independently of GitHub Actions. The root [codemagic.yaml](../codemagic.yaml) reproduces the native SwiftUI + bundled Node.js pipeline.

It is based on the previously tested `Elm-Forest/icey` Codemagic M2/Xcode 26.3 workflow. The build is **ad-hoc signed**, not Apple Developer notarized.

## Set up once in Codemagic

1. Open [Codemagic Apps](https://codemagic.io/apps) and sign in with the existing Codemagic account.
2. Add the GitHub repository `Elm-Forest/magpie-aws-quick` as an application. If the GitHub App permission is restricted to selected repositories, grant access to this repository.
3. Choose **codemagic.yaml** configuration and select workflow `magpie-macos-universal`, branch `main`.
4. Click **Start new build**. The Codemagic build artifacts contain the DMG, ZIP, SHA256SUMS, source commit manifest and relevant logs.
5. Optionally create the repository webhook in the Codemagic application's Webhooks settings. Subsequent pushes to `main` can then trigger this workflow automatically.

The workflow uses a `mac_mini_m2` runner with Xcode `26.3`, builds `arm64` and `x86_64` binaries, downloads and combines Node `v24.11.1`, runs all Node tests, signs the bundle locally, smoke-tests both API dialects, and packages two universal deliverables.

### Code consistency and installation notes

The pipeline checks that the bundle contains the 512 KiB per-tool result limit, the relay code and the fresh-result preflight. The build does **not** access the user's local Amazon Quick accounts, API keys or other macOS configuration. Local settings remain in `~/Library/Application Support/MagpieQuick`.

Ad-hoc signatures do not provide Apple notarization. Only install builds from the project's own authenticated Codemagic run and verify checksums.

A Codemagic app/project must be created by an authenticated account before a build can actually start; simply adding `codemagic.yaml` does not register the repository automatically.
