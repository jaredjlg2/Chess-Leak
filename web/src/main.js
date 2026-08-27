import { Chess } from "chess.js";
import "./styles.css";

const API = "https://api.chess.com/pub";
const ANALYSIS_VERSION = 7;
const CURRICULUM_SCHEMA_VERSION = 1;
const MAX_GAMES = 80;
const MAX_USER_MOVES = 36;
const MIN_PLIES = 16;
const DEFAULT_ARCHIVE_MONTHS = 12;
const DAILY_ARCHIVE_MONTHS = 24;
const CURRENT_WINDOW_DAYS = 90;
const RECENCY_HALF_LIFE_DAYS = 90;
const ENGINE_NODES = 900;
const PUZZLE_NODES = 4200;
const ALTERNATIVE_TOLERANCE_CP = 50;
const TODAY_QUEUE_SIZE = 12;
const TODAY_DUE_TARGET = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const CURRICULUM_DB_NAME = "chess-leak-curriculum";
const CURRICULUM_STORE = "curricula";
const DEFAULT_FILTER_IDS = ["daily", "rapid10"];
const GAME_FILTERS = [
  {
    id: "daily",
    label: "Daily",
    shortLabel: "daily",
    description: "slow correspondence games",
  },
  {
    id: "rapid10",
    label: "10-minute rapid",
    shortLabel: "10-minute rapid",
    description: "10-minute-base rapid games",
  },
  {
    id: "rapidOther",
    label: "Other rapid",
    shortLabel: "other rapid",
    description: "rapid games outside the 10-minute bucket",
  },
  {
    id: "blitz",
    label: "Blitz",
    shortLabel: "blitz",
    description: "fast games with more time-pressure noise",
  },
  {
    id: "bullet",
    label: "Bullet",
    shortLabel: "bullet",
    description: "very fast games with the most speed noise",
  },
];
const PIECES = {
  w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" },
  b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" },
};

const $ = (selector, root = document) => root.querySelector(selector);
const views = ["#onboarding", "#working", "#report", "#error-view"];
let cancelled = false;
let enginePromise = null;
let currentUsername = "";
let currentReport = null;
let currentCurriculum = null;
let activeDeck = "today";
let activePuzzleIndex = 0;
let todayQueueIds = [];
let curriculumSaveChain = Promise.resolve();
let analysisMessage = "";

function showView(selector) {
  views.forEach((view) => { $(view).hidden = view !== selector; });
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    selector === "#report" ? "#f2f3ed" : "#12201c"
  );
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setProgress(percent, title, detail) {
  $("#progress-fill").style.width = `${Math.max(2, Math.min(100, percent))}%`;
  $(".progress")?.setAttribute("aria-valuenow", String(Math.round(percent)));
  $("#working-title").textContent = title;
  $("#progress-text").textContent = detail;
}

function showError(title, message) {
  $("#error-title").textContent = title;
  $("#error-message").textContent = message;
  showView("#error-view");
}

class StockfishEngine {
  constructor() {
    this.worker = new Worker("./engine/stockfish-18-lite-single.js");
    this.current = null;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.worker.onmessage = (event) => {
      String(event.data).split("\n").forEach((line) => this.onLine(line.trim()));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "Stockfish failed to start");
      this.readyReject?.(error);
      this.current?.reject(error);
      this.current = null;
    };
    this.worker.postMessage("uci");
  }

  onLine(line) {
    if (!line) return;
    if (line === "uciok") {
      this.worker.postMessage("isready");
      return;
    }
    if (line === "readyok") {
      this.readyResolve();
      return;
    }
    if (!this.current) return;
    if (line.startsWith("info ") && line.includes(" score ")) {
      const depth = Number(line.match(/\bdepth (\d+)/)?.[1] || 0);
      const cpMatch = line.match(/\bscore cp (-?\d+)/);
      const mateMatch = line.match(/\bscore mate (-?\d+)/);
      const pv = line.match(/\bpv (.+)$/)?.[1]?.split(/\s+/) || [];
      let sideCp = 0;
      let scoreText = "0.0";
      if (mateMatch) {
        const mate = Number(mateMatch[1]);
        sideCp = mate > 0 ? 1500 : -1500;
        scoreText = mate > 0 ? `M${mate}` : `-M${Math.abs(mate)}`;
      } else if (cpMatch) {
        sideCp = Number(cpMatch[1]);
        scoreText = `${sideCp >= 0 ? "+" : ""}${(sideCp / 100).toFixed(1)}`;
      }
      if (!this.current.latest || depth >= this.current.latest.depth) {
        this.current.latest = { depth, sideCp, scoreText, pv };
      }
      return;
    }
    if (line.startsWith("bestmove ")) {
      const bestUci = line.split(/\s+/)[1];
      const latest = this.current.latest || { depth: 0, sideCp: 0, scoreText: "0.0", pv: [] };
      const whiteCp = this.current.turn === "w" ? latest.sideCp : -latest.sideCp;
      let whiteText = latest.scoreText;
      if (this.current.turn === "b") {
        whiteText = whiteText.startsWith("-")
          ? whiteText.slice(1)
          : `-${whiteText}`;
      }
      const result = { ...latest, bestUci, whiteCp, whiteText };
      clearTimeout(this.current.timer);
      this.current.resolve(result);
      this.current = null;
    }
  }

  async analyze(fen, nodes) {
    await this.ready;
    if (this.current) throw new Error("Stockfish is already analyzing");
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.worker.postMessage("stop");
        if (this.current) {
          this.current.reject(new Error("Stockfish analysis timed out"));
          this.current = null;
        }
      }, 20000);
      this.current = {
        resolve,
        reject,
        latest: null,
        turn: fen.split(" ")[1],
        timer,
      };
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go nodes ${nodes}`);
    });
  }
}

function ensureEngine() {
  if (!enginePromise) {
    enginePromise = Promise.resolve(new StockfishEngine());
  }
  return enginePromise;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    if (response.status === 404) throw new Error("Chess.com username not found.");
    throw new Error(`Chess.com returned ${response.status}.`);
  }
  return response.json();
}

function normalizeFilterIds(ids) {
  const selected = new Set(ids || []);
  return GAME_FILTERS.map((filter) => filter.id).filter((id) => selected.has(id));
}

function selectedFilterIds() {
  return normalizeFilterIds(
    [...document.querySelectorAll('input[name="game-filter"]:checked')]
      .map((input) => input.value)
  );
}

function setSelectedFilterIds(ids) {
  const selected = new Set(normalizeFilterIds(ids));
  document.querySelectorAll('input[name="game-filter"]').forEach((input) => {
    input.checked = selected.has(input.value);
  });
  updateGameFilterSummary();
}

function filterLabel(filterId, mode = "shortLabel") {
  return GAME_FILTERS.find((filter) => filter.id === filterId)?.[mode] || filterId;
}

function filterSummary(filterIds) {
  const labels = normalizeFilterIds(filterIds).map((id) => filterLabel(id));
  if (!labels.length) return "selected games";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function updateGameFilterSummary() {
  const summary = $("#filter-summary");
  if (!summary) return;
  const selected = selectedFilterIds();
  summary.textContent = selected.length
    ? `${filterSummary(selected)} selected`
    : "Choose at least one";
}

function parseClock(timeControl) {
  const match = String(timeControl || "").match(/^(\d+)(?:\+(\d+))?$/);
  if (!match) return null;
  return {
    baseSeconds: Number(match[1]),
    incrementSeconds: Number(match[2] || 0),
  };
}

function clockLabel(game) {
  if (game.time_class === "daily") return "daily";
  const clock = parseClock(game.time_control);
  if (!clock) return game.time_class || "unknown";
  const base = clock.baseSeconds >= 60 && clock.baseSeconds % 60 === 0
    ? `${clock.baseSeconds / 60}`
    : `${clock.baseSeconds}s`;
  const increment = clock.incrementSeconds ? `+${clock.incrementSeconds}` : "";
  return `${base}${increment} ${game.time_class || ""}`.trim();
}

function parseGameEndMs(raw, headers = {}) {
  if (raw.end_time) return raw.end_time * 1000;
  const date = headers.UTCDate || headers.Date;
  if (!date) return null;
  const time = headers.UTCTime || "00:00:00";
  const parsed = Date.parse(`${date}T${time}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageDays(endMs, nowMs = Date.now()) {
  if (!endMs) return null;
  return Math.max(0, Math.floor((nowMs - endMs) / (24 * 60 * 60 * 1000)));
}

function recencyWeight(days) {
  if (days === null || days === undefined || !Number.isFinite(days)) return 0.55;
  return Math.max(0.18, Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS));
}

function recencyBucket(days) {
  if (days === null || days === undefined || !Number.isFinite(days)) return "unknown date";
  if (days <= 30) return "last 30 days";
  if (days <= CURRENT_WINDOW_DAYS) return "31-90 days";
  if (days <= 180) return "3-6 months";
  if (days <= 365) return "6-12 months";
  return "12+ months";
}

