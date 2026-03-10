const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const AITUNNEL_API_KEY = (process.env.AITUNNEL_API_KEY || "").trim();
const AITUNNEL_BASE_URL = String(process.env.AITUNNEL_BASE_URL || "https://api.aitunnel.ru/v1")
  .trim()
  .replace(/\/+$/g, "");
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-3-flash-preview").trim();
const TASK_SUPPORT_MODES = new Set(["adjacent", "row", "column", "rook", "global"]);

function parseBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeSupportMode(value, fallback = "adjacent") {
  const mode = String(value || "").trim().toLowerCase();
  return TASK_SUPPORT_MODES.has(mode) ? mode : fallback;
}

function sanitizeTaskConfig(raw = {}) {
  return {
    supportMode: normalizeSupportMode(raw.supportMode, "adjacent"),
    fallbackMode: normalizeSupportMode(raw.fallbackMode, "global"),
    neighborRadius: clampInt(raw.neighborRadius, 1, 3, 1),
    requireDifferentArticle: parseBool(raw.requireDifferentArticle, false)
  };
}

const SERVER_TASK_CONFIG = sanitizeTaskConfig({
  supportMode: process.env.TASK_SUPPORT_MODE || "adjacent",
  fallbackMode: process.env.TASK_FALLBACK_MODE || "global",
  neighborRadius: process.env.TASK_NEIGHBOR_RADIUS || 1,
  requireDifferentArticle: process.env.TASK_REQUIRE_DIFFERENT_ARTICLE || false
});

const PHASE = {
  SETUP_WORDS: "setup_words",
  PLAYER_MOVE: "player_move",
  PLAYER_BLOCK: "player_block",
  AWAIT_SENTENCE: "await_sentence",
  COMPUTER_TURN: "computer_turn",
  GAME_OVER: "game_over"
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.use(express.static(__dirname));

app.get("/", (_req, res) => res.redirect("/student.html"));
app.get("/student", (_req, res) => res.redirect("/student.html"));
app.get("/teacher", (_req, res) => res.redirect("/teacher.html"));
app.get("/health", (_req, res) => res.json({
  ok: true,
  time: Date.now(),
  aiProvider: "aitunnel",
  aiModel: GEMINI_MODEL,
  aiBaseUrl: AITUNNEL_BASE_URL,
  hasApiKey: Boolean(AITUNNEL_API_KEY)
}));

function createMatrix(size, value) {
  return Array.from({ length: size }, () => Array(size).fill(value));
}

function centerForSize(size) {
  return { r: Math.floor(size / 2), c: Math.floor(size / 2) };
}

function createOpenedCells(size, marker) {
  const opened = createMatrix(size, false);
  opened[marker.r][marker.c] = true;
  return opened;
}

function makeState(size = 7) {
  const marker = centerForSize(size);
  return {
    size,
    phase: PHASE.SETUP_WORDS,
    currentTurn: "player",
    wordPool: [],
    boardWordIds: createMatrix(size, null),
    blocked: createMatrix(size, false),
    marker,
    openedCells: createOpenedCells(size, marker),
    openedCount: 1,
    requiredWords: [],
    currentTask: null,
    pendingAction: null,
    taskSeq: 0,
    taskConfig: { ...SERVER_TASK_CONFIG },
    sentenceText: "",
    sentenceSubmitted: false,
    feedback: "",
    info: "Ожидание загрузки слов.",
    aiThinking: false,
    gameOver: false,
    winner: ""
  };
}

let state = makeState(7);
let busyComputerTurn = false;

function inBounds(size, r, c) {
  return r >= 0 && c >= 0 && r < size && c < size;
}

function getWordById(id) {
  return state.wordPool.find((w) => w.id === id) || null;
}

function getWordAt(r, c) {
  const id = state.boardWordIds[r][c];
  if (id == null) return "";
  const item = getWordById(id);
  return item ? item.word : "";
}

function boardAssignedCount() {
  let count = 0;
  for (let r = 0; r < state.size; r += 1) {
    for (let c = 0; c < state.size; c += 1) {
      if (state.boardWordIds[r][c] != null) count += 1;
    }
  }
  return count;
}

function allBoardCellsAssigned() {
  return boardAssignedCount() === state.size * state.size;
}

function recomputeUsedFlags() {
  const usedIds = new Set();
  for (let r = 0; r < state.size; r += 1) {
    for (let c = 0; c < state.size; c += 1) {
      const id = state.boardWordIds[r][c];
      if (id != null) usedIds.add(id);
    }
  }
  for (const item of state.wordPool) {
    item.used = usedIds.has(item.id);
  }
}

function getLegalMoves(markerRef, blockedRef) {
  const marker = markerRef || state.marker;
  const blocked = blockedRef || state.blocked;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];
  const out = [];

  for (const [dr, dc] of dirs) {
    let r = marker.r + dr;
    let c = marker.c + dc;
    while (inBounds(state.size, r, c) && !blocked[r][c]) {
      out.push({ r, c });
      r += dr;
      c += dc;
    }
  }
  return out;
}

