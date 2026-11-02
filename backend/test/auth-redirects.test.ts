import assert from "node:assert/strict";
import { it } from "node:test";
import { loginDestination, platformLoginHref, platformReturn } from "../../frontend/app/lib/auth-redirects";

it("keeps organization role values on the organization landing page", () => {
  assert.equal(loginDestination("SUPER_ADMIN", null), "/dashboard");
  assert.equal(loginDestination("ORGANIZATION_ADMIN", null), "/dashboard");
  assert.equal(loginDestination("EMPLOYEE", null), "/dashboard");
});
it("preserves safe platform URLs without granting User roles platform continuations", () => {
  for (const path of ["/super-admin", "/super-admin/settings", "/super-admin/admins", "/super-admin/organizations/cuid_example-123"]) {
    assert.equal(platformReturn(path), path);
    assert.equal(new URL(platformLoginHref(path), "http://localhost").searchParams.get("next"), path);
    assert.equal(new URL(platformLoginHref(path), "http://localhost").pathname, "/super-admin/login");
    assert.equal(new URL(platformLoginHref(path), "http://localhost").searchParams.get("reason"), "session-ended");
    assert.equal(loginDestination("SUPER_ADMIN", path), "/dashboard");
    assert.equal(loginDestination("ORGANIZATION_ADMIN", path), "/dashboard");
    assert.equal(loginDestination("EMPLOYEE", path), "/dashboard");
  }
});
it("rejects unsafe URLs and malformed platform continuations", () => {
  for (const value of ["https://evil.test/super-admin", "//evil.test", "/\\evil.test", "/super-admin?role=SUPER_ADMIN", "/super-admin#token=x", "/super-admin/../dashboard", "/super-admin/organizations/../login", "/super-admin/organizations/", "/super-admin/organizations/%2Fbad", "/super-admin\n", "/super-admin/organizations/" + "a".repeat(101), "%2Fsuper-admin", "/login", "/super-admin/login", "/dashboard", "/billing"]) {
    assert.equal(platformReturn(value), null, value);
    assert.equal(loginDestination("SUPER_ADMIN", value), "/dashboard");
    assert.equal(loginDestination("ORGANIZATION_ADMIN", value), "/dashboard");
  }
});
it("preserves organization billing continuations independently of legacy User role values", () => {
  for (const tier of ["essentials", "growth", "organization"]) for (const period of ["monthly", "yearly"]) {
    const path = `/billing?plan=${tier}-${period}&period=${period}`;
    assert.equal(loginDestination("ORGANIZATION_ADMIN", path), path);
    assert.equal(loginDestination("SUPER_ADMIN", path), path);
  }
});
