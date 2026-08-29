import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.text({ type: "*/*" }));

// ✅ CORS setup
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

let browser, page;
let queue = []; // packets from cloud → local

async function startBrowser() {
  console.log("[BRIDGE] Launching Chrome...");

  browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-web-security",
      "--disable-site-isolation-trials",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-features=VizDisplayCompositor",
      "--disable-breakpad",
      "--no-zygote",
      "--single-process"
    ]
  });

  page = await browser.newPage();

  await page.goto("https://YOUR-RAILWAY-APP.up.railway.app/client.html", {
    waitUntil: "load"
  });

  console.log("[BRIDGE] Cloud Eagler client loaded");

  // ✅ Attach CDP session
  const client = await page.target().createCDPSession();
  await client.send("Network.enable");

  // ✅ Intercept WebSocket frames (cloud → bridge)
  client.on("Network.webSocketFrameReceived", ({ response }) => {
    const data = response.payloadData;
    const buf = Buffer.from(data, "binary");
    const b64 = buf.toString("base64");
    queue.push(b64);
    console.log("[BRIDGE] WS recv | bytes:", buf.length);
  });

  // ✅ Intercept WebSocket frames (bridge → cloud)
  client.on("Network.webSocketFrameSent", ({ response }) => {
    const data = response.payloadData;
    const buf = Buffer.from(data, "binary");
    const b64 = buf.toString("base64");
    queue.push(b64);
    console.log("[BRIDGE] WS sent | bytes:", buf.length);
  });

  // ✅ Explicitly open the Eagler server WebSocket
  await page.evaluate(() => {
    const SERVER_URL = "wss://eaglercraft.cc"; // change if using another server
    window.eaglerWS = new WebSocket(SERVER_URL);
    console.log("[BRIDGE] Cloud WebSocket opened:", SERVER_URL);
  });

  console.log("[BRIDGE] WebSocket hooks installed (CDP)");
}

startBrowser().catch(err => {
  console.error("[BRIDGE] Chrome failed:", err);
});

// ✅ /send (local → cloud)
app.post("/send", async (req, res) => {
  try {
    const raw = Buffer.from(req.body, "base64");
    const arr = [...new Uint8Array(raw)];

    console.log("[BRIDGE] /send | bytes:", arr.length);

    await page.evaluate((data) => {
      if (window.eaglerWS && window.eaglerWS.readyState === 1) {
        window.eaglerWS.send(new Uint8Array(data));
      }
    }, arr);

    res.send("ok");
  } catch (e) {
    console.log("[BRIDGE] /send ERROR:", e);
    res.status(500).send("error");
  }
});

// ✅ /recv (cloud → local)
app.get("/recv", (req, res) => {
  if (queue.length > 0) {
    res.send(queue.shift());
  } else {
    res.send("");
  }
});

// ✅ Serve client files
app.use(express.static("public"));

// ✅ Railway port fix
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("[BRIDGE] Running on port", PORT);
});
