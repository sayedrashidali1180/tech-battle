import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ============================================================
   HTTP + SOCKET.IO
============================================================ */

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

/* ============================================================
   CONFIG
============================================================ */

const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;

const QUESTION_TIME = 20_000;
const COUNTDOWN_TIME = 3_000;
const RESULTS_TIME = 3_000;

const RECONNECT_GRACE = 60_000;
const ROOM_IDLE_CLEANUP = 10 * 60_000;

const STREAK_BONUS_PER_STEP = 10;
const STREAK_BONUS_CAP = 50;

const rooms = new Map();

const ROOM_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const CATEGORIES = [
  "programming",
  "ai",
  "computer-science",
  "databases",
  "web-development",
  "networking",
  "cloud",
  "cybersecurity"
];

/* ============================================================
   QUESTION BANK (72 QUESTIONS)
============================================================ */

const q = (id, category, difficulty, text, options, correctIndex) => ({
  id, category, difficulty, text, options, correctIndex
});

const QUESTION_BANK = [

  /* PROGRAMMING */
  q("programming-easy-1", "programming", "easy", "Which keyword defines a function in Python?", ["func", "def", "function", "define"], 1),
  q("programming-easy-2", "programming", "easy", "Which symbol starts a comment in Python?", ["//", "#", "<!-- -->", "/* */"], 1),
  q("programming-easy-3", "programming", "easy", "Which data type represents true/false values?", ["Integer", "Boolean", "String", "Float"], 1),
  q("programming-medium-1", "programming", "medium", "What is the average-case lookup complexity of a hash table?", ["O(1)", "O(log n)", "O(n)", "O(n log n)"], 0),
  q("programming-medium-2", "programming", "medium", "What does the acronym 'API' stand for?", ["Application Programming Interface", "Automated Program Instruction", "Applied Programming Index", "Advanced Protocol Interface"], 0),
  q("programming-medium-3", "programming", "medium", "Which sorting algorithm has average time complexity O(n log n)?", ["Bubble sort", "Merge sort", "Selection sort", "Insertion sort"], 1),
  q("programming-hard-1", "programming", "hard", "Which principle says software entities should be open for extension but closed for modification?", ["DRY", "KISS", "Open/Closed Principle", "YAGNI"], 2),
  q("programming-hard-2", "programming", "hard", "What is a race condition?", ["A CPU scheduling algorithm", "A bug from unsynchronized concurrent access to shared data", "A network routing error", "A type of memory leak"], 1),
  q("programming-hard-3", "programming", "hard", "Which design pattern restricts a class to a single instance?", ["Factory", "Singleton", "Observer", "Decorator"], 1),

  /* AI */
  q("ai-easy-1", "ai", "easy", "What does AI stand for?", ["Automated Interface", "Artificial Intelligence", "Applied Internet", "Algorithmic Integration"], 1),
  q("ai-easy-2", "ai", "easy", "What is a 'dataset' in machine learning?", ["A programming language", "A collection of data used to train models", "A type of neural network", "A cloud server"], 1),
  q("ai-easy-3", "ai", "easy", "Which company created ChatGPT?", ["Google", "Anthropic", "OpenAI", "Meta"], 2),
  q("ai-medium-1", "ai", "medium", "Which type of machine learning uses labeled training examples?", ["Unsupervised learning", "Reinforcement learning", "Supervised learning", "Random learning"], 2),
  q("ai-medium-2", "ai", "medium", "What is 'overfitting' in machine learning?", ["A model that performs well on new data", "A model that memorizes training data but fails to generalize", "A model with too few parameters", "A model trained too quickly"], 1),
  q("ai-medium-3", "ai", "medium", "What does NLP stand for?", ["Natural Language Processing", "Neural Learning Protocol", "Network Layer Programming", "Numeric Language Parsing"], 0),
  q("ai-hard-1", "ai", "hard", "Which activation function is commonly used in hidden layers of modern neural networks?", ["ReLU", "Softmax", "Linear only", "Identity only"], 0),
  q("ai-hard-2", "ai", "hard", "Which technique reduces overfitting by randomly disabling neurons during training?", ["Dropout", "Batch normalization", "Gradient clipping", "Pooling"], 0),
  q("ai-hard-3", "ai", "hard", "What is the core mechanism behind Transformer models?", ["Convolution", "Recurrence", "Self-attention", "Pooling"], 2),

  /* COMPUTER SCIENCE */
  q("cs-easy-1", "computer-science", "easy", "What does CPU stand for?", ["Central Processing Unit", "Computer Primary Utility", "Core Program Unit", "Central Program User"], 0),
  q("cs-easy-2", "computer-science", "easy", "What does RAM stand for?", ["Random Access Memory", "Read Access Module", "Rapid Application Method", "Runtime Allocation Memory"], 0),
  q("cs-easy-3", "computer-science", "easy", "Which number system uses only 0s and 1s?", ["Decimal", "Binary", "Hexadecimal", "Octal"], 1),
  q("cs-medium-1", "computer-science", "medium", "Which data structure follows FIFO ordering?", ["Stack", "Queue", "Tree", "Heap"], 1),
  q("cs-medium-2", "computer-science", "medium", "Which data structure uses LIFO ordering?", ["Queue", "Stack", "Array", "Linked list"], 1),
  q("cs-medium-3", "computer-science", "medium", "What is recursion?", ["A loop that never ends", "A function that calls itself", "A sorting algorithm", "A type of variable"], 1),
  q("cs-hard-1", "computer-science", "hard", "What is the time complexity of binary search on a sorted array?", ["O(1)", "O(log n)", "O(n)", "O(n²)"], 1),
  q("cs-hard-2", "computer-science", "hard", "What is the worst-case time complexity of quicksort?", ["O(n log n)", "O(n)", "O(n²)", "O(log n)"], 2),
  q("cs-hard-3", "computer-science", "hard", "Which traversal visits a binary tree's root before its children?", ["In-order", "Post-order", "Pre-order", "Level-order"], 2),

  /* DATABASES */
  q("db-easy-1", "databases", "easy", "Which SQL command retrieves rows from a table?", ["GET", "SELECT", "READ", "FETCHROW"], 1),
  q("db-easy-2", "databases", "easy", "What does SQL stand for?", ["Structured Query Language", "Simple Query Logic", "Sequential Query List", "System Query Language"], 0),
  q("db-easy-3", "databases", "easy", "Which command adds new rows to a table?", ["INSERT", "ADD", "APPEND", "CREATE"], 0),
  q("db-medium-1", "databases", "medium", "What does a primary key uniquely identify?", ["A database", "A table", "A row in a table", "A SQL query"], 2),
  q("db-medium-2", "databases", "medium", "What does a foreign key do?", ["Encrypts a column", "Links a row to a row in another table", "Indexes a table for speed", "Deletes duplicate rows"], 1),
  q("db-medium-3", "databases", "medium", "What type of database uses tables with rows and columns?", ["Relational", "Document", "Graph", "Key-value"], 0),
  q("db-hard-1", "databases", "hard", "Which normal form removes transitive dependencies?", ["1NF", "2NF", "3NF", "4NF"], 2),
  q("db-hard-2", "databases", "hard", "What does ACID stand for in database transactions?", ["Atomicity, Consistency, Isolation, Durability", "Access, Control, Index, Data", "Automatic Commit In Databases", "Aggregation, Cache, Index, Durability"], 0),
  q("db-hard-3", "databases", "hard", "Which SQL clause combines rows from two tables based on a related column?", ["WHERE", "JOIN", "GROUP BY", "UNION"], 1),

  /* WEB DEVELOPMENT */
  q("web-easy-1", "web-development", "easy", "Which language structures the content of a web page?", ["HTML", "CSS", "SQL", "Bash"], 0),
  q("web-easy-2", "web-development", "easy", "Which language is primarily used to style web pages?", ["HTML", "CSS", "SQL", "Python"], 1),
  q("web-easy-3", "web-development", "easy", "What does URL stand for?", ["Uniform Resource Locator", "Universal Record Link", "User Response Layer", "Unified Retrieval Language"], 0),
  q("web-medium-1", "web-development", "medium", "Which HTTP method is conventionally used to create a resource?", ["GET", "POST", "HEAD", "OPTIONS"], 1),
  q("web-medium-2", "web-development", "medium", "Which JavaScript concept lets a function remember variables from its outer scope?", ["Hoisting", "Closure", "Promise", "Callback"], 1),
  q("web-medium-3", "web-development", "medium", "What does DOM stand for?", ["Document Object Model", "Data Output Method", "Dynamic Object Mapping", "Document Ordering Module"], 0),
  q("web-hard-1", "web-development", "hard", "What does CORS primarily control?", ["Database indexing", "Cross-origin browser requests", "CPU scheduling", "File compression"], 1),
  q("web-hard-2", "web-development", "hard", "Which HTTP status code indicates a resource was not found?", ["200", "301", "404", "500"], 2),
  q("web-hard-3", "web-development", "hard", "What is the purpose of a JWT?", ["To style web pages", "To securely transmit claims between parties as a token", "To compress images", "To query databases"], 1),

  /* NETWORKING */
  q("networking-easy-1", "networking", "easy", "What does IP stand for?", ["Internet Protocol", "Internal Port", "Interface Process", "Internet Provider"], 0),
  q("networking-easy-2", "networking", "easy", "What device connects multiple networks together?", ["Router", "Monitor", "Keyboard", "Printer"], 0),
  q("networking-easy-3", "networking", "easy", "What does Wi-Fi primarily use to transmit data?", ["Radio waves", "Sound waves", "Light waves", "Sound cables"], 0),
  q("networking-medium-1", "networking", "medium", "Which protocol translates domain names into IP addresses?", ["DHCP", "DNS", "FTP", "SSH"], 1),
  q("networking-medium-2", "networking", "medium", "Which port does HTTPS typically use?", ["21", "80", "443", "8080"], 2),
  q("networking-medium-3", "networking", "medium", "What does VPN stand for?", ["Virtual Private Network", "Verified Public Network", "Virtual Personal Node", "Variable Packet Network"], 0),
  q("networking-hard-1", "networking", "hard", "Which transport protocol provides reliable and ordered delivery?", ["UDP", "ICMP", "TCP", "ARP"], 2),
  q("networking-hard-2", "networking", "hard", "Which layer of the OSI model handles routing between networks?", ["Data link", "Network", "Transport", "Session"], 1),
  q("networking-hard-3", "networking", "hard", "What does a subnet mask do?", ["Encrypts network traffic", "Divides an IP network into subnetworks", "Assigns MAC addresses", "Blocks malicious traffic"], 1),

  /* CLOUD */
  q("cloud-easy-1", "cloud", "easy", "Which cloud service model provides virtualized computing resources?", ["IaaS", "SaaS", "LAN", "DNS"], 0),
  q("cloud-easy-2", "cloud", "easy", "What does SaaS deliver to users?", ["Raw hardware", "Software over the internet", "Only storage", "Only networking"], 1),
  q("cloud-easy-3", "cloud", "easy", "Which company operates AWS?", ["Google", "Microsoft", "Amazon", "IBM"], 2),
  q("cloud-medium-1", "cloud", "medium", "Which cloud property allows resources to scale with demand?", ["Elasticity", "Normalization", "Compilation", "Locality"], 0),
  q("cloud-medium-2", "cloud", "medium", "What is a 'region' in cloud computing?", ["A single server", "A geographic area containing data centers", "A type of database", "A pricing tier"], 1),
  q("cloud-medium-3", "cloud", "medium", "What does 'serverless' computing mean?", ["There are no servers anywhere", "Developers don't manage the underlying servers", "It only runs on local machines", "It requires manual server provisioning"], 1),
  q("cloud-hard-1", "cloud", "hard", "Which service model provides a managed application platform?", ["IaaS", "PaaS", "DNS", "LAN"], 1),
  q("cloud-hard-2", "cloud", "hard", "What is a key benefit of container orchestration tools like Kubernetes?", ["Manual scaling only", "Automated deployment, scaling, and management of containers", "Faster internet speed", "Cheaper electricity bills"], 1),
  q("cloud-hard-3", "cloud", "hard", "What does 'multi-tenancy' mean in cloud architecture?", ["One customer per physical server", "Multiple customers sharing the same infrastructure securely", "Servers located in multiple countries", "Backup servers only"], 1),

  /* CYBERSECURITY */
  q("security-easy-1", "cybersecurity", "easy", "What is phishing?", ["A backup method", "A social-engineering attack", "A routing protocol", "A compression algorithm"], 1),
  q("security-easy-2", "cybersecurity", "easy", "What is a firewall used for?", ["Speeding up internet", "Filtering network traffic for security", "Storing passwords", "Compressing files"], 1),
  q("security-easy-3", "cybersecurity", "easy", "What does 2FA stand for?", ["Two-Factor Authentication", "Two-File Access", "Twice Fast Authorization", "Two-Frame Analysis"], 0),
  q("security-medium-1", "cybersecurity", "medium", "Which principle gives users only the permissions they need?", ["Least privilege", "Fail-open", "Replication", "Obfuscation"], 0),
  q("security-medium-2", "cybersecurity", "medium", "What is malware?", ["Malicious software designed to harm systems", "A hardware component", "A networking protocol", "A database query"], 0),
  q("security-medium-3", "cybersecurity", "medium", "What is a VPN primarily used for in security?", ["Speeding up downloads", "Encrypting and securing network traffic", "Compressing files", "Blocking all internet access"], 1),
  q("security-hard-1", "cybersecurity", "hard", "Which attack injects untrusted input into a database query?", ["SQL injection", "ARP spoofing", "DDoS", "Packet fragmentation"], 0),
  q("security-hard-2", "cybersecurity", "hard", "What is a 'zero-day' vulnerability?", ["A bug fixed the same day it's found", "A flaw unknown to the vendor with no available patch", "A vulnerability only in old software", "A type of firewall rule"], 1),
  q("security-hard-3", "cybersecurity", "hard", "What does encryption 'at rest' protect?", ["Data while being typed", "Data stored on disk", "Data displayed on screen", "Data in browser cache"], 1)
];

