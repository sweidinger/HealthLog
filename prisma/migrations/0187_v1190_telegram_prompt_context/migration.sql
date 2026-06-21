-- v1.19.0 — force-reply correlation for the interactive mood reminder.
-- Maps a bot prompt message to the entry a free-text reply attaches to.
CREATE TABLE "telegram_prompt_contexts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "prompt_msg_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_prompt_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_prompt_contexts_chat_id_prompt_msg_id_key" ON "telegram_prompt_contexts"("chat_id", "prompt_msg_id");

-- CreateIndex
CREATE INDEX "telegram_prompt_contexts_expires_at_idx" ON "telegram_prompt_contexts"("expires_at");
