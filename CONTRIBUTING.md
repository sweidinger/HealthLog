# Contributing to HealthLog

Contributions are welcome. This guide covers how to set up the project and submit changes.

## Prerequisites

- Node.js 20+
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
POSTGRES_PASSWORD=<base64, 24 bytes>
DATABASE_URL="postgresql://healthlog:${POSTGRES_PASSWORD}@db:5432/healthlog"
SESSION_SECRET=<64-char hex>
ENCRYPTION_KEY=<64-char hex>
API_TOKEN_HMAC_KEY=<64-char hex>
```

Generate the four secrets:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)" >> .env
echo "SESSION_SECRET=$(openssl rand -hex 32)"       >> .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"       >> .env
echo "API_TOKEN_HMAC_KEY=$(openssl rand -hex 32)"   >> .env
```

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
pnpm dev             # Start dev server (http://localhost:3000)
pnpm lint            # ESLint
pnpm format:check    # Prettier (check)
pnpm typecheck       # TypeScript strict mode
pnpm test            # Vitest
pnpm build           # Next.js production build
```

All five checks must pass before submitting a PR. The full one-liner that mirrors CI:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build
```

## Code Conventions

- **TypeScript strict mode** -- avoid `any`. Where it's truly unavoidable (e.g. variadic Next.js handler signatures in `src/lib/api-handler.ts`), document the reason inline.
- **English-default UI** -- the default locale is English. German is user-selectable. Code, comments, commit messages, and docs are English. All user-facing strings go through `t("key")` with translations in both `messages/en.json` and `messages/de.json`. The `i18n-locale-integrity.test.ts` suite blocks merges if keys drift between locales or duplicate at any nesting depth.
- **API responses** follow the `{ data, error }` envelope via `apiSuccess()` / `apiError()` in `src/lib/api-response.ts`. Wrap every route handler in `apiHandler()` (`src/lib/api-handler.ts`) for error handling, structured Wide-Event logging, and `x-request-id` propagation.
- **Zod v4** (`import { ... } from "zod/v4"`) for input validation in API routes and forms.
- **shadcn/ui** components (new-york style) for UI primitives.
- **Dracula theme** -- dark mode is the default; a `light`/`system` toggle is exposed in the topbar. Chart and accent colors use the `--dracula-*` CSS tokens so both themes stay coherent.

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
4. Ensure all checks pass (`pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build`)
5. Submit a PR with a clear description of the changes

## Security

If you find a security vulnerability, **do not open a public issue**. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE) license.
