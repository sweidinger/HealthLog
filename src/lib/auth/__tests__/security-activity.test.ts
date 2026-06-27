import { describe, it, expect } from "vitest";
import {
  matchesSecurityActivity,
  securityActivityWhere,
} from "../security-activity";

describe("matchesSecurityActivity", () => {
  it("includes every auth.* event", () => {
    for (const a of [
      "auth.login.password",
      "auth.login.failed",
      "auth.login.new_device",
      "auth.mfa.verify",
      "auth.password.change",
      "auth.session.revoke",
      "auth.session.revoke_others",
      "auth.token.autoissue.native",
      "auth.bearer.success",
      "auth.register",
    ]) {
      expect(matchesSecurityActivity(a)).toBe(true);
    }
  });

  it("includes export actions", () => {
    for (const a of [
      "export.download",
      "health-record.export",
      "user.export.full-backup",
      "user.export.measurements",
    ]) {
      expect(matchesSecurityActivity(a)).toBe(true);
    }
  });

  it("includes the erasure actions", () => {
    expect(matchesSecurityActivity("user.account.delete")).toBe(true);
    expect(matchesSecurityActivity("user.data.clear")).toBe(true);
  });

  it("excludes unrelated audit actions", () => {
    for (const a of [
      "measurement.create",
      "medication.intake.bulk",
      "coach.budget.exceeded",
      "withings.sync.ok",
      "consent.ai.web",
    ]) {
      expect(matchesSecurityActivity(a)).toBe(false);
    }
  });
});

describe("securityActivityWhere", () => {
  it("scopes by userId and mirrors the predicate clauses", () => {
    const where = securityActivityWhere("user-1");
    expect(where.userId).toBe("user-1");
    expect(where.OR).toEqual([
      { action: { startsWith: "auth." } },
      { action: { contains: "export" } },
      { action: { in: ["user.account.delete", "user.data.clear"] } },
    ]);
  });
});
