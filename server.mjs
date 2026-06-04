import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

await loadDotEnv();

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const PORT = Number(process.env.PORT || 3000);
let bearerToken = process.env.X_BEARER_TOKEN || "";
const DEFAULT_INTERVAL_MS = Number(process.env.X_POLL_INTERVAL_MS || 15000);
const xLivechatClients = new Set();
const xLivechatSeen = new Set();

async function loadDotEnv() {
  try {
    const text = await fs.readFile(new URL(".env", import.meta.url), "utf8");
    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const index = trimmed.indexOf("=");
      if (index === -1) return;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    });
  } catch {
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendSse(res, event, payload) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastXLivechat(payload) {
  for (const res of xLivechatClients) {
    sendSse(res, "message", payload);
  }
}

function normalizePost(post, users) {
  const user = users.get(post.author_id);
  return {
    source: "x",
    id: post.id,
    user: user?.username ? `@${user.username}` : user?.name || "X user",
    text: post.text,
    badge: "X",
    created_at: post.created_at
  };
}

async function fetchRecent(query, sinceId) {
  const params = new URLSearchParams({
    query,
    "tweet.fields": "author_id,created_at,text",
    "user.fields": "name,username",
    expansions: "author_id",
    max_results: "10"
  });
  if (sinceId) params.set("since_id", sinceId);

  const response = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
    headers: { authorization: `Bearer ${bearerToken}` }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.detail || body?.title || body?.errors?.[0]?.message || `X API HTTP ${response.status}`;
    throw new Error(message);
  }

  const users = new Map((body.includes?.users || []).map((user) => [user.id, user]));
  return {
    newestId: body.meta?.newest_id || sinceId,
    posts: (body.data || []).slice().reverse().map((post) => normalizePost(post, users))
  };
}

async function fetchKickChannel(slug) {
  const response = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    headers: {
      accept: "application/json",
      "user-agent": "StreamHub/1.0"
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message || `Kick channel lookup failed: HTTP ${response.status}`);
  }

  const chatroomId = body?.chatroom?.id || body?.chatroom_id;
  if (!chatroomId) throw new Error("Kick channel found, but no chatroom id was returned.");

  return {
    slug: body.slug || slug,
    username: body.user?.username || body.slug || slug,
    chatroomId
  };
}

async function handleXStream(req, res, url) {
  const rawQuery = url.searchParams.get("query")?.trim();
  if (!rawQuery) {
    sendJson(res, 400, { error: "Missing query parameter. Example: /x/stream?query=%23MyStream" });
    return;
  }

  const query = rawQuery.includes("-is:retweet") ? rawQuery : `${rawQuery} -is:retweet`;
  const intervalMs = Math.max(Number(url.searchParams.get("interval") || DEFAULT_INTERVAL_MS), 5000);
  let sinceId = url.searchParams.get("since_id") || "";
  let closed = false;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });

  if (!bearerToken) {
    sendSse(res, "error", {
      source: "x",
      error: "Missing X Bearer Token. Paste it in the StreamHub X card, then connect again."
    });
    res.end();
    return;
  }

  sendSse(res, "status", { source: "x", status: "connected", query, intervalMs });

  req.on("close", () => {
    closed = true;
  });

  async function poll() {
    if (closed) return;
    try {
      const result = await fetchRecent(query, sinceId);
      sinceId = result.newestId || sinceId;
      result.posts.forEach((post) => sendSse(res, "message", post));
      if (!result.posts.length) sendSse(res, "heartbeat", { source: "x", at: new Date().toISOString() });
    } catch (error) {
      sendSse(res, "error", { source: "x", error: error.message });
    }

    if (!closed) setTimeout(poll, intervalMs);
  }

  poll();
}

async function handleKickStream(req, res, url) {
  const slug = url.searchParams.get("channel")?.trim().replace(/^@/, "");
  const roomId = url.searchParams.get("roomId")?.trim();
  if (!slug && !roomId) {
    sendJson(res, 400, { error: "Missing Kick channel. Example: /kick/stream?channel=xqc" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });

  let closed = false;
  let ws;

  req.on("close", () => {
    closed = true;
    try { ws?.close(); } catch {}
  });

  try {
    const channel = roomId ? { slug: slug || "kick", username: slug || "Kick", chatroomId: roomId } : await fetchKickChannel(slug);
    sendSse(res, "status", { source: "kick", status: "connected", channel: channel.slug, chatroomId: channel.chatroomId });

    ws = new WebSocket("wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false");

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        event: "pusher:subscribe",
        data: { auth: "", channel: `chatrooms.${channel.chatroomId}.v2` }
      }));
    });

    ws.addEventListener("message", (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(event.data);

        if (msg.event === "pusher:subscription_succeeded") {
          sendSse(res, "status", { source: "kick", status: "live", channel: channel.slug });
          return;
        }

        if (msg.event === "App\\Events\\ChatMessageEvent") {
          const data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
          const badges = data.sender?.identity?.badges || [];
          const badge = badges.some((item) => item.type === "moderator")
            ? "MOD"
            : badges.some((item) => item.type === "subscriber")
              ? "SUB"
              : "";
          sendSse(res, "message", {
            source: "kick",
            id: data.id,
            user: data.sender?.username || "Kick user",
            text: data.content || "",
            badge
          });
        }

        if (msg.event === "App\\Events\\SubscriptionEvent") {
          const data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
          sendSse(res, "message", {
            source: "kick",
            user: data.username || "Someone",
            text: "Just subscribed",
            badge: "SUB"
          });
        }
      } catch (error) {
        sendSse(res, "error", { source: "kick", error: error.message });
      }
    });

    ws.addEventListener("error", () => {
      sendSse(res, "error", { source: "kick", error: "Kick websocket error. Try again or check the channel name." });
    });

    ws.addEventListener("close", () => {
      if (!closed) sendSse(res, "error", { source: "kick", error: "Kick websocket closed." });
    });
  } catch (error) {
    sendSse(res, "error", { source: "kick", error: error.message });
    res.end();
  }
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function handleXLivechatStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });

  xLivechatClients.add(res);
  sendSse(res, "status", { source: "x", status: "connected", mode: "livechat-bridge" });

  req.on("close", () => {
    xLivechatClients.delete(res);
  });
}

