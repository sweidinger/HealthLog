import { Suspense } from "react";

import { DocumentsView } from "@/components/documents/documents-view";

/**
 * The Dokumente vault — server shell only. The client surface owns the
 * module gate, the URL-backed filter state (which needs `useSearchParams`,
 * hence the Suspense boundary), the virtualized timeline, and the upload
 * queue. The route rides the AuthShell's wide-container flag: the shell
 * owns the page frame, this file never re-implements paddings.
 */
export default function DocumentsPage() {
  return (
    <Suspense fallback={null}>
      <DocumentsView />
    </Suspense>
  );
}
