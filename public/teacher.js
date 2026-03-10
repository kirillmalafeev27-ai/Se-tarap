(() => {
  const { PHASE, legalMoves, legalBlocks, createBoardRenderer } = window.SeaTrapShared;

  const socket = io({ auth: { role: "teacher" } });

  const els = {
    sizeSelect: document.getElementById("sizeSelect"),
    restartTeacherBtn: document.getElementById("restartTeacherBtn"),
    board: document.getElementById("board"),
    phaseText: document.getElementById("phaseText"),
    infoText: document.getElementById("infoText"),
    instructionText: document.getElementById("instructionText"),
    requiredWords: document.getElementById("requiredWords"),
    topicInput: document.getElementById("topicInput"),
    sentencePreview: document.getElementById("sentencePreview"),
    logBox: document.getElementById("logBox"),

    wordContainer: document.getElementById("wordContainer"),
    loadWordsBtn: document.getElementById("loadWordsBtn"),
    shuffleBoardBtn: document.getElementById("shuffleBoardBtn"),
    loadStatus: document.getElementById("loadStatus"),

    wordButtons: document.getElementById("wordButtons"),
    wordHint: document.getElementById("wordHint"),

    finishPlacementBtn: document.getElementById("finishPlacementBtn"),
    teacherCorrectBtn: document.getElementById("teacherCorrectBtn"),
    teacherWrongBtn: document.getElementById("teacherWrongBtn")
  };

  let state = null;
  let selectedWordId = null;

  const renderer = createBoardRenderer(els.board, (r, c) => {
    if (!state) return;
    if (state.aiThinking) return;

    if (state.phase === PHASE.SETUP_WORDS) {
      if (selectedWordId == null) return;
      socket.emit("game:cellClick", { r, c, wordId: selectedWordId });
      return;
    }

    if (state.phase === PHASE.PLAYER_MOVE || state.phase === PHASE.PLAYER_BLOCK) {
      socket.emit("game:cellClick", { r, c, topic: els.topicInput.value });
    }
  });

  function setLog(text, tone = "") {
    els.logBox.textContent = text;
    els.logBox.className = "feedback";
    if (tone) els.logBox.classList.add(tone);
    else els.logBox.classList.add("muted");
  }

  function phaseLabel(phase) {
    switch (phase) {
      case PHASE.SETUP_WORDS:
        return "Подготовка: заполнение слов";
      case PHASE.PLAYER_MOVE:
        return "Ход игрока: выбор клетки для перемещения";
      case PHASE.PLAYER_BLOCK:
        return "Ход игрока: выбор клетки для блокировки";
      case PHASE.AWAIT_SENTENCE:
        return "Ожидание и проверка ответа";
      case PHASE.COMPUTER_TURN:
        return "Ход компьютера";
      case PHASE.GAME_OVER:
        return "Игра завершена";
      default:
        return phase;
    }
  }

  function instructionForPhase(phase) {
    if (state?.aiThinking && !state?.currentTask) {
      return state.info || "Генерация задания...";
    }

    switch (phase) {
      case PHASE.SETUP_WORDS:
        return "Заполните поле вручную или нажмите «Перемешать слова на поле», затем «Готово: начать игру».";
      case PHASE.PLAYER_MOVE:
        return "Игрок выбирает зелёную клетку. Сразу после выбора открывается задание для перемещения.";
      case PHASE.PLAYER_BLOCK:
        return "После подтвержденного перемещения игрок выбирает оранжевую клетку. Для блокировки открывается второе задание.";
      case PHASE.AWAIT_SENTENCE:
        return state?.currentTask
          ? `Проверьте ответ по заданию: ${state.currentTask.prompt}`
          : "Проверьте ответ игрока и нажмите Правильно/Неправильно.";
      case PHASE.COMPUTER_TURN:
        return "Компьютер делает ход автоматически.";
      case PHASE.GAME_OVER:
        return `Победитель: ${state?.winner === "player" ? "Игрок" : "Компьютер"}.`;
      default:
        return "";
    }
  }

  function renderRequiredWords() {
    els.requiredWords.innerHTML = "";
    const words = state.requiredWords?.length ? state.requiredWords : ["Пока нет"];
    for (const word of words) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = word;
      els.requiredWords.appendChild(chip);
    }
  }

  function renderWordButtons() {
    els.wordButtons.innerHTML = "";

    for (const item of state.wordPool || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "word-btn";
      btn.textContent = item.word;
      btn.disabled = Boolean(state?.aiThinking);

      if (state.phase === PHASE.SETUP_WORDS && item.used) btn.classList.add("used");
      if (selectedWordId === item.id) btn.classList.add("active");

      btn.addEventListener("click", () => {
        if (state.phase === PHASE.SETUP_WORDS && item.used) return;
        selectedWordId = item.id;
        renderWordButtons();
        renderStatusOnly();
      });

      els.wordButtons.appendChild(btn);
    }
  }

  function renderStatusOnly() {
    if (!state) return;
    const uiLocked = Boolean(state.aiThinking);
    const waitingTask = uiLocked
      && !state.currentTask
      && (state.phase === PHASE.PLAYER_MOVE || state.phase === PHASE.PLAYER_BLOCK);

    els.phaseText.textContent = waitingTask ? "Генерация задания" : phaseLabel(state.phase);
    els.infoText.textContent = state.info || "";
    els.instructionText.textContent = instructionForPhase(state.phase);

    els.sentencePreview.textContent = state.sentenceSubmitted
      ? (state.sentenceText || "(пустая строка)")
      : "Игрок еще ничего не отправил.";
    els.sentencePreview.className = `feedback${state.sentenceSubmitted ? "" : " muted"}`;

    const total = state.size * state.size;
    const assigned = state.boardWordIds.flat().filter((x) => x != null).length;
    const hasFullPool = (state.wordPool || []).length === total;
    els.loadStatus.textContent = `Заполнено клеток: ${assigned}/${total}`;
    els.loadStatus.className = assigned === total ? "muted ok" : "muted warn";

    const setupWords = state.phase === PHASE.SETUP_WORDS;
    const awaitSentence = state.phase === PHASE.AWAIT_SENTENCE;

    els.sizeSelect.disabled = uiLocked;
    els.wordContainer.disabled = uiLocked;
    els.topicInput.disabled = uiLocked;
    els.loadWordsBtn.disabled = uiLocked;
    els.shuffleBoardBtn.disabled = uiLocked || !setupWords || !hasFullPool;
    els.finishPlacementBtn.disabled = uiLocked || !setupWords || assigned !== total;
    els.restartTeacherBtn.disabled = uiLocked || !hasFullPool;
    els.teacherCorrectBtn.disabled = uiLocked || !awaitSentence;
    els.teacherWrongBtn.disabled = uiLocked || !awaitSentence;

    if (setupWords) {
      els.wordHint.textContent = "Выберите слово и кликните клетку поля, либо используйте автозаполнение кнопкой «Перемешать слова на поле».";
    } else if (awaitSentence) {
      const action = state.currentTask?.actionType === "block" ? "блокировка" : "перемещение";
      els.wordHint.textContent = `Список слов для текущего задания (${action}). Проверьте ответ игрока.`;
    } else {
      els.wordHint.textContent = "Список слов доступен для просмотра.";
    }
  }

  function renderBoardAndStatus() {
    if (!state) return;

    const reach = state.phase === PHASE.PLAYER_MOVE ? legalMoves(state) : [];
    const blocks = state.phase === PHASE.PLAYER_BLOCK ? legalBlocks(state) : [];
    const setupActive = state.phase === PHASE.SETUP_WORDS && selectedWordId != null;

    renderer.render(state, { reach, blocks, setupActive });
    renderer.syncTaskTooltip(state);
    renderRequiredWords();
    renderWordButtons();
    renderStatusOnly();
  }

  socket.on("session:role", ({ role }) => {
    setLog(`Подключено как: ${role}`, "ok");
  });

  socket.on("state:update", ({ state: serverState, animation }) => {
    state = serverState;
    if (state && Number(els.sizeSelect.value) !== state.size) {
      els.sizeSelect.value = String(state.size);
    }

    renderBoardAndStatus();

    if (animation?.type === "move") {
      setLog(`Анимация: ${animation.actor === "player" ? "игрок" : "компьютер"} переместил маркер.`, "ok");
    }
    if (animation?.type === "block") {
      setLog(`Анимация: ${animation.actor === "player" ? "игрок" : "компьютер"} выполнил блокировку.`, "warn");
    }
  });

  socket.on("action:error", ({ message }) => {
    setLog(message, "bad");
  });

  socket.on("action:info", ({ message }) => {
    setLog(message, "ok");
  });

  socket.on("teacher:virtualLog", ({ ok, message, sentence }) => {
    setLog(`Виртуальная проверка (${ok ? "OK" : "FAIL"})\nОтвет: ${sentence || "(пусто)"}\n${message}`, ok ? "ok" : "warn");
  });

  els.sizeSelect.addEventListener("change", () => {
    socket.emit("teacher:setSize", { size: Number(els.sizeSelect.value) });
    selectedWordId = null;
  });

  els.restartTeacherBtn.addEventListener("click", () => {
    socket.emit("game:restart");
  });

  els.loadWordsBtn.addEventListener("click", () => {
    socket.emit("teacher:loadWords", { raw: els.wordContainer.value });
    selectedWordId = null;
  });

  els.shuffleBoardBtn.addEventListener("click", () => {
    socket.emit("teacher:shuffleBoardWords");
  });

  els.finishPlacementBtn.addEventListener("click", () => {
    socket.emit("teacher:finishWordPlacement");
  });

  els.teacherCorrectBtn.addEventListener("click", () => {
    socket.emit("teacher:markSentence", { correct: true });
  });

  els.teacherWrongBtn.addEventListener("click", () => {
    socket.emit("teacher:markSentence", { correct: false });
  });

  window.addEventListener("resize", () => {
    if (state) {
      renderer.forceShipPosition(state);
      renderer.syncTaskTooltip(state);
    }
  });
})();
