"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="auth-loading"><h1>Platform reports are temporarily unavailable.</h1><p>Check the API connection and try again.</p><button className="button primary" onClick={reset}>Try again</button></main>;
}
