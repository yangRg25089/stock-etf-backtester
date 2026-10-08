import { useCallback, useEffect, useState } from "react";

export function useWorkbenchLayout() {
  const [configCollapsed, setConfigCollapsed] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches,
  );
  const [isPhone, setIsPhone] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const responsive = window.matchMedia("(max-width: 1279px)");
    const syncConfigVisibility = (event: MediaQueryListEvent) => setConfigCollapsed(event.matches);
    responsive.addEventListener("change", syncConfigVisibility);
    return () => responsive.removeEventListener("change", syncConfigVisibility);
  }, []);

  useEffect(() => {
    const phone = window.matchMedia("(max-width: 767px)");
    const sync = (event: MediaQueryListEvent) => setIsPhone(event.matches);
    phone.addEventListener("change", sync);
    return () => phone.removeEventListener("change", sync);
  }, []);

  const revealConfig = useCallback(() => {
    setConfigCollapsed(false);
    if (window.matchMedia("(max-width: 767px)").matches) requestAnimationFrame(() => {
      document.getElementById("workbench-config-panel")?.scrollIntoView({ block: "start" });
    });
  }, []);

  return { configCollapsed, setConfigCollapsed, isPhone, revealConfig };
}
