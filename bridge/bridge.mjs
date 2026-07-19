// PRO DJ LINK → WebSocket bridge.
//
// Runs on a machine on the same LAN as rekordbox — NOT the same machine:
// rekordbox occupies the Link UDP ports (50000-50002), so this process must
// live elsewhere (second laptop, Raspberry Pi, …).
//
// Whenever the mixstatus processor decides a new track is on air, this
// broadcasts { type, deck, title, artist, genre } to all connected viewers.

import os from "node:os";
import { bringOnline } from "prolink-connect";
import { WebSocketServer } from "ws";

const PORT = 8765;

const wss = new WebSocketServer({ port: PORT });
let lastMessage = null; // replayed to viewers that connect mid-set

wss.on("connection", (ws, req) => {
  console.log(`viewer connected: ${req.socket.remoteAddress}`);
  if (lastMessage) ws.send(JSON.stringify(lastMessage));
});

function broadcast(msg) {
  lastMessage = msg;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

const lanAddresses = Object.values(os.networkInterfaces())
  .flat()
  .filter(i => i && i.family === "IPv4" && !i.internal)
  .map(i => i.address);

console.log(`WebSocket server listening on port ${PORT}`);
for (const addr of lanAddresses) {
  console.log(`  → open the viewer with ?ws=ws://${addr}:${PORT}`);
}

console.log("Bringing PRO DJ LINK network online…");
const network = await bringOnline();

network.deviceManager.on("connected", device =>
  console.log(`Link device found: ${device.name} [id ${device.id}]`)
);

// rekordbox can sit silent until another Link device announces itself, while
// autoconfigFromPeers waits for rekordbox to announce first — chicken and egg.
// So: wait briefly for a peer, then fall back to configuring manually and
// announcing ourselves as a virtual CDJ, which wakes rekordbox up.
const AUTOCONFIG_TIMEOUT_MS = 8000;
console.log("Waiting for a Link device (start rekordbox in Performance mode)…");
try {
  await Promise.race([
    network.autoconfigFromPeers(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("autoconfig timeout")), AUTOCONFIG_TIMEOUT_MS)
    ),
  ]);
} catch {
  const ifaces = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === "IPv4" && !i.internal)
    // prefer a private-LAN address over oddities like the 192.0.0.2 CLAT iface
    .sort((a, b) => /^(192\.168|10|172)\./.test(b.address) - /^(192\.168|10|172)\./.test(a.address));
  const iface = ifaces[0];
  if (!iface) {
    console.error("No usable IPv4 network interface found");
    process.exit(1);
  }
  console.log(`No device announced itself — announcing as virtual CDJ on ${iface.address} to wake rekordbox up…`);
  network.configure({ vcdjId: 5, iface });
}
await network.connect();

if (!network.isConnected()) {
  console.error("Failed to connect to the Link network");
  process.exit(1);
}
console.log("Connected. Watching for track changes…");

network.mixstatus.on("nowPlaying", async state => {
  const { trackDeviceId, trackSlot, trackType, trackId } = state;
  let track = null;
  try {
    track = await network.db.getMetadata({
      deviceId: trackDeviceId,
      trackSlot,
      trackType,
      trackId,
    });
  } catch (err) {
    console.error("metadata lookup failed:", err?.message ?? err);
  }
  const msg = {
    type: "nowPlaying",
    deck: state.deviceId,
    title: track?.title ?? null,
    artist: track?.artist?.name ?? null,
    genre: track?.genre?.name ?? null,
  };
  console.log(`now playing: ${msg.title ?? `track #${trackId}`} — genre: ${msg.genre ?? "?"}`);
  broadcast(msg);
});

network.mixstatus.on("stopped", ({ deviceId }) => console.log(`deck ${deviceId} stopped`));
network.mixstatus.on("setEnded", () => console.log("set ended"));
