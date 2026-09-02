// Minimal dark-mode probe for chart theming: OpenWorker keeps its theme in
// `data-theme` on <html> (src/theme.ts). Charts just need to re-render when
// that flips, so observe the attribute instead of duplicating preference logic.
import { useEffect, useState } from "react";

export function useDarkMode(): { dark: boolean } {
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === "dark",
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.dataset.theme === "dark");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return { dark };
}
