import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

await loadDotEnv();

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const PORT = Number(process.env.PORT || 3000);
let bearerToken = process.env.X_BEARER_TOKEN || "";
const DEFAULT_INTERVAL_MS = Number(process.env.X_POLL_INTERVAL_MS || 15000);
const YOUTUBE_MIN_POLL_INTERVAL_MS = Math.max(Number(process.env.YOUTUBE_MIN_POLL_INTERVAL_MS || 15000), 1000);
const xLivechatClients = new Set();
const xLivechatSeen = new Set();
const pumpLivechatClients = new Set();
const pumpLivechatSeen = new Set();
const hubClients = new Set();
const hubSeen = new Set();
const hubRecent = [];

const assetTypes = new Map([
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

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

function serveAsset(res, url) {
  const rawName = decodeURIComponent(url.pathname.replace(/^\/assets\//, ""));
  const cleanName = path.basename(rawName);
  if (!cleanName || cleanName !== rawName) {
    sendJson(res, 404, { error: "Asset not found" });
    return;
  }

  const filePath = path.join(ROOT, "assets", cleanName);
  const contentType = assetTypes.get(path.extname(cleanName).toLowerCase()) || "application/octet-stream";

  fs.readFile(filePath)
    .then((file) => {
      res.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-store",
        "access-control-allow-origin": "*"
      });
      res.end(file);
    })
    .catch(() => sendJson(res, 404, { error: "Asset not found" }));
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

function broadcastPumpLivechat(payload) {
  for (const res of pumpLivechatClients) {
    sendSse(res, "message", payload);
  }
}

function broadcastHub(payload) {
  hubRecent.push(payload);
  if (hubRecent.length > 40) hubRecent.shift();
  for (const res of hubClients) {
    sendSse(res, "", payload);
    sendSse(res, "hub", payload);
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
    chatroomId,
    viewerCount: body.livestream?.viewer_count ?? body.viewer_count ?? null,
    isLive: Boolean(body.livestream)
  };
}

async function fetchTwitchViewerCount(channel, token) {
  const cleanToken = String(token || "").replace(/^oauth:/i, "").trim();
  const cleanChannel = String(channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!cleanChannel || !cleanToken) throw new Error("Missing Twitch channel or OAuth token.");

  const validateResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { authorization: `OAuth ${cleanToken}` }
  });
  const validateBody = await validateResponse.json().catch(() => ({}));
  if (!validateResponse.ok || !validateBody.client_id) {
    throw new Error(validateBody.message || "Twitch token validation failed.");
  }

  const streamsResponse = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(cleanChannel)}`, {
    headers: {
      authorization: `Bearer ${cleanToken}`,
      "client-id": validateBody.client_id
    }
  });
  const streamsBody = await streamsResponse.json().catch(() => ({}));
  if (!streamsResponse.ok) {
    throw new Error(streamsBody.message || `Twitch streams lookup failed: HTTP ${streamsResponse.status}`);
  }

  const stream = streamsBody.data?.[0];
  return {
    channel: cleanChannel,
    isLive: Boolean(stream),
    viewerCount: stream?.viewer_count ?? null
  };
}

function extractYouTubeVideoId(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname.includes("youtu.be")) return url.pathname.split("/").filter(Boolean)[0] || "";
    if (url.searchParams.get("v")) return url.searchParams.get("v") || "";
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((part) => ["live", "shorts", "embed"].includes(part));
    if (marker >= 0 && parts[marker + 1]) return parts[marker + 1];
  } catch {
  }
  return "";
}

function buildYouTubeRequest(url, credential) {
  const requestUrl = new URL(url);
  const value = String(credential || "").trim();
  const headers = {};
  if (value.startsWith("AIza")) {
    requestUrl.searchParams.set("key", value);
  } else {
    headers.authorization = `Bearer ${value}`;
  }
  return { url: requestUrl.toString(), headers };
}

async function fetchYouTubeVideoMeta(videoId, credential) {
  const request = buildYouTubeRequest(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoId)}`, credential);
  const response = await fetch(request.url, { headers: request.headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `YouTube video lookup failed: HTTP ${response.status}`);
  }
  const video = body.items?.[0];
  if (!video) throw new Error("YouTube video not found for this token.");
  return {
    title: video.snippet?.title || "YouTube live",
    liveChatId: video.liveStreamingDetails?.activeLiveChatId || "",
    viewerCount: video.liveStreamingDetails?.concurrentViewers ? Number(video.liveStreamingDetails.concurrentViewers) : null
  };
}

