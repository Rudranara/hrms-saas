// Automated billing verification must never reach the real provider API.
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'razorpay.com' || url.hostname.endsWith('.razorpay.com'))
    throw new Error('Real Razorpay requests are disabled in automated verification.');
  return originalFetch(input, init);
};
