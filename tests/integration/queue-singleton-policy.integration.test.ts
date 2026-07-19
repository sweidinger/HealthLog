/**
 * Queue de-duplication semantics, asserted against a real pg-boss on a real
 * Postgres.
 *
 * This suite exists because the bug it pins is invisible to a mocked test. A
 * bare `singletonKey` on a `send()` LOOKS like de-duplication at every call
 * site, and a unit test with a stubbed boss will happily agree. But pg-boss
 * only constrains `singleton_key` through partial unique indexes that are
 * scoped BY QUEUE POLICY, and under the default `standard` policy no such index
 * exists — so every bare `singletonKey` in the tree de-duplicated nothing.
 * Only a real insert against a real index can tell the two apart.
 *
 * The `standard` case below is deliberately kept as a permanent, executable
 * statement of the original defect: if someone drops a policy entry from a
 * registrar table, the matching assertion here goes red instead of the
 * behaviour silently reverting to "the key does nothing".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";

let boss: PgBoss;

/** Unique per run so a re-run never collides with a queue left behind. */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const q = (name: string) => `test-${name}-${suffix}`;

beforeAll(async () => {
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    // Keep the maintenance/monitor loops out of the way; this suite only
    // exercises createQueue/send/fetch.
    schedule: false,
    supervise: false,
  });
  await boss.start();
}, 120_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
});

