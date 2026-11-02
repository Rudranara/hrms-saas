"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { billingReturn, BILLING_CONTINUATION } from "../lib/billing-continuation";
import { Icon } from "./ui-icon";

export function BillingReturnLink({ fallbackLabel }: { fallbackLabel?: string }) {
  const [destination, setDestination] = useState<string | null>(null);
  useEffect(() => {
    const explicit = billingReturn(new URLSearchParams(window.location.search).get("next"));
    let saved: string | null = null;
    try { saved = billingReturn(sessionStorage.getItem(BILLING_CONTINUATION)); } catch {}
    const next = explicit || saved;
    if (next) {
      const query = new URLSearchParams(next.slice(9));
      query.set("review", "1");
      queueMicrotask(() => setDestination(`/billing?${query}`));
    }
  }, []);
  if (fallbackLabel) return <Link className="button primary" href={destination || "/billing"}>{destination ? "Continue with your selected paid plan" : fallbackLabel}<Icon name="arrow" /></Link>;
  return destination ? <p><Link className="button secondary" href={destination}>Continue with your selected paid plan</Link></p> : null;
}
