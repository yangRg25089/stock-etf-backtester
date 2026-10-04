import { useCallback, useEffect, useState } from "react";

export function useWorkbenchLayout() {
  const [configCollapsed, setConfigCollapsed] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches,
  );
  const [mobilePanel, setMobilePanel] = useState<"config" | "results">("results");

  useEffect(() => {
    const responsive = window.matchMedia("(max-width: 1279px)");
    const syncConfigVisibility = (event: MediaQueryListEvent) => setConfigCollapsed(event.matches);
    responsive.addEventListener("change", syncConfigVisibility);
    return () => responsive.removeEventListener("change", syncConfigVisibility);
  }, []);

  useEffect(() => {
    const desktopView = window.matchMedia("(min-width: 768px)");
    const resetMobilePanel = (event: MediaQueryListEvent) => {
      if (event.matches) setMobilePanel("results");
    };
    desktopView.addEventListener("change", resetMobilePanel);
    return () => desktopView.removeEventListener("change", resetMobilePanel);
  }, []);

  const revealConfig = useCallback(() => {
    setConfigCollapsed(false);
    if (window.matchMedia("(max-width: 767px)").matches) setMobilePanel("config");
  }, []);

  return { configCollapsed, setConfigCollapsed, mobilePanel, setMobilePanel, revealConfig };
}