describe("pg-boss singleton semantics by queue policy", () => {
  it("standard: a bare singletonKey de-duplicates NOTHING (the original defect)", async () => {
    const name = q("standard");
    await boss.createQueue(name);

    const first = await boss.send(name, { n: 1 }, { singletonKey: "same" });
    const second = await boss.send(name, { n: 2 }, { singletonKey: "same" });

    // Both inserted. This is the finding: under the default policy the key is
    // inert, so every "coalesced by singletonKey" comment in the tree was
    // describing a guarantee that did not exist.
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("exclusive: suppresses a duplicate while the first is QUEUED", async () => {
    const name = q("excl-queued");
    await boss.createQueue(name, { policy: "exclusive" });

    const first = await boss.send(name, { n: 1 }, { singletonKey: "user-a" });
    const second = await boss.send(name, { n: 2 }, { singletonKey: "user-a" });

    expect(first).toBeTruthy();
    // pg-boss inserts with ON CONFLICT DO NOTHING ... RETURNING, so a
    // suppressed send resolves to null rather than throwing. Every boot
    // discovery helper in the tree counts exactly this as `skipped`.
    expect(second).toBeNull();
  });

  it("exclusive: still suppresses once the first job is ACTIVE", async () => {
    const name = q("excl-active");
    await boss.createQueue(name, { policy: "exclusive" });

    const first = await boss.send(name, { n: 1 }, { singletonKey: "user-a" });
    expect(first).toBeTruthy();

    // Move the job out of `created` and into `active`.
    const fetched = await boss.fetch(name);
    expect(fetched).toHaveLength(1);

    // This is the case that matters for the backfills: a worker restarting
    // during a heavy account's multi-hour pass used to append another
    // identical full-history job, because `short` semantics would have let it
    // through. `exclusive` covers queued OR active.
    const second = await boss.send(name, { n: 2 }, { singletonKey: "user-a" });
    expect(second).toBeNull();
  });

  it("exclusive: a genuinely distinct key still enqueues", async () => {
    const name = q("excl-distinct");
    await boss.createQueue(name, { policy: "exclusive" });

    const a = await boss.send(name, { n: 1 }, { singletonKey: "user-a" });
    const b = await boss.send(name, { n: 2 }, { singletonKey: "user-b" });

    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);
  });

  it("short: suppresses a duplicate while the first is QUEUED", async () => {
    const name = q("short-queued");
    await boss.createQueue(name, { policy: "short" });

    const first = await boss.send(name, { n: 1 }, { singletonKey: "bucket" });
    const second = await boss.send(name, { n: 2 }, { singletonKey: "bucket" });

    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it("short: ADMITS a send once the first job is ACTIVE", async () => {
    const name = q("short-active");
    await boss.createQueue(name, { policy: "short" });

    const first = await boss.send(name, { n: 1 }, { singletonKey: "bucket" });
    expect(first).toBeTruthy();

    const fetched = await boss.fetch(name);
    expect(fetched).toHaveLength(1);

    // This is the property that makes `short` the correct choice for the
    // rollup recompute and the per-document jobs: the running job already read
    // its input, so a write that lands afterwards MUST be able to enqueue its
    // own recompute or it would be stranded in a stale bucket. `exclusive`
    // would return null here and silently drop that work.
    const second = await boss.send(name, { n: 2 }, { singletonKey: "bucket" });
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("short: a genuinely distinct key still enqueues", async () => {
    const name = q("short-distinct");
    await boss.createQueue(name, { policy: "short" });

    const a = await boss.send(name, { n: 1 }, { singletonKey: "bucket-1" });
    const b = await boss.send(name, { n: 2 }, { singletonKey: "bucket-2" });

    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);
  });
});

describe("policy reconcile for queues that already exist", () => {
  it("createQueue does NOT change the policy of an existing queue", async () => {
    const name = q("recreate");
    await boss.createQueue(name);

    // pg-boss's create_queue() ends in ON CONFLICT DO NOTHING, so this is a
    // no-op rather than an upgrade. Without the reconcile in
    // `registrar-shared.ts`, shipping the policy tables would therefore change
    // nothing at all on an instance whose queues already exist -- which is
    // every running instance.
    await boss.createQueue(name, { policy: "exclusive" });

    const queue = await boss.getQueue(name);
    expect(queue?.policy).toBe("standard");

    // And the behaviour confirms it: the key is still inert.
    const first = await boss.send(name, { n: 1 }, { singletonKey: "same" });
    const second = await boss.send(name, { n: 2 }, { singletonKey: "same" });
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
  });

  it("updateQueue refuses a policy change outright", async () => {
    const name = q("update");
    await boss.createQueue(name);

    await expect(
      // @ts-expect-error -- policy is excluded from UpdateQueueOptions by
      // design; this asserts the runtime guard that forces the direct-column
      // reconcile the registrar performs.
      boss.updateQueue(name, { policy: "exclusive" }),
    ).rejects.toThrow(/policy cannot be changed/i);
  });

  it("writing the policy column takes effect on the next send", async () => {
    const name = q("reconciled");
    await boss.createQueue(name);

    // Same statement `reconcileQueuePolicies` issues. The partial unique
    // indexes for every policy already exist on the shared `job_common` table
    // (this deployment does not partition per queue), so claiming a policy
    // later is enough -- no schema change, no worker restart.
    await boss.getDb().executeSql(
      `UPDATE pgboss.queue SET policy = $2, updated_on = now()
         WHERE name = $1 AND policy IS DISTINCT FROM $2`,
      [name, "exclusive"],
    );

    const queue = await boss.getQueue(name);
    expect(queue?.policy).toBe("exclusive");

    const first = await boss.send(name, { n: 1 }, { singletonKey: "same" });
    const second = await boss.send(name, { n: 2 }, { singletonKey: "same" });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });
});

describe("createAndSchedule applies the registrar's policy table", () => {
  it("provisions a NEW queue with the decided policy", async () => {
    const { createAndSchedule } =
      await import("@/lib/jobs/reminder/registrar-shared");
    const name = q("cas-new");

    await createAndSchedule(boss, [name], [], {
      [name]: { policy: "exclusive", reason: "test" },
    });

    const queue = await boss.getQueue(name);
    expect(queue?.policy).toBe("exclusive");

    const first = await boss.send(name, { n: 1 }, { singletonKey: "same" });
    const second = await boss.send(name, { n: 2 }, { singletonKey: "same" });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it("reconciles an EXISTING standard queue onto the decided policy", async () => {
    const { createAndSchedule } =
      await import("@/lib/jobs/reminder/registrar-shared");
    const name = q("cas-existing");

    // Simulate a running instance: the queue already exists under `standard`,
    // which is how every queue on every deployed instance was provisioned.
    await boss.createQueue(name);
    expect((await boss.getQueue(name))?.policy).toBe("standard");

    await createAndSchedule(boss, [name], [], {
      [name]: { policy: "short", reason: "test" },
    });

    expect((await boss.getQueue(name))?.policy).toBe("short");

    const first = await boss.send(name, { n: 1 }, { singletonKey: "same" });
    const second = await boss.send(name, { n: 2 }, { singletonKey: "same" });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it("leaves a queue absent from the table on standard", async () => {
    const { createAndSchedule } =
      await import("@/lib/jobs/reminder/registrar-shared");
    const name = q("cas-absent");

    await createAndSchedule(boss, [name], [], {});

    expect((await boss.getQueue(name))?.policy).toBe("standard");
  });
});

describe("boot-discovery skipped counter", () => {
  it("can actually be non-zero once the queue carries a policy", async () => {
    const name = q("skipped");
    await boss.createQueue(name, { policy: "exclusive" });

    // Mirror the shape every boot-discovery helper uses: iterate a candidate
    // set, count a null job id as `skipped`. Two of these three users are
    // already represented, which under `standard` could never happen -- which
    // is why `skipped` was structurally always zero in the boot log lines.
    const candidates = ["u1", "u1", "u2", "u2", "u3"];
    let enqueued = 0;
    let skipped = 0;
    for (const userId of candidates) {
      const jobId = await boss.send(name, { userId }, { singletonKey: userId });
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }

    expect(enqueued).toBe(3);
    expect(skipped).toBe(2);
  });
});
