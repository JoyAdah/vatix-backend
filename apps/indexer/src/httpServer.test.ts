import { describe, it, expect, afterEach } from "vitest";
import { Registry, Counter } from "prom-client";
import { buildIndexerHttpServer } from "./httpServer.js";

// Integration-style: exercises the real wiring (indexerCorsPlugin +
// marketsRoutes composed together), not just the CORS plugin registered
// against a stub route as apps/indexer/src/middleware/cors.test.ts does.
// This is the check that would have caught the routes/cors modules never
// being mounted anywhere in apps/indexer/src/main.ts.
describe("buildIndexerHttpServer", () => {
  afterEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.NODE_ENV;
  });

  it("rejects a disallowed origin against the real /markets route in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ALLOWED_ORIGINS;

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/markets",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
      },
    });

    expect(response.headers["access-control-allow-origin"]).not.toBe(
      "https://evil.example.com"
    );

    await app.close();
  });

  it("allows an allowlisted origin against the real /markets route in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ALLOWED_ORIGINS = "https://app.vatix.io";

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/markets",
      headers: {
        origin: "https://app.vatix.io",
        "access-control-request-method": "GET",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.vatix.io"
    );

    await app.close();
  });

  // Issue #1081: liveness (/health) must stay 200 while the process is alive,
  // independent of dependency state, so orchestrators do not restart a healthy
  // process during a transient DB/Redis/RPC outage.
  it("returns 200 from /health (liveness) regardless of dependency state", async () => {
    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");

    await app.close();
  });

  // Issue #1081: readiness (/ready) is fail-closed. When a critical dependency
  // is unavailable it must return 503 with a stable error code and a
  // correlation id, and must not leak connection strings or internal addresses.
  it("returns 503 with a stable error code and correlation id from /ready when a dependency is down", async () => {
    const app = await buildIndexerHttpServer({
      readinessChecks: [
        {
          name: "db",
          check: async () => {
            throw new Error(
              "connect ECONNREFUSED postgres://user:secret@10.0.0.5:5432/vatix"
            );
          },
        },
      ],
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("unavailable");
    expect(body.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(typeof body.correlationId).toBe("string");
    expect(body.correlationId.length).toBeGreaterThan(0);

    // Fail-closed responses must not leak secrets or internal addresses.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("10.0.0.5");

    await app.close();
  });

  // Issue #1081: when every critical dependency is healthy, /ready reports 200
  // so the orchestrator can route traffic to the instance.
  it("returns 200 from /ready when all critical dependencies are healthy", async () => {
    const app = await buildIndexerHttpServer({
      readinessChecks: [
        { name: "db", check: async () => undefined },
        { name: "redis", check: async () => undefined },
      ],
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");

    await app.close();
  });

  // ── Metrics endpoint (#1096) ───────────────────────────────────────────────
  //
  // The /metrics endpoint returns Prometheus-formatted metrics when a registry
  // is supplied, and a stub response when it is not.

  it("returns 200 with Prometheus content-type from /metrics when a registry is supplied", async () => {
    const registry = new Registry();
    const testCounter = new Counter({
      name: "test_requests_total",
      help: "test counter for /metrics endpoint",
      registers: [registry],
    });
    testCounter.inc(42);

    const app = await buildIndexerHttpServer({ metricsRegistry: registry });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    const body = response.body;
    expect(body).toContain("test_requests_total 42");

    await app.close();
  });

  it("returns 200 with a stub from /metrics when no registry is supplied", async () => {
    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    const body = response.body;
    expect(body).toContain("No metrics registry configured");

    await app.close();
  });

  // Issue #1096: /metrics must be exempt from rate limiting so that
  // Prometheus scrapers are never throttled (matching /health and /ready).
  it("does not rate-limit /metrics even under load (no RATE_LIMITED response)", async () => {
    const app = await buildIndexerHttpServer();
    await app.ready();

    // Send many rapid requests — none should be rate limited
    for (let i = 0; i < 10; i++) {
      const response = await app.inject({ method: "GET", url: "/metrics" });
      expect(response.statusCode).toBe(200);
    }

    await app.close();
  });
});