function normalizeYouTubeMessage(item) {
  const author = item.authorDetails || {};
  const snippet = item.snippet || {};
  const badges = [];
  if (author.isChatOwner) badges.push("OWNER");
  else if (author.isChatModerator) badges.push("MOD");
  if (author.isChatSponsor) badges.push("MEMBER");
  if (snippet.type === "superChatEvent") badges.push("SUPER");
  return {
    source: "youtube",
    id: item.id,
    user: author.displayName || "YouTube user",
    text: snippet.displayMessage || "",
    badge: badges.join(" "),
    created_at: snippet.publishedAt
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
    const channel = roomId ? { slug: slug || "kick", username: slug || "Kick", chatroomId: roomId, viewerCount: null } : await fetchKickChannel(slug);
    sendSse(res, "status", { source: "kick", status: "connected", channel: channel.slug, chatroomId: channel.chatroomId, viewerCount: channel.viewerCount });

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
      const createdAt = Number.isFinite(Number(item.ts)) ? new Date(Number(item.ts)).toISOString() : new Date().toISOString();
      broadcastXLivechat({
        source: "x",
        id,
        user,
        text,
        badge: "LIVECHAT",
        created_at: createdAt
      });
    }

    sendJson(res, 200, { ok: true, accepted, clients: xLivechatClients.size });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handlePumpLivechatStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });

  pumpLivechatClients.add(res);
  sendSse(res, "status", { source: "pump", status: "connected", mode: "livechat-bridge" });

  req.on("close", () => {
    pumpLivechatClients.delete(res);
  });
}

async function handlePumpLivechatPush(req, res) {
  try {
    const body = await readJsonBody(req);
    if (body.type === "bridge-status") {
      const message = body.url
        ? `Pump.fun bridge detected on ${body.url}. Waiting for new chat messages.`
        : "Pump.fun bridge detected. Waiting for new chat messages.";
      for (const client of pumpLivechatClients) {
        sendSse(client, "status", { source: "pump", status: "connected", mode: "livechat-bridge", bridgeSeen: true, message });
      }
      sendJson(res, 200, { ok: true, type: "bridge-status", clients: pumpLivechatClients.size });
      return;
    }

    const items = Array.isArray(body.messages) ? body.messages : [body];
    let accepted = 0;

    for (const item of items) {
      const text = String(item.text || "").trim();
      if (!text) continue;
      const user = String(item.user || item.username || "Pump user").trim();
      const id = String(item.id || `pump:${user}:${text}:${item.ts || ""}`).slice(0, 600);
      if (pumpLivechatSeen.has(id)) continue;
      pumpLivechatSeen.add(id);
      if (pumpLivechatSeen.size > 2000) {
        const first = pumpLivechatSeen.values().next().value;
        pumpLivechatSeen.delete(first);
      }

      accepted += 1;
      broadcastPumpLivechat({
        source: "pump",
        id,
        user,
        text,
        badge: item.badge || "PUMP",
        created_at: Number.isFinite(Number(item.ts)) ? new Date(Number(item.ts)).toISOString() : new Date().toISOString()
      });
    }

    sendJson(res, 200, { ok: true, accepted, clients: pumpLivechatClients.size });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleHubStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });

  hubClients.add(res);
  sendSse(res, "status", { ok: true, status: "connected" });
  for (const payload of hubRecent.slice(-10)) {
    sendSse(res, "", payload);
    sendSse(res, "hub", payload);
  }

  req.on("close", () => {
    hubClients.delete(res);
  });
}

