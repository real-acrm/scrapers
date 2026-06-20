import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { wholesalers } from "./routes/wholesalers.js";
import { products } from "./routes/products.js";
import { snapshots } from "./routes/snapshots.js";

const app = new Hono();
app.route("/wholesalers", wholesalers);
app.route("/products", products);
app.route("/products", snapshots);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`api on ${port}`);
