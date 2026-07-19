# rekordbox → viewer bridge

Listens to PRO DJ LINK traffic from rekordbox (Performance mode) and pushes
now-playing track metadata — including **genre**, which the viewer maps to a
splat world — to the viewer over WebSocket.

## Important: runs on a SECOND machine

rekordbox binds the Link UDP ports (50000–50002) itself, so this bridge cannot
run on the laptop running rekordbox. Use any second laptop / Raspberry Pi on
the same network. Wired Ethernet between the two machines (direct cable is
fine) is the most reliable; same Wi-Fi network usually works too.

## Setup (on the second machine)

1. Install Node.js 20+ (https://nodejs.org)
2. Copy this `bridge/` folder over
3. ```sh
   npm install
   npm start
   ```
4. Allow incoming connections when the OS firewall prompts (needs UDP
   50000–50002 for Link and TCP 8765 for the WebSocket).

On startup it prints the viewer URL parameter to use, e.g.:

```
  → open the viewer with ?ws=ws://192.168.1.42:8765
```

Open the viewer on the main laptop with that query param:
`http://localhost:8000/viewer/index.html?ws=ws://192.168.1.42:8765`
(without the param the viewer defaults to `ws://localhost:8765`).

## rekordbox side

- Performance mode, controller plugged in as usual — nothing to install.
- Every track you'll play needs its **Genre** field set in rekordbox; that's
  the key the viewer uses to pick a world (matched case-insensitively).
- The "now playing" event fires when the incoming deck becomes dominant
  (master / on-air heuristics), which is exactly when the world crossfade
  should start.

## Testing without decks

Run the bridge, then from another shell you can fake a track change by
connecting to the WebSocket and… actually the simplest smoke test is a tiny
one-liner served to the viewer:

```sh
node -e '
import("ws").then(({ WebSocketServer }) => {
  const wss = new WebSocketServer({ port: 8765 });
  wss.on("connection", ws => ws.send(JSON.stringify({
    type: "nowPlaying", title: "Test Track", artist: "Tester", genre: "techno"
  })));
  console.log("fake bridge on 8765 — sends a techno track to each viewer");
});'
```

Run that (in this folder, so `ws` resolves) on the *same* machine as the
viewer with no `?ws=` param, and the viewer should crossfade to the world
mapped to `techno`.