/* ============================================================
   UTILITY FUNCTIONS
============================================================ */

function randomId() {
  return crypto.randomUUID();
}

function shuffle(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function cleanName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");

  if (name.length < 2 || name.length > 16) return null;
  if (!/^[A-Za-z0-9 _-]+$/.test(name)) return null;

  return name;
}

function normalizeRoomCode(value) {
  return String(value || "").trim().toUpperCase();
}

function generateRoomCode() {
  let code;

  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += ROOM_CHARACTERS[Math.floor(Math.random() * ROOM_CHARACTERS.length)];
    }
  } while (rooms.has(code));

  return code;
}

/* ============================================================
   QUESTION SELECTION
============================================================ */

function shuffleQuestionOptions(question) {
  const order = shuffle(question.options.map((_, index) => index));
  const options = order.map((originalIndex) => question.options[originalIndex]);
  const correctIndex = order.indexOf(question.correctIndex);

  return {
    id: question.id,
    category: question.category,
    difficulty: question.difficulty,
    text: question.text,
    options,
    correctIndex
  };
}

function createGameQuestions() {
  const repeatedCategories = shuffle(CATEGORIES).slice(0, 2);
  const categorySlots = shuffle([...CATEGORIES, ...repeatedCategories]);

  const difficultyPool = [
    "easy", "easy", "easy", "easy",
    "medium", "medium", "medium", "medium",
    "hard", "hard"
  ];

  const assignments = [];
  const usedQuestionIds = new Set();
  const usedCategoryDifficulty = new Set();

  function solve(index, remainingDifficulties) {
    if (index >= categorySlots.length) return true;

    const category = categorySlots[index];
    const tryOrder = shuffle(remainingDifficulties);

    for (const difficulty of tryOrder) {
      const key = `${category}:${difficulty}`;

      if (usedCategoryDifficulty.has(key)) continue;

      const candidates = shuffle(
        QUESTION_BANK.filter(
          (item) =>
            item.category === category &&
            item.difficulty === difficulty &&
            !usedQuestionIds.has(item.id)
        )
      );

      if (candidates.length === 0) continue;

      const question = candidates[0];

      assignments[index] = question;
      usedCategoryDifficulty.add(key);
      usedQuestionIds.add(question.id);

      const nextRemaining = [...remainingDifficulties];
      nextRemaining.splice(nextRemaining.indexOf(difficulty), 1);

      if (solve(index + 1, nextRemaining)) return true;

      usedCategoryDifficulty.delete(key);
      usedQuestionIds.delete(question.id);
      assignments[index] = null;
    }

    return false;
  }

  if (!solve(0, difficultyPool)) {
    throw new Error("Unable to create question set.");
  }

  return shuffle(assignments).map(shuffleQuestionOptions);
}

