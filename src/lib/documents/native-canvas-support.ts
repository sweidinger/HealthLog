/**
 * v1.28.27 — CPU-feature gate for the native canvas renderer.
 *
 * The bundled `@napi-rs/canvas` (Skia) x64 builds use AVX2 instructions. On an
 * x86-64 host WITHOUT AVX2 — Celeron/Atom-class NAS CPUs (Goldmont Plus and
 * older) are the common self-hosting case — the first canvas call dies with
 * SIGILL (`trap invalid opcode … in skia.linux-x64-musl.node`), which kills the
 * whole Node process and puts the container into an infinite restart loop
 * (live incident: a Synology DS1520+ self-host, exit code 132 ~18 s after
 * every boot once the thumbnail backfill touched Skia).
 *
 * A SIGILL cannot be caught in-process, so the only safe posture is to never
 * load the module on an unsupported CPU. Every canvas consumer (document
 * thumbnails, scanned-PDF rasterization) already has a fail-soft path — with
 * the gate closed those features degrade cleanly (no thumbnails, PDFs read as
 * text/native only) while the rest of the app runs normally.
 *
 * Detection: Linux x64 reads `/proc/cpuinfo` once and requires the `avx2`
 * flag. Non-x64 (the arm64 image) and non-Linux (dev machines) are always
 * supported — AVX is an x86 concept. The optional `NATIVE_CANVAS` env var
 * overrides: `off` force-disables (e.g. to rule the renderer out while
 * debugging), `on` force-enables (only sensible if detection misfires; on a
 * CPU that truly lacks AVX2 this WILL crash the process). Unset or any other
 * value → auto-detection.
 */
import { readFileSync } from "node:fs";

import { annotate } from "@/lib/logging/context";

let cached: boolean | null = null;
let announced = false;

/** Read the gate once per process; logs a single annotation when closed. */
export function nativeCanvasSupported(): boolean {
  if (cached === null) {
    cached = detect();
  }
  if (!cached && !announced) {
    announced = true;
    annotate({
      action: { name: "documents.nativeCanvas.unsupported" },
      meta: {
        reason: "cpu_missing_avx2",
        arch: process.arch,
        platform: process.platform,
      },
    });
  }
  return cached;
}

function detect(): boolean {
  const override = process.env.NATIVE_CANVAS?.trim().toLowerCase();
  if (override === "off") return false;
  if (override === "on") return true;

  // AVX is an x86 instruction-set concept; the arm64 image and non-Linux dev
  // hosts never hit the SIGILL class.
  if (process.platform !== "linux" || process.arch !== "x64") return true;

  try {
    const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
    const flagsLine = cpuinfo
      .split("\n")
      .find((line) => line.startsWith("flags"));
    // No flags line = exotic kernel surface; fail OPEN to today's behavior
    // rather than silently disabling a working renderer.
    if (!flagsLine) return true;
    return /\bavx2\b/.test(flagsLine);
  } catch {
    return true;
  }
}

/** Test hook — the gate is process-cached by design. */
export function __resetNativeCanvasSupportForTests(): void {
  cached = null;
  announced = false;
}