async function handleXLivechatPush(req, res) {
  try {
    const body = await readJsonBody(req);
    const items = Array.isArray(body.messages) ? body.messages : [body];
    let accepted = 0;

    for (const item of items) {
      const text = String(item.text || "").trim();
      if (!text) continue;
      const user = String(item.user || item.username || "X livechat").trim();
      const id = String(item.id || `${user}:${text}`).slice(0, 500);
      if (xLivechatSeen.has(id)) continue;
      xLivechatSeen.add(id);
      if (xLivechatSeen.size > 2000) {
        const first = xLivechatSeen.values().next().value;
        xLivechatSeen.delete(first);
      }

      accepted += 1;
      broadcastXLivechat({
        source: "x",
        id,
        user,
        text,
        badge: "LIVECHAT",
        created_at: new Date().toISOString()
      });
    }

    sendJson(res, 200, { ok: true, accepted, clients: xLivechatClients.size });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function livechatCaptureScript() {
  return `(() => {
  const endpoint = "http://127.0.0.1:${PORT}/x/livechat/push";
  const seen = new Set();

  function clean(text) {
    return String(text || "")
      .replace(/\\s+/g, " ")
      .trim();
  }

  function candidates() {
    return Array.from(document.querySelectorAll('[data-testid], [role="listitem"], article, div[dir="auto"]'))
      .map((node) => ({ node, text: clean(node.innerText || node.textContent || "") }))
      .filter((item) => item.text && item.text.length > 2 && item.text.length < 500);
  }

  function parseLine(text) {
    const parts = text.split("\\n").map(clean).filter(Boolean);
    const flat = clean(text);
    if (!flat || /^(reply|repost|like|share)$/i.test(flat)) return null;

    let user = "X livechat";
    let message = flat;

    if (parts.length >= 2) {
      user = parts[0].replace(/^@/, "");
      message = parts.slice(1).join(" ");
    } else {
      const match = flat.match(/^(@?[A-Za-z0-9_]{2,20})\\s+(.+)$/);
      if (match) {
        user = match[1].replace(/^@/, "");
        message = match[2];
      }
    }

    if (!message || message === user || message.length < 2) return null;
    const id = clean(user + ":" + message);
    if (seen.has(id)) return null;
    seen.add(id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
    return { source: "x", user: "@" + user.replace(/^@/, ""), text: message, id };
  }

  async function flush() {
    const messages = candidates().map((item) => parseLine(item.text)).filter(Boolean);
    if (!messages.length) return;
    try {
      await fetch(endpoint, {
        method: "POST",
        mode: "cors",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages })
      });
    } catch (error) {
      console.warn("StreamHub X livechat bridge could not send messages:", error);
    }
  }

  clearInterval(window.__streamHubXLivechatTimer);
  window.__streamHubXLivechatTimer = setInterval(flush, 1200);
  flush();
  console.log("StreamHub X livechat bridge is running. Keep this X livechat tab open.");
})();`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, hasBearer: Boolean(bearerToken) });
    return;
  }

  if (url.pathname === "/config/x" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        const token = String(body.bearerToken || "").trim();
        if (!token) {
          sendJson(res, 400, { error: "Missing bearerToken" });
          return;
        }
        bearerToken = token;
        sendJson(res, 200, { ok: true, hasBearer: true });
      })
      .catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  if (url.pathname === "/x/livechat/stream") {
    handleXLivechatStream(req, res);
    return;
  }

  if (url.pathname === "/x/livechat/push" && req.method === "POST") {
    handleXLivechatPush(req, res);
    return;
  }

  if (url.pathname === "/x/livechat/capture.js") {
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "access-control-allow-origin": "*"
    });
    res.end(livechatCaptureScript());
    return;
  }

  if (url.pathname === "/" || url.pathname === "/overlay" || url.pathname === "/streamhub-contest.html") {
    fs.readFile(path.join(ROOT, "streamhub-contest.html"), "utf8")
      .then((html) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      })
      .catch(() => sendJson(res, 500, { error: "Could not read streamhub-contest.html" }));
    return;
  }

  if (url.pathname === "/x/stream") {
    handleXStream(req, res, url);
    return;
  }

  if (url.pathname === "/kick/stream") {
    handleKickStream(req, res, url);
    return;
  }

  sendJson(res, 404, {
    error: "Not found",
    endpoints: ["/health", "/x/stream?query=%23YourStreamTag", "/x/livechat/stream", "/kick/stream?channel=YourKickChannel"]
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`StreamHub running at http://127.0.0.1:${PORT}`);
  console.log(`OBS overlay URL: http://127.0.0.1:${PORT}/overlay?overlay=1`);
  if (!bearerToken) console.log("Paste your X Bearer Token in the Connect panel, or add X_BEARER_TOKEN to .env.");
});