/* ============================================================
   PLAYER HELPERS
============================================================ */

function getConnectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.active && p.connected);
}

function getActivePlayers(room) {
  return [...room.players.values()].filter((p) => p.active);
}

function transferHost(room) {
  const newHost = getConnectedPlayers(room)[0] || getActivePlayers(room)[0];

  if (!newHost) return null;

  room.hostPlayerId = newHost.id;
  return newHost;
}

function createPlayer(socket, name) {
  return {
    id: randomId(),
    token: randomId(),
    name,
    score: 0,
    streak: 0,
    lastPoints: 0,
    powerups: { fiftyFifty: true, doublePoints: true },
    doublePointsActive: false,
    active: true,
    connected: true,
    socketId: socket.id,
    reconnectTimer: null
  };
}

function bindSocketToPlayer(socket, roomCode, player) {
  socket.join(roomCode);
  socket.data.roomCode = roomCode;
  socket.data.playerId = player.id;
  socket.data.token = player.token;
}

/* ============================================================
   ROOM STATE
============================================================ */

function publicRoomState(room) {
  const players = [...room.players.values()]
    .filter((p) => p.active)
    .map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      active: p.active,
      score: p.score,
      streak: p.streak,
      isHost: p.id === room.hostPlayerId
    }));

  return {
    code: room.code,
    status: room.status,
    hostPlayerId: room.hostPlayerId,
    players,
    currentQuestion: room.currentQuestionIndex,
    answeredCount: room.answers.size,
    connectedAnswerCount: getConnectedPlayers(room).filter((p) =>
      room.answers.has(p.id)
    ).length,
    questionEndsAt: room.questionEndsAt
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room_state", publicRoomState(room));
}

/* ============================================================
   SAFE QUESTION
============================================================ */

function safeQuestion(room, player) {
  const question = room.questions[room.currentQuestionIndex];

  if (!question) return null;

  const existingAnswer = room.answers.get(player?.id);
  const eliminated = player ? room.eliminations.get(player.id) || [] : [];

  return {
    id: question.id,
    category: question.category,
    difficulty: question.difficulty,
    text: question.text,
    options: question.options,
    number: room.currentQuestionIndex + 1,
    total: room.questions.length,
    startsAt: room.questionStartsAt,
    endsAt: room.questionEndsAt,
    answeredCount: room.answers.size,
    alreadyAnswered: Boolean(existingAnswer),
    selectedIndex: existingAnswer?.index ?? null,
    streak: player?.streak || 0,
    eliminatedOptions: eliminated,
    powerups: player
      ? {
          fiftyFiftyAvailable: player.powerups.fiftyFifty,
          doublePointsAvailable: player.powerups.doublePoints,
          doublePointsActive: player.doublePointsActive
        }
      : null
  };
}

/* ============================================================
   SEND CURRENT STATE
============================================================ */

