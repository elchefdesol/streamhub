# StreamHub

Unified live feed for Twitch, X, YouTube, and Kick, designed to run as a local browser source in OBS or Streamlabs.

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
4. Use `+ Add Stream` if you want to merge chats from a cohost or another stream.
5. Press `Connect Filled Platforms`, or connect platforms one by one.
6. Confirm the counter shows connected sources, for example `1/4`, `2/4`, or `5/8`.
7. Press `Launch StreamHub`.

Twitch needs a chat OAuth token with `chat:read`. The channel field is the Twitch channel you want to join.

Useful links:

- Twitch chat token: https://twitchtokengenerator.com/
- Twitch scopes: https://dev.twitch.tv/docs/authentication/scopes/
- X developer portal: https://developer.x.com/en/portal/dashboard
- X API credits: https://docs.x.com/x-api/getting-started/pricing
- X query syntax: https://docs.x.com/x-api/posts/search/integrate/build-a-query
- X livechat bridge folder: `x-livechat-bridge`
- YouTube API: https://console.cloud.google.com/apis/library/youtube.googleapis.com
- YouTube live chat docs: https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list

Kick setup:

1. Enter the Kick channel slug, for example `xqc` from `kick.com/xqc`.
2. Leave Proxy URL as `/kick/stream`.
3. Press `Connect Kick`.

If Kick blocks the automatic channel lookup, paste the channel's chatroom ID into `Chatroom ID fallback` and try again. You can usually find it by opening:

```text
https://kick.com/api/v2/channels/CHANNEL_NAME
```

Then search the JSON for:

```text
"chatroom":{"id":
```

YouTube setup:

1. Enable the YouTube Data API v3 in Google Cloud.
2. Get a YouTube API key, or use a YouTube OAuth access token for private/owned streams.
3. Enter a YouTube live URL, video ID, or `liveChatId`.
4. Leave Proxy URL as `/youtube/stream`.
5. Press `Connect YouTube`.

StreamHub uses YouTube's official Live Chat API and follows YouTube's returned `pollingIntervalMillis`, with a default minimum of 15 seconds between chat polls so an 8-hour stream is much less likely to burn through daily quota.

## Local Settings

StreamHub saves non-secret setup fields in your browser on this computer, so refreshes keep your channel names, queries, proxy URLs, and Kick chatroom ID.

Tokens are only saved if you check `Remember token on this computer`. Do not use that option on a shared computer.

Optional: instead of pasting the token each time, copy `.env.example` to `.env` and set:

```env
X_BEARER_TOKEN=your_x_bearer_token_here
```

## OBS / Streamlabs

StreamHub uses two local browser pages while you stream:

- Main app / dock: connects Twitch, X, YouTube, and Kick.
- Overlay: transparent username + message bubbles for the actual stream scene.

### OBS Dock

Add this URL as a custom browser dock if you want the full StreamHub controls inside OBS:

```text
http://127.0.0.1:3000
```

Connect your platforms here and keep this page open while streaming.

### Stream Overlay

Add this URL as a Browser Source in your scene:

```text
http://127.0.0.1:3000/overlay?overlay=1&duration=6&max=4
```

Suggested Browser Source size: `1280 x 720`.

The overlay is transparent and only shows recent chat messages. It hides platform badges, timestamps, and the dashboard card background so it can sit cleanly on top of a stream. Messages disappear automatically after a few seconds. If there are no new messages, the overlay will look blank on purpose.

If OBS keeps showing an old blank page after you update StreamHub, open the Browser Source properties and click `Refresh cache of current page`, or temporarily add `&v=2` to the overlay URL.

Overlay settings:

```text
http://127.0.0.1:3000/overlay?overlay=1&duration=6&max=4
```

- `duration=6` keeps each message visible for about 6 seconds.
- `max=4` shows at most 4 recent messages.

Important: the OBS overlay receives messages from the main StreamHub app through the local Node server. Keep the main app connected in your browser or OBS dock while the overlay is in your scene.

## How X Works

StreamHub supports X in two ways:

1. Official X API mode for public posts, mentions, hashtags, and creator rules.
2. Experimental X Livechat Bridge for true livestream chat popouts.

X API mode calls the X API from the local Node server and forwards normalized messages to the frontend through Server-Sent Events. You can paste the bearer token into the Connect panel, where it is sent only to your local server and kept in memory, or you can store it in `.env`.

X does not currently expose a stable public livestream chat API like Twitch IRC. The livechat bridge works around that by reading the X chat popout page that you are already logged in to and sending visible messages to your local StreamHub server.

### X Livechat Bridge

Install the optional extension:

1. Open `chrome://extensions/` in Chrome, Edge, or Brave.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select the `x-livechat-bridge` folder from this repo.

Then use it:

1. Start StreamHub.
2. Open `http://127.0.0.1:3000`.
3. In the X card, click `Connect X Livechat Bridge`.
4. Open your X chat popout, usually:

```text
https://x.com/YOUR_HANDLE/chat
```

5. Keep the X chat tab open while streaming.

If you do not want to install the extension, use `Copy console fallback` in the X card, open the X chat popout, paste the script into DevTools Console, and press Enter.

The livechat bridge is experimental because it depends on X's current web page structure. If X changes the chat UI, the bridge may need an update.

After updating StreamHub, reload the unpacked extension from `chrome://extensions/` and refresh the X chat tab. The bridge dedupes by chat row, so repeated messages from the same user are allowed while duplicate scans of the same visible row are ignored.

## How YouTube Works

YouTube uses the official YouTube Live Chat API through the local StreamHub server.

Paste a YouTube live URL, video ID, or direct `liveChatId`, plus a YouTube API key or OAuth access token. StreamHub resolves the active live chat, then reads messages through `/youtube/stream`.

API keys are the easiest path for public live chats. OAuth tokens are useful when YouTube requires account permissions for a private, unlisted, or owned stream.

The YouTube adapter respects the `pollingIntervalMillis` value returned by YouTube, but also enforces a conservative minimum interval of 15 seconds by default. That means even if YouTube says to wait 5 seconds, StreamHub waits 15 seconds to protect quota for long sessions.

At 15 seconds, an 8-hour stream uses about 1,920 chat polls. That is intentionally close to the rough safe budget for a default 10,000-unit YouTube quota if chat polling costs around 5 units per request.

You can override the minimum interval with:

```env
YOUTUBE_MIN_POLL_INTERVAL_MS=15000
```

Viewer count comes from `liveStreamingDetails.concurrentViewers` when YouTube returns it.

## Collab Streams

StreamHub supports multiple stream slots for co-streams and collabs.

1. Click `+ Add Stream`.
2. Name the stream slot, for example `elchefdesol`, `cohost`, or `team red`.
3. Fill in that streamer's Twitch, X, YouTube, and Kick fields.
4. Connect the slot.

Messages in the hub are labeled with both the platform and the stream name:

```text
[Twitch] [elchefdesol] viewer123: let's go
[YouTube] [elchefdesol] fan22: hello from YT
[Kick] [cohost] fan88: chat is moving
```

The Activity panel breaks chat down by platform and by stream slot. Viewer counts are shown when StreamHub can fetch them:

- Twitch: uses the Twitch OAuth token to validate the token's Client-ID, then reads the live stream's `viewer_count`.
- YouTube: uses YouTube `liveStreamingDetails.concurrentViewers` when available.
- Kick: uses Kick channel metadata when Kick returns a live `viewer_count`.
- X: shows message activity, but viewer count is `--` because X does not expose a reliable public livechat viewer count through this bridge.

## Files

- `server.mjs`: local app server and platform relays
- `streamhub-contest.html`: frontend UI and OBS overlay
- `x-livechat-bridge/`: optional browser extension for experimental X livechat capture
- `.env.example`: config template

## Notes

Twitch can connect directly from the browser with a chat OAuth token. YouTube and Kick use local relay adapters. X uses either the official public posts API or the optional livechat bridge.
