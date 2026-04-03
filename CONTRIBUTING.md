# Contributing

## Prerequisites

- Node.js 18+
- npm 9+

## Setup

```bash
git clone https://github.com/your-org/agent-scheduler.git
cd agent-scheduler
npm install
```

## Project structure

```
packages/
  core/            # Tracking engine and SQLite DB layer
  cli/             # CLI (agent-scheduler command)
  paperclip-plugin/ # Paperclip plugin (hook + skill)
docs/              # Documentation
```

## Build

```bash
# Build all packages
npm run build --workspace=packages/core --workspace=packages/cli
```

## Development

```bash
# Watch mode for core
npm run dev --workspace=packages/core

# Watch mode for CLI
npm run dev --workspace=packages/cli
```

## Making changes

1. Fork the repo and create a feature branch
2. Make your changes
3. Build and run a smoke test: `node packages/cli/dist/index.js --help`
4. Open a pull request against `main`

## Releasing

Releases are automated via GitHub Actions. To publish a new version:

1. Bump the `version` field in the relevant `package.json`
2. Create and push a git tag: `git tag v0.2.0 && git push --tags`
3. The `release.yml` workflow will build and publish to npm automatically

An `NPM_TOKEN` secret must be set in the repository settings.
