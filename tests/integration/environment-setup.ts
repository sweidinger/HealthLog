import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    integrationDatabaseUrl: string;
  }
}

process.env.DATABASE_URL = inject("integrationDatabaseUrl");
process.env.ENCRYPTION_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";
delete process.env.ENCRYPTION_KEYS;
delete process.env.ENCRYPTION_ACTIVE_KEY_ID;
process.env.API_TOKEN_HMAC_KEY = "integration-test-hmac-key-32-bytes-minimum";
process.env.SESSION_SECRET = "integration-test-session-secret-32-bytes";
