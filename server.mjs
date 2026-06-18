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
const xLivechatContentSeen = new Map();
const pumpLivechatClients = new Set();
const pumpLivechatSeen = new Set();
const youtubeLivechatClients = new Set();
const youtubeLivechatSeen = new Set();
const youtubeLivechatContentSeen = new Map();
const hubClients = new Set();
const hubSeen = new Set();
const hubRecent = [];
const twitchEventSubs = new Map();
const twitchChatConnections = new Map();

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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

function broadcastYouTubeLivechat(payload) {
  for (const res of youtubeLivechatClients) {
    sendSse(res, "message", payload);
  }
}

function broadcastHub(payload) {
  hubRecent.push(payload);
  if (hubRecent.length > 40) hubRecent.shift();
  for (const res of hubClients) {
    sendSse(res, "hub", payload);
  }
}

function rememberHubId(id) {
  if (hubSeen.has(id)) return false;
  hubSeen.add(id);
  if (hubSeen.size > 3000) {
    const first = hubSeen.values().next().value;
    hubSeen.delete(first);
  }
  return true;
}

function rememberRecentContent(store, key, ttlMs = 120000, maxSize = 2000) {
  const now = Date.now();
  const cutoff = now - ttlMs;
  for (const [itemKey, ts] of store) {
    if (ts < cutoff) store.delete(itemKey);
  }
  if (store.has(key)) {
    store.set(key, now);
    return false;
  }
  store.set(key, now);
  while (store.size > maxSize) {
    store.delete(store.keys().next().value);
  }
  return true;
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

  const validateBody = await validateTwitchToken(cleanToken);
  const stream = await fetchTwitchStream(cleanChannel, cleanToken, validateBody.client_id);
  return {
    channel: cleanChannel,
    isLive: Boolean(stream),
    viewerCount: stream?.viewer_count ?? null
  };
}

async function validateTwitchToken(token) {
  const cleanToken = String(token || "").replace(/^oauth:/i, "").trim();
  const validateResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { authorization: `OAuth ${cleanToken}` }
  });
  const validateBody = await validateResponse.json().catch(() => ({}));
  if (!validateResponse.ok || !validateBody.client_id) {
    throw new Error(validateBody.message || "Twitch token validation failed.");
  }
  return validateBody;
}

async function fetchTwitchUser(login, token, clientId) {
  const cleanLogin = String(login || "").trim().replace(/^@/, "").toLowerCase();
  const usersResponse = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(cleanLogin)}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "client-id": clientId
    }
  });
  const usersBody = await usersResponse.json().catch(() => ({}));
  if (!usersResponse.ok) {
    throw new Error(usersBody.message || `Twitch user lookup failed: HTTP ${usersResponse.status}`);
  }
  const user = usersBody.data?.[0];
  if (!user?.id) throw new Error(`Twitch channel "${cleanLogin}" was not found.`);
  return user;
}

async function fetchTwitchStream(channel, token, clientId) {
  const cleanChannel = String(channel || "").trim().replace(/^@/, "").toLowerCase();
  const streamsResponse = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(cleanChannel)}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "client-id": clientId
    }
  });
  const streamsBody = await streamsResponse.json().catch(() => ({}));
  if (!streamsResponse.ok) {
    throw new Error(streamsBody.message || `Twitch streams lookup failed: HTTP ${streamsResponse.status}`);
  }

  return streamsBody.data?.[0] || null;
}

function parseTwitchTags(tagStr) {
  const tags = {};
  String(tagStr || "").split(";").forEach((tag) => {
    if (!tag) return;
    const index = tag.indexOf("=");
    const key = index === -1 ? tag : tag.slice(0, index);
    const value = index === -1 ? "" : tag.slice(index + 1);
    tags[key] = value.replace(/\\s/g, " ");
  });
  return tags;
}

