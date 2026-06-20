import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import pkg from "../package.json" with { type: "json" };

const version = (pkg as { version?: string }).version ?? "0.0.0";

export function createApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "pk_…",
  });
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Naleo Scraper API",
      version,
      description:
        "Read-only storefront API over scraped B2B wholesaler catalogs.",
    },
    security: [{ bearerAuth: [] }],
  });
  app.get("/docs", swaggerUI({ url: "/openapi.json" }));
  return app;
}
