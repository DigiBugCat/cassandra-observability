import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { counter, gauge, histogram, serialize } from "../src/metrics.js";

describe("metric helpers", () => {
  it("preserves the metric shape for counters, gauges, and histograms", () => {
    expect(counter("mcp_requests_total", 1, { service: "portal" })).toEqual({
      name: "mcp_requests_total",
      value: 1,
      labels: { service: "portal" },
    });

    expect(gauge("mcp_active_keys", 42, { service: "portal" })).toEqual({
      name: "mcp_active_keys",
      value: 42,
      labels: { service: "portal" },
    });

    expect(histogram("mcp_request_duration_ms", 123, { path: "/api/keys" })).toEqual({
      name: "mcp_request_duration_ms",
      value: 123,
      labels: { path: "/api/keys" },
    });
  });
});

describe("serialize", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_123);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes unlabeled metrics", () => {
    expect(serialize([counter("mcp_requests_total", 1)])).toBe(
      "mcp_requests_total 1 1700000000123",
    );
  });

  it("serializes labeled metrics with stable label ordering", () => {
    expect(
      serialize([
        gauge("mcp_active_keys", 3, {
          status: "200",
          path: "/api/keys",
          service: "portal",
        }),
      ]),
    ).toBe(
      'mcp_active_keys{path="/api/keys",service="portal",status="200"} 3 1700000000123',
    );
  });

  it("uses the same timestamp for every metric in a batch", () => {
    expect(
      serialize([
        counter("mcp_requests_total", 1, { service: "portal" }),
        counter("mcp_request_duration_ms_total", 25, { path: "/api/keys" }),
      ]),
    ).toBe(
      'mcp_requests_total{service="portal"} 1 1700000000123\n' +
        'mcp_request_duration_ms_total{path="/api/keys"} 25 1700000000123',
    );
  });

  it("escapes quotes, backslashes, and newlines in label values", () => {
    expect(
      serialize([
        counter("mcp_requests_total", 1, {
          path: "C:\\logs\\worker",
          note: 'quoted "value"',
          service: "line\nbreak",
        }),
      ]),
    ).toBe(
      'mcp_requests_total{note="quoted \\"value\\"",path="C:\\\\logs\\\\worker",service="line\\nbreak"} 1 1700000000123',
    );
  });
});
