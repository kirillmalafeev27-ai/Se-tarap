const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();

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
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

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

function pickSupportWord(cell, primaryWord) {
  const words = [];
  for (let r = 0; r < state.size; r += 1) {
    for (let c = 0; c < state.size; c += 1) {
      if (r === cell.r && c === cell.c) continue;
      const word = getWordAt(r, c);
      if (word) words.push(word);
    }
  }

  if (words.length === 0) return primaryWord;
  const idx = Math.abs((cell.r + 1) * 37 + (cell.c + 1) * 19 + state.openedCount + state.taskSeq) % words.length;
  return words[idx];
}

function buildCellTask(actionType, cell) {
  const primaryWord = getWordAt(cell.r, cell.c) || "Wort";
  const supportWord = pickSupportWord(cell, primaryWord);
  const templates = [
    (a, b) => `Сформулируйте Imperativ с словами "${a}" и "${b}".`,
    (a, b) => `Составьте предложение с определённым артиклем для "${a}" и добавьте "${b}".`,
    (a, b) => `Составьте предложение, где "${a}" стоит во множественном числе, и используйте "${b}".`
  ];
  const idx = Math.abs(cell.r * 31 + cell.c * 17 + state.openedCount + (actionType === "block" ? 5 : 0)) % templates.length;
  state.taskSeq += 1;

  return {
    id: state.taskSeq,
    actionType,
    cell: { r: cell.r, c: cell.c },
    primaryWord,
    supportWord,
    prompt: templates[idx](primaryWord, supportWord),
    requiredWords: supportWord && supportWord !== primaryWord ? [primaryWord, supportWord] : [primaryWord]
  };
}

function clearSentenceStage() {
  state.requiredWords = [];
  state.currentTask = null;
  state.pendingAction = null;
  state.sentenceText = "";
  state.sentenceSubmitted = false;
}

function startTaskStage(actionType, cell) {
  const task = buildCellTask(actionType, cell);
  state.pendingAction = {
    type: actionType,
    target: { r: cell.r, c: cell.c },
    from: { ...state.marker }
  };
  state.currentTask = task;
  state.requiredWords = task.requiredWords.slice();
  state.sentenceText = "";
  state.sentenceSubmitted = false;
  state.phase = PHASE.AWAIT_SENTENCE;
  state.feedback = "Сформулируйте ответ и отправьте учителю.";
  state.info = actionType === "move"
    ? "Проверка задания для перемещения маркера."
    : "Проверка задания для блокировки клетки.";
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
  state = makeState(size);
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
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY не задан на сервере.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim();
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

io.on("connection", (socket) => {
  const roleRaw = socket.handshake.auth?.role || socket.handshake.query?.role || "student";
  const role = roleRaw === "teacher" ? "teacher" : "student";
  socket.data.role = role;
  socket.emit("session:role", { role });
  socket.emit("state:update", { state: payloadState() });

  socket.on("teacher:setSize", ({ size }) => {
    if (socket.data.role !== "teacher") return;
    const n = Number(size);
    if (![5, 6, 7].includes(n)) {
      sendError(socket, "Допустимые размеры: 5, 6, 7.");
      return;
    }
    setSize(n);
    state.info = `Размер поля изменён: ${n}x${n}`;
    emitState();
  });

  socket.on("teacher:loadWords", ({ raw }) => {
    if (socket.data.role !== "teacher") return;
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
    if (busyComputerTurn) {
      sendError(socket, "Дождитесь завершения хода компьютера.");
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

  socket.on("game:cellClick", ({ r, c, wordId }) => {
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
    if (state.currentTurn !== "player") return;

    if (state.phase === PHASE.PLAYER_MOVE) {
      const move = getLegalMoves(state.marker).find((p) => p.r === row && p.c === col);
      if (!move) return;

      startTaskStage("move", move);
      state.feedback = "Открыто задание для перемещения. Введите ответ и отправьте учителю.";
      emitState();
      return;
    }

    if (state.phase === PHASE.PLAYER_BLOCK) {
      const block = getLegalBlocks().find((p) => p.r === row && p.c === col);
      if (!block) return;

      startTaskStage("block", block);
      state.feedback = "Открыто задание для блокировки. Введите ответ и отправьте учителю.";
      emitState();
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
      state.sentenceSubmitted = false;
      state.feedback = "Попробуй ещё раз.";
      state.info = "Ответ отмечен как неверный.";
      emitState();
      return;
    }

    if (!state.sentenceSubmitted) {
      sendError(socket, "Сначала игрок должен отправить ответ.");
      return;
    }

    if (state.pendingAction.type === "move") {
      const animation = finalizeApprovedMove();
      if (!animation) {
        sendError(socket, "Не удалось применить перемещение.");
        return;
      }
      emitState({ animation: { type: "move", actor: "player", from: animation.from, to: animation.to } });
      return;
    }

    if (state.pendingAction.type === "block") {
      const cell = finalizeApprovedBlock();
      if (!cell) {
        sendError(socket, "Не удалось применить блокировку.");
        return;
      }
      emitState({ animation: { type: "block", actor: "player", cell } });
      await runComputerTurn();
      return;
    }

    sendError(socket, "Неизвестный тип задания.");
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
    } catch (_err) {
      message = local
        ? "Gemini недоступен. Локальная проверка: порядок слов соблюдён."
        : "Gemini недоступен. Локальная проверка: порядок слов нарушен.";
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
