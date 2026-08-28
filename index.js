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
        headless: false,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-software-rasterizer",
            "--disable-web-security",
            "--disable-site-isolation-trials",
            "--disable-features=IsolateOrigins,site-per-process"
        ]
    });

    page = await browser.newPage();

    await page.goto("https://YOUR-RAILWAY-APP.up.railway.app/client.html", {
        waitUntil: "load"
    });

    console.log("[BRIDGE] Cloud Eagler client loaded");

    await page.exposeFunction("cloudToBridge", (arr) => {
        const b64 = Buffer.from(Uint8Array.from(arr)).toString("base64");
        queue.push(b64);
        console.log("[BRIDGE] Packet from cloud | bytes:", arr.length);
    });

    await page.evaluate(() => {
        const OrigWS = window.WebSocket;

        window.WebSocket = function(url, proto) {
            const ws = new OrigWS(url, proto);
            if (url.includes("wss://")) {
                window.eaglerWS = ws;
            }
            return ws;
        };

        const origSend = OrigWS.prototype.send;
        OrigWS.prototype.send = function(data) {
            if (this.url.includes("wss://")) {
                const arr = new Uint8Array(data);
                window.cloudToBridge([...arr]);
            }
            return origSend.call(this, data);
        };

        const origOnMessage = OrigWS.prototype.onmessage;
        OrigWS.prototype.onmessage = function(ev) {
            if (this.url.includes("wss://")) {
                const arr = new Uint8Array(ev.data);
                window.cloudToBridge([...arr]);
            }
            return origOnMessage.call(this, ev);
        };
    });

    console.log("[BRIDGE] WebSocket hooks installed");
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

app.listen(3000, () => {
    console.log("[BRIDGE] Running on port 3000");
});
