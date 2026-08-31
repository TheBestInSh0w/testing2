import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.text({ type: "*/*" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

let browser, page;
let queue = [];

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

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  await page.goto("https://YOUR-RAILWAY-APP.up.railway.app/client.html", {
    waitUntil: "load"
  });

  console.log("[BRIDGE] Cloud Eagler client loaded");

  const client = await page.target().createCDPSession();
  await client.send("Network.enable");

  client.on("Network.webSocketFrameReceived", ({ response }) => {
    const buf = Buffer.from(response.payloadData, "binary");
    queue.push(buf.toString("base64"));
    console.log("[BRIDGE] WS recv | bytes:", buf.length);
  });

  client.on("Network.webSocketFrameSent", ({ response }) => {
    const buf = Buffer.from(response.payloadData, "binary");
    queue.push(buf.toString("base64"));
    console.log("[BRIDGE] WS sent | bytes:", buf.length);
  });

  // ⭐ Inject script that opens WS in main world
  await page.addScriptTag({
    content: `
      const SERVER_URL = "wss://eaglercraft.cc";
      console.log("[BRIDGE] Injected script opening WS:", SERVER_URL);

      const ws = new WebSocket(SERVER_URL);

      ws.onopen = () => console.log("[BRIDGE] WS open in Chrome");
      ws.onerror = (e) => console.log("[BRIDGE] WS error in Chrome:", e);
      ws.onclose = () => console.log("[BRIDGE] WS closed in Chrome");

      window.eaglerWS = ws;
    `
  });

  console.log("[BRIDGE] WebSocket injection complete");
}

startBrowser().catch(err => {
  console.error("[BRIDGE] Chrome failed:", err);
});

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

app.get("/recv", (req, res) => {
  if (queue.length > 0) {
    res.send(queue.shift());
  } else {
    res.send("");
  }
});

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("[BRIDGE] Running on port", PORT);
});