function parseTwitchPrivmsg(line) {
  const match = line.match(/^(?:@([^ ]+) )?:(\S+)![^ ]+ PRIVMSG #([^ ]+) :([\s\S]+)$/);
  if (!match) return null;
  return {
    tags: parseTwitchTags(match[1] || ""),
    user: match[2],
    channel: match[3],
    text: match[4]
  };
}

function twitchChatBadge(tags) {
  if (tags.mod === "1") return "MOD";
  if (tags.subscriber === "1") return "SUB";
  if (String(tags.badges || "").includes("broadcaster/")) return "OWNER";
  return "";
}

async function startTwitchChatRelay({ channel, token, streamName, profileId }) {
  const cleanToken = String(token || "").replace(/^oauth:/i, "").trim();
  const cleanChannel = String(channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!cleanChannel || !cleanToken) throw new Error("Missing Twitch channel or OAuth token.");

  const key = `${profileId || "stream-1"}:twitch:${cleanChannel}`;
  const previous = twitchChatConnections.get(key);
  if (previous?.ws) {
    try { previous.ws.close(); } catch {}
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error("Twitch chat relay did not confirm in time."));
    }, 10000);

    twitchChatConnections.set(key, { ws, channel: cleanChannel, streamName, profileId });

    const finishReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ channel: cleanChannel });
    };

    const handleLine = (line) => {
      if (!line) return;
      if (line.startsWith("PING")) {
        ws.send("PONG :tmi.twitch.tv");
        return;
      }
      if (line.includes("Login authentication failed") || line.includes("Improperly formatted auth")) {
        throw new Error("Twitch chat auth failed. Check the OAuth token.");
      }
      if (line.includes(" 001 ") || line.includes(`JOIN #${cleanChannel}`)) {
        finishReady();
      }
      if (!line.includes(" PRIVMSG ")) return;
      const parsed = parseTwitchPrivmsg(line);
      if (!parsed) return;
      const id = parsed.tags.id ? `twitch:${parsed.tags.id}` : `twitch:${parsed.channel}:${parsed.user}:${parsed.text}`;
      const payload = {
        source: "twitch",
        id,
        type: "chat",
        event: "",
        overlay: true,
        user: parsed.tags["display-name"] || parsed.user,
        text: parsed.text,
        badge: twitchChatBadge(parsed.tags),
        streamName: streamName || cleanChannel,
        profileId: profileId || "",
        ts: Date.now()
      };
      if (rememberHubId(payload.id)) broadcastHub(payload);
    };

    ws.addEventListener("open", () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send(`PASS oauth:${cleanToken}`);
      ws.send(`NICK ${cleanChannel}`);
      ws.send(`JOIN #${cleanChannel}`);
    });

    ws.addEventListener("message", (message) => {
      try {
        buffer += String(message.data || "");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        lines.forEach(handleLine);
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          reject(error);
        }
      }
    });

    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("Twitch chat relay websocket error."));
    });

    ws.addEventListener("close", () => {
      const current = twitchChatConnections.get(key);
      if (current?.ws === ws) twitchChatConnections.delete(key);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Twitch chat relay closed before it was ready."));
      }
    });
  });
}

function stopTwitchChatRelay(profileId = "stream-1") {
  for (const [key, item] of twitchChatConnections) {
    if (!key.startsWith(`${profileId}:twitch:`)) continue;
    try { item.ws.close(); } catch {}
    twitchChatConnections.delete(key);
  }
}

async function createTwitchEventSubSubscription({ type, version, condition, token, clientId, sessionId }) {
  const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "client-id": clientId,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      type,
      version,
      condition,
      transport: {
        method: "websocket",
        session_id: sessionId
      }
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || `Twitch EventSub ${type} failed: HTTP ${response.status}`);
  }
  return body.data?.[0] || body;
}

function twitchActivityFromNotification(payload, streamName, profileId) {
  const type = payload.subscription?.type || "";
  const event = payload.event || {};
  if (type === "channel.follow") {
    const user = event.user_name || event.user_login || "Someone";
    return {
      source: "twitch",
      type: "activity",
      event: "follow",
      overlay: false,
      user,
      text: `${user} followed`,
      badge: "FOLLOW",
      streamName,
      profileId,
      ts: Date.now()
    };
  }
  if (type === "channel.subscribe") {
    const user = event.user_name || event.user_login || "Someone";
    return {
      source: "twitch",
      type: "activity",
      event: "subscription",
      overlay: false,
      user,
      text: `${user} subscribed`,
      badge: "SUB",
      streamName,
      profileId,
      ts: Date.now()
    };
  }
  return null;
}

