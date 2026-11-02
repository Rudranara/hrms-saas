import assert from "node:assert/strict";
import { it } from "node:test";
import { definitiveRefundError, RefundApiError, refundRequest } from "../../frontend/app/lib/refund-types";

it("retains refund HTTP status and error code for validation and balance conflicts", async () => {
  const original = global.fetch;
  try {
    for (const status of [400, 409]) {
      global.fetch = async () => Response.json({ code: "INVALID_REFUND_AMOUNT", message: "Balance changed" }, { status });
      await assert.rejects(refundRequest("/fixture", {}), error => error instanceof RefundApiError && error.status === status && error.code === "INVALID_REFUND_AMOUNT" && definitiveRefundError(error));
    }
  } finally { global.fetch = original; }
});
it("keeps timeout, connection loss and ambiguous server errors uncertain for safe same-key retries", async () => {
  const original = global.fetch;
  try {
    for (const error of [new TypeError("Connection lost"), new DOMException("Timeout", "TimeoutError"), new RefundApiError("Commit may have succeeded", 503)]) assert.equal(definitiveRefundError(error), false);
    global.fetch = async () => { throw new TypeError("Connection lost"); };
    await assert.rejects(refundRequest("/fixture", { requestId: "unchanged" }), error => !definitiveRefundError(error));
  } finally { global.fetch = original; }
});