function getLegalBlocks(markerRef, blockedRef) {
  const marker = markerRef || state.marker;
  const blocked = blockedRef || state.blocked;
  const out = [];

  for (let r = 0; r < state.size; r += 1) {
    for (let c = 0; c < state.size; c += 1) {
      if (!blocked[r][c] && !(marker.r === r && marker.c === c)) {
        out.push({ r, c });
      }
    }
  }
  return out;
}

function hasAnyMove() {
  return getLegalMoves().length > 0;
}

function evaluatePressure(pos, blocked) {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];
  let walls = 0;
  for (const [dr, dc] of dirs) {
    const nr = pos.r + dr;
    const nc = pos.c + dc;
    if (!inBounds(state.size, nr, nc) || blocked[nr][nc]) walls += 1;
  }
  return walls;
}

function chooseComputerAction() {
  const moves = getLegalMoves(state.marker, state.blocked);
  if (moves.length === 0) return null;

  let bestScore = -Infinity;
  let best = [];

  for (const move of moves) {
    const blocks = getLegalBlocks(move, state.blocked);
    for (const block of blocks) {
      const sim = state.blocked.map((row) => row.slice());
      sim[block.r][block.c] = true;
      const nextMoves = getLegalMoves(move, sim).length;
      const score = -nextMoves * 100 + evaluatePressure(move, sim) * 8 + Math.random() * 0.2;
      if (score > bestScore) {
        bestScore = score;
        best = [{ move, block }];
      } else if (score === bestScore) {
        best.push({ move, block });
      }
    }
  }

  return best[Math.floor(Math.random() * best.length)] || null;
}

function parseGermanWord(lineRaw) {
  let line = String(lineRaw || "").trim();
  if (!line) return "";

  const pairMatch = line.match(/^(.*?)(?:\s[-–—:|]\s|\t)(.+)$/u);
  if (pairMatch) {
    line = pairMatch[1].trim();
  } else {
    const cyr = line.search(/[А-Яа-яЁё]/u);
    if (cyr > 0) line = line.slice(0, cyr).trim();
  }

  line = line.replace(/[.,;:]+$/g, "").trim();
  return line;
}

