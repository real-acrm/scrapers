import "dotenv/config";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { createApp } from "./openapi.js";
import { products } from "./routes/products.js";
import { facets } from "./routes/facets.js";
import { apiKeyAuth } from "./middleware/auth.js";

const app = createApp();

const corsOrigin = process.env.CORS_ORIGIN ?? "*";
const origins = corsOrigin
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  "*",
  cors({
    origin: origins.length === 1 ? origins[0] : origins,
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "OPTIONS"],
  }),
);

app.use("/products/*", apiKeyAuth);
app.use("/facets/*", apiKeyAuth);
app.route("/products", products);
app.route("/facets", facets);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`api on ${port}`);
