(() => {
  const { PHASE, legalMoves, legalBlocks, createBoardRenderer } = window.SeaTrapShared;
  const socket = io({ auth: { role: "student" } });

  const els = {
    roleText: document.getElementById("roleText"),
    restartStudentBtn: document.getElementById("restartStudentBtn"),
    board: document.getElementById("board"),
    phaseText: document.getElementById("phaseText"),
    instructionText: document.getElementById("instructionText"),
    requiredWords: document.getElementById("requiredWords"),
    topicInput: document.getElementById("topicInput"),
    sentenceInput: document.getElementById("sentenceInput"),
    sendSentenceBtn: document.getElementById("sendSentenceBtn"),
    virtualCheckBtn: document.getElementById("virtualCheckBtn"),
    feedbackBox: document.getElementById("feedbackBox")
  };

  let state = null;

  const renderer = createBoardRenderer(els.board, (r, c) => {
    if (!state) return;
    if (state.aiThinking) return;
    if (state.phase === PHASE.PLAYER_MOVE || state.phase === PHASE.PLAYER_BLOCK) {
      socket.emit("game:cellClick", { r, c, topic: els.topicInput.value });
    }
  });

  function setFeedback(text, tone = "") {
    els.feedbackBox.textContent = text;
    els.feedbackBox.className = "feedback";
    if (tone) els.feedbackBox.classList.add(tone);
    else els.feedbackBox.classList.add("muted");
  }

  function phaseLabel(phase) {
    switch (phase) {
      case PHASE.SETUP_WORDS:
        return "Подготовка поля";
      case PHASE.PLAYER_MOVE:
        return "Ваш ход: выбор клетки для перемещения";
      case PHASE.PLAYER_BLOCK:
        return "Ваш ход: выбор клетки для блокировки";
      case PHASE.AWAIT_SENTENCE:
        return "Выполнение задания";
      case PHASE.COMPUTER_TURN:
        return "Ход компьютера";
      case PHASE.GAME_OVER:
        return "Игра завершена";
      default:
        return phase;
    }
  }

  function instruction(phase) {
    if (state?.aiThinking && !state?.currentTask) {
      return state.info || "Генерация задания...";
    }

    switch (phase) {
      case PHASE.SETUP_WORDS:
        return "Подождите, пока учитель завершит подготовку поля и запустит игру.";
      case PHASE.PLAYER_MOVE:
        return "Нажмите зелёную клетку: откроется задание для перемещения маркера по прямой.";
      case PHASE.PLAYER_BLOCK:
        return "Нажмите оранжевую клетку: откроется отдельное задание для обязательной блокировки.";
      case PHASE.AWAIT_SENTENCE: {
        const task = state?.currentTask;
        if (!task) return "Составьте предложение и отправьте его учителю.";
        const mode = task.actionType === "move" ? "для перемещения" : "для блокировки";
        return `Задание ${mode}: ${task.prompt}`;
      }
      case PHASE.COMPUTER_TURN:
        return "Ожидайте завершения хода компьютера.";
      case PHASE.GAME_OVER:
        return `Победил: ${state?.winner === "player" ? "Игрок" : "Компьютер"}.`;
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

  function detectTone(text) {
    const sample = String(text || "").toLowerCase();
    if (sample.includes("невер") || sample.includes("попроб")) return "warn";
    if (sample.includes("пройд") || sample.includes("отправ") || sample.includes("подтверж")) return "ok";
    return "";
  }

  function render() {
    if (!state) return;

    const isPlayerTurn = state.currentTurn === "player";
    const reach = state.phase === PHASE.PLAYER_MOVE && isPlayerTurn ? legalMoves(state) : [];
    const blocks = state.phase === PHASE.PLAYER_BLOCK && isPlayerTurn ? legalBlocks(state) : [];
    const waitingTask = state.aiThinking
      && !state.currentTask
      && (state.phase === PHASE.PLAYER_MOVE || state.phase === PHASE.PLAYER_BLOCK);

    renderer.render(state, { reach, blocks, setupActive: false });
    renderer.syncTaskTooltip(state);

    els.phaseText.textContent = waitingTask ? "Генерация задания" : phaseLabel(state.phase);
    els.instructionText.textContent = instruction(state.phase);
    renderRequiredWords();

    const canInput = state.phase === PHASE.AWAIT_SENTENCE && !state.aiThinking;
    els.sentenceInput.disabled = !canInput;
    els.sendSentenceBtn.disabled = !canInput;
    els.virtualCheckBtn.disabled = !canInput;
    els.topicInput.disabled = Boolean(state.aiThinking);

    const total = state.size * state.size;
    const hasPool = (state.wordPool || []).length === total;
    els.restartStudentBtn.disabled = !hasPool || state.aiThinking;

    if (state.phase === PHASE.GAME_OVER) {
      setFeedback(`Игра завершена. Победил: ${state.winner === "player" ? "Игрок" : "Компьютер"}.`, "bad");
      return;
    }

    if (state.feedback) {
      setFeedback(state.feedback, detectTone(state.feedback));
    }
  }

  socket.on("session:role", ({ role }) => {
    els.roleText.textContent = `Роль: ${role === "teacher" ? "учитель" : "ученик"}`;
  });

  socket.on("state:update", ({ state: nextState }) => {
    state = nextState;
    render();
  });

  socket.on("action:error", ({ message }) => {
    setFeedback(message, "bad");
  });

  socket.on("action:info", ({ message }) => {
    setFeedback(message, "ok");
  });

  socket.on("virtual:result", ({ ok, message }) => {
    setFeedback(`Виртуальный учитель:\n${message}`, ok ? "ok" : "warn");
  });

  els.restartStudentBtn.addEventListener("click", () => {
    socket.emit("game:restart");
  });

  els.sendSentenceBtn.addEventListener("click", () => {
    socket.emit("student:submitSentence", { text: els.sentenceInput.value });
  });

  els.virtualCheckBtn.addEventListener("click", () => {
    socket.emit("student:virtualCheck", { text: els.sentenceInput.value });
  });

  window.addEventListener("resize", () => {
    if (state) {
      renderer.forceShipPosition(state);
      renderer.syncTaskTooltip(state);
    }
  });
})();
