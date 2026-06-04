# StreamHub

Unified live feed for Twitch, X, and Kick, designed to run as a local browser source in OBS or Streamlabs.

## Quick Start

1. Start the app:

```bash
npm start
```

On Windows, you can also double-click:

```text
start-streamhub.bat
```

On Windows PowerShell, if `npm start` is blocked by execution policy, use:

```powershell
npm.cmd start
```

Or run Node directly:

```bash
node server.mjs
```

2. Open:

```text
http://127.0.0.1:3000
```

3. Fill in the platform cards.
4. Press `Connect All`, or connect platforms one by one.
5. Confirm the counter shows `1/3`, `2/3`, or `3/3`.
6. Press `Launch StreamHub`.

Twitch needs a chat OAuth token with `chat:read`. The channel field is the Twitch channel you want to join.

Useful links:

- Twitch chat token: https://twitchtokengenerator.com/
- Twitch scopes: https://dev.twitch.tv/docs/authentication/scopes/
- X developer portal: https://developer.x.com/en/portal/dashboard
- X API credits: https://docs.x.com/x-api/getting-started/pricing
- X query syntax: https://docs.x.com/x-api/posts/search/integrate/build-a-query

Kick setup:

1. Enter the Kick channel slug, for example `xqc` from `kick.com/xqc`.
2. Leave Proxy URL as `/kick/stream`.
3. Press `Connect Kick`.

If Kick blocks the automatic channel lookup, paste the channel's chatroom ID into `Chatroom ID optional` and try again. You can usually find it by opening:

```text
https://kick.com/api/v2/channels/CHANNEL_NAME
```

Then search the JSON for:

```text
"chatroom":{"id":
```

## Local Settings

StreamHub saves non-secret setup fields in your browser on this computer, so refreshes keep your channel names, queries, proxy URLs, and Kick chatroom ID.

Tokens are only saved if you check `Remember token on this computer`. Do not use that option on a shared computer.

Optional: instead of pasting the token each time, copy `.env.example` to `.env` and set:

```env
X_BEARER_TOKEN=your_x_bearer_token_here
```

## OBS / Streamlabs

Add a Browser Source with this URL:

```text
http://127.0.0.1:3000/overlay?overlay=1&x=%23YourStreamTag&autoconnect=1
```

Replace `%23YourStreamTag` with your hashtag. `%23` is `#` in a URL.

Examples:

```text
http://127.0.0.1:3000/overlay?overlay=1&x=%23MarketBubble&autoconnect=1
http://127.0.0.1:3000/overlay?overlay=1&x=%40MarketBubble&autoconnect=1
http://127.0.0.1:3000/overlay?overlay=1&x=%23MarketBubble%20OR%20%40MarketBubble&autoconnect=1
```

Suggested Browser Source size: `1280 x 720`.

## How X Works

X is not a Twitch-style livestream chat API. StreamHub pulls near-real-time public X posts that match a query, hashtag, mention, or creator rule.

The local Node server calls the X API and forwards normalized messages to the frontend through Server-Sent Events. You can paste the bearer token into the Connect panel, where it is sent only to your local server and kept in memory, or you can store it in `.env`.

Native X livechat is intentionally not wired as a first-class connector because X does not currently expose a stable public livestream chat API. If X adds one later, StreamHub can add it as another source adapter.

## Files

- `server.mjs`: local app server and X proxy
- `streamhub-contest.html`: frontend UI and OBS overlay
- `.env.example`: config template

## Notes

Twitch can connect directly from the browser with a chat OAuth token. Kick is left as a relay adapter because reliable official real-time chat support changes more often.
