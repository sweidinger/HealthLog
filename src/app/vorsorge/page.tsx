"use client";

import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { VorsorgeSection } from "@/components/measurement-reminders/vorsorge-section";

/**
 * v1.17.1 — Vorsorge (preventive-care) reminders page. The dedicated
 * feature surface for "wann muss ich was wo machen". Auth-gated; the
 * section component owns the list + create flow.
 */
export default function VorsorgePage() {
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();

  if (!mounted || isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <VorsorgeSection enabled={isAuthenticated} />
    </div>
  );
}