async function handleHubPush(req, res) {
  try {
    const body = await readJsonBody(req);
    const id = String(body.id || `${body.source}:${body.user}:${body.text}:${body.ts || ""}`).slice(0, 600);
    if (hubSeen.has(id)) {
      sendJson(res, 200, { ok: true, duplicate: true, clients: hubClients.size });
      return;
    }
    hubSeen.add(id);
    if (hubSeen.size > 3000) {
      const first = hubSeen.values().next().value;
      hubSeen.delete(first);
    }

    const payload = {
      id,
      source: body.source,
      user: body.user || body.username || "unknown",
      text: body.text || "",
      badge: body.badge || "",
      streamName: body.streamName || "",
      profileId: body.profileId || "",
      ts: body.ts || Date.now()
    };
    broadcastHub(payload);
    sendJson(res, 200, { ok: true, clients: hubClients.size });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleHubRecent(req, res) {
  sendJson(res, 200, { messages: hubRecent.slice(-20), clients: hubClients.size });
}

async function handleKickMeta(req, res, url) {
  try {
    const slug = url.searchParams.get("channel")?.trim().replace(/^@/, "");
    if (!slug) {
      sendJson(res, 400, { error: "Missing Kick channel." });
      return;
    }
    const channel = await fetchKickChannel(slug);
    sendJson(res, 200, {
      source: "kick",
      channel: channel.slug,
      isLive: channel.isLive,
      viewerCount: channel.viewerCount
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleTwitchMeta(req, res) {
  try {
    const body = await readJsonBody(req);
    const meta = await fetchTwitchViewerCount(body.channel, body.token);
    sendJson(res, 200, { source: "twitch", ...meta });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleYouTubeMeta(req, res, url) {
  try {
    const token = url.searchParams.get("token") || "";
    const liveChatId = url.searchParams.get("liveChatId") || "";
    const videoId = extractYouTubeVideoId(url.searchParams.get("video") || url.searchParams.get("url") || "");
    if (!token) {
      sendJson(res, 400, { error: "Missing YouTube API key or OAuth access token." });
      return;
    }
    if (liveChatId) {
      sendJson(res, 200, { source: "youtube", liveChatId, viewerCount: null });
      return;
    }
    if (!videoId) {
      sendJson(res, 400, { error: "Missing YouTube video URL or liveChatId." });
      return;
    }
    const meta = await fetchYouTubeVideoMeta(videoId, token);
    sendJson(res, 200, { source: "youtube", videoId, ...meta });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleYouTubeStream(req, res, url) {
  const token = url.searchParams.get("token")?.trim();
  const directLiveChatId = url.searchParams.get("liveChatId")?.trim();
  const videoInput = url.searchParams.get("video") || url.searchParams.get("url") || "";
  const videoId = extractYouTubeVideoId(videoInput);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });

  if (!token) {
    sendSse(res, "error", { source: "youtube", error: "Missing YouTube API key or OAuth access token." });
    res.end();
    return;
  }

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  try {
    const meta = directLiveChatId
      ? { liveChatId: directLiveChatId, title: "YouTube live", viewerCount: null }
      : await fetchYouTubeVideoMeta(videoId, token);
    if (!meta.liveChatId) {
      sendSse(res, "error", { source: "youtube", error: "No active YouTube liveChatId found. The stream may not be live or chat may be disabled." });
      res.end();
      return;
    }

    sendSse(res, "status", { source: "youtube", status: "connected", title: meta.title, liveChatId: meta.liveChatId, viewerCount: meta.viewerCount });

    const seen = new Set();
    let pageToken = "";
    let lastViewerRefresh = 0;

    async function poll() {
      if (closed) return;
      try {
        const params = new URLSearchParams({
          liveChatId: meta.liveChatId,
          part: "snippet,authorDetails",
          maxResults: "200"
        });
        if (pageToken) params.set("pageToken", pageToken);

        const request = buildYouTubeRequest(`https://www.googleapis.com/youtube/v3/liveChat/messages?${params}`, token);
        const response = await fetch(request.url, { headers: request.headers });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || `YouTube chat HTTP ${response.status}`);

        for (const item of body.items || []) {
          if (!item.id || seen.has(item.id)) continue;
          seen.add(item.id);
          const message = normalizeYouTubeMessage(item);
          if (message.text) sendSse(res, "message", message);
        }
        while (seen.size > 1000) seen.delete(seen.values().next().value);

        pageToken = body.nextPageToken || pageToken;
        if (videoId && Date.now() - lastViewerRefresh > 60000) {
          lastViewerRefresh = Date.now();
          try {
            const fresh = await fetchYouTubeVideoMeta(videoId, token);
            sendSse(res, "status", { source: "youtube", status: "connected", title: fresh.title, liveChatId: fresh.liveChatId || meta.liveChatId, viewerCount: fresh.viewerCount });
          } catch {
          }
        }

        const youtubeInterval = Number(body.pollingIntervalMillis || 5000);
        const waitMs = Math.max(youtubeInterval, YOUTUBE_MIN_POLL_INTERVAL_MS);
        sendSse(res, "status", { source: "youtube", status: "connected", title: meta.title, liveChatId: meta.liveChatId, viewerCount: meta.viewerCount, nextPollMs: waitMs });
        setTimeout(poll, waitMs);
      } catch (error) {
        sendSse(res, "error", { source: "youtube", error: error.message });
        res.end();
      }
    }

    poll();
  } catch (error) {
    sendSse(res, "error", { source: "youtube", error: error.message });
    res.end();
  }
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

  if (url.pathname.startsWith("/assets/")) {
    serveAsset(res, url);
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

  if (url.pathname === "/pump/livechat/stream") {
    handlePumpLivechatStream(req, res);
    return;
  }

  if (url.pathname === "/pump/livechat/push" && req.method === "POST") {
    handlePumpLivechatPush(req, res);
    return;
  }

  if (url.pathname === "/hub/stream") {
    handleHubStream(req, res);
    return;
  }

  if (url.pathname === "/hub/push" && req.method === "POST") {
    handleHubPush(req, res);
    return;
  }

  if (url.pathname === "/hub/recent") {
    handleHubRecent(req, res);
    return;
  }

  if (url.pathname === "/kick/meta") {
    handleKickMeta(req, res, url);
    return;
  }

  if (url.pathname === "/twitch/meta" && req.method === "POST") {
    handleTwitchMeta(req, res);
    return;
  }

  if (url.pathname === "/youtube/meta") {
    handleYouTubeMeta(req, res, url);
    return;
  }

  if (url.pathname === "/youtube/stream") {
    handleYouTubeStream(req, res, url);
    return;
  }

  if (url.pathname === "/x/livechat/capture.js") {
    fs.readFile(path.join(ROOT, "x-livechat-bridge", "content.js"), "utf8")
      .then((script) => {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        });
        res.end(script);
      })
      .catch(() => sendJson(res, 500, { error: "Could not read x-livechat-bridge/content.js" }));
    return;
  }

  if (url.pathname === "/pump/livechat/capture.js") {
    fs.readFile(path.join(ROOT, "pump-livechat-bridge", "content.js"), "utf8")
      .then((script) => {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        });
        res.end(script);
      })
      .catch(() => sendJson(res, 500, { error: "Could not read pump-livechat-bridge/content.js" }));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/overlay" || url.pathname === "/streamhub-contest.html") {
    fs.readFile(path.join(ROOT, "streamhub-contest.html"), "utf8")
      .then((html) => {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        });
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
    endpoints: ["/health", "/hub/stream", "/hub/push", "/hub/recent", "/x/stream?query=%23YourStreamTag", "/youtube/stream?url=YouTubeLiveUrl", "/pump/livechat/stream", "/kick/stream?channel=YourKickChannel"]
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`StreamHub running at http://127.0.0.1:${PORT}`);
  console.log(`OBS overlay URL: http://127.0.0.1:${PORT}/overlay?overlay=1`);
  if (!bearerToken) console.log("Paste your X Bearer Token in the Connect panel, or add X_BEARER_TOKEN to .env.");
});