function ageLabel(days) {
  if (days === null || days === undefined || !Number.isFinite(days)) return "unknown date";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function cpForSide(whiteCp, color) {
  return color === "w" ? whiteCp : -whiteCp;
}

function cpText(cp) {
  if (!Number.isFinite(cp)) return "unknown";
  if (Math.abs(cp) < 15) return "roughly equal";
  return `${cp > 0 ? "+" : ""}${(cp / 100).toFixed(1)}`;
}

function pieceName(piece) {
  return ({
    p: "pawn",
    n: "knight",
    b: "bishop",
    r: "rook",
    q: "queen",
    k: "king",
  })[piece] || "piece";
}

function moveUci(move) {
  return move ? `${move.from}${move.to}${move.promotion || ""}` : "";
}

function isForcingMove(move) {
  return Boolean(move?.captured || move?.san?.includes("+") || move?.san?.includes("#"));
}

function matchesFilter(game, filterId) {
  const clock = parseClock(game.time_control);
  if (filterId === "daily") return game.time_class === "daily";
  if (filterId === "rapid10") return game.time_class === "rapid" && clock?.baseSeconds === 600;
  if (filterId === "rapidOther") return game.time_class === "rapid" && clock?.baseSeconds !== 600;
  if (filterId === "blitz") return game.time_class === "blitz";
  if (filterId === "bullet") return game.time_class === "bullet";
  return false;
}

function matchesSelectedFilters(game, filterIds) {
  return normalizeFilterIds(filterIds).some((filterId) => matchesFilter(game, filterId));
}

function cacheKey(username, filterIds) {
  return `report:${ANALYSIS_VERSION}:${username}:${normalizeFilterIds(filterIds).join(",")}`;
}

function curriculumKey(username, filterIds) {
  return `${String(username || "").toLowerCase()}:${normalizeFilterIds(filterIds).join(",")}`;
}

function normalizedFen(fen) {
  return String(fen || "").split(" ").slice(0, 4).join(" ");
}

function hashText(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function puzzleId(puzzle) {
  return `position-${hashText(normalizedFen(puzzle?.fen))}`;
}

function createCurriculum(username, filterIds) {
  const normalizedFilters = normalizeFilterIds(filterIds);
  return {
    key: curriculumKey(username, normalizedFilters),
    schemaVersion: CURRICULUM_SCHEMA_VERSION,
    username: String(username || "").toLowerCase(),
    filterIds: normalizedFilters,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    positions: [],
    games: [],
    analyzedGameUrls: [],
    attempts: {},
    reportSummary: null,
  };
}

function normalizeCurriculum(value, username, filterIds) {
  const curriculum = value && typeof value === "object"
    ? value
    : createCurriculum(username, filterIds);
  curriculum.key = curriculumKey(username, filterIds);
  curriculum.schemaVersion = CURRICULUM_SCHEMA_VERSION;
  curriculum.username = String(username || curriculum.username || "").toLowerCase();
  curriculum.filterIds = normalizeFilterIds(filterIds || curriculum.filterIds);
  curriculum.positions = Array.isArray(curriculum.positions) ? curriculum.positions : [];
  curriculum.games = Array.isArray(curriculum.games) ? curriculum.games : [];
  curriculum.analyzedGameUrls = Array.isArray(curriculum.analyzedGameUrls)
    ? curriculum.analyzedGameUrls
    : curriculum.games.map((game) => game.url).filter(Boolean);
  curriculum.attempts = curriculum.attempts && typeof curriculum.attempts === "object"
    ? curriculum.attempts
    : {};
  return curriculum;
}

let curriculumDbPromise = null;

function openCurriculumDb() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));
  if (curriculumDbPromise) return curriculumDbPromise;
  curriculumDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CURRICULUM_DB_NAME, CURRICULUM_SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CURRICULUM_STORE)) {
        db.createObjectStore(CURRICULUM_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open curriculum storage"));
  });
  return curriculumDbPromise;
}

async function loadCurriculum(username, filterIds) {
  const key = curriculumKey(username, filterIds);
  try {
    const db = await openCurriculumDb();
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction(CURRICULUM_STORE, "readonly")
        .objectStore(CURRICULUM_STORE)
        .get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    return normalizeCurriculum(value, username, filterIds);
  } catch {
    try {
      const value = JSON.parse(localStorage.getItem(`curriculum:${key}`) || "null");
      return normalizeCurriculum(value, username, filterIds);
    } catch {
      return createCurriculum(username, filterIds);
    }
  }
}

async function persistCurriculum(curriculum) {
  curriculum.updatedAt = Date.now();
  try {
    const db = await openCurriculumDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(CURRICULUM_STORE, "readwrite");
      transaction.objectStore(CURRICULUM_STORE).put(curriculum);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    try {
      localStorage.setItem(`curriculum:${curriculum.key}`, JSON.stringify(curriculum));
    } catch {
      // The in-memory curriculum remains usable for this session.
    }
  }
}

function queueCurriculumSave() {
  if (!currentCurriculum) return;
  const snapshot = typeof structuredClone === "function"
    ? structuredClone(currentCurriculum)
    : JSON.parse(JSON.stringify(currentCurriculum));
  curriculumSaveChain = curriculumSaveChain
    .catch(() => {})
    .then(() => persistCurriculum(snapshot));
}

function puzzleProgressKey(report = currentReport) {
  if (!report) return "";
  return `puzzleProgress:${report.username}:${normalizeFilterIds(report.filterIds).join(",")}`;
}

function loadPuzzleProgress(report = currentReport) {
  try {
    const value = localStorage.getItem(puzzleProgressKey(report));
    if (!value) return { deck: "", indexes: {} };
    const parsed = JSON.parse(value);
    return {
      deck: parsed.deck || "",
      indexes: parsed.indexes && typeof parsed.indexes === "object" ? parsed.indexes : {},
    };
  } catch {
    return { deck: "", indexes: {} };
  }
}

function savePuzzleProgress() {
  if (!currentReport) return;
  try {
    const progress = loadPuzzleProgress(currentReport);
    progress.deck = activeDeck;
    progress.indexes = progress.indexes || {};
    progress.indexes[activeDeck] = activePuzzleIndex;
    localStorage.setItem(puzzleProgressKey(currentReport), JSON.stringify(progress));
  } catch {
    // Puzzle progress is helpful but non-essential.
  }
}

function clampIndex(index, length) {
  return Math.max(0, Math.min(Math.max(0, length - 1), Number(index) || 0));
}

function parseGame(raw, username) {
  try {
    const chess = new Chess();
    chess.loadPgn(raw.pgn);
    const headers = chess.getHeaders();
    const history = chess.history({ verbose: true });
    const white = String(headers.White || raw.white?.username || "").toLowerCase();
    const black = String(headers.Black || raw.black?.username || "").toLowerCase();
    if (username !== white && username !== black) return null;
    if (history.length < MIN_PLIES) return null;
    const endMs = parseGameEndMs(raw, headers);
    return {
      url: raw.url || headers.Link || "",
      timeClass: raw.time_class,
      timeControl: raw.time_control || headers.TimeControl || "",
      timeLabel: clockLabel(raw),
      date: headers.UTCDate || headers.Date || "",
      endMs,
      headers,
      history,
      color: username === white ? "w" : "b",
      result: headers.Result || "*",
    };
  } catch {
    return null;
  }
}

async function loadRecentGames(username, filterIds, excludeGameUrls = []) {
  const selected = normalizeFilterIds(filterIds);
  if (!selected.length) {
    throw new Error("Choose at least one game type to analyze.");
  }
  const archiveLimit = selected.includes("daily") ? DAILY_ARCHIVE_MONTHS : DEFAULT_ARCHIVE_MONTHS;
  setProgress(5, "Fetching selected game archives…", `Looking up ${username} • ${filterSummary(selected)}`);
  const archives = await fetchJson(`${API}/player/${encodeURIComponent(username)}/games/archives`);
  const urls = (archives.archives || []).slice(-archiveLimit);
  if (!urls.length) throw new Error("No public Chess.com games were found.");

  const rawGames = [];
  for (let index = 0; index < urls.length; index += 1) {
    if (cancelled) throw new Error("Cancelled");
    setProgress(8 + (index / urls.length) * 14, "Fetching recent games…", `Monthly archive ${index + 1} of ${urls.length}`);
    const month = await fetchJson(urls[index]);
    rawGames.push(...(month.games || []));
  }

  rawGames.sort((a, b) => (b.end_time || 0) - (a.end_time || 0));
  const meaningful = rawGames
    .filter((game) =>
      game.rules === "chess" &&
      game.rated !== false &&
      matchesSelectedFilters(game, selected) &&
      game.pgn
    )
    .map((game) => parseGame(game, username))
    .filter(Boolean);

  if (!meaningful.length) {
    throw new Error(`No rated ${filterSummary(selected)} games longer than eight moves were found in the last ${urls.length} monthly archives. Try adding another game type.`);
  }
  const analyzed = new Set(excludeGameUrls || []);
  const unseen = meaningful.filter((game) => !game.url || !analyzed.has(game.url));
  return {
    games: unseen.slice(0, MAX_GAMES),
    fetched: rawGames.length,
    eligible: meaningful.length,
    unseen: unseen.length,
    remainingEligibleGames: Math.max(0, unseen.length - MAX_GAMES),
    archiveMonths: urls.length,
    filterIds: selected,
    filterLabels: selected.map((id) => filterLabel(id, "label")),
    filterSummary: filterSummary(selected),
  };
}

function uciMove(chess, uci) {
  if (!uci || uci === "(none)" || uci.length < 4) return null;
  try {
    return chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] || "q",
    });
  } catch {
    return null;
  }
}

function phaseFor(fen, ply) {
  if (ply < 20) return "opening";
  const pieces = fen.split(" ")[0].replace(/[1-8/]/g, "");
  const queens = (pieces.match(/[qQ]/g) || []).length;
  const nonPawns = (pieces.match(/[nbrqNBRQ]/g) || []).length;
  if (!queens || nonPawns <= 5) return "endgame";
  return "middlegame";
}

function classifyMistake(beforeFen, afterFen, bestUci, replyUci, phase) {
  const before = new Chess(beforeFen);
  const best = uciMove(before, bestUci);
  if (best?.captured) return best.captured === "p" ? "Missed capture" : "Missed material win";
  if (best?.san?.includes("+")) return "Missed forcing check";

  const after = new Chess(afterFen);
  const reply = after.moves({ verbose: true }).find((move) => move.lan === replyUci || `${move.from}${move.to}${move.promotion || ""}` === replyUci);
  if (reply?.captured === "q") return "Hung queen";
  if (reply?.captured) return "Move safety / hanging pieces";
  if (reply?.san?.includes("+")) return "Allowed forcing attack";
  if (phase === "opening") return "Opening discipline";
  if (phase === "endgame") return "Endgame technique";
  return "Calculation / move safety";
}

function resultFor(game) {
  if (game.result === "1/2-1/2") return "draw";
  if ((game.result === "1-0" && game.color === "w") || (game.result === "0-1" && game.color === "b")) return "win";
  return "loss";
}

