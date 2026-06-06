import { hash, verify } from "@node-rs/argon2";
import zxcvbn from "zxcvbn-typescript";
import { getZxcvbnTranslations } from "@/lib/zxcvbn-i18n";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, type Locale } from "@/lib/i18n/config";
// The Argon2id params live in a plain `.mjs` module so the operator
// password-reset CLI (scripts/reset-password.mjs) can mint a byte-identical
// hash under plain `node` in the production standalone image — there is one
// source of truth for the cost parameters, not two.
import { ARGON2_HASH_OPTIONS } from "./argon2-params.mjs";

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_HASH_OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  return verify(storedHash, password);
}

export interface PasswordStrength {
  score: number; // 0-4
  feedback: string[];
  isAcceptable: boolean;
}

const MIN_PASSWORD_LENGTH = 12;

export function checkPasswordStrength(
  password: string,
  userInputs: string[] = [],
  locale: Locale = defaultLocale,
): PasswordStrength {
  const { t } = getServerTranslator(locale);
  const { translate } = getZxcvbnTranslations(locale);

  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      score: 0,
      feedback: [
        t("auth.passwordTooShort", { minLength: MIN_PASSWORD_LENGTH }),
      ],
      isAcceptable: false,
    };
  }

  const result = zxcvbn(password, userInputs);
  const feedback: string[] = [];

  if (result.feedback.warning) {
    feedback.push(translate(result.feedback.warning));
  }
  if (result.feedback.suggestions) {
    feedback.push(...result.feedback.suggestions.map(translate));
  }

  return {
    score: result.score,
    feedback,
    isAcceptable: result.score >= 3,
  };
}
