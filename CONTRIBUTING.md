# Contributing to HealthLog

Contributions are welcome. This guide covers how to set up the project and submit changes.

## Prerequisites

- Node.js 22+
- pnpm
- PostgreSQL 16+ (or Docker)
- Git

## Setup

```bash
git clone https://github.com/MBombeck/HealthLog.git
cd HealthLog
cp .env.example .env
```

Edit `.env` and configure at minimum:

```
DATABASE_URL="postgresql://healthlog:healthlog@localhost:5432/healthlog"
SESSION_SECRET=<64-char hex>
ENCRYPTION_KEY=<64-char hex>
API_TOKEN_HMAC_KEY=<64-char hex>
```

Generate secrets with `openssl rand -hex 32`.

### With Docker (database only)

```bash
docker compose up -d db
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

### Full Docker

```bash
docker compose up -d
```

## Development Workflow

```bash
pnpm dev            # Start dev server (http://localhost:3000)
pnpm lint           # ESLint
pnpm format         # Prettier
pnpm typecheck      # TypeScript strict mode
pnpm test           # Vitest
```

All four checks must pass before submitting a PR.

## Code Conventions

- **TypeScript strict mode** -- no `any` types, no type assertions unless absolutely necessary
- **UI text in German**, code/comments/docs in English
- **API responses** follow `{ data, error, meta }` envelope pattern
- **Zod v4** for input validation (API routes and forms)
- **shadcn/ui** components (new-york style) for UI primitives
- **Dracula theme** -- dark mode only, use `--dracula-*` CSS tokens

See `CLAUDE.md` for detailed architecture and patterns.

## Database Changes

```bash
# After modifying prisma/schema.prisma:
pnpm db:migrate     # Creates a new migration
pnpm db:generate    # Regenerates Prisma client
```

Always include the migration file in your PR.

## Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Ensure all checks pass (`pnpm lint && pnpm typecheck && pnpm test`)
5. Submit a PR with a clear description of the changes

## Security

If you find a security vulnerability, **do not open a public issue**. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE) license.
