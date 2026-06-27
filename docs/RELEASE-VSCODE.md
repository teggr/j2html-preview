# Release VS Code Extension (Local)

This document describes local packaging and publishing for the extension.

Extension ID:
- dev-rebelstack.j2html-preview

## Prerequisites

- Node.js 18+
- npm
- VS Code Extension Manager (vsce) available via dev dependency
- Marketplace publisher created: dev-rebelstack

## Build and verify locally

```bash
cd j2html-preview-vscode
npm ci
npm test
npm run package
```

Output:
- j2html-preview-<version>.vsix

## Install VSIX locally for verification

```bash
code --install-extension ./j2html-preview-<version>.vsix --force
```

## Publish directly to VS Code Marketplace

One-time login on your machine:

```bash
cd j2html-preview-vscode
npx vsce login dev-rebelstack
```

Publish current package.json version:

```bash
npx vsce publish
```

Or publish a specific packaged VSIX:

```bash
npx vsce publish --packagePath ./j2html-preview-<version>.vsix
```

## Suggested release flow

```bash
cd j2html-preview-vscode
npm version <patch|minor|major>
npm test
npm run package
npx vsce publish
```

## Notes

- Publisher identifiers cannot contain dots, so dev-rebelstack is valid while dev.rebelcraft is not.
- If publish fails after version bump, fix the issue and publish the same version if it has not been accepted by Marketplace.