async function startTwitchEventSub({ channel, token, streamName, profileId }) {
  const cleanToken = String(token || "").replace(/^oauth:/i, "").trim();
  const cleanChannel = String(channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!cleanChannel || !cleanToken) throw new Error("Missing Twitch channel or OAuth token.");

  const validateBody = await validateTwitchToken(cleanToken);
  const scopes = new Set(validateBody.scopes || []);
  if (!scopes.has("moderator:read:followers")) {
    throw new Error("Twitch follow events need a token with moderator:read:followers. Generate a new token with chat:read and moderator:read:followers.");
  }

  const broadcaster = await fetchTwitchUser(cleanChannel, cleanToken, validateBody.client_id);
  const key = `${profileId || "stream-1"}:twitch:${broadcaster.id}`;
  const previous = twitchEventSubs.get(key);
  if (previous?.ws) {
    try { previous.ws.close(); } catch {}
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let sessionId = "";
    const created = [];
    const ws = new WebSocket("wss://eventsub.wss.twitch.tv/ws");
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error("Twitch EventSub did not confirm in time."));
    }, 10000);

    twitchEventSubs.set(key, { ws, channel: cleanChannel, streamName, profileId });

    const finishReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        channel: cleanChannel,
        broadcasterId: broadcaster.id,
        subscriptions: created.map((item) => item.type).filter(Boolean)
      });
    };

    ws.addEventListener("message", async (message) => {
      try {
        const data = JSON.parse(message.data);
        const messageType = data.metadata?.message_type;
        if (messageType === "session_welcome") {
          sessionId = data.payload?.session?.id;
          if (!sessionId) throw new Error("Twitch EventSub welcome did not include a session id.");
          created.push(await createTwitchEventSubSubscription({
            type: "channel.follow",
            version: "2",
            condition: {
              broadcaster_user_id: broadcaster.id,
              moderator_user_id: validateBody.user_id
            },
            token: cleanToken,
            clientId: validateBody.client_id,
            sessionId
          }));
          if (scopes.has("channel:read:subscriptions")) {
            try {
              created.push(await createTwitchEventSubSubscription({
                type: "channel.subscribe",
                version: "1",
                condition: {
                  broadcaster_user_id: broadcaster.id
                },
                token: cleanToken,
                clientId: validateBody.client_id,
                sessionId
              }));
            } catch {
              // Keep follow events running even if optional subscription events are unavailable.
            }
          }
          finishReady();
          return;
        }
        if (messageType === "notification") {
          const activity = twitchActivityFromNotification(data.payload, streamName || cleanChannel, profileId || "");
          if (activity) broadcastHub(activity);
          return;
        }
        if (messageType === "session_reconnect") {
          const reconnectUrl = data.payload?.session?.reconnect_url;
          if (reconnectUrl) {
            try { ws.close(); } catch {}
            startTwitchEventSub({ channel: cleanChannel, token: cleanToken, streamName, profileId }).catch(() => {});
          }
          return;
        }
        if (messageType === "revocation") {
          const reason = data.payload?.subscription?.status || "revoked";
          broadcastHub({
            source: "twitch",
            type: "activity",
            event: "eventsub_revoked",
            overlay: false,
            user: "Twitch",
            text: `Twitch EventSub was revoked: ${reason}`,
            badge: "EVENTSUB",
            streamName: streamName || cleanChannel,
            profileId: profileId || "",
            ts: Date.now()
          });
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          reject(error);
        }
      }
    });

    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("Twitch EventSub websocket error."));
    });

    ws.addEventListener("close", () => {
      const current = twitchEventSubs.get(key);
      if (current?.ws === ws) twitchEventSubs.delete(key);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Twitch EventSub closed before it was ready."));
      }
    });
  });
}

