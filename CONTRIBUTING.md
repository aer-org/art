# Contributing to ART

Thank you for your interest in contributing to ART (Automated Research Team). This guide will help you get started. For an overview of the project, see the [README](README.md).

## Types of Contributions

### Skills (`.claude/skills/`)

Skills are self-contained features distributed as git branches. Anyone can contribute new skills — they don't require changes to core code.

### Core (`src/`, `container/`)

Changes to the pipeline engine, container runtime, or CLI require coordination with maintainers. Please open an issue or discussion first to align on approach.

### Documentation

Improvements to docs, examples, and guides are always welcome.

## Development Setup

```bash
git clone https://github.com/aer-org/art.git
cd art
npm install          # Installs dependencies and builds
npm run dev          # Watch mode with hot reload
npm run test         # Run tests
```

### Prerequisites

- Node.js >= 20
- Docker (or Podman/udocker) for container tests
- Git

## Code Style

- **TypeScript** with strict mode enabled
- **Prettier** for formatting — run `npm run format:check` to verify
- No manual formatting fixes needed; run `npm run format:fix` to auto-format

## Pull Request Process

1. Fork the repository and create a feature branch
2. Make your changes with tests where applicable
3. Ensure CI passes: `npm run typecheck && npm run test && npm run format:check`
4. Fill out the PR template
5. A maintainer will review your PR

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation only
- `refactor:` — Code change that neither fixes a bug nor adds a feature
- `test:` — Adding or updating tests
- `chore:` — Maintenance tasks

## Why is `dist/` tracked in git?

The `dist/` directory is intentionally committed so that ART can be installed directly from GitHub via `npm install github:aer-org/art` without requiring a build step. Published npm releases also include `dist/`.

## Security Issues

**Do not open public issues for security vulnerabilities.** Please follow the process described in [SECURITY.md](docs/SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.
