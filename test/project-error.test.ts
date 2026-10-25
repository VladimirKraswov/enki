import { expect, it } from "vitest";
import { ApiError } from "../src/api/http";
import { projectErrorText } from "../src/api/projectError";
it("distinguishes confirmed filesystem denial from an opaque server error", () => {
  expect(projectErrorText(new ApiError(500, "EPERM: lstat /private/secret"))).toContain("отказ доступа");
  expect(projectErrorText(new ApiError(500, "EPERM: lstat /private/secret"))).not.toContain("/private/secret");
  expect(projectErrorText(new ApiError(403, "EACCES: denied"))).toContain("отказ доступа");
  expect(projectErrorText(new ApiError(403, "API permission denied"))).not.toContain("папку проекта");
  const unknown = projectErrorText(new ApiError(500, "Unexpected server error (err_abc123)"));
  expect(unknown).toContain("HTTP 500");
  expect(unknown).toContain("err_abc123");
  expect(unknown).not.toContain("(отказ доступа)");
});
