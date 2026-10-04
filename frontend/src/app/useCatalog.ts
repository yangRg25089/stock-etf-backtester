import { useEffect, useState } from "react";
import { CatalogApiError, fetchCatalog } from "../api/catalog";
import type { Catalog } from "../api/generated";

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; value: Catalog }
  | { status: "failed"; error: CatalogApiError };

export function useCatalog() {
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" });
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogState({ status: "loading" });
    fetchCatalog(controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setCatalogState({ status: "ready", value });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const catalogError = error instanceof CatalogApiError
          ? error : new CatalogApiError("catalog.fetch_failed");
        setCatalogState({ status: "failed", error: catalogError });
      });
    return () => controller.abort();
  }, [retryCount]);

  return {
    catalogState,
    catalog: catalogState.status === "ready" ? catalogState.value : null,
    retryCatalog: () => setRetryCount(count => count + 1),
  };
}