function stopTwitchEventSub(profileId = "stream-1") {
  for (const [key, item] of twitchEventSubs) {
    if (!key.startsWith(`${profileId}:twitch:`)) continue;
    try { item.ws.close(); } catch {}
    twitchEventSubs.delete(key);
  }
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
  const type = snippet.type || "textMessageEvent";
  const superChatAmount = snippet.superChatDetails?.amountDisplayString || "";
  const isActivity = [
    "superChatEvent",
    "superStickerEvent",
    "newSponsorEvent",
    "memberMilestoneChatEvent",
    "membershipGiftingEvent",
    "giftMembershipReceivedEvent"
  ].includes(type);
  if (type === "superChatEvent" || type === "superStickerEvent") badges.push("PAID");
  if (type === "newSponsorEvent" || type === "memberMilestoneChatEvent") badges.push("MEMBER");

  const activityText = (() => {
    if (type === "superChatEvent") return `${author.displayName || "YouTube user"} sent a Super Chat${superChatAmount ? ` (${superChatAmount})` : ""}`;
    if (type === "superStickerEvent") return `${author.displayName || "YouTube user"} sent a Super Sticker`;
    if (type === "newSponsorEvent") return `${author.displayName || "YouTube user"} became a member`;
    if (type === "memberMilestoneChatEvent") return snippet.displayMessage || `${author.displayName || "YouTube user"} shared a member milestone`;
    if (type === "membershipGiftingEvent") return `${author.displayName || "YouTube user"} gifted memberships`;
    if (type === "giftMembershipReceivedEvent") return `${author.displayName || "YouTube user"} received a gifted membership`;
    return snippet.displayMessage || "";
  })();

  return {
    source: "youtube",
    id: item.id,
    type: isActivity ? "activity" : "chat",
    event: isActivity ? type : "",
    overlay: !isActivity,
    user: author.displayName || "YouTube user",
    text: isActivity ? activityText : snippet.displayMessage || "",
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
            type: "activity",
            event: "subscription",
            overlay: false,
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
      const contentKey = `${user}:${text}`.replace(/\s+/g, " ").trim().toLowerCase();
      if (!rememberRecentContent(xLivechatContentSeen, contentKey)) continue;
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

async function handleYouTubeLivechatStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });

  youtubeLivechatClients.add(res);
  sendSse(res, "status", { source: "youtube", status: "connected", mode: "livechat-bridge" });

  req.on("close", () => {
    youtubeLivechatClients.delete(res);
  });
}

async function handleYouTubeLivechatPush(req, res) {
  try {
    const body = await readJsonBody(req);
    if (body.type === "bridge-status") {
      const message = body.url
        ? `YouTube bridge detected on ${body.url}. Waiting for new chat messages.`
        : "YouTube bridge detected. Waiting for new chat messages.";
      for (const client of youtubeLivechatClients) {
        sendSse(client, "status", { source: "youtube", status: "connected", mode: "livechat-bridge", bridgeSeen: true, message });
      }
      sendJson(res, 200, { ok: true, type: "bridge-status", clients: youtubeLivechatClients.size });
      return;
    }

    const items = Array.isArray(body.messages) ? body.messages : [body];
    let accepted = 0;

    for (const item of items) {
      const text = String(item.text || item.message || "").trim();
      if (!text) continue;
      const user = String(item.user || item.username || "YouTube user").trim();
      const event = String(item.event || "").trim();
      const contentKey = `${event}:${user}:${text}`.replace(/\s+/g, " ").trim().toLowerCase();
      if (!rememberRecentContent(youtubeLivechatContentSeen, contentKey)) continue;
      const id = String(item.id || `youtube:${contentKey}:${item.ts || ""}`).slice(0, 600);
      if (youtubeLivechatSeen.has(id)) continue;
      youtubeLivechatSeen.add(id);
      if (youtubeLivechatSeen.size > 2000) {
        const first = youtubeLivechatSeen.values().next().value;
        youtubeLivechatSeen.delete(first);
      }

      accepted += 1;
      const ts = Number.isFinite(Number(item.ts)) ? Number(item.ts) : Date.now();
      const payload = {
        source: "youtube",
        id,
        type: item.type || "chat",
        event,
        overlay: item.overlay !== false,
        user,
        text,
        badge: item.badge || "",
        created_at: new Date(ts).toISOString(),
        ts
      };
      broadcastYouTubeLivechat(payload);
      if (payload.type !== "activity" && payload.overlay !== false && rememberHubId(payload.id)) {
        broadcastHub(payload);
      }
    }

    sendJson(res, 200, { ok: true, accepted, clients: youtubeLivechatClients.size });
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
    sendSse(res, "hub", payload);
  }

  const heartbeat = setInterval(() => {
    sendSse(res, "status", { ok: true, status: "connected", ts: Date.now() });
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    hubClients.delete(res);
  });
}