async function analyzeGames(username, loaded) {
  const engine = await ensureEngine();
  const games = loaded.games;
  const totalMoves = games.reduce(
    (sum, game) => sum + Math.min(MAX_USER_MOVES, game.history.filter((move) => move.color === game.color).length),
    0
  );
  let completed = 0;
  let totalLoss = 0;
  let measuredMoves = 0;
  const mistakes = [];
  const gameSummaries = [];

  for (let gameIndex = 0; gameIndex < games.length; gameIndex += 1) {
    if (cancelled) throw new Error("Cancelled");
    const game = games[gameIndex];
    const gameAgeDays = ageDays(game.endMs);
    const gameRecencyWeight = recencyWeight(gameAgeDays);
    const gameRecencyBucket = recencyBucket(gameAgeDays);
    const userMoves = game.history.filter((move) => move.color === game.color).slice(0, MAX_USER_MOVES);
    let gameLoss = 0;
    let gameMistakes = 0;
    let gameMeasuredMoves = 0;

    for (const move of userMoves) {
      if (cancelled) throw new Error("Cancelled");
      const percent = 24 + (completed / Math.max(1, totalMoves)) * 68;
      setProgress(
        percent,
        "Stockfish is finding your recurring leaks…",
        `Game ${gameIndex + 1}/${games.length} · move ${move.moveNumber || Math.floor(move.before.split(" ")[5])}`
      );
      completed += 1;

      const beforeInfo = await engine.analyze(move.before, ENGINE_NODES);
      const beforeUser = cpForSide(beforeInfo.whiteCp, game.color);
      if (beforeUser <= -600) continue;
      const afterInfo = await engine.analyze(move.after, ENGINE_NODES);
      const afterUser = cpForSide(afterInfo.whiteCp, game.color);
      const loss = Math.max(0, Math.min(1500, beforeUser - afterUser));
      totalLoss += loss;
      gameLoss += loss;
      measuredMoves += 1;
      gameMeasuredMoves += 1;
      if (loss < 80) continue;

      const bestBoard = new Chess(move.before);
      const bestMove = uciMove(bestBoard, beforeInfo.bestUci);
      const phase = phaseFor(move.before, move.ply || completed);
      const theme = classifyMistake(move.before, move.after, beforeInfo.bestUci, afterInfo.bestUci, phase);
      const forcingTarget = isForcingMove(bestMove);
      mistakes.push({
        fen: move.before,
        afterFen: move.after,
        playedUci: move.lan || moveUci(move),
        playedSan: move.san,
        bestUci: beforeInfo.bestUci,
        bestSan: bestMove?.san || beforeInfo.bestUci,
        bestMoveFlags: bestMove?.flags || "",
        bestMoveCaptured: bestMove?.captured || "",
        bestMoveIsCheck: Boolean(bestMove?.san?.includes("+") || bestMove?.san?.includes("#")),
        forcingTarget,
        beforeUserCp: Math.round(beforeUser),
        afterUserCp: Math.round(afterUser),
        lossCp: Math.round(loss),
        evalBeforeWhite: beforeInfo.whiteCp,
        evalAfterWhite: afterInfo.whiteCp,
        phase,
        theme,
        color: game.color,
        gameUrl: game.url,
        date: game.date,
        gameEndMs: game.endMs,
        ageDays: gameAgeDays,
        recencyWeight: gameRecencyWeight,
        recencyBucket: gameRecencyBucket,
        timeClass: game.timeClass,
        timeLabel: game.timeLabel,
      });
      gameMistakes += 1;
    }

    gameSummaries.push({
      id: game.url || `${game.date}:${game.color}:${gameIndex}`,
      url: game.url,
      result: resultFor(game),
      color: game.color,
      date: game.date,
      endMs: game.endMs,
      ageDays: gameAgeDays,
      recencyWeight: gameRecencyWeight,
      recencyBucket: gameRecencyBucket,
      timeClass: game.timeClass,
      timeLabel: game.timeLabel,
      moves: userMoves.length,
      measuredMoves: gameMeasuredMoves,
      totalLossCp: Math.round(gameLoss),
      averageLoss: Math.round(gameLoss / Math.max(1, userMoves.length)),
      mistakes: gameMistakes,
    });
  }

  setProgress(95, "Ranking your training priorities…", "Turning mistakes into a practice plan");
  return buildReport(username, loaded, gameSummaries, mistakes, Math.round(totalLoss / Math.max(1, measuredMoves)));
}

function mistakePriority(mistake) {
  return Math.min(700, mistake.lossCp) * (mistake.recencyWeight ?? 0.55);
}

function opportunityScore(mistake) {
  const beforeUser = mistake.beforeUserCp ?? cpForSide(mistake.evalBeforeWhite, mistake.color);
  const concreteBonus = mistake.forcingTarget ? 220 : 0;
  const advantageBonus = Math.max(0, Math.min(260, beforeUser + 80));
  return mistakePriority(mistake) + concreteBonus + advantageBonus;
}

function isOpportunityPuzzle(mistake) {
  const beforeUser = mistake.beforeUserCp ?? cpForSide(mistake.evalBeforeWhite, mistake.color);
  const concreteTarget = mistake.forcingTarget || /missed|material|capture|check/i.test(mistake.theme || "");
  return mistake.lossCp >= 120 && (
    concreteTarget ||
    beforeUser >= 60 ||
    (beforeUser >= -40 && mistake.lossCp >= 220)
  );
}

function preparePuzzle(mistake, deck) {
  return {
    ...mistake,
    id: puzzleId(mistake),
    deck,
    deckTags: [deck],
    puzzleGoal: deck === "opportunity"
      ? "Win or preserve the chance your opponent gave you."
      : deck === "blunder"
        ? "Avoid the mistake from your real game."
        : "Find the strongest practical move in your personal position.",
  };
}

function buildPuzzlePool(candidates, limit = Number.POSITIVE_INFINITY, score = mistakePriority) {
  const groups = new Map();
  const seenPositions = new Set();
  [...candidates].sort((a, b) => score(b) - score(a)).forEach((mistake) => {
    const key = normalizedFen(mistake.fen);
    if (!key || seenPositions.has(key)) return;
    seenPositions.add(key);
    if (!groups.has(mistake.gameUrl)) groups.set(mistake.gameUrl, []);
    groups.get(mistake.gameUrl).push(mistake);
  });
  const ordered = [...groups.values()].sort((a, b) => score(b[0]) - score(a[0]));
  const pool = [];
  for (let round = 0; pool.length < limit; round += 1) {
    let added = false;
    ordered.forEach((group) => {
      if (group[round] && pool.length < limit) {
        pool.push(group[round]);
        added = true;
      }
    });
    if (!added) break;
  }
  return pool;
}

function buildPuzzleDecks(mistakes, limit = Number.POSITIVE_INFINITY) {
  const serious = mistakes.filter((mistake) =>
    mistake.lossCp >= 100 &&
    mistake.fen &&
    mistake.bestUci &&
    mistake.playedUci &&
    String(mistake.bestUci).slice(0, 4) !== String(mistake.playedUci).slice(0, 4)
  );
  const opportunities = serious.filter(isOpportunityPuzzle);
  const allPool = buildPuzzlePool(serious, limit, mistakePriority);
  const opportunityPool = buildPuzzlePool(opportunities, limit, opportunityScore);
  const opportunityFill = opportunityPool.length >= Math.min(12, serious.length)
    ? opportunityPool
    : [
        ...opportunityPool,
        ...buildPuzzlePool(
          serious.filter((mistake) => !opportunityPool.some((picked) => picked.gameUrl === mistake.gameUrl && picked.playedUci === mistake.playedUci)),
          limit - opportunityPool.length,
          mistakePriority
        ),
      ];
  const blunderPool = buildPuzzlePool(
    serious.filter((mistake) => mistake.lossCp >= 150),
    limit,
    mistakePriority
  );
  return {
    all: allPool.slice(0, limit).map((mistake) => preparePuzzle(mistake, "all")),
    opportunity: opportunityFill.slice(0, limit).map((mistake) => preparePuzzle(mistake, "opportunity")),
    blunder: blunderPool.slice(0, limit).map((mistake) => preparePuzzle(mistake, "blunder")),
  };
}

function buildWeaknesses(mistakes) {
  const counts = new Map();
  mistakes.filter((mistake) => mistake.lossCp >= 100).forEach((mistake) => {
    const current = counts.get(mistake.theme) || {
      title: mistake.theme,
      events: 0,
      games: new Set(),
      currentGames: new Set(),
      buckets: new Set(),
      total: 0,
      weightedTotal: 0,
      weightedEvents: 0,
      currentEvents: 0,
      currentTotal: 0,
      newestAgeDays: Infinity,
      oldestAgeDays: 0,
    };
    const cappedLoss = Math.min(600, mistake.lossCp);
    const weight = mistake.recencyWeight ?? recencyWeight(mistake.ageDays);
    current.events += 1;
    current.games.add(mistake.gameUrl);
    current.total += cappedLoss;
    current.weightedTotal += cappedLoss * weight;
    current.weightedEvents += weight;
    current.buckets.add(mistake.recencyBucket || recencyBucket(mistake.ageDays));
    if (mistake.ageDays !== null && mistake.ageDays !== undefined) {
      current.newestAgeDays = Math.min(current.newestAgeDays, mistake.ageDays);
      current.oldestAgeDays = Math.max(current.oldestAgeDays, mistake.ageDays);
      if (mistake.ageDays <= CURRENT_WINDOW_DAYS) {
        current.currentEvents += 1;
        current.currentTotal += cappedLoss;
        current.currentGames.add(mistake.gameUrl);
      }
    }
    counts.set(mistake.theme, current);
  });
  const weaknesses = [...counts.values()]
    .map((area) => {
      const spread = Math.min(1, area.games.size / 5);
      const currentSignal = Math.min(1, (area.currentGames.size / 3) + (area.currentEvents / 12));
      const persistence = Math.min(1, Math.max(0, area.buckets.size - 1) / 3);
      const continuitySignal = area.currentEvents
        ? Math.min(1, area.oldestAgeDays / 365) * Math.min(1, area.buckets.size / 4)
        : 0;
      const continuityEvidence = continuitySignal
        ? Math.min(area.total * 0.18, area.weightedTotal * 0.65)
        : 0;
      const stalePenalty = area.currentEvents
        ? 1
        : area.newestAgeDays > 365
          ? 0.45
          : area.newestAgeDays > 180
            ? 0.65
            : 0.85;
      const impact = (area.weightedTotal + continuityEvidence)
        * (0.72 + 0.18 * spread + 0.10 * persistence)
        * (1 + 0.18 * currentSignal)
        * (1 + 0.35 * continuitySignal)
        * stalePenalty;
      const newestAge = Number.isFinite(area.newestAgeDays) ? area.newestAgeDays : null;
      const oldestAge = area.oldestAgeDays || null;
      const bucketList = [...area.buckets].filter((bucket) => bucket !== "unknown date");
      return {
        title: area.title,
        events: area.events,
        games: area.games.size,
        currentEvents: area.currentEvents,
        currentGames: area.currentGames.size,
        average: Math.round(area.total / Math.max(1, area.events)),
        weightedAverage: Math.round(area.weightedTotal / Math.max(1, area.weightedEvents)),
        impact,
        newestAgeDays: newestAge,
        oldestAgeDays: oldestAge,
        latestSeen: ageLabel(newestAge),
        buckets: bucketList,
        urgency: area.currentEvents
          ? continuitySignal > 0.35
            ? `Persistent current leak: seen in the last ${CURRENT_WINDOW_DAYS} days and as far back as ${ageLabel(oldestAge)}.`
            : `${area.currentEvents} current event${area.currentEvents === 1 ? "" : "s"} in the last ${CURRENT_WINDOW_DAYS} days; latest ${ageLabel(newestAge)}.`
          : `Not seen in the last ${CURRENT_WINDOW_DAYS} days; latest ${ageLabel(newestAge)}.`,
        prescription: prescriptionFor(area.title),
      };
    })
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 5);
  return weaknesses;
}

