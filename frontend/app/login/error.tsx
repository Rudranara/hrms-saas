"use client";
export default function LoginError({ reset }: { reset: () => void }) {
  return <main className="auth-loading"><h1>We couldn’t check your session.</h1><p>Check that the local API is running, then try again.</p><button className="button primary" onClick={reset}>Try again</button></main>;
}
