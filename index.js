import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.text({ type: "*/*" }));

// CORS
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

    // ⭐ Attach to Chrome DevTools Protocol
    const client = await page.target().createCDPSession();
    await client.send("Network.enable");

    // ⭐ Intercept WebSocket frames (cloud → bridge)
    client.on("Network.webSocketFrameReceived", ({ response }) => {
        const data = response.payloadData;
        const buf = Buffer.from(data, "binary");
        const b64 = buf.toString("base64");
        queue.push(b64);
        console.log("[BRIDGE] WS recv | bytes:", buf.length);
    });

    // ⭐ Intercept WebSocket frames sent (bridge → cloud)
    client.on("Network.webSocketFrameSent", ({ response }) => {
        const data = response.payloadData;
        const buf = Buffer.from(data, "binary");
        const b64 = buf.toString("base64");
        queue.push(b64);
        console.log("[BRIDGE] WS sent | bytes:", buf.length);
    });

    console.log("[BRIDGE] WebSocket hooks installed (CDP)");
}

startBrowser().catch(err => {
    console.error("[BRIDGE] Chrome failed:", err);
});

// /send (local → cloud)
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

// /recv (cloud → local)
app.get("/recv", (req, res) => {
    if (queue.length > 0) {
        res.send(queue.shift());
    } else {
        res.send("");
    }
});

// Serve client
app.use(express.static("public"));

app.listen(3000, () => {
    console.log("[BRIDGE] Running on port 3000");
});