function parseWordContainer(raw) {
  const text = String(raw || "");
  let lines = text
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    lines = text
      .split(/[;,]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return lines
    .map(parseGermanWord)
    .map((s) => s.trim())
    .filter(Boolean);
}

function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function extractArticle(word) {
  const token = String(word || "").trim().toLowerCase().split(/\s+/)[0];
  return ["der", "die", "das"].includes(token) ? token : "";
}

function matchesSupportMode(origin, target, mode, radius) {
  const dr = Math.abs(target.r - origin.r);
  const dc = Math.abs(target.c - origin.c);
  if (dr === 0 && dc === 0) return false;

  switch (mode) {
    case "adjacent":
      return Math.max(dr, dc) <= radius;
    case "row":
      return target.r === origin.r;
    case "column":
      return target.c === origin.c;
    case "rook":
      return target.r === origin.r || target.c === origin.c;
    case "global":
    default:
      return true;
  }
}

function collectSupportWords(cell, mode, radius, primaryArticle, requireDifferentArticle) {
  const words = [];
  for (let r = 0; r < state.size; r += 1) {
    for (let c = 0; c < state.size; c += 1) {
      if (!matchesSupportMode(cell, { r, c }, mode, radius)) continue;
      const word = getWordAt(r, c);
      if (!word) continue;

      if (requireDifferentArticle && primaryArticle) {
        const candidateArticle = extractArticle(word);
        if (candidateArticle && candidateArticle === primaryArticle) continue;
      }

      words.push(word);
    }
  }
  return words;
}

function pickSupportWord(cell, primaryWord) {
  const cfg = sanitizeTaskConfig(state.taskConfig || SERVER_TASK_CONFIG);
  const primaryArticle = extractArticle(primaryWord);

  let words = collectSupportWords(
    cell,
    cfg.supportMode,
    cfg.neighborRadius,
    primaryArticle,
    cfg.requireDifferentArticle
  );

  if (words.length === 0 && cfg.fallbackMode !== cfg.supportMode) {
    words = collectSupportWords(
      cell,
      cfg.fallbackMode,
      cfg.neighborRadius,
      primaryArticle,
      cfg.requireDifferentArticle
    );
  }

  // Last fallback: relax article restriction, but keep geometric mode.
  if (words.length === 0 && cfg.requireDifferentArticle) {
    words = collectSupportWords(cell, cfg.supportMode, cfg.neighborRadius, primaryArticle, false);
    if (words.length === 0 && cfg.fallbackMode !== cfg.supportMode) {
      words = collectSupportWords(cell, cfg.fallbackMode, cfg.neighborRadius, primaryArticle, false);
    }
  }

  if (words.length === 0) return primaryWord;
  const idx = Math.abs((cell.r + 1) * 37 + (cell.c + 1) * 19 + state.openedCount + state.taskSeq) % words.length;
  return words[idx];
}

function buildCellTask(actionType, cell) {
  const primaryWord = getWordAt(cell.r, cell.c) || "Wort";
  const supportWord = pickSupportWord(cell, primaryWord);
  const pairTemplates = [
    (a, b) => `Сформулируйте Imperativ с словами "${a}" и "${b}".`,
    (a, b) => `Составьте предложение с определённым артиклем для "${a}" и добавьте "${b}".`,
    (a, b) => `Составьте предложение, где "${a}" стоит во множественном числе, и используйте "${b}".`
  ];
  const singleTemplates = [
    (a) => `Сформулируйте Imperativ со словом "${a}".`,
    (a) => `Составьте предложение с определённым артиклем для "${a}".`,
    (a) => `Составьте предложение, где "${a}" стоит во множественном числе.`
  ];
  const idx = Math.abs(cell.r * 31 + cell.c * 17 + state.openedCount + (actionType === "block" ? 5 : 0)) % pairTemplates.length;
  state.taskSeq += 1;
  const hasSupportWord = supportWord && supportWord !== primaryWord;
  const prompt = hasSupportWord
    ? pairTemplates[idx](primaryWord, supportWord)
    : singleTemplates[idx](primaryWord);

  return {
    id: state.taskSeq,
    actionType,
    cell: { r: cell.r, c: cell.c },
    primaryWord,
    supportWord,
    prompt,
    requiredWords: hasSupportWord ? [primaryWord, supportWord] : [primaryWord]
  };
}

async function generateCellTask(actionType, cell, topic) {
  const primaryWord = getWordAt(cell.r, cell.c) || "Wort";
  const supportWord = pickSupportWord(cell, primaryWord);
  const hasSupportWord = supportWord && supportWord !== primaryWord;
  const requiredWords = hasSupportWord ? [primaryWord, supportWord] : [primaryWord];

  const topicStr = String(topic || "").trim();
  const wordsStr = requiredWords.map((word) => `"${word}"`).join(", ");
  const promptText = topicStr
    ? `Ты преподаватель немецкого языка. Составь одно задание на русском языке, где ученик должен использовать следующие немецкие слова: ${wordsStr}.
ГЛАВНАЯ ИНСТРУКЦИЯ: ${topicStr}
Строго следуй этой инструкции. Адаптируй сложность, формат (диалог, ситуация, экзамен и т.д.), возраст и грамматику ИМЕННО ТАК, как указано в главной инструкции. Ничего не выдумывай от себя, если это противоречит инструкции. Выведи только текст задания.`
    : `Ты креативный гейм-мастер. Составь одно увлекательное задание на русском языке, где ученик должен использовать немецкие слова: ${wordsStr}. Придумай интересную мини-ситуацию (например, элементы легких приключений, интересных схваток или бытовая комедия), но так, чтобы она была приемлема для любого возраста (в том числе для детей 11 лет, то есть без шок-контента). Текст должен быть коротким (1-2 предложения). Выведи только текст задания.`;

  let generatedPrompt = "";
  try {
    generatedPrompt = (await callGemini(promptText)).trim();
  } catch (err) {
    console.error("Gemini task error:", {
      model: GEMINI_MODEL,
      actionType,
      cell,
      topic: topicStr || "(fallback)",
      requiredWords,
      error: err?.message || String(err)
    });
    throw err;
  }

  state.taskSeq += 1;
  return {
    id: state.taskSeq,
    actionType,
    cell: { r: cell.r, c: cell.c },
    primaryWord,
    supportWord,
    prompt: generatedPrompt,
    requiredWords
  };
}

function clearSentenceStage() {
  state.requiredWords = [];
  state.currentTask = null;
  state.pendingAction = null;
  state.sentenceText = "";
  state.sentenceSubmitted = false;
}

async function startTaskStage(actionType, cell, topic) {
  state.pendingAction = {
    type: actionType,
    target: { r: cell.r, c: cell.c },
    from: { ...state.marker }
  };
  state.currentTask = null;
  state.requiredWords = [];
  state.sentenceText = "";
  state.sentenceSubmitted = false;
  state.aiThinking = true;
  state.feedback = "Генерация задания...";
  state.info = "Генерация задания...";
  emitState();

  const task = await generateCellTask(actionType, cell, topic);
  state.currentTask = task;
  state.requiredWords = task.requiredWords.slice();
  state.sentenceText = "";
  state.sentenceSubmitted = false;
  state.phase = PHASE.AWAIT_SENTENCE;
  state.aiThinking = false;
  state.feedback = "Сформулируйте ответ и отправьте учителю.";
  state.info = actionType === "move"
    ? "Проверка задания для перемещения маркера."
    : "Проверка задания для блокировки клетки.";
  emitState();
}

function markOpened(cell) {
  if (!state.openedCells[cell.r][cell.c]) {
    state.openedCells[cell.r][cell.c] = true;
    state.openedCount += 1;
  }
}

function finalizeApprovedMove() {
  const pending = state.pendingAction;
  if (!pending || pending.type !== "move") return null;

  const from = { ...pending.from };
  const to = { ...pending.target };
  state.marker = to;
  state.currentTurn = "player";
  markOpened(to);

  clearSentenceStage();
  state.phase = PHASE.PLAYER_BLOCK;
  state.feedback = "Перемещение подтверждено. Теперь выберите клетку для блокировки.";
  state.info = `Открыто слов: ${state.openedCount}. Требуется выполнить блокировку другой клетки.`;

  if (getLegalBlocks().length === 0) {
    state.phase = PHASE.GAME_OVER;
    state.gameOver = true;
    state.winner = "computer";
    state.feedback = "Нет доступных клеток для обязательной блокировки.";
    state.info = "Игрок заперт: обязательную блокировку выполнить нельзя.";
  }

  return { from, to };
}

function finalizeApprovedBlock() {
  const pending = state.pendingAction;
  if (!pending || pending.type !== "block") return null;

  const cell = { ...pending.target };
  state.blocked[cell.r][cell.c] = true;
  state.currentTurn = "computer";

  clearSentenceStage();
  state.phase = PHASE.COMPUTER_TURN;
  state.feedback = "Проверка пройдена. Ход передан компьютеру.";
  state.info = "Компьютер начинает ход.";
  return cell;
}

function payloadState() {
  return {
    ...state,
    boardWords: state.boardWordIds.map((row, r) => row.map((id, c) => {
      if (id == null) return "";
      return getWordAt(r, c);
    }))
  };
}

function emitState(extra = {}) {
  io.emit("state:update", {
    state: payloadState(),
    ...extra
  });
}

function sendError(socket, message) {
  socket.emit("action:error", { message });
}

function setSize(size) {
  const preservedTaskConfig = state?.taskConfig ? { ...state.taskConfig } : { ...SERVER_TASK_CONFIG };
  state = makeState(size);
  state.taskConfig = sanitizeTaskConfig(preservedTaskConfig);
}

function centerMarker() {
  return centerForSize(state.size);
}

function resetRound({ preserveBoardWords = true } = {}) {
  if (!preserveBoardWords) {
    state.boardWordIds = createMatrix(state.size, null);
  }

  state.blocked = createMatrix(state.size, false);
  state.marker = centerMarker();
  state.openedCells = createOpenedCells(state.size, state.marker);
  state.openedCount = 1;
  state.currentTurn = "player";
  state.taskSeq = 0;
  state.taskConfig = sanitizeTaskConfig(state.taskConfig || SERVER_TASK_CONFIG);
  clearSentenceStage();
  state.feedback = "";
  state.aiThinking = false;
  state.gameOver = false;
  state.winner = "";

  if (allBoardCellsAssigned()) {
    state.phase = PHASE.PLAYER_MOVE;
    state.info = "Ход игрока. Маркер находится в центре поля.";
  } else {
    state.phase = PHASE.SETUP_WORDS;
    state.info = "Подготовка поля.";
  }

  recomputeUsedFlags();
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(prompt) {
  if (!AITUNNEL_API_KEY) {
    throw new Error("AITUNNEL_API_KEY не задан на сервере.");
  }

  const url = `${AITUNNEL_BASE_URL}/chat/completions`;
  const body = {
    model: GEMINI_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 800
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AITUNNEL_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`AITunnel API ${resp.status} [${GEMINI_MODEL}]: ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      return "";
    }).join("\n").trim()
    : String(content || "").trim();
  if (!text) throw new Error("Gemini вернул пустой ответ.");
  return text;
}

function checkWordOrderLocal(requiredWords, sentence) {
  const s = String(sentence || "").toLowerCase();
  let idx = -1;
  for (const word of requiredWords) {
    const p = s.indexOf(String(word).toLowerCase(), idx + 1);
    if (p < 0) return false;
    idx = p;
  }
  return true;
}

async function runComputerTurn() {
  if (busyComputerTurn) return;
  busyComputerTurn = true;

  try {
    clearSentenceStage();
    state.phase = PHASE.COMPUTER_TURN;
    state.currentTurn = "computer";
    state.aiThinking = true;
    state.info = "Ход компьютера.";
    emitState();

    await sleep(400);

    if (!hasAnyMove()) {
      state.phase = PHASE.GAME_OVER;
      state.gameOver = true;
      state.winner = "player";
      state.aiThinking = false;
      state.info = "Компьютеру некуда ходить.";
      emitState();
      return;
    }

    const action = chooseComputerAction();
    if (!action) {
      state.phase = PHASE.GAME_OVER;
      state.gameOver = true;
      state.winner = "player";
      state.aiThinking = false;
      state.info = "Компьютер не нашёл ход.";
      emitState();
      return;
    }

    const from = { ...state.marker };
    state.marker = { ...action.move };
    emitState({ animation: { type: "move", actor: "computer", from, to: action.move } });

    await sleep(480);

    state.blocked[action.block.r][action.block.c] = true;
    emitState({ animation: { type: "block", actor: "computer", cell: action.block } });

    await sleep(480);

    state.aiThinking = false;
    state.phase = PHASE.PLAYER_MOVE;
    state.currentTurn = "player";
    clearSentenceStage();
    state.feedback = "";
    state.info = `Ход игрока. Открыто слов: ${state.openedCount}.`;

    if (!hasAnyMove()) {
      state.phase = PHASE.GAME_OVER;
      state.gameOver = true;
      state.winner = "computer";
      state.info = "Игроку некуда ходить.";
    }

    emitState();
  } finally {
    busyComputerTurn = false;
  }
}

function canPlayAsPlayer(socket) {
  return socket.data.role === "student" || socket.data.role === "teacher";
}

function interactionLocked() {
  return busyComputerTurn || state.aiThinking;
}

function rejectSentence(feedbackText = "Попробуй ещё раз.", infoText = "Ответ отмечен как неверный.") {
  state.aiThinking = false;
  state.sentenceSubmitted = false;
  state.feedback = feedbackText;
  state.info = infoText;
  emitState();
}

async function approveSentence() {
  state.aiThinking = false;

  if (state.pendingAction?.type === "move") {
    const animation = finalizeApprovedMove();
    if (!animation) throw new Error("Не удалось применить перемещение.");
    emitState({ animation: { type: "move", actor: "player", from: animation.from, to: animation.to } });
    return;
  }

  if (state.pendingAction?.type === "block") {
    const cell = finalizeApprovedBlock();
    if (!cell) throw new Error("Не удалось применить блокировку.");
    emitState({ animation: { type: "block", actor: "player", cell } });
    await runComputerTurn();
    return;
  }

  throw new Error("Неизвестный тип задания.");
}

io.on("connection", (socket) => {
  const roleRaw = socket.handshake.auth?.role || socket.handshake.query?.role || "student";
  const role = roleRaw === "teacher" ? "teacher" : "student";
  socket.data.role = role;
  socket.emit("session:role", { role });
  socket.emit("state:update", { state: payloadState() });

  socket.on("teacher:setSize", ({ size }) => {
    if (socket.data.role !== "teacher") return;
    if (interactionLocked()) {
      sendError(socket, "Дождитесь завершения текущего действия.");
      return;
    }
    const n = Number(size);
    if (![5, 6, 7].includes(n)) {
      sendError(socket, "Допустимые размеры: 5, 6, 7.");
      return;
    }
    setSize(n);
    state.info = `Размер поля изменён: ${n}x${n}`;
    emitState();
  });

  socket.on("teacher:setTaskConfig", (raw = {}) => {
    if (socket.data.role !== "teacher") return;
    state.taskConfig = sanitizeTaskConfig({
      ...state.taskConfig,
      ...raw
    });
    const cfg = state.taskConfig;
    state.info = `Настройки заданий: mode=${cfg.supportMode}, radius=${cfg.neighborRadius}, fallback=${cfg.fallbackMode}, diffArticle=${cfg.requireDifferentArticle ? "on" : "off"}.`;
    emitState();
  });

  socket.on("teacher:loadWords", ({ raw }) => {
    if (socket.data.role !== "teacher") return;
    if (interactionLocked()) {
      sendError(socket, "Дождитесь завершения текущего действия.");
      return;
    }
    const words = parseWordContainer(raw);
    const needed = state.size * state.size;
    if (words.length !== needed) {
      sendError(socket, `Нужно ровно ${needed} слов. Сейчас: ${words.length}.`);
      return;
    }

    state.wordPool = words.map((word, idx) => ({ id: idx + 1, word, used: false }));
    resetRound({ preserveBoardWords: false });
    state.info = `Загружено ${needed} слов. Можно заполнить поле вручную или нажать «Перемешать слова на поле».`;
    emitState();
  });

  socket.on("teacher:shuffleBoardWords", () => {
    if (socket.data.role !== "teacher") return;
    if (interactionLocked()) {
      sendError(socket, "Дождитесь завершения текущего действия.");
      return;
    }
    if (state.phase !== PHASE.SETUP_WORDS) {
      sendError(socket, "Перемешивание доступно только на этапе подготовки.");
      return;
    }

    const needed = state.size * state.size;
    if (state.wordPool.length !== needed) {
      sendError(socket, `Сначала загрузите ровно ${needed} слов в контейнер.`);
      return;
    }

    const shuffled = shuffleArray(state.wordPool.map((item) => item.id));
    let k = 0;
    for (let r = 0; r < state.size; r += 1) {
      for (let c = 0; c < state.size; c += 1) {
        state.boardWordIds[r][c] = shuffled[k++];
      }
    }

    recomputeUsedFlags();
    state.info = "Поле автоматически заполнено и перемешано.";
    emitState();
  });

  socket.on("teacher:finishWordPlacement", () => {
    if (socket.data.role !== "teacher") return;
    if (interactionLocked()) {
      sendError(socket, "Дождитесь завершения текущего действия.");
      return;
    }
    if (state.phase !== PHASE.SETUP_WORDS) return;
    if (!allBoardCellsAssigned()) {
      sendError(socket, `Заполнено ${boardAssignedCount()} из ${state.size * state.size} клеток.`);
      return;
    }

    resetRound({ preserveBoardWords: true });
    state.phase = PHASE.PLAYER_MOVE;
    state.info = "Игра запущена. Выберите клетку для перемещения маркера.";
    emitState();
  });

  socket.on("game:restart", () => {
    if (!canPlayAsPlayer(socket)) return;
    if (interactionLocked()) {
      sendError(socket, "Дождитесь завершения текущего действия.");
      return;
    }

    resetRound({ preserveBoardWords: true });
    const actor = socket.data.role === "teacher" ? "Учитель" : "Ученик";
    if (state.phase === PHASE.PLAYER_MOVE) {
      state.info = `${actor} перезапустил игру. Маркер в центре, ход игрока.`;
    } else {
      state.info = `${actor} перезапустил игру. Подготовьте поле.`;
    }
    emitState();
  });

  socket.on("game:cellClick", async ({ r, c, wordId, topic } = {}) => {
    const row = Number(r);
    const col = Number(c);
    if (!inBounds(state.size, row, col)) return;

    if (state.phase === PHASE.SETUP_WORDS) {
      if (socket.data.role !== "teacher") return;
      const selectedId = Number(wordId);
      const item = getWordById(selectedId);
      if (!item) {
        sendError(socket, "Слово для заполнения не выбрано.");
        return;
      }

      const current = state.boardWordIds[row][col];
      if (item.used && current !== selectedId) {
        sendError(socket, "Это слово уже размещено в другой клетке.");
        return;
      }

      if (current != null && current !== selectedId) {
        const prev = getWordById(current);
        if (prev) prev.used = false;
      }

      state.boardWordIds[row][col] = selectedId;
      item.used = true;
      state.info = `Заполнено ${boardAssignedCount()} из ${state.size * state.size}.`;
      emitState();
      return;
    }

    if (!canPlayAsPlayer(socket)) return;
    if (interactionLocked()) {
      sendError(socket, "Дождитесь завершения текущего действия.");
      return;
    }
    if (state.currentTurn !== "player") return;

    if (state.phase === PHASE.PLAYER_MOVE) {
      const move = getLegalMoves(state.marker).find((p) => p.r === row && p.c === col);
      if (!move) return;

      try {
        await startTaskStage("move", move, topic);
      } catch (err) {
        clearSentenceStage();
        state.aiThinking = false;
        state.feedback = "Не удалось сгенерировать задание. Попробуйте выбрать клетку ещё раз.";
        state.info = "Ошибка генерации задания.";
        emitState();
        sendError(socket, `Не удалось сгенерировать задание: ${err.message}`);
      }
      return;
    }

    if (state.phase === PHASE.PLAYER_BLOCK) {
      const block = getLegalBlocks().find((p) => p.r === row && p.c === col);
      if (!block) return;

      try {
        await startTaskStage("block", block, topic);
      } catch (err) {
        clearSentenceStage();
        state.aiThinking = false;
        state.feedback = "Не удалось сгенерировать задание. Попробуйте выбрать клетку ещё раз.";
        state.info = "Ошибка генерации задания.";
        emitState();
        sendError(socket, `Не удалось сгенерировать задание: ${err.message}`);
      }
    }
  });

  socket.on("student:submitSentence", ({ text }) => {
    if (!canPlayAsPlayer(socket)) return;
    if (state.phase !== PHASE.AWAIT_SENTENCE) {
      sendError(socket, "Сейчас отправка недоступна.");
      return;
    }
    if (!state.pendingAction || !state.currentTask) {
      sendError(socket, "Нет активного задания для проверки.");
      return;
    }

    state.sentenceText = String(text || "");
    state.sentenceSubmitted = true;
    state.feedback = "Ответ отправлен учителю.";
    state.info = "Учитель проверяет ответ.";
    emitState();
  });

  socket.on("teacher:markSentence", async ({ correct }) => {
    if (socket.data.role !== "teacher") return;
    if (state.phase !== PHASE.AWAIT_SENTENCE) {
      sendError(socket, "Сейчас нечего проверять.");
      return;
    }
    if (!state.pendingAction || !state.currentTask) {
      sendError(socket, "Нет активного задания.");
      return;
    }

    if (!correct) {
      rejectSentence("Попробуй ещё раз.", "Ответ отмечен как неверный.");
      return;
    }

    if (!state.sentenceSubmitted) {
      sendError(socket, "Сначала игрок должен отправить ответ.");
      return;
    }

    try {
      await approveSentence();
    } catch (err) {
      sendError(socket, err.message);
    }
  });

  socket.on("student:virtualCheck", async ({ text }) => {
    if (!canPlayAsPlayer(socket)) return;
    if (state.phase !== PHASE.AWAIT_SENTENCE) {
      sendError(socket, "Виртуальная проверка доступна только во время активного задания.");
      return;
    }

    const sentence = String(text || "").trim();
    const required = state.requiredWords.slice();
    const local = checkWordOrderLocal(required, sentence);
    state.sentenceText = sentence;
    state.sentenceSubmitted = true;
    state.aiThinking = true;
    state.feedback = "Виртуальный учитель проверяет ответ...";
    state.info = "Виртуальный учитель проверяет ответ...";
    emitState();

    let ok = local;
    let message = "Локальная проверка выполнена.";

    try {
      const prompt = [
        "Ты преподаватель немецкого языка.",
        `Задание: ${state.currentTask?.prompt || "нет"}`,
        `Требуемые слова в порядке: ${required.join(" -> ")}`,
        `Ответ ученика: ${sentence}`,
        "Оцени корректность по заданию и базовой грамматике.",
        "Ответь строго в формате:",
        "RESULT: OK или RESULT: FAIL",
        "FEEDBACK: ...",
        "RULE: ..."
      ].join("\n");

      const answer = await callGemini(prompt);
      ok = /RESULT:\s*OK/i.test(answer) || (local && !/RESULT:\s*FAIL/i.test(answer));
      message = answer;
    } catch (err) {
      console.error("Gemini virtual-check error:", {
        model: GEMINI_MODEL,
        sentence,
        required,
        error: err?.message || String(err)
      });
      message = local
        ? `${err?.message || "Gemini недоступен."}\nЛокальная проверка: порядок слов соблюдён.`
        : `${err?.message || "Gemini недоступен."}\nЛокальная проверка: порядок слов нарушен.`;
    }

    const resultMessage = `Виртуальный учитель:\n${message}`;

    if (ok) {
      try {
        await approveSentence();
      } catch (err) {
        state.aiThinking = false;
        state.feedback = "Не удалось применить результат виртуальной проверки.";
        state.info = "Ошибка применения результата виртуальной проверки.";
        emitState();
        sendError(socket, err.message);
        return;
      }
    } else {
      rejectSentence(`${resultMessage}\n\nПопробуй ещё раз.`, "Виртуальный учитель отклонил ответ.");
    }

    socket.emit("virtual:result", { ok, message });
    if (socket.data.role !== "teacher") {
      io.emit("teacher:virtualLog", {
        who: socket.id,
        ok,
        message,
        sentence
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`German Sea Trap server started on http://localhost:${PORT}`);
});
