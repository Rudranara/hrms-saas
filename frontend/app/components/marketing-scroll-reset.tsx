"use client";

import { useLayoutEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Marketing pages are deliberately landing pages.  Next preserves scroll
 * position during some client-side route changes, which can otherwise leave
 * a visitor at the footer of the page they just opened.  Keep this scoped to
 * those pages so account and in-page hash navigation retain their normal
 * behavior.
 */
export function MarketingScrollReset() {
  const pathname = usePathname();

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname]);

  return null;
}
