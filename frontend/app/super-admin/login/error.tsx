"use client";
import "../../auth.css";
export default function PlatformLoginError({ reset }: { reset: () => void }) {
  return <main className="auth-loading"><h1>Platform sign-in is temporarily unavailable.</h1><p>We could not check your session. Check the local API connection and try again.</p><button className="button primary" onClick={reset}>Try again</button></main>;
}
