import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { counter, pushMetrics, type MetricsEnv } from "../src/metrics.js";

interface CapturedRequest {
  body: string;
  headers: IncomingMessage["headers"];
  method: string | undefined;
  url: string | undefined;
}

interface CaptureServer {
  close: () => Promise<void>;
  requests: CapturedRequest[];
  url: string;
}

async function startCaptureServer(
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<CaptureServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: string[] = [];
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      requests.push({
        body: chunks.join(""),
        headers: req.headers,
        method: req.method,
        url: req.url,
      });

      if (handler) {
        handler(req, res);
        return;
      }

      res.statusCode = 204;
      res.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP address");
  }

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    requests,
    url: `http://127.0.0.1:${address.port}/api/v1/import/prometheus`,
  };
}

function createEnv(overrides: Partial<MetricsEnv> = {}): MetricsEnv {
  return {
    VM_PUSH_URL: "https://unused.example.test/api/v1/import/prometheus",
    VM_PUSH_CLIENT_ID: "client-id",
    VM_PUSH_CLIENT_SECRET: "client-secret",
    ...overrides,
  };
}

async function waitForIdle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
}

describe("pushMetrics", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_123);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the serialized metrics with Cloudflare Access headers", async () => {
    const server = await startCaptureServer();

    try {
      await pushMetrics(
        createEnv({ VM_PUSH_URL: server.url }),
        [
          counter("mcp_requests_total", 1, { service: "portal", path: "/api/keys" }),
          counter("mcp_request_duration_ms_total", 25, { service: "portal" }),
        ],
      );

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toMatchObject({
        method: "POST",
        url: "/api/v1/import/prometheus",
      });
      expect(server.requests[0]?.headers["content-type"]).toContain("text/plain");
      expect(server.requests[0]?.headers["cf-access-client-id"]).toBe("client-id");
      expect(server.requests[0]?.headers["cf-access-client-secret"]).toBe("client-secret");
      expect(server.requests[0]?.body).toBe(
        'mcp_requests_total{path="/api/keys",service="portal"} 1 1700000000123\n' +
          'mcp_request_duration_ms_total{service="portal"} 25 1700000000123',
      );
    } finally {
      await server.close();
    }
  });

  it("returns without sending a request when the metric list is empty", async () => {
    const server = await startCaptureServer();

    try {
      await pushMetrics(createEnv({ VM_PUSH_URL: server.url }), []);
      await waitForIdle();
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("returns without sending a request when required auth config is missing", async () => {
    const server = await startCaptureServer();

    try {
      await pushMetrics(
        createEnv({
          VM_PUSH_CLIENT_ID: "",
          VM_PUSH_URL: server.url,
        }),
        [counter("mcp_requests_total", 1, { service: "portal" })],
      );

      await waitForIdle();
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("swallows non-2xx responses", async () => {
    const server = await startCaptureServer((_req, res) => {
      res.statusCode = 500;
      res.end("server error");
    });

    try {
      await expect(
        pushMetrics(
          createEnv({ VM_PUSH_URL: server.url }),
          [counter("mcp_requests_total", 1, { service: "portal" })],
        ),
      ).resolves.toBeUndefined();
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("swallows network failures", async () => {
    const server = await startCaptureServer();
    const url = server.url;
    await server.close();

    await expect(
      pushMetrics(
        createEnv({ VM_PUSH_URL: url }),
        [counter("mcp_requests_total", 1, { service: "portal" })],
      ),
    ).resolves.toBeUndefined();
  });
});
