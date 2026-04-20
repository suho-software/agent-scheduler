# Contributing to agent-scheduler

Thank you for your interest in contributing! This guide covers everything you need to know to get started.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Code Style Guide](#code-style-guide)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Issues](#reporting-issues)
- [Release Process](#release-process)

---

## Code of Conduct

Be kind, be constructive. We're all here to build something useful.

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 10+

### Setup

```bash
# Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/agent-scheduler.git
cd agent-scheduler

# Install dependencies (all workspaces)
npm install

# Build all packages
npm run build
```

### Verify your setup

```bash
node packages/cli/dist/index.js --help
```

You should see the agent-scheduler CLI help output.

---

## Project Structure

This is a Turbo monorepo. Each package is independently versioned and published.

```
agent-scheduler/
├── packages/
│   ├── core/               # Tracking engine and SQLite DB layer
│   │                       # → All budget/usage logic lives here
│   ├── cli/                # CLI — "agent-scheduler" command
│   │                       # → Depends on core
│   ├── paperclip-plugin/   # Paperclip hook + skill integration
│   │                       # → Depends on core
│   └── (sdk wrappers)      # Per-provider SDK wrapper packages
├── docs/                   # User-facing documentation
├── .github/
│   ├── ISSUE_TEMPLATE/     # Bug / feature / dogfood templates
│   └── workflows/          # CI and release automation
├── turbo.json              # Turbo pipeline config
└── package.json            # Root workspace config
```

### Dependency flow

```
core  ←  cli
core  ←  paperclip-plugin
core  ←  (sdk wrappers)
```

Changes to `core` require rebuilding all dependent packages before testing.

---

## Development Workflow

### Creating a branch

```bash
# Use a descriptive branch name
git checkout -b fix/budget-reset-on-midnight
git checkout -b feat/gemini-sdk-wrapper
git checkout -b docs/contributing-guide
```

### Watch mode (recommended during development)

```bash
# Core
npm run dev --workspace=packages/core

# CLI (in a separate terminal)
npm run dev --workspace=packages/cli
```

### Full build

```bash
npm run build
```

Turbo caches build outputs — subsequent builds on unchanged packages are near-instant.

---

## Code Style Guide

- **TypeScript** everywhere — no plain `.js` source files
- **ESM modules** — use `import`/`export`, not `require()`
- **No default exports** on utility modules — prefer named exports for tree-shaking
- **Error messages** should describe what went wrong and what the user can do:
  - Bad: `"Budget error"`
  - Good: `"Daily budget of $10.00 exceeded. Current spend: $10.43. Pause low-priority agents or increase the limit with: agent-scheduler budget set --limit 15"`
- Keep functions focused — if a function needs a comment explaining what it does, it's probably two functions
- No `any` types unless wrapping truly untyped third-party APIs

---

## Testing

```bash
# Run all tests
npm test

# Run tests for a specific package
npm test --workspace=packages/core
```

Before opening a PR, run a manual smoke test:

```bash
npm run build
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js status
```

---

## Submitting a Pull Request

### PR checklist

Before submitting, confirm:

- [ ] `npm run build` passes with no errors
- [ ] All tests pass (`npm test`)
- [ ] Manual smoke test passes (`node packages/cli/dist/index.js --help`)
- [ ] Code follows the style guide above
- [ ] If adding a feature: a brief entry in `CHANGELOG.md` under `[Unreleased] > Added`
- [ ] If fixing a bug: a brief entry in `CHANGELOG.md` under `[Unreleased] > Fixed`
- [ ] If changing public API: `README.md` and relevant `docs/` pages are updated

### PR title format

```
fix: budget reset not triggering at UTC midnight
feat: add Gemini 1.5 Pro token tracking
docs: expand CONTRIBUTING.md with monorepo structure
chore: bump turbo to 2.1.0
```

### Review process

- A maintainer will review within **1 week**
- CI must be green before merge
- Reviewers may request changes — please address feedback or open a discussion if you disagree

---

## Reporting Issues

Use GitHub Issues with the appropriate template:

- **Bug report** — something is broken
- **Feature request** — something you wish existed
- **Dogfood feedback** — issues discovered while using agent-scheduler to monitor real AI workloads (gets prioritized!)

See `.github/ISSUE_TEMPLATE/` for templates.

---

## Release Process

Releases are automated via GitHub Actions (`release.yml`).

1. Bump `version` in the relevant `package.json` files
2. Update `CHANGELOG.md` — move items from `[Unreleased]` to the new version section
3. Commit: `chore: release v0.1.1`
4. Tag and push:
   ```bash
   git tag v0.1.1
   git push && git push --tags
   ```
5. The release workflow publishes to npm automatically

An `NPM_TOKEN` secret must be configured in repository settings.