async function handleHubPush(req, res) {
  try {
    const body = await readJsonBody(req);
    sendHubPayload(res, body);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function sendHubPayload(res, body) {
  const id = String(body.id || `${body.source}:${body.type || "chat"}:${body.event || ""}:${body.user || body.username}:${body.text}:${body.ts || ""}`).slice(0, 600);
  if (!rememberHubId(id)) {
      sendJson(res, 200, { ok: true, duplicate: true, clients: hubClients.size });
      return;
  }

  const type = body.type || "chat";
  const event = body.event || "";
  const user = body.user || body.username || "unknown";
  const payload = {
    id,
    source: body.source,
    type,
    event,
    overlay: body.overlay !== false,
    user,
    text: body.text || (type === "activity" && event ? `${user} ${event}` : ""),
    badge: body.badge || "",
    streamName: body.streamName || "",
    profileId: body.profileId || "",
    ts: body.ts || Date.now()
  };
  broadcastHub(payload);
  sendJson(res, 200, { ok: true, clients: hubClients.size });
}

async function handleActivityPush(req, res) {
  try {
    const body = await readJsonBody(req);
    const sourceMap = {
      "pump.fun": "pump",
      pumpfun: "pump",
      yt: "youtube",
      twitter: "x"
    };
    const rawSource = String(body.source || "twitch").toLowerCase();
    const source = sourceMap[rawSource] || rawSource;
    const allowedSources = new Set(["twitch", "x", "youtube", "pump", "kick"]);
    if (!allowedSources.has(source)) {
      sendJson(res, 400, { error: "Unknown activity source. Use twitch, x, youtube, pump, or kick." });
      return;
    }
    const event = String(body.event || body.activity || "follow").toLowerCase();
    const user = body.user || body.username || body.name || "Someone";
    const labels = {
      follow: "followed",
      sub: "subscribed",
      subscribe: "subscribed",
      subscription: "subscribed",
      member: "became a member",
      superchat: "sent a Super Chat",
      raid: "raided"
    };
    sendHubPayload(res, {
      ...body,
      source,
      type: "activity",
      event,
      overlay: false,
      user,
      text: body.text || `${user} ${labels[event] || event}`,
      badge: body.badge || event.toUpperCase()
    });
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

async function handleTwitchEventSubStart(req, res) {
  try {
    const body = await readJsonBody(req);
    const result = await startTwitchEventSub({
      channel: body.channel,
      token: body.token,
      streamName: body.streamName,
      profileId: body.profileId
    });
    sendJson(res, 200, { ok: true, source: "twitch", ...result });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleTwitchEventSubStop(req, res) {
  try {
    const body = await readJsonBody(req);
    stopTwitchEventSub(body.profileId || "stream-1");
    sendJson(res, 200, { ok: true, source: "twitch" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleTwitchChatStart(req, res) {
  try {
    const body = await readJsonBody(req);
    const result = await startTwitchChatRelay({
      channel: body.channel,
      token: body.token,
      streamName: body.streamName,
      profileId: body.profileId
    });
    sendJson(res, 200, { ok: true, source: "twitch", ...result });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleTwitchChatStop(req, res) {
  try {
    const body = await readJsonBody(req);
    stopTwitchChatRelay(body.profileId || "stream-1");
    sendJson(res, 200, { ok: true, source: "twitch" });
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

  if (url.pathname === "/youtube/livechat/stream") {
    handleYouTubeLivechatStream(req, res);
    return;
  }

  if (url.pathname === "/youtube/livechat/push" && req.method === "POST") {
    handleYouTubeLivechatPush(req, res);
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

  if (url.pathname === "/activity/push" && req.method === "POST") {
    handleActivityPush(req, res);
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

  if (url.pathname === "/twitch/eventsub/start" && req.method === "POST") {
    handleTwitchEventSubStart(req, res);
    return;
  }

  if (url.pathname === "/twitch/eventsub/stop" && req.method === "POST") {
    handleTwitchEventSubStop(req, res);
    return;
  }

  if (url.pathname === "/twitch/chat/start" && req.method === "POST") {
    handleTwitchChatStart(req, res);
    return;
  }

  if (url.pathname === "/twitch/chat/stop" && req.method === "POST") {
    handleTwitchChatStop(req, res);
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

  if (url.pathname === "/youtube/livechat/capture.js") {
    fs.readFile(path.join(ROOT, "youtube-livechat-bridge", "content.js"), "utf8")
      .then((script) => {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        });
        res.end(script);
      })
      .catch(() => sendJson(res, 500, { error: "Could not read youtube-livechat-bridge/content.js" }));
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
    endpoints: ["/health", "/hub/stream", "/hub/push", "/hub/recent", "/x/stream?query=%23YourStreamTag", "/youtube/stream?url=YouTubeLiveUrl", "/youtube/livechat/stream", "/pump/livechat/stream", "/kick/stream?channel=YourKickChannel"]
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`StreamHub running at http://127.0.0.1:${PORT}`);
  console.log(`OBS overlay URL: http://127.0.0.1:${PORT}/overlay?overlay=1`);
  if (!bearerToken) console.log("Paste your X Bearer Token in the Connect panel, or add X_BEARER_TOKEN to .env.");
});
