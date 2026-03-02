import "dotenv/config";
import express from "express";
import { MongoClient } from "mongodb";

const app = express();
const PORT = process.env.PORT ?? 3001;
const DATABASE_URL = process.env.DATABASE_URL!;

const mongo = new MongoClient(DATABASE_URL);
const db = mongo.db();
const appsCollection = db.collection("App");

const slugCache = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL = 60_000;

async function resolveSupabaseUrl(slug: string): Promise<string | null> {
  const cached = slugCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const doc = await appsCollection.findOne({ slug }, { projection: { supabaseUrl: 1 } });
  if (!doc) return null;

  slugCache.set(slug, { url: doc.supabaseUrl, expiresAt: Date.now() + CACHE_TTL });
  return doc.supabaseUrl;
}

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

app.get("/", (req, res) => {
  res.send("Supabase Proxy Backend");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

const STRIPPED_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "x-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "forwarded",
  "via",
  "host",
];

// /:slug/* — resolve slug from DB then proxy to the real Supabase URL
app.all("/:slug/*splat", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const { slug } = req.params;
    const supabaseUrl = await resolveSupabaseUrl(slug);

    if (!supabaseUrl) {
      return res.status(404).json({ error: "Proxy not found for this slug" });
    }

    // Everything after /:slug becomes the Supabase path
    const proxyPath = req.path.replace(`/${slug}`, "") || "/";
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const targetURL = supabaseUrl.replace(/\/$/, "") + proxyPath + query;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && !STRIPPED_HEADERS.includes(key.toLowerCase())) {
        headers[key] = value;
      }
    }

    const response = await fetch(targetURL, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "follow",
    });

    response.headers.forEach((value, key) => {
      res.set(key, value);
    });

    res.status(response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Proxy error" });
  }
});

app.use((req, res) => {
  res.status(404).send("Not Found");
});

async function start() {
  await mongo.connect();
  console.log("Connected to MongoDB");
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch(console.error);