function sendCurrentState(socket, room, player) {
  socket.emit("room_state", publicRoomState(room));

  if (room.status === "countdown" && room.countdownEndsAt) {
    socket.emit("countdown", { endsAt: room.countdownEndsAt });
    return;
  }

  if (room.status === "question") {
    socket.emit("question", safeQuestion(room, player));
    return;
  }

  if (room.status === "results" && room.lastResults) {
    socket.emit("question_results", room.lastResults);
    return;
  }

  if (room.status === "finished" && room.finalResults) {
    socket.emit("game_finished", room.finalResults);
  }
}

/* ============================================================
   CLEAR TIMERS
============================================================ */

function clearRoomTimers(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }

  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
}

/* ============================================================
   GAME FLOW
============================================================ */

function startCountdown(room) {
  clearRoomTimers(room);

  room.status = "countdown";
  room.currentQuestionIndex = -1;
  room.questions = createGameQuestions();
  room.countdownEndsAt = Date.now() + COUNTDOWN_TIME;

  broadcastRoom(room);

  io.to(room.code).emit("countdown", { endsAt: room.countdownEndsAt });

  room.timer = setTimeout(() => startQuestion(room), COUNTDOWN_TIME);
}

function startQuestion(room) {
  clearRoomTimers(room);

  room.currentQuestionIndex++;

  if (room.currentQuestionIndex >= room.questions.length) {
    finishGame(room);
    return;
  }

  room.status = "question";
  room.answers = new Map();
  room.eliminations = new Map();
  room.lastResults = null;
  room.questionStartsAt = Date.now();
  room.questionEndsAt = room.questionStartsAt + QUESTION_TIME;

  broadcastRoom(room);

  for (const player of room.players.values()) {
    if (!player.active || !player.connected) continue;

    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket) continue;

    socket.emit("question", safeQuestion(room, player));
  }

  room.timer = setTimeout(() => finishQuestion(room), QUESTION_TIME);
}

function finishQuestion(room) {
  if (room.status !== "question") return;

  clearRoomTimers(room);

  room.status = "results";

  const question = room.questions[room.currentQuestionIndex];

  for (const player of room.players.values()) {
    if (!player.active) continue;

    const answer = room.answers.get(player.id);
    let points = 0;

    const wasCorrect = Boolean(answer && answer.index === question.correctIndex);

    if (wasCorrect) {
      const remaining = Math.max(0, room.questionEndsAt - answer.at);
      const speedBonus = 50 * (remaining / QUESTION_TIME);
      const streakBonus = Math.min(
        STREAK_BONUS_CAP,
        player.streak * STREAK_BONUS_PER_STEP
      );

      points = Math.round(100 + speedBonus + streakBonus);

      if (player.doublePointsActive) points *= 2;

      player.streak += 1;
    } else {
      player.streak = 0;
    }

    player.doublePointsActive = false;
    player.lastPoints = points;
    player.score += points;
  }

  const leaderboard = getActivePlayers(room)
    .map((p) => ({
      id: p.id,
      name: p.name,
      points: p.lastPoints || 0,
      total: p.score,
      streak: p.streak
    }))
    .sort((a, b) => b.total - a.total);

  room.lastResults = {
    questionNumber: room.currentQuestionIndex + 1,
    correctAnswer: question.options[question.correctIndex],
    players: leaderboard
  };

  broadcastRoom(room);

  io.to(room.code).emit("question_results", room.lastResults);

  room.timer = setTimeout(() => {
    if (room.currentQuestionIndex >= room.questions.length - 1) {
      finishGame(room);
    } else {
      startQuestion(room);
    }
  }, RESULTS_TIME);
}

function finishGame(room) {
  clearRoomTimers(room);

  room.status = "finished";

  const leaderboard = [...room.players.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      total: p.score,
      left: !p.active
    }))
    .sort((a, b) => b.total - a.total);

  const highestScore = leaderboard.length ? leaderboard[0].total : 0;
  const winners = leaderboard.filter((p) => p.total === highestScore);

  room.finalResults = {
    leaderboard,
    winners,
    winner: winners[0] || null
  };

  broadcastRoom(room);

  io.to(room.code).emit("game_finished", room.finalResults);

  room.cleanupTimer = setTimeout(() => {
    rooms.delete(room.code);
  }, ROOM_IDLE_CLEANUP);
}

function resetRoomForReplay(room) {
  clearRoomTimers(room);

  room.status = "waiting";
  room.currentQuestionIndex = -1;
  room.questions = [];
  room.answers = new Map();
  room.eliminations = new Map();
  room.questionStartsAt = null;
  room.questionEndsAt = null;
  room.countdownEndsAt = null;
  room.lastResults = null;
  room.finalResults = null;

  for (const [id, player] of room.players) {
    if (!player.active) {
      room.players.delete(id);
      continue;
    }

    player.score = 0;
    player.streak = 0;
    player.lastPoints = 0;
    player.doublePointsActive = false;
    player.powerups = { fiftyFifty: true, doublePoints: true };
  }

  if (!room.players.has(room.hostPlayerId)) transferHost(room);

  broadcastRoom(room);
}

/* ============================================================
   RECONNECT / PRESENCE
============================================================ */

function scheduleReconnectExpiry(room, player) {
  if (player.reconnectTimer) clearTimeout(player.reconnectTimer);

  player.reconnectTimer = setTimeout(() => {
    if (player.connected || !player.active) return;

    player.active = false;

    if (room.hostPlayerId === player.id) transferHost(room);

    broadcastRoom(room);
    checkMinPlayers(room);
    maybeDeleteEmptyRoom(room);
  }, RECONNECT_GRACE);
}

function checkEarlyFinish(room) {
  if (room.status !== "question") return;

  const connected = getConnectedPlayers(room);

  if (connected.length === 0) return;

  if (connected.every((p) => room.answers.has(p.id))) {
    finishQuestion(room);
  }
}

function checkMinPlayers(room) {
  if (
    room.status === "question" ||
    room.status === "countdown" ||
    room.status === "results"
  ) {
    if (getActivePlayers(room).length < MIN_PLAYERS) finishGame(room);
  }
}

function maybeDeleteEmptyRoom(room) {
  const stillPresent = [...room.players.values()].some(
    (p) => p.active || p.connected
  );

  if (!stillPresent) {
    clearRoomTimers(room);
    rooms.delete(room.code);
  }
}

function removePlayer(room, playerId) {
  const player = room.players.get(playerId);

  if (!player) return;

  player.active = false;
  player.connected = false;

  if (player.reconnectTimer) {
    clearTimeout(player.reconnectTimer);
    player.reconnectTimer = null;
  }

  if (room.hostPlayerId === player.id) transferHost(room);

  broadcastRoom(room);
  checkEarlyFinish(room);
  checkMinPlayers(room);
  maybeDeleteEmptyRoom(room);
}