function buildReport(username, loaded, games, mistakes, acpl) {
  const weaknesses = buildWeaknesses(mistakes);
  const results = games.reduce((all, game) => {
    all[game.result] = (all[game.result] || 0) + 1;
    return all;
  }, {});
  const puzzleDecks = buildPuzzleDecks(mistakes);
  return {
    analysisVersion: ANALYSIS_VERSION,
    username,
    generatedAt: Date.now(),
    gamesAnalyzed: games.length,
    gamesFetched: loaded.fetched,
    eligibleGames: loaded.eligible,
    archiveMonths: loaded.archiveMonths,
    filterIds: loaded.filterIds,
    filterLabels: loaded.filterLabels,
    filterSummary: loaded.filterSummary,
    currentWindowDays: CURRENT_WINDOW_DAYS,
    recencyHalfLifeDays: RECENCY_HALF_LIFE_DAYS,
    results,
    acpl,
    blunders: mistakes.filter((mistake) => mistake.lossCp >= 200).length,
    weaknesses,
    puzzleDecks,
    puzzles: puzzleDecks.opportunity,
    games,
    remainingEligibleGames: loaded.remainingEligibleGames || 0,
  };
}

function stripLargeReportData(report) {
  if (!report) return null;
  const { puzzleDecks, puzzles, games, ...summary } = report;
  return summary;
}

function collectReportPositions(report) {
  const positions = new Map();
  const decks = report?.puzzleDecks || { opportunity: report?.puzzles || [] };
  Object.entries(decks).forEach(([deck, puzzles]) => {
    (puzzles || []).forEach((puzzle) => {
      const id = puzzle.id || puzzleId(puzzle);
      const existing = positions.get(id);
      const tags = new Set([...(existing?.deckTags || []), ...(puzzle.deckTags || []), deck]);
      const sources = new Set([
        ...(existing?.sourceGames || []),
        ...(puzzle.sourceGames || []),
        puzzle.gameUrl,
      ].filter(Boolean));
      positions.set(id, {
        ...(existing || {}),
        ...puzzle,
        id,
        deckTags: [...tags],
        sourceGames: [...sources],
      });
    });
  });
  return [...positions.values()];
}

function decksFromPositions(positions) {
  const ordered = [...positions].sort((a, b) => mistakePriority(b) - mistakePriority(a));
  return {
    all: ordered,
    opportunity: ordered.filter((puzzle) => puzzle.deckTags?.includes("opportunity")),
    blunder: ordered.filter((puzzle) => puzzle.deckTags?.includes("blunder")),
  };
}

function cumulativeReport(curriculum, latestReport = null) {
  const base = latestReport || curriculum.reportSummary || {};
  const positions = curriculum.positions || [];
  const games = curriculum.games || [];
  const puzzleDecks = decksFromPositions(positions);
  const results = games.length
    ? games.reduce((all, game) => {
        all[game.result] = (all[game.result] || 0) + 1;
        return all;
      }, {})
    : (base.results || {});
  const measuredMoves = games.reduce((sum, game) => sum + (game.measuredMoves || game.moves || 0), 0);
  const totalLoss = games.reduce((sum, game) => sum + (game.totalLossCp || 0), 0);
  return {
    ...base,
    analysisVersion: ANALYSIS_VERSION,
    username: curriculum.username,
    filterIds: curriculum.filterIds,
    generatedAt: base.generatedAt || curriculum.updatedAt || Date.now(),
    gamesAnalyzed: games.length || base.gamesAnalyzed || 0,
    eligibleGames: Math.max(base.eligibleGames || 0, games.length),
    results,
    acpl: measuredMoves ? Math.round(totalLoss / measuredMoves) : (base.acpl || 0),
    blunders: positions.filter((puzzle) => puzzle.lossCp >= 200).length,
    weaknesses: positions.length ? buildWeaknesses(positions) : (base.weaknesses || []),
    puzzleDecks,
    puzzles: puzzleDecks.opportunity,
    positionBankSize: positions.length,
    reviewUpdatedAt: curriculum.updatedAt || Date.now(),
  };
}

async function mergeReportIntoCurriculum(report, curriculum = null) {
  const target = normalizeCurriculum(
    curriculum,
    report.username,
    report.filterIds
  );
  const now = Date.now();
  const positions = new Map(target.positions.map((puzzle) => [puzzle.id || puzzleId(puzzle), puzzle]));
  collectReportPositions(report).forEach((puzzle) => {
    const id = puzzle.id || puzzleId(puzzle);
    const existing = positions.get(id);
    const tags = new Set([...(existing?.deckTags || []), ...(puzzle.deckTags || [])]);
    const sources = new Set([...(existing?.sourceGames || []), ...(puzzle.sourceGames || [])]);
    positions.set(id, {
      ...(existing || {}),
      ...puzzle,
      id,
      deckTags: [...tags],
      sourceGames: [...sources],
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
    });
  });
  target.positions = [...positions.values()];

  const games = new Map(target.games.map((game) => [game.id || game.url, game]));
  (report.games || []).forEach((game) => games.set(game.id || game.url, game));
  target.games = [...games.values()].filter(Boolean);
  target.analyzedGameUrls = [...new Set([
    ...target.analyzedGameUrls,
    ...target.games.map((game) => game.url),
  ].filter(Boolean))];
  target.updatedAt = now;
  const combined = cumulativeReport(target, report);
  target.reportSummary = stripLargeReportData(combined);
  await persistCurriculum(target);
  return { curriculum: target, report: combined };
}

function prescriptionFor(theme) {
  const text = theme.toLowerCase();
  if (text.includes("missed")) return "List every check and capture before considering a quiet move.";
  if (text.includes("hanging") || text.includes("safety") || text.includes("hung")) return "Before releasing a piece, name the opponent’s checks, captures, and attacks.";
  if (text.includes("opening")) return "Replay only the first ten moves and identify the first broken opening principle.";
  if (text.includes("endgame")) return "Replay these exact positions against the engine from both sides.";
  if (text.includes("forcing")) return "Pause when the king or queen is exposed and calculate the opponent’s forcing reply.";
  return "Solve your personal positions slowly, then replay each wrong branch until the punishment is obvious.";
}

function saveReport(report) {
  try {
    localStorage.setItem(
      cacheKey(report.username, report.filterIds),
      JSON.stringify(stripLargeReportData(report))
    );
    localStorage.setItem("lastUsername", report.username);
    localStorage.setItem("lastFilterIds", JSON.stringify(report.filterIds));
  } catch {
    // A report can still be used even if WebView storage is unavailable.
  }
}

function loadCachedReport(username, filterIds) {
  try {
    const value = localStorage.getItem(cacheKey(username, filterIds))
      || localStorage.getItem(`report:6:${username}:${normalizeFilterIds(filterIds).join(",")}`);
    if (!value) return null;
    const report = JSON.parse(value);
    if (![6, ANALYSIS_VERSION].includes(report.analysisVersion)) return null;
    if (normalizeFilterIds(report.filterIds).join(",") !== normalizeFilterIds(filterIds).join(",")) return null;
    if (Date.now() - report.generatedAt > 7 * 24 * 60 * 60 * 1000) return null;
    return report;
  } catch {
    return null;
  }
}

function reviewStateFor(puzzle) {
  return currentCurriculum?.attempts?.[puzzle.id || puzzleId(puzzle)] || null;
}

function reviewStatusFor(puzzle, now = Date.now()) {
  const state = reviewStateFor(puzzle);
  if (!state?.attempts) return { key: "new", label: "New" };
  if (state.savedForReview) return { key: "saved", label: "Review" };
  if (state.dueAt <= now) return { key: "due", label: state.lastCorrect ? "Due" : "Retry due" };
  if (state.mastered) return { key: "mastered", label: "Mastered" };
  return { key: "learning", label: "Learning" };
}

function reviewStats(now = Date.now()) {
  const positions = currentCurriculum?.positions || [];
  return positions.reduce((stats, puzzle) => {
    const status = reviewStatusFor(puzzle, now).key;
    stats[status] += 1;
    return stats;
  }, { new: 0, due: 0, learning: 0, mastered: 0, saved: 0 });
}

function savedReviewPuzzles() {
  return (currentCurriculum?.positions || [])
    .filter((puzzle) => reviewStateFor(puzzle)?.savedForReview)
    .sort((a, b) => (reviewStateFor(b)?.savedAt || 0) - (reviewStateFor(a)?.savedAt || 0));
}

