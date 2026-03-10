import { createRegistrationOptions } from "@/lib/auth/passkey";
import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const POST = apiHandler(async () => {
  const { user } = await requireAuth();

  const { options, challengeId } = await createRegistrationOptions(
    user.id,
    user.email ?? user.username,
  );

  annotate({ action: { name: "auth.passkey.register-options" } });

  return apiSuccess({ options, challengeId });
});