/* ============================================================
   CREATE / JOIN / RECONNECT
============================================================ */

function createRoom(socket, payload, callback) {
  const name = cleanName(payload?.name);

  if (!name) {
    callback({ error: "Name must contain 2–16 valid characters." });
    return;
  }

  const roomCode = generateRoomCode();
  const player = createPlayer(socket, name);

  const room = {
    code: roomCode,
    status: "waiting",
    hostPlayerId: player.id,
    players: new Map(),
    questions: [],
    currentQuestionIndex: -1,
    answers: new Map(),
    eliminations: new Map(),
    questionStartsAt: null,
    questionEndsAt: null,
    countdownEndsAt: null,
    timer: null,
    cleanupTimer: null,
    lastResults: null,
    finalResults: null
  };

  room.players.set(player.id, player);
  rooms.set(roomCode, room);

  bindSocketToPlayer(socket, roomCode, player);

  callback({
    ok: true,
    roomCode,
    playerId: player.id,
    token: player.token,
    name
  });

  broadcastRoom(room);
}

function joinRoom(socket, payload, callback) {
  const name = cleanName(payload?.name);
  const roomCode = normalizeRoomCode(payload?.roomCode);

  if (!name) {
    callback({ error: "Name must contain 2–16 valid characters." });
    return;
  }

  if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
    callback({ error: "Room code must contain 6 characters." });
    return;
  }

  const room = rooms.get(roomCode);

  if (!room) {
    callback({ error: "Room not found." });
    return;
  }

  if (room.status !== "waiting") {
    callback({ error: "The game has already started. New players cannot join." });
    return;
  }

  const activePlayers = getActivePlayers(room);

  if (activePlayers.length >= MAX_PLAYERS) {
    callback({ error: "This room is full." });
    return;
  }

  const duplicate = activePlayers.some(
    (p) => p.name.toLowerCase() === name.toLowerCase()
  );

  if (duplicate) {
    callback({ error: "That player name is already taken." });
    return;
  }

  const player = createPlayer(socket, name);

  room.players.set(player.id, player);

  bindSocketToPlayer(socket, roomCode, player);

  callback({
    ok: true,
    roomCode,
    playerId: player.id,
    token: player.token,
    name
  });

  broadcastRoom(room);
}

function reconnectPlayer(socket, payload, callback) {
  const roomCode = normalizeRoomCode(payload?.roomCode);
  const token = String(payload?.token || "");

  const room = rooms.get(roomCode);

  if (!room) {
    callback({ error: "The room no longer exists." });
    return;
  }

  const player = [...room.players.values()].find(
    (c) => c.token === token && c.active
  );

  if (!player) {
    callback({ error: "Reconnection session expired." });
    return;
  }

  if (player.reconnectTimer) {
    clearTimeout(player.reconnectTimer);
    player.reconnectTimer = null;
  }

  player.connected = true;
  player.socketId = socket.id;

  bindSocketToPlayer(socket, roomCode, player);

  callback({
    ok: true,
    roomCode,
    playerId: player.id,
    token: player.token,
    name: player.name
  });

  sendCurrentState(socket, room, player);
  broadcastRoom(room);
}

/* ============================================================
   SOCKET CONNECTION
============================================================ */

io.on("connection", (socket) => {

  console.log(`Socket connected: ${socket.id}`);

  socket.on("time_sync", (callback) => {
    if (typeof callback === "function") callback(Date.now());
  });

  socket.on("create_room", (payload, callback) => {
    createRoom(socket, payload, callback);
  });

  socket.on("join_room", (payload, callback) => {
    joinRoom(socket, payload, callback);
  });

  socket.on("reconnect_player", (payload, callback) => {
    reconnectPlayer(socket, payload, callback);
  });

  /* START GAME */

  socket.on("start_game", (payload, callback) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room) return callback({ error: "Room not found." });

    const player = room.players.get(socket.data.playerId);

    if (!player) return callback({ error: "Player not found." });

    if (room.hostPlayerId !== player.id) {
      return callback({ error: "Only the host can start the game." });
    }

    if (room.status !== "waiting") {
      return callback({ error: "The game has already started." });
    }

    if (getActivePlayers(room).length < MIN_PLAYERS) {
      return callback({ error: "At least 2 players are required." });
    }

    try {
      startCountdown(room);
      callback({ ok: true });
    } catch (error) {
      console.error(error);
      callback({ error: "Unable to create the game questions." });
    }
  });

  /* USE POWER-UP */

  socket.on("use_powerup", (payload, callback) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room) return callback?.({ error: "Room not found." });

    const player = room.players.get(socket.data.playerId);

    if (!player || !player.active || !player.connected) {
      return callback?.({ error: "You are not an active player." });
    }

    if (room.status !== "question") {
      return callback?.({ error: "Power-ups can only be used during a question." });
    }

    if (room.answers.has(player.id)) {
      return callback?.({ error: "You already answered this question." });
    }

    const type = payload?.type;
    const question = room.questions[room.currentQuestionIndex];

    if (type === "fiftyFifty") {
      if (!player.powerups.fiftyFifty) {
        return callback?.({ error: "You already used 50/50." });
      }

      const wrongIndexes = question.options
        .map((_, index) => index)
        .filter((index) => index !== question.correctIndex);

      const eliminated = shuffle(wrongIndexes).slice(0, 2);

      player.powerups.fiftyFifty = false;
      room.eliminations.set(player.id, eliminated);

      return callback?.({ ok: true, eliminatedOptions: eliminated });
    }

    if (type === "doublePoints") {
      if (!player.powerups.doublePoints) {
        return callback?.({ error: "You already used Double Points." });
      }

      player.powerups.doublePoints = false;
      player.doublePointsActive = true;

      return callback?.({ ok: true, doublePointsActive: true });
    }

    callback?.({ error: "Unknown power-up." });
  });

  /* SUBMIT ANSWER */

  socket.on("submit_answer", (payload, callback) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room) return callback({ error: "Room not found." });

    const player = room.players.get(socket.data.playerId);

    if (!player || !player.active || !player.connected) {
      return callback({ error: "You are not an active player." });
    }

    if (room.status !== "question") {
      return callback({ error: "The question is no longer active." });
    }

    const question = room.questions[room.currentQuestionIndex];

    if (!question || payload?.questionId !== question.id) {
      return callback({ error: "This question is no longer current." });
    }

    if (room.answers.has(player.id)) {
      return callback({ error: "You have already answered this question." });
    }

    const index = Number(payload?.index);

    if (!Number.isInteger(index) || index < 0 || index >= question.options.length) {
      return callback({ error: "Invalid answer." });
    }

    const now = Date.now();

    if (now > room.questionEndsAt) {
      return callback({ error: "Time is up." });
    }

    room.answers.set(player.id, { index, at: now });

    callback({ ok: true });

    io.to(room.code).emit("answer_count", {
      count: room.answers.size,
      total: getConnectedPlayers(room).length
    });

    checkEarlyFinish(room);
  });

  /* PLAY AGAIN */

  socket.on("play_again", (payload, callback) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room) return callback?.({ error: "Room not found." });

    const player = room.players.get(socket.data.playerId);

    if (!player) return callback?.({ error: "Player not found." });

    if (room.hostPlayerId !== player.id) {
      return callback?.({ error: "Only the host can restart the game." });
    }

    if (room.status !== "finished") {
      return callback?.({ error: "The game hasn't finished yet." });
    }

    resetRoomForReplay(room);

    callback?.({ ok: true });
  });

  /* LEAVE GAME */

  socket.on("leave_game", (payload, callback) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room) return callback?.({ ok: true });

    removePlayer(room, socket.data.playerId);

    socket.leave(room.code);

    callback?.({ ok: true });
  });

  /* DISCONNECT */

  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);

    const room = rooms.get(socket.data.roomCode);

    if (!room) return;

    const player = room.players.get(socket.data.playerId);

    if (!player || !player.active) return;

    player.connected = false;
    player.socketId = null;

    if (room.hostPlayerId === player.id) transferHost(room);

    broadcastRoom(room);
    scheduleReconnectExpiry(room, player);
    checkEarlyFinish(room);
  });

});

