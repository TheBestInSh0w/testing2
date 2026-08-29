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
let queue = []; // packets from cloud → loca

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

    // Cloud → Bridge
    await page.exposeFunction("cloudToBridge", (arr) => {
        const b64 = Buffer.from(Uint8Array.from(arr)).toString("base64");
        queue.push(b64);
        console.log("[BRIDGE] Packet from cloud | bytes:", arr.length);
    });

    // ⭐ SAFE WebSocket hook (no illegal invocation)
    await page.evaluate(() => {
        const OrigWS = window.WebSocket;

        // Wrap constructor safely
        window.WebSocket = new Proxy(OrigWS, {
            construct(target, args) {
                const ws = new target(...args);

                if (args[0].includes("wss://")) {
                    window.eaglerWS = ws;
                }

                return ws;
            }
        });

        // Wrap send()
        const origSend = OrigWS.prototype.send;
        OrigWS.prototype.send = function(data) {
            if (this.url.includes("wss://")) {
                const arr = new Uint8Array(data);
                window.cloudToBridge([...arr]);
            }
            return Reflect.apply(origSend, this, [data]);
        };

        // Wrap onmessage
        const origOnMessage = OrigWS.prototype.onmessage;
        OrigWS.prototype.onmessage = function(ev) {
            if (this.url.includes("wss://")) {
                const arr = new Uint8Array(ev.data);
                window.cloudToBridge([...arr]);
            }
            return Reflect.apply(origOnMessage, this, [ev]);
        };
    });

    console.log("[BRIDGE] WebSocket hooks installed");
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
