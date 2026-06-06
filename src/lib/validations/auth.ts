import { z } from "zod/v4";
import { isValidKvnr, normaliseKvnr } from "@/lib/validations/kvnr";

/** Minimum password length — must match checkPasswordStrength() in @/lib/auth/password.ts */
const PASSWORD_MIN_LENGTH = 12;

export const registerSchema = z.object({
  email: z.email("Invalid email address"),
  username: z
    .string()
    .min(3, "At least 3 characters")
    .max(30, "Maximum 30 characters")
    .regex(/^[a-zA-Z0-9_-]+$/, "Only letters, numbers, _ and -"),
  password: z
    .string()
    .min(
      PASSWORD_MIN_LENGTH,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    ),
  /**
   * v1.4.25 W7 — browser-detected timezone. The signup form pulls
   * `Intl.DateTimeFormat().resolvedOptions().timeZone` and sends it
   * along; the server validates against the runtime IANA list and
   * falls back to the admin-configured server default
   * (`AppSettings.defaultUserTimezone`) when the value is invalid
   * or missing. Optional so legacy clients that predate v1.4.25
   * keep working.
   */
  timezone: z.string().max(64).optional(),
});

export const loginPasswordSchema = z.object({
  email: z.string().trim().min(1, "Email or username required"),
  password: z.string().min(1),
});

export const profileSchema = z.object({
  email: z.email("Invalid email address").nullable().optional(),
  heightCm: z.number().min(50).max(300).nullable().optional(),
  dateOfBirth: z.string().nullable().optional(), // ISO date string
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable().optional(),
  // v1.7.0 — optional patient-identity fields for the health-record
  // export cover + FHIR Patient resource. All optional, never required.
  fullName: z.string().trim().max(120).nullable().optional(),
  insurerName: z.string().trim().max(120).nullable().optional(),
  // German KVNR. Empty string / null clears it; a non-empty value must
  // pass the mod-10 check-digit validation. Normalised (whitespace
  // stripped + uppercased) before the refine runs.
  insuranceNumber: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      if (v === null || v === undefined) return v;
      const cleaned = normaliseKvnr(v);
      return cleaned.length === 0 ? null : cleaned;
    })
    .refine((v) => v === null || v === undefined || isValidKvnr(v), {
      message: "Invalid insurance number (KVNR)",
    }),
  // v1.8.6 — German insurer institution number (IKNR). Optional;
  // empty string / null clears it. A non-empty value is trimmed and
  // must be exactly 9 digits (no checksum — the IKNR carries a mod-10
  // check digit but we deliberately do not enforce it here, mirroring
  // the iOS client contract). Surfaced on the FHIR `Coverage` payor.
  insurerIkNumber: z
    .string()
    .max(32)
    .nullable()
    .optional()
    .transform((v) => {
      if (v === null || v === undefined) return v;
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    })
    .refine((v) => v === null || v === undefined || /^[0-9]{9}$/.test(v), {
      message: "Invalid insurer IK number (expected 9 digits)",
    }),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(
        PASSWORD_MIN_LENGTH,
        `New password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      ),
    confirmPassword: z.string().min(1, "Password confirmation is required"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginPasswordInput = z.infer<typeof loginPasswordSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