function dateToken(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function todayQueueStorageKey() {
  return currentCurriculum ? `todayQueue:${currentCurriculum.key}:${dateToken()}` : "";
}

function buildTodayQueue() {
  const positions = currentCurriculum?.positions || [];
  const byId = new Map(positions.map((puzzle) => [puzzle.id, puzzle]));
  try {
    const saved = JSON.parse(localStorage.getItem(todayQueueStorageKey()) || "null");
    const valid = Array.isArray(saved) ? saved.filter((id) => byId.has(id)) : [];
    if (valid.length) return valid;
  } catch {
    // A new queue will be generated below.
  }

  const now = Date.now();
  const due = positions
    .filter((puzzle) => {
      const state = reviewStateFor(puzzle);
      return state?.attempts && state.dueAt <= now;
    })
    .sort((a, b) => {
      const left = reviewStateFor(a);
      const right = reviewStateFor(b);
      if (left.lastCorrect !== right.lastCorrect) return left.lastCorrect ? 1 : -1;
      return (left.dueAt || 0) - (right.dueAt || 0);
    });
  const fresh = positions
    .filter((puzzle) => !reviewStateFor(puzzle)?.attempts)
    .sort((a, b) => mistakePriority(b) - mistakePriority(a));
  const queue = [];
  due.slice(0, TODAY_DUE_TARGET).forEach((puzzle) => queue.push(puzzle.id));
  fresh.slice(0, TODAY_QUEUE_SIZE - queue.length).forEach((puzzle) => queue.push(puzzle.id));
  due.slice(TODAY_DUE_TARGET).forEach((puzzle) => {
    if (queue.length < TODAY_QUEUE_SIZE) queue.push(puzzle.id);
  });
  if (!queue.length) {
    positions
      .filter((puzzle) => !reviewStateFor(puzzle)?.mastered)
      .slice(0, TODAY_QUEUE_SIZE)
      .forEach((puzzle) => queue.push(puzzle.id));
  }
  try {
    localStorage.setItem(todayQueueStorageKey(), JSON.stringify(queue));
  } catch {
    // Today's queue remains available in memory.
  }
  return queue;
}

function scheduleReview(previous, grade, now) {
  const state = {
    attempts: 0,
    correct: 0,
    incorrect: 0,
    hints: 0,
    reveals: 0,
    streak: 0,
    intervalDays: 0,
    dueAt: now,
    mastered: false,
    ...previous,
  };
  if (grade < 3) {
    state.streak = 0;
    state.intervalDays = grade === 2 ? 1 : 10 / (24 * 60);
  } else {
    state.streak += 1;
    const intervals = [1, 3, 7, 14, 30, 60, 120];
    state.intervalDays = intervals[Math.min(intervals.length - 1, state.streak - 1)];
  }
  state.dueAt = now + state.intervalDays * DAY_MS;
  state.mastered = false;
  return state;
}

function recordPuzzleAttempt(puzzle, outcome) {
  if (!currentCurriculum) return;
  const id = puzzle.id || puzzleId(puzzle);
  const now = Date.now();
  const previous = currentCurriculum.attempts[id] || null;
  const state = scheduleReview(previous, outcome.grade, now);
  state.attempts += 1;
  state.correct += outcome.correct ? 1 : 0;
  state.incorrect += outcome.correct ? 0 : 1;
  state.hints += outcome.usedHint ? 1 : 0;
  state.reveals += outcome.revealed ? 1 : 0;
  state.cleanCorrect = (previous?.cleanCorrect || 0)
    + (outcome.correct && !outcome.usedHint && !outcome.revealed ? 1 : 0);
  state.lastCorrect = outcome.correct;
  state.lastAttemptAt = now;
  state.lastSolveMs = outcome.solveMs;
  state.lastMoveUci = outcome.moveUci;
  state.lastEvalLoss = Math.round(outcome.evalLoss || 0);
  state.mastered = state.streak >= 3
    && state.cleanCorrect >= 3
    && outcome.correct
    && !outcome.usedHint
    && !outcome.revealed;
  currentCurriculum.attempts[id] = state;
  currentCurriculum.updatedAt = now;
  queueCurriculumSave();
  updateReviewSummary();
}

function setPuzzleDisposition(puzzle, disposition) {
  if (!currentCurriculum) return;
  const id = puzzle.id || puzzleId(puzzle);
  const now = Date.now();
  const previous = currentCurriculum.attempts[id] || {};
  const state = {
    attempts: 1,
    correct: 0,
    incorrect: 0,
    hints: 0,
    reveals: 0,
    streak: 0,
    intervalDays: 0,
    dueAt: now,
    mastered: false,
    ...previous,
  };
  if (disposition === "review") {
    state.savedForReview = true;
    state.savedAt = now;
    state.mastered = false;
  } else {
    state.savedForReview = false;
    state.mastered = true;
    state.lastCorrect = true;
    state.streak = Math.max(3, state.streak || 0);
    state.intervalDays = 120;
    state.dueAt = now + 120 * DAY_MS;
  }
  currentCurriculum.attempts[id] = state;
  currentCurriculum.updatedAt = now;
  queueCurriculumSave();
  updateReviewSummary();
}

function updateReviewSummary() {
  if (!currentCurriculum || !$("#review-summary")) return;
  const stats = reviewStats();
  $("#review-summary").innerHTML = [
    [stats.due, "due today"],
    [stats.mastered, "mastered"],
  ].map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("");
  if ($("#analysis-status")) $("#analysis-status").textContent = analysisMessage;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderReport(report, options = {}) {
  currentReport = report;
  todayQueueIds = buildTodayQueue();
  const progress = loadPuzzleProgress(report);
  const defaultDeck = todayQueueIds.length ? "today" : "all";
  activeDeck = ["today", "all", "review"].includes(progress.deck)
    ? progress.deck
    : defaultDeck;
  if (!activePuzzles().length) activeDeck = defaultDeck;
  activePuzzleIndex = clampIndex(progress.indexes?.[activeDeck], activePuzzles().length);
  $("#report-title").textContent = "Today’s practice";
  $("#report-subtitle").textContent = `${report.username} · ${todayQueueIds.length || deckTotalText(report)} position${(todayQueueIds.length || deckTotalText(report)) === 1 ? "" : "s"} ready`;
  const topFocus = report.weaknesses[0];
  $("#focus-title").textContent = topFocus?.title || "Keep building your pattern signal";
  $("#focus-copy").textContent = topFocus
    ? `${topFocus.prescription} This showed up in ${topFocus.games} game${topFocus.games === 1 ? "" : "s"}.`
    : "Analyze a few more games so recurring patterns can rise above one-off mistakes.";

  updateReviewSummary();
  renderPuzzles();
  showView("#report");
  if (options.resumePuzzle && activePuzzles().length) {
    window.setTimeout(() => $("#puzzle-mode")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  }
}

function deckTotalText(report) {
  return report.puzzleDecks?.all?.length
    ?? report.positionBankSize
    ?? report.puzzles?.length
    ?? 0;
}

function activePuzzles() {
  if (activeDeck === "today") {
    const byId = new Map((currentCurriculum?.positions || []).map((puzzle) => [puzzle.id, puzzle]));
    return todayQueueIds.map((id) => byId.get(id)).filter(Boolean);
  }
  if (activeDeck === "review") return savedReviewPuzzles();
  return currentReport?.puzzleDecks?.[activeDeck] || currentReport?.puzzles || [];
}

function deckLabel() {
  return ({
    today: "today",
    all: "all personal",
    review: "saved review",
    opportunity: "opportunity",
    blunder: "blunder repair",
  })[activeDeck] || activeDeck;
}

function updateDeckTabs() {
  $("#deck-today")?.classList.toggle("active", activeDeck === "today");
  $("#deck-all")?.classList.toggle("active", activeDeck === "all");
  $("#deck-review")?.classList.toggle("active", activeDeck === "review");
  $("#deck-today").disabled = !todayQueueIds.length;
  $("#deck-all").disabled = !(currentReport?.puzzleDecks?.all?.length);
  const reviewCount = savedReviewPuzzles().length;
  $("#deck-review").disabled = !reviewCount;
  $("#deck-review").textContent = reviewCount ? `Review ${reviewCount}` : "Review";
}

function renderPuzzles() {
  updateDeckTabs();
  const allPuzzles = activePuzzles();
  activePuzzleIndex = clampIndex(activePuzzleIndex, allPuzzles.length);
  if (!allPuzzles.length) {
    $("#puzzles").innerHTML = activeDeck === "today"
      ? "<p>Nothing is due today. The full personal bank is still available.</p>"
      : `<p>No ${deckLabel()} positions were found in this curriculum.</p>`;
    $("#deck-count").textContent = "0 positions";
    $("#puzzle-prev").disabled = true;
    $("#puzzle-next").disabled = true;
    return;
  }
  $("#puzzles").replaceChildren(createPuzzleCard(allPuzzles[activePuzzleIndex], activePuzzleIndex));
  $("#deck-count").textContent = `${activePuzzleIndex + 1} of ${allPuzzles.length}`;
  $("#puzzle-prev").disabled = activePuzzleIndex <= 0;
  $("#puzzle-next").disabled = activePuzzleIndex >= allPuzzles.length - 1;
  savePuzzleProgress();
}

function evalLabel(cp, text = "") {
  if (text.includes("M")) return text.startsWith("-") ? `Black ${text.slice(1)}` : `White ${text}`;
  if (Math.abs(cp) < 15) return "Equal";
  return `${cp > 0 ? "White" : "Black"} ${(Math.abs(cp) / 100).toFixed(1)}`;
}

function updateEval(card, cp, text = "") {
  card.classList.remove("eval-hidden");
  const bounded = Math.max(-1500, Math.min(1500, cp || 0));
  const percent = 50 + 47 * Math.tanh(bounded / 400);
  $(".eval-needle", card).style.left = `${percent}%`;
  $(".eval-label", card).textContent = evalLabel(bounded, text);
}

function sameMove(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function updateCardReviewState(card, puzzle) {
  const status = reviewStatusFor(puzzle);
  const badge = $(".review-state", card);
  if (!badge) return;
  badge.className = `review-state ${status.key}`;
  badge.textContent = status.label;
}

function boardSquares(perspective) {
  const files = perspective === "b" ? ["h", "g", "f", "e", "d", "c", "b", "a"] : ["a", "b", "c", "d", "e", "f", "g", "h"];
  const ranks = perspective === "b" ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  return ranks.flatMap((rank) => files.map((file) => `${file}${rank}`));
}

function renderBoard(card, state) {
  const board = $(".board", card);
  board.replaceChildren();
  boardSquares(state.puzzle.color).forEach((square, index) => {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]);
    const piece = state.chess.get(square);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `square ${(file + rank) % 2 ? "dark" : "light"}${piece ? " occupied" : ""}`;
    button.dataset.square = square;
    button.setAttribute("aria-label", piece ? `${square}, ${piece.color === "w" ? "white" : "black"} ${pieceName(piece.type)}` : `${square}, empty`);
    if (piece) button.innerHTML = `<span class="piece ${piece.color === "w" ? "white-piece" : "black-piece"}">${PIECES[piece.color][piece.type]}</span>`;
    if (index % 8 === 0) {
      button.insertAdjacentHTML("beforeend", `<span class="coordinate rank" aria-hidden="true">${square[1]}</span>`);
    }
    if (index >= 56) {
      button.insertAdjacentHTML("beforeend", `<span class="coordinate file" aria-hidden="true">${square[0]}</span>`);
    }
    button.addEventListener("click", () => clickSquare(card, state, square));
    board.append(button);
  });
}

function clearBoardMarks(card) {
  card.querySelectorAll(".square").forEach((square) => square.classList.remove("selected", "target", "game-from", "game-to"));
}

function markMoveSquares(card, uci, fromClass = "game-from", toClass = "game-to") {
  if (!uci || uci.length < 4) return;
  clearBoardMarks(card);
  $(`[data-square="${uci.slice(0, 2)}"]`, card)?.classList.add(fromClass);
  $(`[data-square="${uci.slice(2, 4)}"]`, card)?.classList.add(toClass);
}

function selectSquare(card, state, square) {
  const moves = state.chess.moves({ square, verbose: true });
  clearBoardMarks(card);
  if (!moves.length) {
    state.selected = null;
    return false;
  }
  state.selected = square;
  $(`[data-square="${square}"]`, card).classList.add("selected");
  moves.forEach((move) => $(`[data-square="${move.to}"]`, card)?.classList.add("target"));
  setFeedback(card, "neutral", "Piece selected. Choose its destination.");
  return true;
}

function clickSquare(card, state, square) {
  if (state.busy) return;
  if (!state.selected) {
    selectSquare(card, state, square);
    return;
  }
  const from = state.selected;
  if (selectSquare(card, state, square)) return;
  state.selected = null;
  clearBoardMarks(card);
  let move;
  try {
    move = state.chess.move({ from, to: square, promotion: "q" });
  } catch {
    move = null;
  }
  if (!move) {
    setFeedback(card, "incorrect", "That move is not legal in this position.");
    return;
  }
  renderBoard(card, state);
  analyzePuzzleMove(card, state, move);
}

function setFeedback(card, kind, message) {
  const node = $(".feedback", card);
  node.className = `feedback ${kind}`;
  node.textContent = message;
}

function showSolveControls(card, state) {
  $("button.hint", card).hidden = false;
  $("button.hint", card).textContent = state.hintLevel ? "Stronger hint" : "Hint";
  $("button.hint", card).disabled = state.hintLevel >= 2;
  $(".game-move", card).hidden = false;
  $(".answer", card).hidden = false;
  $(".retry", card).hidden = true;
  $(".engine", card).hidden = true;
  $(".advanced-controls", card).hidden = true;
  $(".advanced-controls", card).open = false;
  $(".line", card).hidden = true;
  $(".explanation", card).hidden = true;
  $(".finish-actions", card).hidden = true;
  updateMoveControls(card, state);
}

function showExploreControls(card, state) {
  $("button.hint", card).hidden = true;
  $(".game-move", card).hidden = true;
  $(".answer", card).hidden = true;
  const retry = $(".retry", card);
  retry.hidden = !state.retry;
  retry.textContent = state.retry?.ply > 0 ? "Retry this move" : "Try again";
  const gameOver = state.chess.isGameOver();
  $(".engine", card).hidden = gameOver;
  $(".advanced-controls", card).hidden = gameOver;
  $(".explanation", card).hidden = false;
  $(".line", card).hidden = gameOver || !$(".line", card).textContent;
  $(".finish-actions", card).hidden = !state.canFinish;
  const saveButton = $(".save-review", card);
  const isSaved = Boolean(reviewStateFor(state.puzzle)?.savedForReview);
  saveButton.setAttribute("aria-pressed", String(isSaved));
  saveButton.textContent = isSaved ? "Saved for review" : "Review later";
  updateMoveControls(card, state);
}

function updateMoveControls(card, state) {
  if (!state) return;
  const hasHistory = state.chess.history().length > 0;
  const back = $(".back-move", card);
  const forward = $(".engine", card);
  if (back) back.disabled = state.busy || !hasHistory;
  if (forward) forward.disabled = state.busy || !hasHistory || state.chess.isGameOver();
  card.querySelectorAll(".controls button, .finish-actions button").forEach((button) => {
    if (!button.classList.contains("hint") || state.hintLevel < 2) {
      button.disabled = state.busy;
    }
  });
}

async function analyzeCurrentPosition(card, state, feedback = "Analyzing current position…") {
  if (state.chess.isGameOver()) {
    state.busy = false;
    updateMoveControls(card, state);
    return null;
  }
  state.busy = true;
  updateMoveControls(card, state);
  setFeedback(card, "neutral", feedback);
  const engine = await ensureEngine();
  const info = await engine.analyze(state.chess.fen(), PUZZLE_NODES);
  state.lastInfo = info;
  state.lastInfoFen = state.chess.fen();
  state.currentEvalWhite = info.whiteCp;
  updateEval(card, info.whiteCp, info.whiteText);
  $(".turn", card).textContent = state.chess.turn() === "w" ? "white to move" : "black to move";
  $(".line", card).textContent = principalVariation(state.chess, info.pv);
  state.busy = false;
  updateMoveControls(card, state);
  return info;
}

async function undoPuzzleMove(card, state) {
  if (state.busy) return;
  const undone = state.chess.undo();
  if (!undone) return;
  state.selected = null;
  clearBoardMarks(card);
  renderBoard(card, state);
  if (!state.chess.history().length) {
    state.mode = "solve";
    state.solved = false;
    state.canFinish = false;
    state.retry = null;
    state.startedAt = Date.now();
    state.lastInfo = null;
    state.lastInfoFen = "";
    state.currentEvalWhite = state.puzzle.evalBeforeWhite;
    updateEval(card, state.puzzle.evalBeforeWhite);
    $(".turn", card).textContent = state.chess.turn() === "w" ? "white to move" : "black to move";
    showSolveControls(card, state);
    setFeedback(card, "neutral", `Undid ${undone.san}. Back to the original puzzle position.`);
    return;
  }
  state.mode = "explore";
  $(".explanation", card).hidden = false;
  $(".line", card).hidden = false;
  try {
    await analyzeCurrentPosition(card, state, `Undid ${undone.san}. Rechecking the position…`);
    setFeedback(card, "neutral", `Undid ${undone.san}. Continue from here, or use → Best move.`);
    showExploreControls(card, state);
  } catch (error) {
    state.busy = false;
    updateMoveControls(card, state);
    setFeedback(card, "incorrect", `Analysis failed: ${error.message}`);
  }
}

function retryPuzzleMove(card, state) {
  if (state.busy || !state.retry) return;
  const retry = state.retry;
  while (state.chess.history().length > retry.ply) state.chess.undo();
  state.selected = null;
  state.retry = null;
  state.currentEvalWhite = retry.evalWhite;
  state.lastInfo = retry.info || null;
  state.lastInfoFen = retry.info ? state.chess.fen() : "";
  state.canFinish = retry.wasSolved;
  clearBoardMarks(card);
  renderBoard(card, state);
  updateEval(card, state.currentEvalWhite, retry.evalText || "");
  $(".line", card).textContent = principalVariation(state.chess, retry.info?.pv);
  $(".explanation", card).textContent = "Continue from this position. Look for the strongest forcing move.";
  $(".turn", card).textContent = state.chess.turn() === "w" ? "white to move" : "black to move";
  if (!retry.ply) {
    state.mode = "solve";
    state.solved = false;
    state.canFinish = false;
    state.startedAt = Date.now();
    showSolveControls(card, state);
    setFeedback(card, "neutral", "Try again. Find a stronger first move.");
    return;
  }
  state.mode = "explore";
  state.retry = null;
  state.canFinish = state.solved;
  showExploreControls(card, state);
  setFeedback(card, "neutral", "That move is reset. Try a different continuation from here.");
}

async function playEngineMove(card, state) {
  if (state.busy || !state.chess.history().length) return;
  if (state.chess.isGameOver()) {
    showExploreControls(card, state);
    return;
  }
  try {
    if (!state.lastInfo?.bestUci || state.lastInfoFen !== state.chess.fen()) {
      await analyzeCurrentPosition(card, state, "Finding the best move from here…");
    }
    const move = uciMove(state.chess, state.lastInfo?.bestUci);
    if (!move) {
      if (state.chess.isGameOver()) {
        showExploreControls(card, state);
        return;
      }
      setFeedback(card, "incorrect", "The engine could not find a legal continuation.");
      return;
    }
    renderBoard(card, state);
    await analyzePuzzleMove(card, state, move, { automatic: true });
  } catch (error) {
    state.busy = false;
    updateMoveControls(card, state);
    setFeedback(card, "incorrect", `Best move failed: ${error.message}`);
  }
}

function recordInitialSolve(card, state, outcome) {
  const solveMs = Math.max(0, Date.now() - state.startedAt);
  const assisted = state.usedHint || state.usedGameMove;
  const grade = outcome.revealed
    ? 0
    : outcome.correct
      ? assisted
        ? 3
        : solveMs <= 60_000
          ? 5
          : 4
      : outcome.loss < 150
        ? 2
        : 0;
  recordPuzzleAttempt(state.puzzle, {
    correct: outcome.correct,
    grade,
    usedHint: assisted,
    revealed: Boolean(outcome.revealed),
    solveMs,
    moveUci: outcome.moveUci,
    evalLoss: outcome.loss,
  });
  updateCardReviewState(card, state.puzzle);
}

function finishGamePosition(card, state, move, options, wasSolve, beforeEvalWhite) {
  const isMate = state.chess.isCheckmate();
  const attemptedUci = moveUci(move);
  const exactTarget = sameMove(attemptedUci, state.puzzle.bestUci);
  const countedCorrect = !options.revealed && (isMate || exactTarget);
  state.busy = false;
  state.mode = "explore";
  state.lastInfo = null;
  state.lastInfoFen = state.chess.fen();
  state.retry = null;

  if (isMate) {
    const whiteCp = move.color === "w" ? 1500 : -1500;
    state.currentEvalWhite = whiteCp;
    updateEval(card, whiteCp, move.color === "w" ? "M0" : "-M0");
    $(".turn", card).textContent = "checkmate";
    if (options.revealed) {
      setFeedback(card, "hint", `Answer: ${move.san}. Checkmate.`);
    } else if (options.automatic) {
      setFeedback(card, "correct", `Checkmate — ${move.san} completes the line.`);
    } else {
      setFeedback(card, "correct", `Checkmate — excellent finish with ${move.san}.`);
    }
    $(".explanation", card).textContent = wasSolve
      ? explainTargetMove(state.puzzle, move)
      : "The king has no legal escape. The game is over, so there is no engine reply to play.";
    state.solved = state.solved || countedCorrect || Boolean(options.revealed) || !wasSolve;
    state.canFinish = state.solved;
  } else {
    state.currentEvalWhite = 0;
    updateEval(card, 0);
    $(".eval-label", card).textContent = "Draw";
    $(".turn", card).textContent = "game over";
    setFeedback(card, exactTarget ? "correct" : "neutral", `Draw — ${move.san} ends the game.`);
    $(".explanation", card).textContent = "The position is finished, so there is no legal reply to play.";
    state.solved = state.solved || countedCorrect || Boolean(options.revealed);
    state.canFinish = state.solved;
    if (wasSolve && !state.solved) {
      state.retry = {
        ply: 0,
        evalWhite: beforeEvalWhite,
        info: null,
        wasSolved: false,
      };
    }
  }
  $(".line", card).textContent = "";
  showExploreControls(card, state);
  if (wasSolve) {
    recordInitialSolve(card, state, {
      correct: countedCorrect,
      revealed: options.revealed,
      moveUci: attemptedUci,
      loss: countedCorrect ? 0 : 150,
    });
  }
}

async function analyzePuzzleMove(card, state, move, options = {}) {
  const wasSolve = state.mode === "solve";
  const previousInfo = state.lastInfo;
  const previousSolved = state.solved;
  const retryPly = Math.max(0, state.chess.history().length - 1);
  let beforeEvalWhite = state.currentEvalWhite;
  state.busy = true;
  updateMoveControls(card, state);
  setFeedback(card, "neutral", options.automatic ? `Playing ${move.san} and analyzing…` : `Analyzing ${move.san}…`);
  try {
    if (state.chess.isGameOver()) {
      finishGamePosition(card, state, move, options, wasSolve, beforeEvalWhite);
      return;
    }
    const engine = await ensureEngine();
    const baselineInfo = wasSolve
      ? (options.baselineInfo || await engine.analyze(state.puzzle.fen, PUZZLE_NODES))
      : null;
    if (baselineInfo) beforeEvalWhite = baselineInfo.whiteCp;
    const info = await engine.analyze(state.chess.fen(), PUZZLE_NODES);
    state.lastInfo = info;
    state.lastInfoFen = state.chess.fen();
    state.mode = "explore";
    state.currentEvalWhite = info.whiteCp;
    state.busy = false;
    updateMoveControls(card, state);
    updateEval(card, info.whiteCp, info.whiteText);
    $(".turn", card).textContent = state.chess.turn() === "w" ? "white to move" : "black to move";
    const attemptedUci = moveUci(move);
    const playerBefore = move.color === "w" ? beforeEvalWhite : -beforeEvalWhite;
    const playerAfter = move.color === "w" ? info.whiteCp : -info.whiteCp;
    const loss = Math.max(0, playerBefore - playerAfter);
    const confirmedTarget = wasSolve && sameMove(attemptedUci, baselineInfo?.bestUci);
    const storedTarget = wasSolve && sameMove(attemptedUci, state.puzzle.bestUci);
    const isTarget = confirmedTarget || (storedTarget && loss < ALTERNATIVE_TOLERANCE_CP);
    const isStrongAlternative = wasSolve && !isTarget && loss < ALTERNATIVE_TOLERANCE_CP;
    const countedCorrect = !options.revealed && (isTarget || isStrongAlternative);
    if (wasSolve) {
      state.solved = countedCorrect || Boolean(options.revealed);
      state.canFinish = state.solved;
      state.retry = state.solved
        ? null
        : {
            ply: 0,
            evalWhite: beforeEvalWhite,
            info: baselineInfo,
            evalText: baselineInfo?.whiteText,
            wasSolved: false,
          };
    } else if (!options.automatic && loss >= ALTERNATIVE_TOLERANCE_CP) {
      state.retry = {
        ply: retryPly,
        evalWhite: beforeEvalWhite,
        info: previousInfo,
        evalText: previousInfo?.whiteText,
        wasSolved: previousSolved,
      };
      state.canFinish = false;
    } else {
      state.retry = null;
      state.canFinish = state.solved;
    }
    if (options.revealed) {
      setFeedback(card, "hint", `Answer: ${move.san}. Review why it works, then move on or try again.`);
      $(".explanation", card).textContent = explainTargetMove(state.puzzle, move, info);
    } else if (isTarget) {
      setFeedback(card, "correct", `Correct — ${move.san}. Review the idea, then move to the next position.`);
      $(".explanation", card).textContent = explainTargetMove(state.puzzle, move, info);
    } else if (isStrongAlternative) {
      setFeedback(card, "correct", `Strong alternative. ${move.san} stays within half a pawn of Stockfish's choice, so it counts as correct.`);
      $(".explanation", card).textContent = `Stockfish's first choice is ${bestSan(new Chess(state.puzzle.fen), baselineInfo?.bestUci)}, but your move preserves essentially the same result.`;
    } else {
      const verdict = info.whiteText.includes("M") && playerAfter < 0
        ? "The opponent now has a forced mate."
        : loss < 50
          ? "This is a playable alternative."
          : loss < 150
            ? "This gives away a small part of your advantage."
            : loss < 300
              ? "This gives the opponent a clear chance."
              : "This changes the position significantly in the opponent’s favor.";
      setFeedback(card, loss < 50 ? "neutral" : "incorrect", `${options.automatic ? "Engine played" : "Played"} ${move.san}. ${verdict}`);
      $(".explanation", card).textContent = wasSolve
        ? explainWrongMove(state.puzzle, move, state.chess, info)
        : `From this branch, Stockfish now recommends ${bestSan(state.chess, info.bestUci)}.`;
    }
    $(".line", card).textContent = principalVariation(state.chess, info.pv);
    showExploreControls(card, state);
    if (wasSolve) {
      recordInitialSolve(card, state, {
        correct: countedCorrect,
        revealed: Boolean(options.revealed),
        moveUci: attemptedUci,
        loss,
      });
    }
  } catch (error) {
    state.busy = false;
    updateMoveControls(card, state);
    setFeedback(card, "incorrect", `Analysis failed: ${error.message}`);
  }
}

function bestSan(chess, uci) {
  const copy = new Chess(chess.fen());
  return uciMove(copy, uci)?.san || uci || "—";
}

function principalVariation(chess, pv) {
  if (!pv?.length) return "";
  const copy = new Chess(chess.fen());
  const san = [];
  pv.slice(0, 6).forEach((uci) => {
    const move = uciMove(copy, uci);
    if (move) san.push(move.san);
  });
  return san.length ? `Engine line: ${san.join(" ")}` : "";
}

function targetMoveReason(puzzle, move) {
  const theme = (puzzle.theme || "").toLowerCase();
  const san = move?.san || puzzle.bestSan || "";
  const captured = move?.captured || puzzle.bestMoveCaptured;
  if (san.includes("#")) return "it ends the calculation with mate.";
  if (captured) return `it wins or removes the ${pieceName(captured)} with tempo.`;
  if (san.includes("+") || puzzle.bestMoveIsCheck) return "it starts with check, which sharply limits the opponent's replies.";
  if (theme.includes("missed")) return "it is the forcing resource available in the position.";
  if (theme.includes("hanging") || theme.includes("hung")) return "it solves the immediate safety problem before the opponent can cash in.";
  if (theme.includes("opening")) return "it better serves development, center control, or king safety.";
  if (theme.includes("endgame")) return "it preserves activity or a critical tempo.";
  return "it best limits the opponent's forcing replies.";
}

function explainTargetMove(puzzle, move, info = null) {
  const targetAfter = info ? cpForSide(info.whiteCp, puzzle.color) : null;
  const gameAfter = puzzle.afterUserCp ?? cpForSide(puzzle.evalAfterWhite, puzzle.color);
  const gain = Number.isFinite(targetAfter) ? Math.max(0, Math.round(targetAfter - gameAfter)) : puzzle.lossCp;
  const comparison = gain >= 50
    ? `Compared with your game move ${puzzle.playedSan}, this is about ${(gain / 100).toFixed(1)} pawns better.`
    : `It keeps the position at least as healthy as your game move ${puzzle.playedSan}.`;
  return `Why ${move?.san || puzzle.bestSan} works: ${targetMoveReason(puzzle, move)} ${comparison}`;
}

function explainGameMove(puzzle) {
  const before = puzzle.beforeUserCp ?? cpForSide(puzzle.evalBeforeWhite, puzzle.color);
  const after = puzzle.afterUserCp ?? cpForSide(puzzle.evalAfterWhite, puzzle.color);
  const drop = Math.max(0, Math.round(before - after));
  return `In the game you played ${puzzle.playedSan}. The stronger move was ${puzzle.bestSan}. Your move changed the evaluation from ${cpText(before)} to ${cpText(after)}, a swing of about ${((drop || puzzle.lossCp) / 100).toFixed(1)} pawns. Reveal the answer to see the better idea.`;
}

function explainWrongMove(puzzle, move, chess, info) {
  const isGameMove = moveUci(move).slice(0, 4) === String(puzzle.playedUci || "").slice(0, 4);
  const target = `The target is ${puzzle.bestSan}: ${targetMoveReason(puzzle, null)}`;
  const gameNote = isGameMove
    ? explainGameMove(puzzle)
    : `In your actual game, you played ${puzzle.playedSan}; this card's target is ${puzzle.bestSan}.`;
  return `${gameNote} ${target}. From this new position, Stockfish recommends ${bestSan(chess, info?.bestUci)}.`;
}

function showGameMove(card, state) {
  if (state.busy) return;
  state.selected = null;
  state.usedGameMove = true;
  markMoveSquares(card, state.puzzle.playedUci);
  setFeedback(card, "hint", `Your game move was ${state.puzzle.playedSan}.`);
  const explanation = $(".explanation", card);
  explanation.hidden = false;
  explanation.textContent = explainGameMove(state.puzzle);
}

function firstHintForPuzzle(puzzle) {
  const san = puzzle.bestSan || "";
  if (san.includes("#")) return "There is a checkmating move. Start with every forcing check.";
  if (san.includes("+") || puzzle.bestMoveIsCheck) return "Start with checks. One of them sharply limits the reply.";
  if (puzzle.bestMoveCaptured) return "Start with forcing captures, then check whether the capturing piece stays safe.";
  const theme = String(puzzle.theme || "").toLowerCase();
  if (theme.includes("opening")) return "Prioritize development, center control, and king safety.";
  if (theme.includes("endgame")) return "Look for the move that improves activity or gains a tempo.";
  return "List the forcing moves first: checks, captures, and direct threats.";
}

function givePuzzleHint(card, state) {
  if (state.busy || state.hintLevel >= 2) return;
  state.usedHint = true;
  state.hintLevel += 1;
  const button = $("button.hint", card);
  if (state.hintLevel === 1) {
    setFeedback(card, "hint", firstHintForPuzzle(state.puzzle));
    button.textContent = "Stronger hint";
    return;
  }
  const from = String(state.puzzle.bestUci || "").slice(0, 2);
  const piece = new Chess(state.puzzle.fen).get(from);
  clearBoardMarks(card);
  $(`[data-square="${from}"]`, card)?.classList.add("selected");
  setFeedback(card, "hint", `Focus on the ${pieceName(piece?.type)} on ${from}. The destination is still yours to find.`);
  button.textContent = "Hints used";
  button.disabled = true;
}

function finishAndAdvance(card, state, disposition) {
  const wasReviewDeck = activeDeck === "review";
  setPuzzleDisposition(state.puzzle, disposition);
  updateCardReviewState(card, state.puzzle);
  updateDeckTabs();
  showExploreControls(card, state);
  const puzzlesAfter = activePuzzles();

  if (wasReviewDeck && disposition === "got-it") {
    if (!puzzlesAfter.length) {
      activeDeck = todayQueueIds.length ? "today" : "all";
      const nextDeck = activePuzzles();
      const completedId = state.puzzle.id || puzzleId(state.puzzle);
      const completedIndex = nextDeck.findIndex((puzzle) => (puzzle.id || puzzleId(puzzle)) === completedId);
      activePuzzleIndex = nextDeck.length > 1 && completedIndex >= 0
        ? (completedIndex + 1) % nextDeck.length
        : 0;
    } else {
      activePuzzleIndex = clampIndex(activePuzzleIndex, puzzlesAfter.length);
    }
    renderPuzzles();
    $("#puzzle-mode")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  if (activePuzzleIndex < puzzlesAfter.length - 1) {
    activePuzzleIndex += 1;
    renderPuzzles();
    $("#puzzle-mode")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  setFeedback(
    card,
    "correct",
    disposition === "review"
      ? "Saved to Review. You’re at the end of this set."
      : "Got it. You’re at the end of this set."
  );
  card.querySelectorAll(".finish-actions button").forEach((button) => { button.disabled = true; });
}

async function revealPuzzleAnswer(card, state) {
  if (state.busy) return;
  resetPuzzle(card, state);
  state.busy = true;
  updateMoveControls(card, state);
  setFeedback(card, "neutral", "Confirming the strongest move…");
  try {
    const baselineInfo = await (await ensureEngine()).analyze(state.puzzle.fen, PUZZLE_NODES);
    const move = uciMove(state.chess, baselineInfo.bestUci || state.puzzle.bestUci);
    if (!move) throw new Error("Stockfish did not return a legal answer");
    state.busy = false;
    renderBoard(card, state);
    await analyzePuzzleMove(card, state, move, { baselineInfo, revealed: true });
  } catch (error) {
    state.busy = false;
    updateMoveControls(card, state);
    setFeedback(card, "incorrect", `Answer failed: ${error.message}`);
  }
}

function createPuzzleCard(puzzle, index) {
  const card = document.createElement("article");
  card.className = "puzzle";
  const prompt = "Find the strongest move.";
  const status = reviewStatusFor(puzzle);
  const side = puzzle.color === "w" ? "White" : "Black";
  card.innerHTML = `
    <div class="puzzle-head"><div class="puzzle-title"><span class="eyebrow">${escapeHtml(puzzle.theme)}</span><span class="review-state ${status.key}">${status.label}</span></div><a href="${escapeHtml(puzzle.gameUrl)}" aria-label="Open the original game">Original game ↗</a></div>
    <div class="evaluation">
      <div class="eval-bar"><span class="eval-needle"></span></div>
      <div class="eval-meta"><span class="eval-label"></span><span class="turn"></span></div>
    </div>
    <div class="board" aria-label="Playable chess position"></div>
    <div class="position-brief">
      <p class="position-meta">Position ${index + 1} · ${side} to move</p>
      <p class="prompt">${prompt}</p>
    </div>
    <p class="feedback neutral" aria-live="polite">Make your move.</p>
    <div class="controls">
      <button class="hint" type="button">Hint</button>
      <button class="game-move" type="button">My move</button>
      <button class="answer" type="button">Reveal answer</button>
      <button class="retry" type="button" hidden>Try again</button>
    </div>
    <div class="finish-actions" aria-label="Finish this position" hidden>
      <button class="got-it" type="button">Got it, next →</button>
      <button class="save-review" type="button" aria-pressed="false">Review later</button>
    </div>
    <details class="advanced-controls" hidden>
      <summary>Play the continuation</summary>
      <div class="advanced-actions">
        <button class="back-move" type="button" disabled>← Back</button>
        <button class="engine" type="button" hidden>Best reply →</button>
      </div>
      <p class="line" hidden></p>
    </details>
    <p class="explanation" hidden></p>`;
  const state = {
    puzzle,
    chess: new Chess(puzzle.fen),
    selected: null,
    busy: false,
    mode: "solve",
    lastInfo: null,
    lastInfoFen: "",
    currentEvalWhite: puzzle.evalBeforeWhite,
    startedAt: Date.now(),
    usedHint: false,
    usedGameMove: false,
    hintLevel: 0,
    solved: false,
    canFinish: false,
    retry: null,
  };
  renderBoard(card, state);
  updateEval(card, state.currentEvalWhite);
  $(".turn", card).textContent = state.chess.turn() === "w" ? "white to move" : "black to move";

  $("button.hint", card).addEventListener("click", () => givePuzzleHint(card, state));
  $(".answer", card).addEventListener("click", () => revealPuzzleAnswer(card, state));
  $(".game-move", card).addEventListener("click", () => showGameMove(card, state));
  $(".back-move", card).addEventListener("click", () => undoPuzzleMove(card, state));
  $(".engine", card).addEventListener("click", () => playEngineMove(card, state));
  $(".retry", card).addEventListener("click", () => retryPuzzleMove(card, state));
  $(".got-it", card).addEventListener("click", () => finishAndAdvance(card, state, "got-it"));
  $(".save-review", card).addEventListener("click", () => finishAndAdvance(card, state, "review"));
  updateMoveControls(card, state);
  return card;
}

function resetPuzzle(card, state) {
  state.chess = new Chess(state.puzzle.fen);
  state.selected = null;
  state.busy = false;
  state.mode = "solve";
  state.lastInfo = null;
  state.lastInfoFen = "";
  state.currentEvalWhite = state.puzzle.evalBeforeWhite;
  state.startedAt = Date.now();
  state.usedHint = false;
  state.usedGameMove = false;
  state.hintLevel = 0;
  state.solved = false;
  state.canFinish = false;
  state.retry = null;
  renderBoard(card, state);
  updateEval(card, state.currentEvalWhite);
  $(".turn", card).textContent = state.chess.turn() === "w" ? "white to move" : "black to move";
  showSolveControls(card, state);
  setFeedback(card, "neutral", "Make your move.");
}

async function startAnalysis(username, filterIds = selectedFilterIds()) {
  currentUsername = username.trim().toLowerCase();
  if (!currentUsername) return;
  const selected = normalizeFilterIds(filterIds);
  if (!selected.length) {
    showError("Choose game types", "Pick at least one game type before analyzing. Daily + 10-minute rapid is the recommended starting profile.");
    return;
  }
  cancelled = false;
  localStorage.setItem("lastUsername", currentUsername);
  localStorage.setItem("lastFilterIds", JSON.stringify(selected));
  showView("#working");
  setProgress(3, "Starting the on-device engine…", "Loading Stockfish 18");
  try {
    await ensureEngine();
    currentCurriculum = await loadCurriculum(currentUsername, selected);
    const beforePositions = currentCurriculum.positions.length;
    const loaded = await loadRecentGames(
      currentUsername,
      selected,
      currentCurriculum.analyzedGameUrls
    );
    if (!loaded.games.length) {
      if (!currentCurriculum.positions.length) {
        throw new Error("No unanalyzed games were available for this profile.");
      }
      analysisMessage = "Your position bank is current for the available game history.";
      currentReport = cumulativeReport(currentCurriculum);
      renderReport(currentReport, { resumePuzzle: true });
      return;
    }
    const scanReport = await analyzeGames(currentUsername, loaded);
    if (cancelled) return;
    const merged = await mergeReportIntoCurriculum(scanReport, currentCurriculum);
    currentCurriculum = merged.curriculum;
    const report = merged.report;
    saveReport(report);
    const added = Math.max(0, currentCurriculum.positions.length - beforePositions);
    analysisMessage = `${loaded.games.length} games analyzed · ${added} new unique position${added === 1 ? "" : "s"} added.`;
    if (loaded.remainingEligibleGames > 0) {
      analysisMessage += ` ${loaded.remainingEligibleGames} more eligible games are ready for another scan.`;
    }
    setProgress(100, "Curriculum updated", `${currentCurriculum.positions.length} unique personal positions saved`);
    renderReport(report);
  } catch (error) {
    if (cancelled || error.message === "Cancelled") {
      showView("#onboarding");
      return;
    }
    showError("Analysis stopped", error.message || String(error));
  }
}

$("#username-form").addEventListener("submit", (event) => {
  event.preventDefault();
  startAnalysis($("#username").value, selectedFilterIds());
});
$("#cancel-analysis").addEventListener("click", () => {
  cancelled = true;
  showView("#onboarding");
});
$("#retry-analysis").addEventListener("click", () => startAnalysis(currentUsername || $("#username").value, selectedFilterIds()));
$("#change-player").addEventListener("click", () => showView("#onboarding"));
$("#error-change-player").addEventListener("click", () => showView("#onboarding"));
$("#analyze-more").addEventListener("click", () => startAnalysis(
  currentReport?.username || currentUsername || $("#username").value,
  currentReport?.filterIds || selectedFilterIds()
));
$("#puzzle-prev").addEventListener("click", () => {
  activePuzzleIndex = clampIndex(activePuzzleIndex - 1, activePuzzles().length);
  renderPuzzles();
  $("#puzzle-mode")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#puzzle-next").addEventListener("click", () => {
  activePuzzleIndex = clampIndex(activePuzzleIndex + 1, activePuzzles().length);
  renderPuzzles();
  $("#puzzle-mode")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#deck-today").addEventListener("click", () => {
  const progress = loadPuzzleProgress(currentReport);
  activeDeck = "today";
  activePuzzleIndex = clampIndex(progress.indexes?.today, activePuzzles().length);
  renderPuzzles();
});
$("#deck-all").addEventListener("click", () => {
  const progress = loadPuzzleProgress(currentReport);
  activeDeck = "all";
  activePuzzleIndex = clampIndex(progress.indexes?.all, activePuzzles().length);
  renderPuzzles();
});
$("#deck-review").addEventListener("click", () => {
  const progress = loadPuzzleProgress(currentReport);
  activeDeck = "review";
  activePuzzleIndex = clampIndex(progress.indexes?.review, activePuzzles().length);
  renderPuzzles();
});
document.querySelectorAll('input[name="game-filter"]').forEach((input) => {
  input.addEventListener("change", updateGameFilterSummary);
});
const androidDownload = $("#download-android");
if (androidDownload) androidDownload.hidden = window.location.protocol === "file:";

const remembered = localStorage.getItem("lastUsername") || "sonyjared";
$("#username").value = remembered;
let rememberedFilters = DEFAULT_FILTER_IDS;
try {
  rememberedFilters = normalizeFilterIds(JSON.parse(localStorage.getItem("lastFilterIds") || "null"));
  if (!rememberedFilters.length) rememberedFilters = DEFAULT_FILTER_IDS;
} catch {
  rememberedFilters = DEFAULT_FILTER_IDS;
}
setSelectedFilterIds(rememberedFilters);
const cached = loadCachedReport(remembered, rememberedFilters);

async function boot() {
  try {
    currentUsername = remembered;
    currentCurriculum = await loadCurriculum(remembered, rememberedFilters);
    if (cached?.puzzleDecks || cached?.puzzles?.length) {
      const migrated = await mergeReportIntoCurriculum(cached, currentCurriculum);
      currentCurriculum = migrated.curriculum;
      currentReport = migrated.report;
      saveReport(currentReport);
    } else if (currentCurriculum.positions.length) {
      currentReport = cumulativeReport(currentCurriculum, cached || currentCurriculum.reportSummary);
    }
    if (currentReport?.puzzleDecks?.all?.length) {
      analysisMessage = "Your permanent personal position bank is ready.";
      renderReport(currentReport, { resumePuzzle: true });
    } else {
      showView("#onboarding");
    }
  } catch {
    showView("#onboarding");
  }
}

boot();
