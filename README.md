# Chess Leak for Android

Chess Leak is a small native Android shell around an offline-first coaching UI.
It uses the public Chess.com API for game history, `chess.js` for legal moves,
and Stockfish 18 WebAssembly for analysis. No account login is required and the
report stays on the device.

## What it analyzes

- A selectable Chess.com game profile from the main screen:
  - Daily
  - 10-minute rapid
  - Other rapid
  - Blitz
  - Bullet
- Daily + 10-minute rapid is the default profile, so fast 1/3-minute noise is
  excluded unless you explicitly turn those buckets on.
- Up to the newest 80 rated standard games matching the selected profile and
  lasting at least eight full moves.
- The app looks back up to 12 monthly archives normally, or up to 24 when Daily
  is selected, because daily games are naturally sparse.
- Up to the first 36 user moves in each game, which concentrates the mobile
  analysis budget where recurring practical errors are most actionable.
- Weakness ranking is recency- and persistence-weighted. Older games can supply
  evidence, but old-only patterns are suppressed. Themes that appeared
  historically and still appear in the last 90 days receive the strongest
  urgency boost.

The report ranks recurring costly patterns, creates a two-week practice loop,
and builds two personal position decks:

- **Opportunity**: stricter puzzle-like positions where there was something
  concrete or valuable to win/preserve.
- **Blunder repair**: positions focused on the move actually played in the game
  and why it failed.

Puzzle mode shows one position at a time. Positions are deduplicated and kept in
a permanent per-player, per-game-profile bank; the old 48-position deck limit is
gone. **Today** mixes due reviews with unseen personal positions, while **All
personal**, **Opportunity**, and **Blunder repair** provide browsable views of
the full bank. The app records first-try accuracy, solve time, hints, answer
reveals, and retries, then schedules each position through learning, due, and
mastered states. **Find more from my games** analyzes the next unseen batch of
eligible games and merges the new positions without replacing earlier work.

## Use the installed app

Open **Chess Leak**, enter a Chess.com username, choose the game types you want
included, and tap **Analyze**. The initial scan can take a few minutes depending
on the phone, archive count, and game count. A completed report is cached for
seven days per username + selected game profile. **Change player** returns to the
username and game-type picker.

In a position:

1. Tap a piece and then a destination.
2. Any legal move is accepted, including a wrong one.
3. Use **My game move** to reveal and highlight what was played in the real game.
4. Use **Show answer** to play the target move and get a short explanation of
   why it works.
5. The app confirms the starting position at a stronger depth, counts an
   engine-equivalent alternative as correct, then reveals the evaluation and
   explains the approximate cost of other branches.
6. Use **← Back move** to undo one move inside the current puzzle.
7. After a move is made, use **→ Best move** to have Stockfish play the best move
   for the side to move from the latest position.
8. Continue moving for either side, or tap **Retry**.

The board uses classic high-contrast chess glyphs on a green/cream board, with
fixed 8x8 row/column sizing so empty ranks never collapse.

## Build and install

Install JDK 17 or newer, the Android SDK with platform tools, and Node.js/npm.
Set `JAVA_HOME` and `ANDROID_HOME`, enable USB debugging on the phone, connect
it, then run:

```text
build-and-install.cmd
```

The script builds the web bundle, assembles a debug APK, installs it on the
connected phone, and launches it. The APK is written to:

```text
app\build\outputs\apk\debug\app-debug.apk
```

The project can also be opened in Android Studio, which can supply the JDK and
Android SDK. It targets Android 16 (API 36), supports Android 8.0 and newer, and
uses Gradle's checked-in wrapper.

## Architecture

- `web/src/main.js` — Chess.com import, Stockfish analysis, ranking, plan, and
  interactive positions.
- `web/src/styles.css` — phone-first interface.
- `app/src/main/java/.../MainActivity.java` — hardened local WebView host.
- `app/src/main/assets/` — generated web bundle and Stockfish WASM.

Stockfish and stockfish.js are GPL-licensed; retain their license/source notices
when redistributing the APK.
