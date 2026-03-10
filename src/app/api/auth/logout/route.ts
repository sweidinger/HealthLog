import { destroySession } from "@/lib/auth/session";
import { apiSuccess } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const POST = apiHandler(async () => {
  await destroySession();

  annotate({ action: { name: "auth.logout" } });

  return apiSuccess({ loggedOut: true });
});
