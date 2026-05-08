# HealthLog v1.4.6 marathon — project

Personal health-tracking PWA. v1.4.5 live in production. v1.4.6 marathon
brief is `docs/audit/v146-findings.md` — that file is the source of truth
for every fix, feature, and gate. `CLAUDE.md` covers project-wide rules
(tooling, conventions, hard constraints).

## Scope

- Tier 1 (T1-T9): release blockers
- New feature: chart bucketing for ranges > 1 year
- Tier 2 (P1-P20): polish
- Multi-agent QA + simplify pass
- Release & deploy v1.4.6
- GitHub releases backfill (v1.4.2-v1.4.6) + GHCR housekeeping
- Docs + landing site sync

## Hard rules (Marc, verbatim)

1. Niemals `--no-verify`.
2. Niemals `--no-gpg-sign` ohne Anfrage.
3. Niemals force-push to main.
4. Changelog/Release-Notes user-facing — kein "Claude", keine internen
   Phasennamen.
5. Out-of-scope > typo → defer to v1.5.

## References

- `CLAUDE.md` — project conventions
- `docs/audit/v146-findings.md` — release spec
- `CHANGELOG.md` — release tone & format
