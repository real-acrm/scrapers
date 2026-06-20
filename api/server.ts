import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./openapi.js";
import { wholesalers } from "./routes/wholesalers.js";
import { products } from "./routes/products.js";
import { snapshots } from "./routes/snapshots.js";
import { brands } from "./routes/brands.js";
import { categories } from "./routes/categories.js";
import { deals } from "./routes/deals.js";
import { apiKeyAuth } from "./middleware/auth.js";

const app = createApp();
app.use("/wholesalers/*", apiKeyAuth);
app.use("/products/*", apiKeyAuth);
app.use("/deals/*", apiKeyAuth);
app.route("/wholesalers", wholesalers);
app.route("/wholesalers", brands);
app.route("/wholesalers", categories);
app.route("/products", products);
app.route("/products", snapshots);
app.route("/deals", deals);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`api on ${port}`);
