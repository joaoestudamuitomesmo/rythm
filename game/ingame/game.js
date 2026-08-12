// ============================================================
// game.js - core rhythm engine.
// Notes travel from BOTTOM to TOP toward a fixed hit zone at the top.
// Exposes window.RhythmGame.start(songEntry, difficulty)
// ============================================================

(function () {
  const LANES = 4;

  // FNF 4-Lane Standard Layout:
  // Lane 0: Left | Lane 1: Down | Lane 2: Up | Lane 3: Right
  const KEY_TO_LANE = {
    // Arrow Keys (Standard FNF)
    "arrowleft": 0,
    "arrowdown": 1,
    "arrowup": 2,
    "arrowright": 3,

    // WASD Keys (Standard FNF)
    "a": 0,
    "s": 1,
    "w": 2,
    "d": 3,

    // DFJK Keys (Alternative 4K FNF Engine Layout)
    // To use DFJK instead of WASD, replace A/S/W/D above with:
    // "d": 0, "f": 1, "j": 2, "k": 3
  };

  // How long (seconds) a note takes to travel from spawn (bottom edge)
  // to the hit zone (top edge). Bigger = more reaction time.
  const NOTE_TRAVEL_TIME_BY_DIFF = { easy: 1.65, normal: 1.4, hard: 1.15 };

  // Judgement windows in seconds (absolute time difference)
  const WINDOWS_BY_DIFF = {
    easy:   { sick: 0.07, good: 0.14, bad: 0.22, miss: 0.28 },
    normal: { sick: 0.05, good: 0.10, bad: 0.16, miss: 0.20 },
    hard:   { sick: 0.035, good: 0.075, bad: 0.12, miss: 0.15 },
  };

  const SCORE = { sick: 100, good: 70, bad: 30, miss: 0 };
  const DIFFICULTY_KEYS = ["easy", "normal", "hard"];

  // Set from the chosen difficulty when a song starts.
  let NOTE_TRAVEL_TIME = NOTE_TRAVEL_TIME_BY_DIFF.normal;
  let WINDOWS = WINDOWS_BY_DIFF.normal;
  let MISS_WINDOW = WINDOWS.miss;

  let audioEl, trackContainer, receptors, scoreDisplay, comboDisplay,
      accuracyDisplay, progressFill, countdownDisplay, bgOverlay;

  let chartData = null;
  let activeNotes = [];   // notes currently spawned & on screen
  let allNotes = [];      // full note list for current difficulty
  let nextNoteIndex = 0;
  let score = 0, combo = 0, maxCombo = 0;
  let hitCount = 0, totalJudged = 0, accuracySum = 0;
  let rafId = null;
  let trackHeight = 0;
  let finished = false;

  let clockStartMs = null;
  let audioStarted = false;

  function $(id) { return document.getElementById(id); }

  function cacheDom() {
    audioEl = $("song-audio");
    trackContainer = $("track-container");
    receptors = Array.from(document.querySelectorAll(".receptor"));
    scoreDisplay = $("score-display");
    comboDisplay = $("combo-display");
    accuracyDisplay = $("accuracy-display");
    progressFill = $("progress-bar-fill");
    countdownDisplay = $("countdown-display");

    // Create the background overlay dynamically if it doesn't exist
    if (!$("bg-overlay")) {
      bgOverlay = document.createElement("div");
      bgOverlay.id = "bg-overlay";
      document.body.insertBefore(bgOverlay, document.body.firstChild);
    } else {
      bgOverlay = $("bg-overlay");
    }
  }

  function getCurrentTime() {
    if (audioStarted) return audioEl.currentTime;
    if (clockStartMs === null) return 0;
    return (performance.now() - clockStartMs) / 1000;
  }

  async function loadChart(chartPath) {
    const res = await fetch(chartPath);
    if (!res.ok) throw new Error("Failed to load chart: " + chartPath);
    return res.json();
  }

  function resetState() {
    activeNotes.forEach(n => n.el && n.el.remove());
    activeNotes = [];
    trackContainer.querySelectorAll(".particle, .combo-milestone, .judgement").forEach(el => el.remove());
    document.querySelectorAll(".combo-flash").forEach(el => el.remove());
    
    nextNoteIndex = 0;
    score = 0; combo = 0; maxCombo = 0;
    hitCount = 0; totalJudged = 0; accuracySum = 0;
    finished = false;
    audioStarted = false;
    clockStartMs = null;
    
    updateHud();
    updateBackgroundHeat();
    
    progressFill.style.width = "0%";
    if (countdownDisplay) countdownDisplay.textContent = "";
  }

  function updateHud() {
    scoreDisplay.textContent = "SCORE: " + score;
    comboDisplay.textContent = combo > 1 ? combo + "x COMBO" : "";
    const acc = totalJudged > 0 ? (accuracySum / totalJudged) * 100 : 100;
    accuracyDisplay.textContent = "ACC: " + acc.toFixed(1) + "%";
  }

  function updateBackgroundHeat() {
    // Max intensity reached at 50 combo
    const heat = Math.min(combo / 50, 1);
    if (bgOverlay) {
      bgOverlay.style.setProperty("--combo-heat", heat);
    }
  }

  function bump(el, className, duration = 150) {
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
    clearTimeout(el.dataset.bumpTimer);
    const timer = setTimeout(() => el.classList.remove(className), duration);
    el.dataset.bumpTimer = timer;
  }

  function spawnNote(noteData) {
    const el = document.createElement("div");
    el.className = "note lane-" + noteData.lane;
    trackContainer.querySelector(`.lane[data-lane="${noteData.lane}"]`).appendChild(el);
    const noteObj = { el, time: noteData.time, lane: noteData.lane, judged: false };
    activeNotes.push(noteObj);
    return noteObj;
  }

  function receptorY() {
    const size = getComputedStyle(document.documentElement).getPropertyValue("--receptor-size");
    const px = parseFloat(size) || 70;
    return 20 + px / 2;
  }

  function noteSizePx() {
    const size = getComputedStyle(document.documentElement).getPropertyValue("--receptor-size");
    return parseFloat(size) || 70;
  }

  function gameLoop() {
    const currentTime = getCurrentTime();
    trackHeight = trackContainer.clientHeight;

    if (!audioStarted) {
      if (currentTime >= 0) {
        audioStarted = true;
        countdownDisplay.textContent = "";
        audioEl.play();
      } else {
        const secondsLeft = Math.ceil(-currentTime);
        countdownDisplay.textContent = secondsLeft > 0 ? String(secondsLeft) : "GO!";
      }
    }

    // Spawn upcoming notes
    while (nextNoteIndex < allNotes.length &&
           allNotes[nextNoteIndex].time - NOTE_TRAVEL_TIME <= currentTime) {
      spawnNote(allNotes[nextNoteIndex]);
      nextNoteIndex++;
    }

    const rY = receptorY();
    const noteSize = noteSizePx();
    const bottomEdgeY = trackHeight - noteSize / 2;

    // Update positions & check for misses (move UP from bottom to top)
    for (let i = activeNotes.length - 1; i >= 0; i--) {
      const n = activeNotes[i];
      const spawnTime = n.time - NOTE_TRAVEL_TIME;
      const progress = (currentTime - spawnTime) / NOTE_TRAVEL_TIME;
      
      const y = bottomEdgeY + (rY - bottomEdgeY) * progress - noteSize / 2;
      n.el.style.top = y + "px";

      const delta = currentTime - n.time;
      if (!n.judged && delta > MISS_WINDOW) {
        judgeNote(n, "miss");
      }

      if (n.judged && (progress > 1.15 || delta > MISS_WINDOW + 0.05)) {
        n.el.remove();
        activeNotes.splice(i, 1);
      }
    }

    if (audioEl.duration) {
      const pct = Math.max(0, Math.min(1, currentTime / audioEl.duration));
      progressFill.style.width = pct * 100 + "%";
    }

    if (!finished && audioEl.duration &&
        currentTime >= audioEl.duration - 0.05 &&
        nextNoteIndex >= allNotes.length &&
        activeNotes.every(n => n.judged)) {
      finished = true;
      endSong();
      return;
    }

    rafId = requestAnimationFrame(gameLoop);
  }

  function judgeNote(noteObj, forcedJudgement) {
    if (noteObj.judged) return;
    noteObj.judged = true;

    let judgement = forcedJudgement;
    if (!judgement) {
      const delta = Math.abs(getCurrentTime() - noteObj.time);
      if (delta <= WINDOWS.sick) judgement = "sick";
      else if (delta <= WINDOWS.good) judgement = "good";
      else if (delta <= WINDOWS.bad) judgement = "bad";
      else judgement = "miss";
    }

    score += SCORE[judgement];
    totalJudged++;
    if (judgement === "miss") {
      combo = 0;
      accuracySum += 0;
    } else {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
      hitCount++;
      const accWeight = judgement === "sick" ? 1 : judgement === "good" ? 0.7 : 0.4;
      accuracySum += accWeight;
    }

    updateBackgroundHeat();
    showJudgement(judgement, noteObj.lane);
    flashReceptor(noteObj.lane, judgement !== "miss");
    updateHud();
    bump(scoreDisplay, "bump");
    if (combo > 1) bump(comboDisplay, "bump");

    if (judgement === "sick" || judgement === "good") {
      spawnParticles(noteObj.lane);
      // Spawn random flash if you've got a combo going
      if (combo >= 5) spawnComboFlash();
    }

    if (judgement === "sick") {
      bump(trackContainer, "punch", 120);
    } else if (judgement === "miss") {
      bump(trackContainer, "shake", 250);
    }

    if (judgement !== "miss" && combo > 0 && combo % 10 === 0) {
      showComboMilestone(combo);
    }

    if (judgement === "miss") {
      noteObj.el.style.opacity = "0.15";
    } else {
      noteObj.el.style.opacity = "0";
    }
  }

  function spawnComboFlash() {
    const flash = document.createElement("div");
    flash.className = "combo-flash";
    
    // Pick random position across the screen
    flash.style.left = (Math.random() * 90 + 5) + "vw";
    flash.style.top = (Math.random() * 90 + 5) + "vh";
    
    // Scale flash size based on current heat
    const heat = Math.min(combo / 50, 1);
    const size = 150 + (heat * 400); 
    flash.style.width = size + "px";
    flash.style.height = size + "px";
    flash.style.marginLeft = -(size / 2) + "px";
    flash.style.marginTop = -(size / 2) + "px";

    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 400);
  }

  function spawnParticles(lane) {
    const receptor = receptors[lane];
    const rect = receptor.getBoundingClientRect();
    const containerRect = trackContainer.getBoundingClientRect();
    const cx = rect.left - containerRect.left + rect.width / 2;
    const cy = rect.top - containerRect.top + rect.height / 2;
    const color = getLaneColor(lane);

    const PARTICLE_COUNT = 8;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const angle = (Math.PI * 2 * i) / PARTICLE_COUNT + Math.random() * 0.4;
      const distance = 40 + Math.random() * 30;
      const p = document.createElement("div");
      p.className = "particle";
      p.style.left = cx + "px";
      p.style.top = cy + "px";
      p.style.background = color;
      p.style.boxShadow = `0 0 6px ${color}`;
      p.style.setProperty("--px", Math.cos(angle) * distance + "px");
      p.style.setProperty("--py", Math.sin(angle) * distance + "px");
      trackContainer.appendChild(p);
      setTimeout(() => p.remove(), 460);
    }
  }

  function showComboMilestone(combo) {
    const el = document.createElement("div");
    el.className = "combo-milestone";
    el.textContent = combo + " COMBO!";
    trackContainer.appendChild(el);
    setTimeout(() => el.remove(), 600);
  }

  function showJudgement(judgement, lane) {
    const label = { sick: "SICK!", good: "GOOD", bad: "BAD", miss: "MISS" }[judgement];
    const el = document.createElement("div");
    el.className = "judgement " + judgement;
    el.textContent = label;
    trackContainer.appendChild(el);
    setTimeout(() => el.remove(), 400);
  }

  function flashReceptor(lane, hit) {
    const receptor = receptors[lane];
    receptor.classList.add("active");
    receptor.style.borderColor = hit ? getLaneColor(lane) : "#ff3c3c";
    setTimeout(() => {
      receptor.classList.remove("active");
      receptor.style.borderColor = "";
    }, 100);
  }

  function getLaneColor(lane) {
    return getComputedStyle(document.documentElement).getPropertyValue("--lane" + lane).trim();
  }

  function findClosestUnjudgedNote(lane) {
    let best = null, bestDelta = Infinity;
    for (const n of activeNotes) {
      if (n.judged || n.lane !== lane) continue;
      const delta = Math.abs(getCurrentTime() - n.time);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = n;
      }
    }
    if (best && bestDelta <= MISS_WINDOW) return best;
    return null;
  }

  // --- INPUT HANDLERS ---
  function handleKeyDown(e) {
    const key = e.key.toLowerCase();
    if (!(key in KEY_TO_LANE)) return;
    triggerInput(KEY_TO_LANE[key]);
  }

  function handleMouseDown(e) {
    let key = null;
    if (e.button === 0) key = "lmb";       // Left Click
    else if (e.button === 2) key = "rmb";  // Right Click

    if (!key || !(key in KEY_TO_LANE)) return;
    triggerInput(KEY_TO_LANE[key]);
  }

  function preventContextMenu(e) {
    e.preventDefault(); // Prevents right-click menu during gameplay
  }

  function triggerInput(lane) {
    flashReceptor(lane, true);
    const note = findClosestUnjudgedNote(lane);
    if (note) judgeNote(note);
  }

  function endSong() {
    cancelAnimationFrame(rafId);
    
    // Clean up input listeners
    document.removeEventListener("keydown", handleKeyDown);
    document.removeEventListener("mousedown", handleMouseDown);
    document.removeEventListener("contextmenu", preventContextMenu);

    const acc = totalJudged > 0 ? (accuracySum / totalJudged) * 100 : 100;
    $("result-score").textContent = score;
    $("result-combo").textContent = maxCombo;
    $("result-accuracy").textContent = acc.toFixed(1) + "%";

    let rank = "D";
    if (acc >= 95) rank = "S";
    else if (acc >= 85) rank = "A";
    else if (acc >= 70) rank = "B";
    else if (acc >= 50) rank = "C";
    $("result-rank").textContent = "RANK: " + rank;

    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    $("results-screen").classList.add("active");
  }

  async function start(songEntry, difficulty) {
    cacheDom();
    resetState();

    chartData = await loadChart(songEntry.chart);

    let diffKey = DIFFICULTY_KEYS.includes(difficulty) ? difficulty : "normal";
    let notes = chartData.difficulties[diffKey];
    if (!notes) {
      diffKey = DIFFICULTY_KEYS.find(k => chartData.difficulties[k]);
      notes = chartData.difficulties[diffKey];
    }
    allNotes = notes.slice().sort((a, b) => a.time - b.time);

    NOTE_TRAVEL_TIME = NOTE_TRAVEL_TIME_BY_DIFF[diffKey] || NOTE_TRAVEL_TIME_BY_DIFF.normal;
    WINDOWS = WINDOWS_BY_DIFF[diffKey] || WINDOWS_BY_DIFF.normal;
    MISS_WINDOW = WINDOWS.miss;

    let audioPath = chartData.audio;
    if (!audioPath.startsWith("http") && !audioPath.startsWith("/")) {
      const chartDir = songEntry.chart.substring(0, songEntry.chart.lastIndexOf("/") + 1);
      audioPath = chartDir + chartData.audio;
    }
    audioEl.src = audioPath;
    audioEl.currentTime = 0;

    await new Promise(resolve => {
      audioEl.oncanplaythrough = resolve;
      audioEl.load();
    });

    // Attach keyboard and mouse input listeners
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("contextmenu", preventContextMenu);

    audioStarted = false;
    const preRoll = NOTE_TRAVEL_TIME + 0.3;
    clockStartMs = performance.now() + preRoll * 1000;

    rafId = requestAnimationFrame(gameLoop);
  }

  window.RhythmGame = { start };
})();