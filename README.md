# Chess Leak

Chess Leak turns mistakes from your own Chess.com games into a focused personal puzzle library. It runs Stockfish on the device, requires no Chess.com login, and keeps analysis and practice progress in local browser/app storage.

## Try or install it

- **Use the web app:** [jaredjlg2.github.io/Chess-Leak](https://jaredjlg2.github.io/Chess-Leak/)
- **Download Android:** [Chess-Leak.apk](https://github.com/jaredjlg2/Chess-Leak/releases/latest/download/Chess-Leak.apk)
- **See all releases:** [GitHub Releases](https://github.com/jaredjlg2/Chess-Leak/releases)

On Android, the browser may ask you to allow installation from this source. Download the APK, open it, and approve that one-time permission if prompted. Android 8.0 or newer is required.

## What it does

- Imports selected Daily and Rapid games through the public Chess.com API.
- Finds recurring costly positions with Stockfish 18.
- Builds a permanent, deduplicated personal puzzle bank.
- Creates a small **Today** queue from new and due positions.
- Provides progressive hints without immediately revealing the answer.
- Lets you play engine continuations and retry only the last incorrect branch move.
- Recognizes checkmate and other completed positions without requesting an invalid engine reply.
- Saves chosen positions to a dedicated **Review** bank.
- Supports **Got it, next** for ideas you feel comfortable retiring.
- Tracks distinct daily and weekly completions, a practice-day streak, and meaningful goal milestones without farmable points.

## Privacy

No Chess.com password or account authorization is used. The app reads public game archives for the username you enter. Its curriculum, review history, and cached analysis remain in local storage on the device or browser where you use it.

## Build and install locally

Install JDK 17 or newer, Android SDK Platform 36 with platform tools, and Node.js/npm. Set `JAVA_HOME` and `ANDROID_HOME`, enable USB debugging, connect an Android phone, and run:

```text
build-and-install.cmd
```

The script builds the web bundle, assembles the debug APK, installs it on an authorized device, and opens the app. The generated APK is located at:

```text
app\build\outputs\apk\debug\app-debug.apk
```

To build only the web app:

```text
cd web
npm ci
npm run build
```

## Project structure

- `web/src/main.js` — game import, analysis, puzzle state, review scheduling, and persistence.
- `web/src/styles.css` — responsive, accessibility-focused interface.
- `app/src/main/java/.../MainActivity.java` — local Android WebView host.
- `.github/workflows/deploy-pages.yml` — automatic GitHub Pages deployment from `main`.

Stockfish and its JavaScript/WebAssembly distribution are GPL-licensed. Retain their license and source notices when redistributing the APK.