/* ============================================================
   BACKEND PAGES
   Background: space scene (planets, meteors, pixel rocks, grid floor)
   Content: server-health dashboard layout
   Browsers get a styled page; apps get JSON (or add ?format=json)
============================================================ */

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

function wantsHtml(req) {
  if (req.query.format === "json") return false;
  return String(req.headers.accept || "").includes("text/html");
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

const PAGE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }

body {
  min-height: 100vh;
  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #fff;
  overflow-x: hidden;
  background: linear-gradient(180deg, #060a1f 0%, #08112a 55%, #04070f 100%);
}

/* ---------- BACKGROUND SCENE ---------- */
.scene { position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }

.stars {
  position: absolute; inset: 0;
  background-image:
    radial-gradient(circle, #fff 0 1px, transparent 1.6px),
    radial-gradient(circle, rgba(160,200,255,.9) 0 1px, transparent 1.5px),
    radial-gradient(circle, rgba(0,255,150,.7) 0 1px, transparent 1.5px);
  background-size: 130px 130px, 210px 210px, 290px 290px;
  background-position: 14px 22px, 80px 90px, 150px 40px;
  opacity: .75;
  animation: twinkle 5s ease-in-out infinite alternate;
}
@keyframes twinkle { from { opacity: .45; } to { opacity: .85; } }

.planet { position: absolute; border-radius: 50%; }

.planet.left {
  width: 380px; height: 380px; left: -190px; top: 24%;
  background:
    radial-gradient(circle at 62% 28%, rgba(0,255,150,.18) 0 6%, transparent 7%),
    radial-gradient(circle at 70% 55%, rgba(0,0,0,.35) 0 7%, transparent 8%),
    radial-gradient(circle at 55% 78%, rgba(0,0,0,.30) 0 5%, transparent 6%),
    radial-gradient(circle at 40% 40%, #1c4a48 0%, #0d2a34 50%, #060f1c 78%);
  box-shadow: inset -30px -10px 60px rgba(0,0,0,.65), 0 0 40px rgba(0,255,150,.12);
}

.planet.right {
  width: 300px; height: 300px; right: -120px; top: 9%;
  background:
    radial-gradient(circle at 30% 30%, rgba(0,0,0,.3) 0 6%, transparent 7%),
    radial-gradient(circle at 50% 65%, rgba(0,0,0,.28) 0 8%, transparent 9%),
    radial-gradient(circle at 35% 40%, #1f4a3f 0%, #10303a 52%, #070f1c 80%);
  box-shadow: inset 30px -10px 60px rgba(0,0,0,.6), 0 0 36px rgba(0,255,150,.10);
}

.planet.small {
  width: 46px; height: 46px; right: 6%; top: 42%;
  background: radial-gradient(circle at 35% 35%, #4b3f86, #1b1745 70%);
  box-shadow: 0 0 14px rgba(120,90,255,.35);
}

.meteor {
  position: absolute; height: 2px; width: 130px;
  background: linear-gradient(90deg, transparent, #b9ffe2 70%, #fff);
  border-radius: 2px;
  transform: rotate(-35deg);
  filter: drop-shadow(0 0 6px rgba(0,255,150,.8));
  opacity: .8;
  animation: drift 7s ease-in-out infinite alternate;
}
.meteor.m1 { left: 8%; top: 12%; background: linear-gradient(90deg, transparent, #a78bfa 70%, #fff); filter: drop-shadow(0 0 6px rgba(140,110,255,.8)); }
.meteor.m2 { right: 12%; top: 6%; animation-delay: -2s; }
.meteor.m3 { right: 6%; top: 60%; width: 90px; animation-delay: -4s; background: linear-gradient(90deg, transparent, #a78bfa 70%, #fff); }
@keyframes drift { from { transform: rotate(-35deg) translateX(-14px); } to { transform: rotate(-35deg) translateX(14px); } }

.rocks { position: absolute; bottom: 0; width: 340px; height: 300px; filter: drop-shadow(0 0 12px rgba(0,255,90,.75)); }
.rocks.l { left: 0; }
.rocks.r { right: 0; transform: scaleX(-1); }
.rocks::before {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(160deg, #22307a 0%, #111845 55%, #0a0e2b 100%);
  clip-path: polygon(0 100%, 0 46%, 9% 46%, 9% 30%, 19% 30%, 19% 16%, 31% 16%, 31% 34%, 42% 34%, 42% 52%, 54% 52%, 54% 68%, 68% 68%, 68% 84%, 82% 84%, 82% 100%);
}

.floor {
  position: absolute; left: 0; right: 0; bottom: 0; height: 30vh;
  perspective: 420px;
  -webkit-mask-image: linear-gradient(to top, #000 25%, transparent);
  mask-image: linear-gradient(to top, #000 25%, transparent);
}
.floor::before {
  content: ""; position: absolute; left: -60%; right: -60%; top: 0; bottom: 0;
  background-image:
    linear-gradient(rgba(0,255,106,.6) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0,255,106,.6) 1px, transparent 1px);
  background-size: 64px 64px;
  transform: rotateX(62deg);
  transform-origin: 50% 100%;
}

/* ---------- CONTENT ---------- */
.page { position: relative; z-index: 1; width: min(1120px, 92vw); margin: 0 auto; padding: 48px 0 40px; }

.hero { text-align: center; position: relative; }

.crown { font-size: clamp(42px, 7vw, 70px); line-height: .8; filter: drop-shadow(0 0 18px rgba(255,205,70,.55)); }
.weapons, .controller { position: absolute; top: 42px; font-size: clamp(38px, 6vw, 68px); filter: drop-shadow(0 0 14px rgba(0,255,160,.45)); }
.weapons { left: 2%; transform: rotate(-28deg); }
.controller { right: 2%; transform: rotate(9deg); }

h1 {
  margin: 8px 0 4px;
  font-size: clamp(48px, 9vw, 92px);
  line-height: .95;
  letter-spacing: .09em;
  font-weight: 950;
  font-style: italic;
  text-shadow: 0 0 8px rgba(0,255,160,.9), 0 0 25px rgba(0,255,160,.55), 0 0 55px rgba(0,255,160,.25);
}

.title-line {
  width: min(650px, 75vw); height: 2px; margin: 14px auto 16px;
  background: linear-gradient(90deg, transparent, #00ff9a, transparent);
  box-shadow: 0 0 18px rgba(0,255,154,.8);
}

.subtitle { color: #d9fff1; font-size: clamp(12px, 2vw, 17px); letter-spacing: .22em; text-transform: uppercase; font-weight: 800; }

.online {
  width: fit-content; margin: 25px auto 8px; padding: 9px 20px;
  border: 1px solid rgba(0,255,154,.55); border-radius: 999px;
  background: rgba(0,255,154,.07); color: #00ff9a;
  font-size: 13px; font-weight: 900; letter-spacing: .15em;
  box-shadow: 0 0 25px rgba(0,255,154,.12), inset 0 0 20px rgba(0,255,154,.04);
}
.dot { display: inline-block; width: 9px; height: 9px; margin-right: 9px; border-radius: 50%; background: #00ff9a; box-shadow: 0 0 12px #00ff9a; }

.tagline { color: #a9c4be; margin: 10px 0 28px; font-size: 14px; }

.health {
  padding: 22px 24px; margin-bottom: 20px;
  border: 1px solid rgba(0,255,154,.30); border-radius: 18px;
  background: rgba(6,17,20,.78);
  box-shadow: 0 0 30px rgba(0,255,154,.07), inset 0 0 35px rgba(0,255,154,.025);
}
.health-head { display: flex; justify-content: space-between; gap: 20px; align-items: center; margin-bottom: 12px; }
.health-label { font-weight: 800; color: #dffef2; }
.health-value { color: #00ff9a; font-size: 18px; font-weight: 900; }
.bar { height: 13px; border-radius: 999px; background: #111b20; overflow: hidden; border: 1px solid rgba(255,255,255,.07); }
.bar > div { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #00a96d, #00ff9a, #7dffd1); box-shadow: 0 0 18px rgba(0,255,154,.8); }

.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.card {
  min-height: 132px; padding: 22px 16px; text-align: center;
  border: 1px solid rgba(0,255,154,.24); border-radius: 18px;
  background: linear-gradient(145deg, rgba(10,28,30,.88), rgba(4,12,17,.9));
  box-shadow: inset 0 0 25px rgba(0,255,154,.025), 0 12px 35px rgba(0,0,0,.22);
  transition: transform .2s, border-color .2s, box-shadow .2s;
}
.card:hover { transform: translateY(-4px); border-color: rgba(0,255,154,.62); box-shadow: 0 0 28px rgba(0,255,154,.10); }
.icon { font-size: 29px; margin-bottom: 9px; }
.label { color: #78908c; text-transform: uppercase; letter-spacing: .16em; font-size: 10px; font-weight: 800; }
.value { margin-top: 9px; color: #fff; font-size: 19px; font-weight: 900; letter-spacing: .06em; word-break: break-word; }
.value.green { color: #00ff9a; text-shadow: 0 0 12px rgba(0,255,154,.4); }

.panel {
  margin-top: 20px; padding: 22px 24px;
  border: 1px solid rgba(0,255,154,.24); border-radius: 18px;
  background: rgba(6,17,20,.78);
}
.panel h2 { margin: 0 0 14px; font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: #dffef2; }
.panel h3 { margin: 16px 0 8px; font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: #78908c; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 6px 12px; border: 1px solid rgba(0,255,154,.28); border-radius: 999px; background: rgba(0,255,154,.06); color: #00ff9a; font-size: 12px; font-weight: 800; letter-spacing: .04em; }
.row { display: flex; justify-content: space-between; gap: 16px; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,.06); font-size: 13px; }
.row:last-child { border-bottom: 0; }
.row b { color: #dffff3; }
.row span { color: #00ff9a; font-weight: 800; }

.links { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 20px; }
.link {
  display: flex; align-items: center; justify-content: space-between; gap: 15px; padding: 18px 20px;
  color: #fff; text-decoration: none;
  border: 1px solid rgba(0,255,154,.22); border-radius: 15px; background: rgba(5,15,20,.75);
  transition: .2s;
}
.link:hover { border-color: #00ff9a; box-shadow: 0 0 24px rgba(0,255,154,.1); transform: translateY(-2px); }
.link strong { color: #dffff3; font-size: 13px; }
.link small { color: #00ff9a; font-weight: 800; }

.footer { text-align: center; margin-top: 30px; color: #627772; font-size: 12px; letter-spacing: .08em; }

@media (max-width: 800px) {
  .weapons, .controller { opacity: .25; }
  .cards { grid-template-columns: repeat(2, 1fr); }
  .rocks { width: 220px; height: 200px; }
}
@media (max-width: 520px) {
  .page { padding-top: 30px; }
  .cards { grid-template-columns: 1fr; }
  .weapons, .controller { display: none; }
  .rocks { display: none; }
}
`;

function renderPage({
  title = "Tech Battle Server",
  tagline = "The Tech Battle server is running and ready for players.",
  badge = "SERVER ONLINE",
  healthValue = "100%",
  cards = [],
  panels = []
}) {
  const cardsHtml = cards
    .map(
      (c) => `
    <article class="card">
      <div class="icon">${c.icon}</div>
      <div class="label">${esc(c.label)}</div>
      <div class="value${c.green ? " green" : ""}">${esc(c.value)}</div>
    </article>`
    )
    .join("");

  const panelsHtml = panels
    .map((p) => {
      const body = p.groups
        ? p.groups
            .map(
              (g) => `<h3>${esc(g.name)}</h3>
        <div class="chips">${g.items.map((i) => `<span class="chip">${esc(i)}</span>`).join("")}</div>`
            )
            .join("")
        : p.rows
        ? p.rows.map((r) => `<div class="row"><b>${esc(r[0])}</b><span>${esc(r[1])}</span></div>`).join("")
        : "";

      return `<section class="panel"><h2>${esc(p.title)}</h2>${body}</section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>

<div class="scene">
  <div class="stars"></div>
  <div class="planet left"></div>
  <div class="planet right"></div>
  <div class="planet small"></div>
  <div class="meteor m1"></div>
  <div class="meteor m2"></div>
  <div class="meteor m3"></div>
  <div class="floor"></div>
  <div class="rocks l"></div>
  <div class="rocks r"></div>
</div>

<main class="page">

  <section class="hero">
    <div class="weapons">⚔️</div>
    <div class="controller">🎮</div>
    <div class="crown">👑</div>

    <h1>TECH BATTLE</h1>
    <div class="title-line"></div>
    <div class="subtitle">⚔️ REAL-TIME MULTIPLAYER TECHNOLOGY QUIZ 🎮</div>

    <div class="online"><span class="dot"></span>${esc(badge)}</div>
    <p class="tagline">${esc(tagline)}</p>
  </section>

  <section class="health">
    <div class="health-head">
      <div class="health-label">💚 Server Health</div>
      <div class="health-value">${esc(healthValue)}</div>
    </div>
    <div class="bar"><div></div></div>
  </section>

  <section class="cards">${cardsHtml}</section>

  ${panelsHtml}

  <section class="links">
    <a class="link" href="/health"><strong>❤️ HEALTH CHECK</strong><small>/health</small></a>
    <a class="link" href="/api"><strong>⚡ SERVER API</strong><small>/api</small></a>
    <a class="link" href="/docs"><strong>📖 DOCUMENTATION</strong><small>/docs</small></a>
  </section>

  <div class="footer">
    <b>TECH BATTLE</b> • Multiplayer Quiz Server • Socket.IO Online
  </div>

</main>

</body>
</html>`;
}

/* ---------- HOME ---------- */

app.get("/", (req, res) => {
  res.send(
    renderPage({
      cards: [
        { icon: "⚡", label: "Status", value: "ACTIVE", green: true },
        { icon: "⚔️", label: "Multiplayer", value: "ENABLED" },
        { icon: "🌐", label: "Environment", value: "PRODUCTION" },
        { icon: "🔌", label: "Port", value: PORT },
        { icon: "❤️", label: "Health", value: "100%", green: true },
        { icon: "🎮", label: "Game Engine", value: "READY" }
      ]
    })
  );
});

/* ---------- API INFO ---------- */

app.get("/api", (req, res) => {
  const info = {
    service: "Tech Battle Server",
    status: "online",
    multiplayer: true,
    socketIO: true,
    environment: process.env.NODE_ENV || "production",
    endpoints: {
      health: "/health",
      docs: "/docs",
      socket: "Socket.IO"
    }
  };

  if (!wantsHtml(req)) return res.json(info);

  res.send(
    renderPage({
      title: "Server API • Tech Battle",
      tagline: "Game API information for the Tech Battle server.",
      cards: [
        { icon: "⚡", label: "Status", value: "ONLINE", green: true },
        { icon: "⚔️", label: "Multiplayer", value: "ENABLED" },
        { icon: "📡", label: "Socket.IO", value: "ENABLED" },
        { icon: "🌐", label: "Environment", value: info.environment.toUpperCase() },
        { icon: "🔌", label: "Port", value: PORT },
        { icon: "🎮", label: "Service", value: "TECH BATTLE" }
      ],
      panels: [
        {
          title: "Endpoints",
          rows: [
            ["Health check", "/health"],
            ["Documentation", "/docs"],
            ["Realtime", "Socket.IO"]
          ]
        }
      ]
    })
  );
});

/* ---------- HEALTH ---------- */

app.get("/health", (req, res) => {
  const data = {
    ok: true,
    service: "Tech Battle server",
    timestamp: Date.now(),
    uptimeSeconds: Math.floor(process.uptime()),
    activeRooms: rooms.size
  };

  if (!wantsHtml(req)) return res.json(data);

  res.send(
    renderPage({
      title: "Health Check • Tech Battle",
      tagline: "All systems operational.",
      badge: "HEALTHY",
      cards: [
        { icon: "⚡", label: "Status", value: "OK", green: true },
        { icon: "⏱️", label: "Uptime", value: formatUptime(process.uptime()) },
        { icon: "🏠", label: "Active Rooms", value: rooms.size },
        { icon: "🔌", label: "Port", value: PORT },
        { icon: "🕒", label: "Server Time", value: new Date(data.timestamp).toISOString().slice(11, 19) + " UTC" },
        { icon: "❤️", label: "Health", value: "100%", green: true }
      ]
    })
  );
});

/* ---------- DOCS ---------- */

app.get("/docs", (req, res) => {
  const docs = {
    service: "Tech Battle Server",
    transport: "Socket.IO",
    limits: {
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      questionTimeMs: QUESTION_TIME
    },
    clientEvents: [
      "time_sync", "create_room", "join_room", "reconnect_player",
      "start_game", "use_powerup", "submit_answer", "play_again", "leave_game"
    ],
    serverEvents: [
      "room_state", "countdown", "question", "answer_count",
      "question_results", "game_finished"
    ],
    http: {
      "/health": "Health check",
      "/api": "Service info",
      "/docs": "This page"
    }
  };

  if (!wantsHtml(req)) return res.json(docs);

  res.send(
    renderPage({
      title: "Documentation • Tech Battle",
      tagline: "Socket.IO events and game limits.",
      cards: [
        { icon: "👥", label: "Min Players", value: MIN_PLAYERS },
        { icon: "🧑‍🤝‍🧑", label: "Max Players", value: MAX_PLAYERS },
        { icon: "⏳", label: "Question Time", value: `${QUESTION_TIME / 1000}s` },
        { icon: "❓", label: "Questions / Game", value: 10 },
        { icon: "🔌", label: "Transport", value: "SOCKET.IO" },
        { icon: "🎮", label: "Game Engine", value: "READY", green: true }
      ],
      panels: [
        {
          title: "Socket Events",
          groups: [
            { name: "Client → Server", items: docs.clientEvents },
            { name: "Server → Client", items: docs.serverEvents }
          ]
        }
      ]
    })
  );
});

/* ============================================================
   START SERVER
============================================================ */

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("======================================");
  console.log("       TECH BATTLE SERVER");
  console.log("======================================");
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log("Socket.IO multiplayer: ENABLED");
  console.log("======================================");
});