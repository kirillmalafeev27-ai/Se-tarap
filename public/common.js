(function () {
  const PHASE = {
    SETUP_WORDS: "setup_words",
    PLAYER_MOVE: "player_move",
    PLAYER_BLOCK: "player_block",
    AWAIT_SENTENCE: "await_sentence",
    COMPUTER_TURN: "computer_turn",
    GAME_OVER: "game_over"
  };

  function inBounds(size, r, c) {
    return r >= 0 && c >= 0 && r < size && c < size;
  }

  function key(r, c) {
    return `${r},${c}`;
  }

  function legalMoves(state) {
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];
    const out = [];

    for (const [dr, dc] of dirs) {
      let r = state.marker.r + dr;
      let c = state.marker.c + dc;
      while (inBounds(state.size, r, c) && !state.blocked[r][c]) {
        out.push({ r, c });
        r += dr;
        c += dc;
      }
    }
    return out;
  }

  function legalBlocks(state) {
    const out = [];
    for (let r = 0; r < state.size; r += 1) {
      for (let c = 0; c < state.size; c += 1) {
        if (!state.blocked[r][c] && !(state.marker.r === r && state.marker.c === c)) {
          out.push({ r, c });
        }
      }
    }
    return out;
  }

  function createBoardRenderer(boardEl, onCellClick) {
    let size = 0;
    let cells = [];
    let shipEl = null;
    let prevBlocked = [];

    function createMatrix(n, value) {
      return Array.from({ length: n }, () => Array(n).fill(value));
    }

    function metrics() {
      const gap = 6;
      const total = boardEl.clientWidth;
      const cellSize = (total - gap * (size - 1)) / size;
      return { cellSize, gap };
    }

    function pixel(pos) {
      const m = metrics();
      return {
        x: pos.c * (m.cellSize + m.gap) + m.cellSize / 2,
        y: pos.r * (m.cellSize + m.gap) + m.cellSize / 2
      };
    }

    function cellAt(r, c) {
      return cells[r * size + c];
    }

    function ensureMine(r, c, animateDrop) {
      const cell = cellAt(r, c);
      let mine = cell.querySelector(".mine");
      if (!mine) {
        mine = document.createElement("div");
        mine.className = "mine";
        cell.appendChild(mine);
      }

      if (animateDrop) {
        mine.classList.add("fall");
        const splash = document.createElement("div");
        splash.className = "splash";
        cell.appendChild(splash);
        window.setTimeout(() => mine.classList.remove("fall"), 520);
        window.setTimeout(() => splash.remove(), 740);
      }
    }

    function removeMine(r, c) {
      const cell = cellAt(r, c);
      const mine = cell.querySelector(".mine");
      const splash = cell.querySelector(".splash");
      if (mine) mine.remove();
      if (splash) splash.remove();
    }

    function rebuild(nextSize) {
      size = nextSize;
      boardEl.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
      boardEl.innerHTML = "";
      cells = [];
      prevBlocked = createMatrix(size, false);

      for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "cell";
          const word = document.createElement("div");
          word.className = "cell-word";
          word.textContent = "";
          btn.appendChild(word);
          btn.addEventListener("click", () => onCellClick(r, c));
          boardEl.appendChild(btn);
          cells.push(btn);
        }
      }

      shipEl = document.createElement("div");
      shipEl.className = "ship";
      boardEl.appendChild(shipEl);
    }

    function render(state, opts = {}) {
      if (!state) return;
      if (state.size !== size) rebuild(state.size);

      const moveSet = new Set((opts.reach || []).map((p) => key(p.r, p.c)));
      const blockSet = new Set((opts.blocks || []).map((p) => key(p.r, p.c)));

      for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
          const cell = cellAt(r, c);
          const wordEl = cell.querySelector(".cell-word");
          const word = state.boardWords?.[r]?.[c] || "";
          wordEl.textContent = word || "—";

          cell.classList.remove("reach", "block-target", "blocked", "setup-active");
          if (moveSet.has(key(r, c))) cell.classList.add("reach");
          if (blockSet.has(key(r, c))) cell.classList.add("block-target");
          if (opts.setupActive) cell.classList.add("setup-active");

          if (state.blocked[r][c]) {
            cell.classList.add("blocked");
            const animateDrop = !prevBlocked[r][c];
            ensureMine(r, c, animateDrop);
          } else {
            removeMine(r, c);
          }
        }
      }

      const p = pixel(state.marker);
      shipEl.style.left = `${p.x}px`;
      shipEl.style.top = `${p.y}px`;

      prevBlocked = state.blocked.map((row) => row.slice());
    }

    function forceShipPosition(state) {
      if (!shipEl || !state) return;
      const p = pixel(state.marker);
      shipEl.style.transition = "none";
      shipEl.style.left = `${p.x}px`;
      shipEl.style.top = `${p.y}px`;
      requestAnimationFrame(() => {
        shipEl.style.transition = "";
      });
    }

    return {
      render,
      forceShipPosition
    };
  }

  window.SeaTrapShared = {
    PHASE,
    legalMoves,
    legalBlocks,
    createBoardRenderer
  };
})();
