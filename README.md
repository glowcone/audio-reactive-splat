# Audio-Reactive Splat Viewer

A browser-based viewer for flying through a 3D Gaussian Splat, reacting to live microphone audio, and exporting 360° equirectangular panoramas. Everything runs client-side from a single HTML file; there is no package install or build step for the viewer.

## Launch the viewer

### Requirements

- A current desktop browser with WebGL and ES module support
- Python 3 (only used to serve the files locally)
- An internet connection on first load, because the JavaScript libraries (including Meyda) are loaded from CDNs
- Optional: a microphone for the audio-reactive effects

From the repository root, start a local HTTP server:

```bash
python3 -m http.server 8777
```

Then open:

<http://localhost:8777/viewer/>

The PLY cannot be opened reliably through `file://`; the viewer fetches it over HTTP. If port `8777` is already in use, choose another port in both the command and URL.

Click **Click to enter** to lock the pointer and begin navigating. To enable the reactive visuals, click **Enable mic** and allow microphone access when prompted. Browsers treat `localhost` as a secure context, so microphone access works when launched as described above.

### Route Spotify into the viewer on macOS

The viewer can listen to Spotify through the [BlackHole](https://github.com/ExistentialAudio/BlackHole) virtual audio device. Install its two-channel driver with Homebrew:

```bash
brew install blackhole-2ch
```

To hear Spotify while also sending it to the viewer:

1. Open **Audio MIDI Setup** from `/Applications/Utilities/`.
2. Click the **+** button at the bottom-left and choose **Create Multi-Output Device**.
3. Check both **BlackHole 2ch** and the speakers or headphones you want to hear.
4. Select the speakers/headphones as the primary device and enable **Drift Correction** for BlackHole if Audio MIDI Setup offers it.
5. In macOS **Control Center → Sound → Output**, select the new **Multi-Output Device**.
6. Start playing a Spotify track or playlist. The Spotify desktop app follows the macOS system output.
7. Reload the viewer if it was already open. In its audio-input menu, select **BlackHole 2ch**, then click **Enable audio**.

The viewer input must be **BlackHole 2ch**, not the Multi-Output Device. The Multi-Output Device is the macOS playback destination; BlackHole is the capture source exposed to the browser.

For routing without speaker monitoring, choose **BlackHole 2ch** directly as the macOS sound output and still select **BlackHole 2ch** as the viewer input. You will not hear Spotify through your speakers in that configuration.

macOS may disable its normal output-volume control while a Multi-Output Device is active. Adjust volume in Spotify or on the physical speakers/headphones instead. Restore your usual sound output when you finish.

## Controls

| Input | Action |
| --- | --- |
| Mouse | Look around while the pointer is locked |
| `W` / `A` / `S` / `D` | Move forward, left, backward, and right |
| `E` or `Space` | Move up |
| `Q`, `C`, or `Ctrl` | Move down |
| `Shift` | Move at 4× the selected fly speed |
| `Esc` | Release the pointer |
| `P` | Capture a panorama at the current position |

The on-screen controls also provide:

- **Fly speed** — changes the base navigation speed.
- **Audio input** — selects a microphone, DJ mixer, or audio interface exposed by the operating system.
- **Enable audio** — starts worklet-based analysis. The HUD displays volume, spectral-flux onsets, spectral centroid classification, and chroma alongside low, mid, and high energy.
- **System audio** — opens the browser share dialog for a browser tab or screen with audio. For Spotify, use the Spotify Web Player and share that tab with **Share tab audio** enabled. Browser and operating-system support for capturing native application audio varies.
- **MIDI** — connects available DJ controllers through Web MIDI. Choose a deck, fader, or effect target, click **Map next CC**, and move the desired hardware control to learn it. Mapped values are normalized to 0–1.
- **Shader** — shows or hides controls for pulse, wave, shimmer, color, sparkle, animation, and audio processing. The panel's **reset** button restores its defaults.
- **Z-up → Y-up** — rotates the source PLY by −90° around X so Blender-style Z-up data appears upright in Three.js.
- **2K / 4K / 8K** — chooses the panorama output size.
- **Capture Panorama** — renders and downloads a PNG.
- **Reset view** — returns the camera to the origin and its initial direction.

## Panorama export

A capture renders six 90° cube faces from the camera's current position. Each face is rendered for several frames to allow Spark's asynchronous splat sorting to settle, then the browser reprojects the cube faces into a 2:1 equirectangular image.

The downloaded file is named from the camera coordinates and output width, for example:

```text
panorama_0.0_0.0_0.0_4096.png
```

Higher resolutions require more GPU and system memory and take longer to stitch. If an 8K capture fails or the tab becomes unresponsive, retry at 4K or 2K.

## How the viewer is built

The viewer is implemented in [`viewer/index.html`](viewer/index.html) with browser-native HTML, CSS, and JavaScript. It uses:

- [Three.js](https://threejs.org/) `0.180.0` for WebGL rendering, cameras, render targets, and math.
- [Three.js PointerLockControls](https://threejs.org/docs/#examples/en/controls/PointerLockControls) for mouse-look and first-person navigation.
- [Spark](https://sparkjs.dev/) `2.1.0` (`@sparkjsdev/spark`) to load, sort, render, and modify Gaussian splats.
- Spark's `dyno` graph to apply per-splat GPU animation: low frequencies expand the scene, mids create radial waves and fractal color, and highs add jitter and sparkle.
- The MIT-licensed [`fractalBreathing` effect from 3DGS Morphlab](https://github.com/VibrantNebula/3DGS_Morphlab/tree/work/v0.5.55-hackathon-handoff/src/splatEffects) provides the basis for the bounded fractal field and breathing/ripple displacement. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- [Meyda](https://meyda.js.org/) `5.6.3` for RMS volume, amplitude spectrum, spectral centroid, spectral flatness, and 12-bin chroma features.
- [Essentia.js](https://mtg.github.io/essentia.js/) `0.1.3`, TensorFlow.js, and the MSD MusiCNN model for slow music autotagging. A rolling audio window is classified every eight seconds and smoothed over successive results.
- The browser [Web Audio API](https://developer.mozilla.org/docs/Web/API/Web_Audio_API), `getUserMedia()`, and an `AudioWorkletNode` for microphone, mixer, or interface input. A custom adaptive spectral-flux detector identifies onsets, while low (20–250 Hz), mid (250–2,000 Hz), and high (2,000–8,000 Hz) bands continue to drive the shader.
- The browser [Web MIDI API](https://developer.mozilla.org/docs/Web/API/Web_MIDI_API) for DJ-controller input. Controller-change messages are normalized to 0–1 and exposed through a device-independent mapping event.
- Canvas, WebGL render targets, and browser download APIs for client-side panorama stitching and PNG export.

The libraries are pinned in the import map near the top of `viewer/index.html` and loaded from jsDelivr and `sparkjs.dev`. No npm dependencies are installed locally.

### Audio-to-effect mapping

- **RMS volume** is the master for all splat displacement and scale animation. Silence returns positional effects to their original scene layout.
- **Mood** selects a stabilized base tint for the Morphlab-style fractal breathing field.
- **Genre** selects a pre-generated three-color palette: low glow, mid/fractal, and sparkle.
- **Chroma** gates those genre colors so they appear only when matching pitch-class energy crosses the **Chroma color gate** threshold. C/D/E trigger low glow, F/G/A trigger mid/fractal color, and accidentals plus B trigger sparkle color.
- **Bass, mids, and treble** still shape the character of the volume-mastered motion and determine the strength of low glow, fractal color, and sparkle respectively.

## Repository layout

```text
.
├── gaussian/
│   └── point_cloud_1.ply   # 3D Gaussian Splat loaded by the viewer
├── viewer/
│   ├── index.html          # viewer UI, renderer, and analysis bindings
│   ├── audio-analysis.js   # Meyda features, onset detection, input and MIDI mapping
│   ├── audio-worklet.js    # off-main-thread overlapping audio frame capture
│   ├── genre-worker.js     # slow Essentia/MusiCNN inference worker
│   └── models/             # local TensorFlow.js MusiCNN model (~3.2 MB)
└── tools/
    └── splat_to_mesh.py    # optional, lossy splat-to-mesh conversion
```

To display a different splat, place its PLY file in the repository and update `SPLAT_URL` in `viewer/index.html`. Keep the path relative to the viewer file so it continues to work through the local server.

## Optional: convert the splat to a mesh

A Gaussian Splat is a collection of oriented, colored ellipsoids rather than a triangle mesh. The included conversion tool reconstructs a surface from the splat centers, so the result is necessarily an approximation.

Install its separate Python dependencies and run:

```bash
python3 -m pip install open3d numpy plyfile
python3 tools/splat_to_mesh.py gaussian/point_cloud_1.ply \
  -o out/mesh --method poisson --depth 10 --min-opacity 0.1
```

This writes `out/mesh.obj` and `out/mesh.glb` with vertex colors. Useful options include:

- `--depth 11` or `--depth 12` for more Poisson detail at a higher compute and memory cost.
- `--method bpa` for a non-watertight Ball-Pivoting result that may follow the points more closely.
- `--min-opacity` to discard faint splats and floaters before reconstruction.
- `--up keep` to preserve the PLY's original Z-up coordinates instead of converting them to Y-up.

Open3D does not export FBX. With Blender installed, print a ready-to-run GLB-to-FBX command using:

```bash
python3 tools/splat_to_mesh.py gaussian/point_cloud_1.ply \
  -o out/mesh --print-fbx-cmd
```

## Troubleshooting

- **Blank page or missing splat:** confirm the server was started from the repository root, not from `viewer/`, and check that `gaussian/point_cloud_1.ply` exists.
- **Libraries fail to load:** verify internet access and inspect the browser console for blocked requests to jsDelivr or `sparkjs.dev`.
- **Microphone is blocked:** reload the page, check the browser's site permissions for `localhost`, and enable microphone access.
- **Mixer/interface is missing:** connect it before loading the page, then choose it from the audio-input menu. Reload if the operating system does not announce the device change.
- **BlackHole is missing from the viewer:** confirm **BlackHole 2ch** appears in Audio MIDI Setup, grant microphone permission to the browser, and reload the viewer. Restart the browser after a new driver installation.
- **Spotify is playing but the meters do not move:** macOS output should be the configured Multi-Output Device (or BlackHole directly), while the viewer's input must specifically be **BlackHole 2ch**.
- **System audio is silent:** share a browser tab instead of an entire screen and explicitly enable the browser's audio-sharing checkbox. Native Spotify/system capture is not exposed on every browser/OS combination.
- **Genre remains “listening”:** the first result needs several seconds of continuous music. Check the console for blocked TensorFlow.js or Essentia.js CDN requests.
- **MIDI is unavailable:** Web MIDI support varies by browser. Use a current Chromium-based browser and grant MIDI access when prompted.
- **Scene is sideways or upside down:** toggle **Z-up → Y-up**.
- **Movement does not respond:** click the 3D scene to lock the pointer again.
