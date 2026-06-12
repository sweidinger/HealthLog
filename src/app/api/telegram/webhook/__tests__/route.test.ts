import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- Module-boundary mocks must come before importing the route. ---

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    medication: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    medicationIntakeEvent: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    telegramReminderMessage: {
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
    },
    telegramScheduledDeletion: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((value: string) => `decrypted:${value}`),
}));

vi.mock("@/lib/telegram", () => ({
  answerTelegramCallbackQuery: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  sendTelegramMessage: vi.fn().mockResolvedValue({ messageId: 999, ok: true }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => ({
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

vi.mock("@/lib/medications/inventory/consumption", () => ({
  consumeForIntake: vi.fn().mockResolvedValue(undefined),
  restoreForIntake: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));

vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeMedicationComplianceForEvent: vi.fn().mockResolvedValue(undefined),
}));

import { POST, GET } from "../route";
import { prisma } from "@/lib/db";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  answerTelegramCallbackQuery,
  deleteMessage,
  sendTelegramMessage,
} from "@/lib/telegram";
import { checkRateLimit } from "@/lib/rate-limit";

const ORIGINAL_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const TG_USER = {
  id: "user-1",
  telegramBotToken: "ENC(token-blob)",
  locale: "en",
  timezone: "Europe/Berlin",
};

const MEDICATION = { id: "med-1", name: "Ramipril" };

/**
 * The slot-attribution load (`loadAttributeMedication`) selects the full
 * schedule projection (distinguishable by `select.schedules`); every other
 * `medication.findFirst` in the webhook wants the bare id/name shape. The
 * default projection carries no schedules, so the generic dispatch tests
 * exercise the ad-hoc (standalone create) path unchanged.
 */
function wireMedicationFindFirst(
  schedules: unknown[] = [],
  scheduleRevisions: unknown[] = [],
) {
  vi.mocked(prisma.medication.findFirst).mockImplementation(((args: {
    select?: Record<string, unknown>;
  }) => {
    if (args?.select && "schedules" in args.select) {
      return Promise.resolve({
        id: "med-1",
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        schedules,
        scheduleRevisions,
      });
    }
    return Promise.resolve(MEDICATION);
  }) as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.TELEGRAM_WEBHOOK_SECRET = "sekret";
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 120,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(prisma.user.findFirst).mockResolvedValue(TG_USER as never);
  wireMedicationFindFirst();
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medication.update).mockResolvedValue({} as never);
  vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({} as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.telegramReminderMessage.deleteMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.telegramReminderMessage.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.telegramScheduledDeletion.createMany).mockResolvedValue({
    count: 0,
  } as never);
  // Interactive transactions run their callback against the same mock
  // client (the route converges the intake write + snooze update inside
  // one transaction); batch arrays resolve like Promise.all.
  vi.mocked(prisma.$transaction).mockImplementation(((arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)(prisma)
      : Promise.all(arg as Promise<unknown>[])) as never);
  vi.mocked(answerTelegramCallbackQuery).mockResolvedValue(undefined as never);
  vi.mocked(deleteMessage).mockResolvedValue(undefined as never);
  vi.mocked(sendTelegramMessage).mockResolvedValue({
    messageId: 999,
    ok: true,
  } as never);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

function tgRequest(
  body: unknown,
  headers: Record<string, string> = {
    "x-telegram-bot-api-secret-token": "sekret",
  },
): NextRequest {
  return new NextRequest("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function callbackUpdate(data: string, overrides: Record<string, unknown> = {}) {
  return {
    update_id: 100,
    callback_query: {
      id: "cb-1",
      data,
      from: { id: 7777 },
      message: {
        message_id: 555,
        chat: { id: 7777 },
      },
      ...overrides,
    },
  };
}

describe("Telegram webhook — secret verification", () => {
  it("returns 401 when the X-Telegram-Bot-Api-Secret-Token header is missing", async () => {
    const res = await POST(tgRequest(callbackUpdate("taken:med-1"), {}));
    expect(res.status).toBe(401);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 when the header is present but does not match the env secret", async () => {
    const res = await POST(
      tgRequest(callbackUpdate("taken:med-1"), {
        "x-telegram-bot-api-secret-token": "WRONG",
      }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 when TELEGRAM_WEBHOOK_SECRET env var is unset (defence in depth)", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const res = await POST(
      tgRequest(callbackUpdate("taken:med-1"), {
        "x-telegram-bot-api-secret-token": "anything",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with a valid header secret (happy path baseline)", async () => {
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);
  });
});

describe("Telegram webhook — rate limit", () => {
  it("returns 429 when rate-limited and never reads the secret/user", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(429);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("Telegram webhook — callback dispatch", () => {
  it("'taken:<medId>' creates a MedicationIntakeEvent + clears snoozedUntil + acks the callback", async () => {
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);

    // No schedules wired → the take is ad-hoc and inserts standalone.
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    const intakeArgs = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0][0];
    expect(intakeArgs.data).toMatchObject({
      userId: "user-1",
      medicationId: "med-1",
      skipped: false,
      source: "REMINDER",
    });
    expect(intakeArgs.data.idempotencyKey).toMatch(
      /^telegram:cb:7777:555:med-1/,
    );

    expect(prisma.medication.update).toHaveBeenCalledWith({
      where: { id: "med-1" },
      data: { snoozedUntil: null },
    });
    // Intake write + snooze reset commit atomically.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // v1.16.10 — the confirmed take consumes inventory units (after the
    // intake transaction committed, on the created row).
    const { consumeForIntake } = await import(
      "@/lib/medications/inventory/consumption"
    );
    expect(consumeForIntake).toHaveBeenCalledTimes(1);
    expect(consumeForIntake).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", medicationId: "med-1" }),
    );

    expect(answerTelegramCallbackQuery).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(
      "decrypted:ENC(token-blob)",
      "7777",
      555,
    );
  });

  it("'taken:<medId>' is idempotent — replaying the same callback with the same message_id does NOT create a second intake event", async () => {
    // First call: existing-row lookup misses → write happens.
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce(
      null,
    );
    await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);

    // Second call: existing-row lookup hits → no second write.
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce({
      id: "intake-existing",
    } as never);
    const res2 = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res2.status).toBe(200);
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1); // unchanged
  });

  it("'snooze:<medId>:60' updates the medication's snoozedUntil and answers with the locale-translated message", async () => {
    const res = await POST(tgRequest(callbackUpdate("snooze:med-1:60")));
    expect(res.status).toBe(200);

    expect(prisma.medication.update).toHaveBeenCalledTimes(1);
    const updateArgs = vi.mocked(prisma.medication.update).mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "med-1" });
    const snoozedUntil = (updateArgs.data as { snoozedUntil: Date })
      .snoozedUntil;
    expect(snoozedUntil).toBeInstanceOf(Date);
    // Allow some clock drift but verify ~60 minutes ahead.
    const deltaMs = snoozedUntil.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(55 * 60_000);
    expect(deltaMs).toBeLessThan(65 * 60_000);

    expect(answerTelegramCallbackQuery).toHaveBeenCalledTimes(1);
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/Ramipril/);
    expect(ackText).toMatch(/1 hour/i);
  });

  it("'skip:<medId>' creates an intake event with skipped=true and snoozes through end-of-day", async () => {
    const res = await POST(tgRequest(callbackUpdate("skip:med-1")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    const intakeArgs = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0][0];
    expect(intakeArgs.data).toMatchObject({
      userId: "user-1",
      medicationId: "med-1",
      skipped: true,
      takenAt: null,
      source: "REMINDER",
    });
    expect(intakeArgs.data.idempotencyKey).toMatch(
      /^telegram:skip:7777:555:med-1/,
    );

    const updateArgs = vi.mocked(prisma.medication.update).mock.calls[0][0];
    const snoozedUntil = (updateArgs.data as { snoozedUntil: Date })
      .snoozedUntil;
    expect(snoozedUntil.getHours()).toBe(23);
    expect(snoozedUntil.getMinutes()).toBe(59);
    // Skip row + rest-of-day snooze commit atomically.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // v1.16.10 — an explicit skip refunds a previously-consumed stamp
    // (no-op for a never-consumed row) and never consumes.
    const { consumeForIntake, restoreForIntake } = await import(
      "@/lib/medications/inventory/consumption"
    );
    expect(consumeForIntake).not.toHaveBeenCalled();
    expect(restoreForIntake).toHaveBeenCalledTimes(1);
  });

  it("'ack:<medId>' answers the callback without creating an intake event", async () => {
    const res = await POST(tgRequest(callbackUpdate("ack:med-1")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(answerTelegramCallbackQuery).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("unknown callback action is acked with an 'unknown action' message and writes nothing", async () => {
    const res = await POST(tgRequest(callbackUpdate("totally:bogus")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medication.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(answerTelegramCallbackQuery).toHaveBeenCalledTimes(1);
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/unknown action/i);
  });

  it("ignores callbacks from chats with no enrolled Telegram user (no answer, no DB writes)", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);
    expect(answerTelegramCallbackQuery).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("rejects 'taken' for an inactive medication and acks with the localised error", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce(null);
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/medication.*not.*found.*inactive/i);
  });

  it("'snooze' with an empty medication id acks with errorInvalidAction (no writes)", async () => {
    const res = await POST(tgRequest(callbackUpdate("snooze::60")));
    expect(res.status).toBe(200);
    expect(prisma.medication.update).not.toHaveBeenCalled();
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/invalid action/i);
  });

  it("'snooze' for a missing medication acks with medicationNotFound (no update)", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce(null);
    const res = await POST(tgRequest(callbackUpdate("snooze:med-X:60")));
    expect(res.status).toBe(200);
    expect(prisma.medication.update).not.toHaveBeenCalled();
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/medication not found/i);
  });

  it("'add:<medId>:umid:<userMsgId>' creates an intake event and deletes both bot + user messages", async () => {
    const res = await POST(tgRequest(callbackUpdate("add:med-1:umid:1234")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    const intakeArgs = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0][0];
    expect(intakeArgs.data.idempotencyKey).toMatch(
      /^telegram:add:7777:555:med-1/,
    );

    // Bot's selection message + user's /add command message both deleted.
    const deleteCalls = vi.mocked(deleteMessage).mock.calls;
    const ids = deleteCalls.map((c) => c[2]);
    expect(ids).toContain(555);
    expect(ids).toContain(1234);
  });

  it("'cancel_add:umid:1234' deletes both messages and acks with the cancelled message", async () => {
    const res = await POST(tgRequest(callbackUpdate("cancel_add:umid:1234")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    const ids = vi.mocked(deleteMessage).mock.calls.map((c) => c[2]);
    expect(ids).toContain(555);
    expect(ids).toContain(1234);
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/cancelled/i);
  });
});

describe("Telegram webhook — text-message dispatch", () => {
  it("returns 200 'ok' for /help and replies with help text", async () => {
    const update = {
      update_id: 200,
      message: {
        message_id: 11,
        text: "/help",
        chat: { id: 7777 },
      },
    };
    const res = await POST(tgRequest(update));
    expect(res.status).toBe(200);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const text = vi.mocked(sendTelegramMessage).mock.calls[0][2];
    expect(text).toMatch(/available commands/i);
  });

  it("ignores unrelated text — never calls sendTelegramMessage", async () => {
    const update = {
      update_id: 201,
      message: {
        message_id: 12,
        text: "the weather is nice today",
        chat: { id: 7777 },
      },
    };
    const res = await POST(tgRequest(update));
    expect(res.status).toBe(200);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("greeting like 'hi' echoes a friendly reply", async () => {
    const res = await POST(
      tgRequest({
        update_id: 202,
        message: {
          message_id: 13,
          text: "hi",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTelegramMessage).mock.calls[0][2]).toMatch(/Hi!/);
  });

  it("/add with no active medications replies with the 'no active' message", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValueOnce([] as never);
    const res = await POST(
      tgRequest({
        update_id: 203,
        message: {
          message_id: 14,
          text: "/add",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(vi.mocked(sendTelegramMessage).mock.calls[0][2]).toMatch(
      /no active medication/i,
    );
  });

  it("/add with exactly one active medication marks it taken without prompting", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValueOnce([
      { id: "med-only", name: "Aspirin", dose: "100mg" },
    ] as never);
    const res = await POST(
      tgRequest({
        update_id: 204,
        message: {
          message_id: 15,
          text: "/add",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    // markMedicationTaken → findFirst on active medication
    expect(prisma.medication.findFirst).toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
  });

  it("/add with multiple medications sends a keyboard listing them with cancel_add", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValueOnce([
      { id: "med-a", name: "Aspirin", dose: "100mg" },
      { id: "med-b", name: "Bisoprolol", dose: "5mg" },
    ] as never);

    const res = await POST(
      tgRequest({
        update_id: 205,
        message: {
          message_id: 16,
          text: "/add",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(sendTelegramMessage).mock.calls[0][3] as {
      replyMarkup: { inline_keyboard: { callback_data: string }[][] };
    };
    const flatData = opts.replyMarkup.inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    expect(flatData).toEqual(
      expect.arrayContaining([
        "add:med-a:umid:16",
        "add:med-b:umid:16",
        "cancel_add:umid:16",
      ]),
    );
    // No intake yet — user still has to choose.
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("'taken Ramipril' (text command) creates an intake event for the matched medication", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce({
      id: "med-1",
    } as never);
    // Second findFirst inside markMedicationTaken
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce({
      id: "med-1",
      name: "Ramipril",
    } as never);

    const res = await POST(
      tgRequest({
        update_id: 206,
        message: {
          message_id: 17,
          text: "taken Ramipril",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    const intakeArgs = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0][0];
    expect(intakeArgs.data.idempotencyKey).toMatch(/^telegram:text:206:med-1/);
  });

  it("'taken' (no name) with no clearly matching medication asks for a medication name", async () => {
    // findMany returns 2 → ambiguous → ask
    vi.mocked(prisma.medication.findMany).mockResolvedValueOnce([
      { id: "med-a", name: "Aspirin" },
      { id: "med-b", name: "Bisoprolol" },
    ] as never);
    const res = await POST(
      tgRequest({
        update_id: 207,
        message: {
          message_id: 18,
          text: "taken",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(vi.mocked(sendTelegramMessage).mock.calls[0][2]).toMatch(
      /specify a medication/i,
    );
  });

  it("'taken UnknownMed' replies with the medication-not-found message and writes nothing", async () => {
    // First findFirst (lookup by name) returns null
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce(null);

    const res = await POST(
      tgRequest({
        update_id: 208,
        message: {
          message_id: 19,
          text: "taken UnknownMed",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(vi.mocked(sendTelegramMessage).mock.calls[0][2]).toMatch(
      /not found/i,
    );
  });

  it("returns 200 ignored when the body has no message and no callback_query", async () => {
    const res = await POST(
      tgRequest({
        update_id: 999,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ignored");
  });

  it("returns 200 ignored when the body has no update_id", async () => {
    const res = await POST(tgRequest({ message: { text: "/help" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ignored");
  });

  it("returns 200 'invalid json' when the request body is malformed JSON", async () => {
    const req = new NextRequest("http://localhost/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "sekret",
      },
      body: "{not-valid",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("invalid json");
  });
});

describe("Telegram webhook — slot convergence (v1.16.9)", () => {
  // Daily 09:00 Berlin med; the worker pre-minted the pending REMINDER row
  // at the canonical slot instant. A Telegram take/skip must converge onto
  // that row instead of inserting a second row anchored at `now` — the old
  // shape left the pending row open to auto-miss, punishing compliance for
  // a dose the user explicitly confirmed.
  const SLOT_0900_BERLIN = new Date("2026-06-10T07:00:00.000Z"); // 09:00 CEST
  const NOW_0903_BERLIN = new Date("2026-06-10T07:03:00.000Z"); // 09:03 CEST

  const scheduleRow = {
    id: "sched-1",
    windowStart: "09:00",
    windowEnd: "09:00",
    daysOfWeek: null,
    timesOfDay: ["09:00"],
    reminderGraceMinutes: null,
    rrule: "FREQ=DAILY",
    rollingIntervalDays: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    doseWindows: null,
  };

  const pendingReminderRow = {
    id: "evt-pending-0900",
    takenAt: null,
    skipped: false,
    idempotencyKey: null,
    scheduledFor: SLOT_0900_BERLIN,
    source: "REMINDER",
    createdAt: new Date("2026-06-10T05:00:00.000Z"),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_0903_BERLIN);
    wireMedicationFindFirst([scheduleRow]);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      pendingReminderRow,
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockImplementation(((args: {
      data: Record<string, unknown>;
    }) =>
      Promise.resolve({
        ...pendingReminderRow,
        ...args.data,
        syncVersion: 2,
      })) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a take converges onto the pending REMINDER row via the reminder's own slot", async () => {
    vi.mocked(prisma.telegramReminderMessage.findFirst).mockResolvedValue({
      date: "2026-06-10",
      timeOfDay: "09:00",
    } as never);

    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);

    // The pending row was updated in place — never a duplicate insert.
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledTimes(1);
    const update = vi.mocked(prisma.medicationIntakeEvent.update).mock
      .calls[0][0] as {
      where: { id: string };
      data: { takenAt: Date; skipped: boolean; autoMissed?: boolean };
    };
    expect(update.where.id).toBe("evt-pending-0900");
    expect(update.data.takenAt?.getTime()).toBe(NOW_0903_BERLIN.getTime());
    expect(update.data.skipped).toBe(false);
    expect(update.data.autoMissed).toBe(false);
    expect(invalidateUserMedications).toHaveBeenCalledWith("user-1", {
      evict: true,
    });
  });

  it("a take converges via band attribution when no reminder row matches", async () => {
    vi.mocked(prisma.telegramReminderMessage.findFirst).mockResolvedValue(null);
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);
    // 09:03 sits inside the 09:00 band → same convergence, no second row.
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledTimes(1);
    expect(
      (
        vi.mocked(prisma.medicationIntakeEvent.update).mock.calls[0][0] as {
          where: { id: string };
        }
      ).where.id,
    ).toBe("evt-pending-0900");
  });

  it("a skip converges onto the pending REMINDER row as skipped (no orphan + no miss)", async () => {
    vi.mocked(prisma.telegramReminderMessage.findFirst).mockResolvedValue({
      date: "2026-06-10",
      timeOfDay: "09:00",
    } as never);

    const res = await POST(tgRequest(callbackUpdate("skip:med-1")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledTimes(1);
    const update = vi.mocked(prisma.medicationIntakeEvent.update).mock
      .calls[0][0] as {
      where: { id: string };
      data: { takenAt: Date | null; skipped: boolean };
    };
    expect(update.where.id).toBe("evt-pending-0900");
    expect(update.data.takenAt).toBeNull();
    expect(update.data.skipped).toBe(true);
    expect(invalidateUserMedications).toHaveBeenCalledWith("user-1", {
      evict: true,
    });
  });

  it("an exotic-zone reminder slot reconstructs on the correct local day", async () => {
    // Pacific/Kiritimati (UTC+14): 09:00 on 2026-06-10 local is
    // 2026-06-09T19:00Z — a naive UTC-noon reference would land a day off.
    const slotKiritimati = new Date("2026-06-09T19:00:00.000Z");
    const nowKiritimati = new Date("2026-06-09T19:05:00.000Z");
    vi.setSystemTime(nowKiritimati);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      ...TG_USER,
      timezone: "Pacific/Kiritimati",
    } as never);
    const pendingRow = {
      ...pendingReminderRow,
      scheduledFor: slotKiritimati,
    };
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      pendingRow,
    ] as never);
    vi.mocked(prisma.telegramReminderMessage.findFirst).mockResolvedValue({
      date: "2026-06-10",
      timeOfDay: "09:00",
    } as never);

    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledTimes(1);
    const update = vi.mocked(prisma.medicationIntakeEvent.update).mock
      .calls[0][0] as { where: { id: string } };
    expect(update.where.id).toBe("evt-pending-0900");
  });
});

describe("Telegram webhook — GET verification", () => {
  it("returns 200 with a valid header secret", async () => {
    const req = new NextRequest("http://localhost/api/telegram/webhook", {
      headers: { "x-telegram-bot-api-secret-token": "sekret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it("returns 401 without a header secret", async () => {
    const req = new NextRequest("http://localhost/api/telegram/webhook");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});
