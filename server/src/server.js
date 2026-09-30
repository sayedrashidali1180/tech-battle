import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
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

// ============================================================
// QUIZBASE API
// ============================================================
//
// One QuizBase API request is made when a match starts.
// That request returns 10 questions which are then stored
// in the room and shared by every player in that match.
//
// The API key MUST be stored in the server environment:
// QUIZBASE_API_KEY
// ============================================================

const QUIZBASE_API_URL =
  "https://quizbase.runriva.com/api/v1/questions/random";

const QUIZBASE_API_KEY =
  process.env.QUIZBASE_API_KEY || "";

const QUIZBASE_QUESTION_COUNT = 10;

const rooms = new Map();

const ROOM_CHARACTERS =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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
   QUIZ TYPES
============================================================ */

const TECHNICAL_CATEGORIES = [...CATEGORIES];

const QUIZ_TYPES = {
  aptitude: {
    label: "Aptitude",
    categories: ["aptitude"]
  },

  reasoning: {
    label: "Logical Reasoning",
    categories: ["reasoning"]
  },

  verbal: {
    label: "Verbal Ability",
    categories: ["verbal"]
  },

  technical: {
    label: "Technical",
    categories: TECHNICAL_CATEGORIES
  },

  mixed: {
    label: "Mixed Placement",
    categories: [
      ...TECHNICAL_CATEGORIES,
      "aptitude",
      "reasoning",
      "verbal"
    ]
  }
};

function normalizeQuizType(value) {
  const type = String(value || "")
    .trim()
    .toLowerCase();

  return QUIZ_TYPES[type] ? type : "mixed";
}

/* ============================================================
   MATCH SIZES / BATTLE FORMATS / TEAMS
============================================================ */

const MATCH_SIZES = [2, 4, 6, 8];

const BATTLE_FORMATS = {
  2: {
    "1v1": { label: "1v1", teams: 2, teamSize: 1 }
  },
  4: {
    "2v2": { label: "2v2", teams: 2, teamSize: 2 },
    "1v1v1v1": { label: "1v1v1v1", teams: 4, teamSize: 1 }
  },
  6: {
    "3v3": { label: "3v3", teams: 2, teamSize: 3 },
    "2v2v2": { label: "2v2v2", teams: 3, teamSize: 2 },
    "1v1v1v1v1v1": { label: "1v1v1v1v1v1", teams: 6, teamSize: 1 }
  },
  8: {
    "4v4": { label: "4v4", teams: 2, teamSize: 4 },
    "2v2v2v2": { label: "2v2v2v2", teams: 4, teamSize: 2 },
    "1v1v1v1v1v1v1v1": { label: "1v1v1v1v1v1v1v1", teams: 8, teamSize: 1 }
  }
};

function normalizeMatchSize(value) {
  const size = Number(value);
  return MATCH_SIZES.includes(size) ? size : 2;
}

function getBattleFormats(matchSize) {
  return BATTLE_FORMATS[normalizeMatchSize(matchSize)] || BATTLE_FORMATS[2];
}

function normalizeBattleFormat(matchSize, value) {
  const formats = getBattleFormats(matchSize);
  const requested = String(value || "").trim().toLowerCase();
  return formats[requested] ? requested : Object.keys(formats)[0];
}

function getBattleConfig(room) {
  return getBattleFormats(room.matchSize)[room.battleFormat];
}

function assignTeams(room) {
  const players = shuffle(getActivePlayers(room));
  const config = getBattleConfig(room);
  const teamNames = Array.from({ length: config.teams }, (_, i) =>
    `Team ${String.fromCharCode(65 + i)}`
  );

  players.forEach((player, index) => {
    const teamIndex = config.ffa ? index : index % config.teams;
    player.teamId = `team-${teamIndex + 1}`;
    player.teamName = config.ffa ? player.name : teamNames[teamIndex];
  });
}

function clearTeams(room) {
  for (const player of room.players.values()) {
    player.teamId = null;
    player.teamName = null;
  }
}

function getTeamStandings(room) {
  const groups = new Map();

  for (const player of getActivePlayers(room)) {
    const id = player.teamId || `player-${player.id}`;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        name: player.teamName || player.name,
        score: 0,
        players: []
      });
    }
    const team = groups.get(id);
    team.score += player.score;
    team.players.push({
      id: player.id,
      name: player.name,
      score: player.score,
      lastPoints: player.lastPoints || 0,
      connected: player.connected
    });
  }

  return [...groups.values()]
    .sort((a, b) => b.score - a.score)
    .map((team, index) => ({
      ...team,
      rank: index + 1,
      players: team.players.sort((a, b) => b.score - a.score)
    }));
}

function getPlayerLeaderboard(room) {
  return getActivePlayers(room)
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      total: player.score,
      points: player.lastPoints || 0,
      lastPoints: player.lastPoints || 0,
      streak: player.streak,
      teamId: player.teamId,
      teamName: player.teamName,
      connected: player.connected
    }))
    .sort((a, b) => b.score - a.score)
    .map((player, index) => ({ ...player, rank: index + 1 }));
}

function getLeaderboardPayload(room) {
  return {
    players: getPlayerLeaderboard(room),
    teams: getTeamStandings(room),
    questionNumber: room.currentQuestionIndex + 1,
    totalQuestions: room.questions.length
  };
}

function emitLeaderboard(room) {
  io.to(room.code).emit("leaderboard_update", getLeaderboardPayload(room));
}

/* ============================================================
   QUESTION HELPER
============================================================ */

const q = (
  id,
  category,
  difficulty,
  text,
  options,
  correctIndex
) => ({
  id,
  category,
  difficulty,
  text,
  options,
  correctIndex
});

/* ============================================================
   QUESTION BANK
============================================================ */

const QUESTION_BANK = [

  /* ==========================================================
     PROGRAMMING
  ========================================================== */

  q(
    "programming-easy-1",
    "programming",
    "easy",
    "Which keyword defines a function in Python?",
    ["func", "def", "function", "define"],
    1
  ),

  q(
    "programming-easy-2",
    "programming",
    "easy",
    "Which symbol starts a comment in Python?",
    ["//", "#", "<!-- -->", "/* */"],
    1
  ),

  q(
    "programming-easy-3",
    "programming",
    "easy",
    "Which data type represents true/false values?",
    ["Integer", "Boolean", "String", "Float"],
    1
  ),

  q(
    "programming-medium-1",
    "programming",
    "medium",
    "What is the average-case lookup complexity of a hash table?",
    ["O(1)", "O(log n)", "O(n)", "O(n log n)"],
    0
  ),

  q(
    "programming-medium-2",
    "programming",
    "medium",
    "What does the acronym API stand for?",
    [
      "Application Programming Interface",
      "Automated Program Instruction",
      "Applied Programming Index",
      "Advanced Protocol Interface"
    ],
    0
  ),

  q(
    "programming-medium-3",
    "programming",
    "medium",
    "Which sorting algorithm has average time complexity O(n log n)?",
    [
      "Bubble sort",
      "Merge sort",
      "Selection sort",
      "Insertion sort"
    ],
    1
  ),

  q(
    "programming-hard-1",
    "programming",
    "hard",
    "Which principle says software entities should be open for extension but closed for modification?",
    [
      "DRY",
      "KISS",
      "Open/Closed Principle",
      "YAGNI"
    ],
    2
  ),

  q(
    "programming-hard-2",
    "programming",
    "hard",
    "What is a race condition?",
    [
      "A CPU scheduling algorithm",
      "A bug from unsynchronized concurrent access to shared data",
      "A network routing error",
      "A type of memory leak"
    ],
    1
  ),

  q(
    "programming-hard-3",
    "programming",
    "hard",
    "Which design pattern restricts a class to a single instance?",
    [
      "Factory",
      "Singleton",
      "Observer",
      "Decorator"
    ],
    1
  ),

  /* ==========================================================
     AI
  ========================================================== */

  q(
    "ai-easy-1",
    "ai",
    "easy",
    "What does AI stand for?",
    [
      "Automated Interface",
      "Artificial Intelligence",
      "Applied Internet",
      "Algorithmic Integration"
    ],
    1
  ),

  q(
    "ai-easy-2",
    "ai",
    "easy",
    "What is a dataset in machine learning?",
    [
      "A programming language",
      "A collection of data used to train models",
      "A type of neural network",
      "A cloud server"
    ],
    1
  ),

  q(
    "ai-easy-3",
    "ai",
    "easy",
    "Which company created ChatGPT?",
    [
      "Google",
      "Anthropic",
      "OpenAI",
      "Meta"
    ],
    2
  ),

  q(
    "ai-medium-1",
    "ai",
    "medium",
    "Which type of machine learning uses labeled training examples?",
    [
      "Unsupervised learning",
      "Reinforcement learning",
      "Supervised learning",
      "Random learning"
    ],
    2
  ),

  q(
    "ai-medium-2",
    "ai",
    "medium",
    "What is overfitting in machine learning?",
    [
      "A model that performs well on new data",
      "A model that memorizes training data but fails to generalize",
      "A model with too few parameters",
      "A model trained too quickly"
    ],
    1
  ),

  q(
    "ai-medium-3",
    "ai",
    "medium",
    "What does NLP stand for?",
    [
      "Natural Language Processing",
      "Neural Learning Protocol",
      "Network Layer Programming",
      "Numeric Language Parsing"
    ],
    0
  ),

  q(
    "ai-hard-1",
    "ai",
    "hard",
    "Which activation function is commonly used in hidden layers of modern neural networks?",
    [
      "ReLU",
      "Softmax",
      "Linear only",
      "Identity only"
    ],
    0
  ),

  q(
    "ai-hard-2",
    "ai",
    "hard",
    "Which technique reduces overfitting by randomly disabling neurons during training?",
    [
      "Dropout",
      "Batch normalization",
      "Gradient clipping",
      "Pooling"
    ],
    0
  ),

  q(
    "ai-hard-3",
    "ai",
    "hard",
    "What is the core mechanism behind Transformer models?",
    [
      "Convolution",
      "Recurrence",
      "Self-attention",
      "Pooling"
    ],
    2
  ),

  /* ==========================================================
     COMPUTER SCIENCE
  ========================================================== */

  q(
    "cs-easy-1",
    "computer-science",
    "easy",
    "What does CPU stand for?",
    [
      "Central Processing Unit",
      "Computer Primary Utility",
      "Core Program Unit",
      "Central Program User"
    ],
    0
  ),

  q(
    "cs-easy-2",
    "computer-science",
    "easy",
    "What does RAM stand for?",
    [
      "Random Access Memory",
      "Read Access Module",
      "Rapid Application Method",
      "Runtime Allocation Memory"
    ],
    0
  ),

  q(
    "cs-easy-3",
    "computer-science",
    "easy",
    "Which number system uses only 0s and 1s?",
    [
      "Decimal",
      "Binary",
      "Hexadecimal",
      "Octal"
    ],
    1
  ),

  q(
    "cs-medium-1",
    "computer-science",
    "medium",
    "Which data structure follows FIFO ordering?",
    [
      "Stack",
      "Queue",
      "Tree",
      "Heap"
    ],
    1
  ),

  q(
    "cs-medium-2",
    "computer-science",
    "medium",
    "Which data structure uses LIFO ordering?",
    [
      "Queue",
      "Stack",
      "Array",
      "Linked list"
    ],
    1
  ),

  q(
    "cs-medium-3",
    "computer-science",
    "medium",
    "What is recursion?",
    [
      "A loop that never ends",
      "A function that calls itself",
      "A sorting algorithm",
      "A type of variable"
    ],
    1
  ),

  q(
    "cs-hard-1",
    "computer-science",
    "hard",
    "What is the time complexity of binary search on a sorted array?",
    [
      "O(1)",
      "O(log n)",
      "O(n)",
      "O(n²)"
    ],
    1
  ),

  q(
    "cs-hard-2",
    "computer-science",
    "hard",
    "What is the worst-case time complexity of quicksort?",
    [
      "O(n log n)",
      "O(n)",
      "O(n²)",
      "O(log n)"
    ],
    2
  ),

  q(
    "cs-hard-3",
    "computer-science",
    "hard",
    "Which traversal visits a binary tree's root before its children?",
    [
      "In-order",
      "Post-order",
      "Pre-order",
      "Level-order"
    ],
    2
  ),

  /* ==========================================================
     DATABASES
  ========================================================== */

  q(
    "db-easy-1",
    "databases",
    "easy",
    "Which SQL command retrieves rows from a table?",
    [
      "GET",
      "SELECT",
      "READ",
      "FETCHROW"
    ],
    1
  ),

  q(
    "db-easy-2",
    "databases",
    "easy",
    "What does SQL stand for?",
    [
      "Structured Query Language",
      "Simple Query Logic",
      "Sequential Query List",
      "System Query Language"
    ],
    0
  ),

  q(
    "db-easy-3",
    "databases",
    "easy",
    "Which command adds new rows to a table?",
    [
      "INSERT",
      "ADD",
      "APPEND",
      "CREATE"
    ],
    0
  ),

  q(
    "db-medium-1",
    "databases",
    "medium",
    "What does a primary key uniquely identify?",
    [
      "A database",
      "A table",
      "A row in a table",
      "A SQL query"
    ],
    2
  ),

  q(
    "db-medium-2",
    "databases",
    "medium",
    "What does a foreign key do?",
    [
      "Encrypts a column",
      "Links a row to a row in another table",
      "Indexes a table for speed",
      "Deletes duplicate rows"
    ],
    1
  ),

  q(
    "db-medium-3",
    "databases",
    "medium",
    "What type of database uses tables with rows and columns?",
    [
      "Relational",
      "Document",
      "Graph",
      "Key-value"
    ],
    0
  ),

  q(
    "db-hard-1",
    "databases",
    "hard",
    "Which normal form removes transitive dependencies?",
    [
      "1NF",
      "2NF",
      "3NF",
      "4NF"
    ],
    2
  ),

  q(
    "db-hard-2",
    "databases",
    "hard",
    "What does ACID stand for in database transactions?",
    [
      "Atomicity, Consistency, Isolation, Durability",
      "Access, Control, Index, Data",
      "Automatic Commit In Databases",
      "Aggregation, Cache, Index, Durability"
    ],
    0
  ),

  q(
    "db-hard-3",
    "databases",
    "hard",
    "Which SQL clause combines rows from two tables based on a related column?",
    [
      "WHERE",
      "JOIN",
      "GROUP BY",
      "UNION"
    ],
    1
  ),

  /* ==========================================================
     WEB DEVELOPMENT
  ========================================================== */

  q(
    "web-easy-1",
    "web-development",
    "easy",
    "Which language structures the content of a web page?",
    [
      "HTML",
      "CSS",
      "SQL",
      "Bash"
    ],
    0
  ),

  q(
    "web-easy-2",
    "web-development",
    "easy",
    "Which language is primarily used to style web pages?",
    [
      "HTML",
      "CSS",
      "SQL",
      "Python"
    ],
    1
  ),

  q(
    "web-easy-3",
    "web-development",
    "easy",
    "What does URL stand for?",
    [
      "Uniform Resource Locator",
      "Universal Record Link",
      "User Response Layer",
      "Unified Retrieval Language"
    ],
    0
  ),

  q(
    "web-medium-1",
    "web-development",
    "medium",
    "Which HTTP method is conventionally used to create a resource?",
    [
      "GET",
      "POST",
      "HEAD",
      "OPTIONS"
    ],
    1
  ),

  q(
    "web-medium-2",
    "web-development",
    "medium",
    "Which JavaScript concept lets a function remember variables from its outer scope?",
    [
      "Hoisting",
      "Closure",
      "Promise",
      "Callback"
    ],
    1
  ),

  q(
    "web-medium-3",
    "web-development",
    "medium",
    "What does DOM stand for?",
    [
      "Document Object Model",
      "Data Output Method",
      "Dynamic Object Mapping",
      "Document Ordering Module"
    ],
    0
  ),

  q(
    "web-hard-1",
    "web-development",
    "hard",
    "What does CORS primarily control?",
    [
      "Database indexing",
      "Cross-origin browser requests",
      "CPU scheduling",
      "File compression"
    ],
    1
  ),

  q(
    "web-hard-2",
    "web-development",
    "hard",
    "Which HTTP status code indicates a resource was not found?",
    [
      "200",
      "301",
      "404",
      "500"
    ],
    2
  ),

  q(
    "web-hard-3",
    "web-development",
    "hard",
    "What is the purpose of a JWT?",
    [
      "To style web pages",
      "To securely transmit claims between parties as a token",
      "To compress images",
      "To query databases"
    ],
    1
  ),

  /* ==========================================================
     NETWORKING
  ========================================================== */

  q(
    "networking-easy-1",
    "networking",
    "easy",
    "What does IP stand for?",
    [
      "Internet Protocol",
      "Internal Port",
      "Interface Process",
      "Internet Provider"
    ],
    0
  ),

  q(
    "networking-easy-2",
    "networking",
    "easy",
    "What device connects multiple networks together?",
    [
      "Router",
      "Monitor",
      "Keyboard",
      "Printer"
    ],
    0
  ),

  q(
    "networking-easy-3",
    "networking",
    "easy",
    "What does Wi-Fi primarily use to transmit data?",
    [
      "Radio waves",
      "Sound waves",
      "Light waves",
      "Sound cables"
    ],
    0
  ),

  q(
    "networking-medium-1",
    "networking",
    "medium",
    "Which protocol translates domain names into IP addresses?",
    [
      "DHCP",
      "DNS",
      "FTP",
      "SSH"
    ],
    1
  ),

  q(
    "networking-medium-2",
    "networking",
    "medium",
    "Which port does HTTPS typically use?",
    [
      "21",
      "80",
      "443",
      "8080"
    ],
    2
  ),

  q(
    "networking-medium-3",
    "networking",
    "medium",
    "What does VPN stand for?",
    [
      "Virtual Private Network",
      "Verified Public Network",
      "Virtual Personal Node",
      "Variable Packet Network"
    ],
    0
  ),

  q(
    "networking-hard-1",
    "networking",
    "hard",
    "Which transport protocol provides reliable and ordered delivery?",
    [
      "UDP",
      "ICMP",
      "TCP",
      "ARP"
    ],
    2
  ),

  q(
    "networking-hard-2",
    "networking",
    "hard",
    "Which layer of the OSI model handles routing between networks?",
    [
      "Data link",
      "Network",
      "Transport",
      "Session"
    ],
    1
  ),

  q(
    "networking-hard-3",
    "networking",
    "hard",
    "What does a subnet mask do?",
    [
      "Encrypts network traffic",
      "Divides an IP network into subnetworks",
      "Assigns MAC addresses",
      "Blocks malicious traffic"
    ],
    1
  ),

  /* ==========================================================
     CLOUD
  ========================================================== */

  q(
    "cloud-easy-1",
    "cloud",
    "easy",
    "Which cloud service model provides virtualized computing resources?",
    [
      "IaaS",
      "SaaS",
      "LAN",
      "DNS"
    ],
    0
  ),

  q(
    "cloud-easy-2",
    "cloud",
    "easy",
    "What does SaaS deliver to users?",
    [
      "Raw hardware",
      "Software over the internet",
      "Only storage",
      "Only networking"
    ],
    1
  ),

  q(
    "cloud-easy-3",
    "cloud",
    "easy",
    "Which company operates AWS?",
    [
      "Google",
      "Microsoft",
      "Amazon",
      "IBM"
    ],
    2
  ),

  q(
    "cloud-medium-1",
    "cloud",
    "medium",
    "Which cloud property allows resources to scale with demand?",
    [
      "Elasticity",
      "Normalization",
      "Compilation",
      "Locality"
    ],
    0
  ),

  q(
    "cloud-medium-2",
    "cloud",
    "medium",
    "What is a region in cloud computing?",
    [
      "A single server",
      "A geographic area containing data centers",
      "A type of database",
      "A pricing tier"
    ],
    1
  ),

  q(
    "cloud-medium-3",
    "cloud",
    "medium",
    "What does serverless computing mean?",
    [
      "There are no servers anywhere",
      "Developers don't manage the underlying servers",
      "It only runs on local machines",
      "It requires manual server provisioning"
    ],
    1
  ),

  q(
    "cloud-hard-1",
    "cloud",
    "hard",
    "Which service model provides a managed application platform?",
    [
      "IaaS",
      "PaaS",
      "DNS",
      "LAN"
    ],
    1
  ),

  q(
    "cloud-hard-2",
    "cloud",
    "hard",
    "What is a key benefit of container orchestration tools like Kubernetes?",
    [
      "Manual scaling only",
      "Automated deployment, scaling, and management of containers",
      "Faster internet speed",
      "Cheaper electricity bills"
    ],
    1
  ),

  q(
    "cloud-hard-3",
    "cloud",
    "hard",
    "What does multi-tenancy mean in cloud architecture?",
    [
      "One customer per physical server",
      "Multiple customers sharing the same infrastructure securely",
      "Servers located in multiple countries",
      "Backup servers only"
    ],
    1
  ),

  /* ==========================================================
     CYBERSECURITY
  ========================================================== */

  q(
    "security-easy-1",
    "cybersecurity",
    "easy",
    "What is phishing?",
    [
      "A backup method",
      "A social-engineering attack",
      "A routing protocol",
      "A compression algorithm"
    ],
    1
  ),

  q(
    "security-easy-2",
    "cybersecurity",
    "easy",
    "What is a firewall used for?",
    [
      "Speeding up internet",
      "Filtering network traffic for security",
      "Storing passwords",
      "Compressing files"
    ],
    1
  ),

  q(
    "security-easy-3",
    "cybersecurity",
    "easy",
    "What does 2FA stand for?",
    [
      "Two-Factor Authentication",
      "Two-File Access",
      "Twice Fast Authorization",
      "Two-Frame Analysis"
    ],
    0
  ),

  q(
    "security-medium-1",
    "cybersecurity",
    "medium",
    "Which principle gives users only the permissions they need?",
    [
      "Least privilege",
      "Fail-open",
      "Replication",
      "Obfuscation"
    ],
    0
  ),

  q(
    "security-medium-2",
    "cybersecurity",
    "medium",
    "What is malware?",
    [
      "Malicious software designed to harm systems",
      "A hardware component",
      "A networking protocol",
      "A database query"
    ],
    0
  ),

  q(
    "security-medium-3",
    "cybersecurity",
    "medium",
    "What is a VPN primarily used for in security?",
    [
      "Speeding up downloads",
      "Encrypting and securing network traffic",
      "Compressing files",
      "Blocking all internet access"
    ],
    1
  ),

  q(
    "security-hard-1",
    "cybersecurity",
    "hard",
    "Which attack injects untrusted input into a database query?",
    [
      "SQL injection",
      "ARP spoofing",
      "DDoS",
      "Packet fragmentation"
    ],
    0
  ),

  q(
    "security-hard-2",
    "cybersecurity",
    "hard",
    "What is a zero-day vulnerability?",
    [
      "A bug fixed the same day it's found",
      "A flaw unknown to the vendor with no available patch",
      "A vulnerability only in old software",
      "A type of firewall rule"
    ],
    1
  ),

  q(
    "security-hard-3",
    "cybersecurity",
    "hard",
    "What does encryption at rest protect?",
    [
      "Data while being typed",
      "Data stored on disk",
      "Data displayed on screen",
      "Data in browser cache"
    ],
    1
  ),

  /* ==========================================================
     APTITUDE
  ========================================================== */

  q(
    "aptitude-easy-1",
    "aptitude",
    "easy",
    "What is 20% of 250?",
    ["25", "40", "50", "60"],
    2
  ),

  q(
    "aptitude-easy-2",
    "aptitude",
    "easy",
    "A product costs ₹500 and is sold for ₹600. What is the profit percentage?",
    ["10%", "15%", "20%", "25%"],
    2
  ),

  q(
    "aptitude-easy-3",
    "aptitude",
    "easy",
    "The ratio of boys to girls is 2:3. If there are 10 boys, how many girls are there?",
    ["12", "15", "18", "20"],
    1
  ),

  q(
    "aptitude-easy-4",
    "aptitude",
    "easy",
    "What is 3/4 of 80?",
    ["40", "60", "70", "80"],
    1
  ),

  q(
    "aptitude-medium-1",
    "aptitude",
    "medium",
    "The average of 10, 20, 30, 40 and 50 is:",
    ["25", "30", "35", "40"],
    1
  ),

  q(
    "aptitude-medium-2",
    "aptitude",
    "medium",
    "A train travels 240 km in 4 hours. What is its average speed?",
    ["50 km/h", "60 km/h", "70 km/h", "80 km/h"],
    1
  ),

  q(
    "aptitude-medium-3",
    "aptitude",
    "medium",
    "If 5 workers complete a task in 12 days, assuming equal efficiency, how many days would 10 workers take?",
    ["3", "6", "10", "24"],
    1
  ),

  q(
    "aptitude-medium-4",
    "aptitude",
    "medium",
    "An ₹800 item is discounted by 15%. What is the sale price?",
    ["₹640", "₹680", "₹700", "₹720"],
    1
  ),

  q(
    "aptitude-hard-1",
    "aptitude",
    "hard",
    "A sum becomes ₹1,210 after 2 years at 10% compound interest per year. What was the principal?",
    ["₹900", "₹1,000", "₹1,100", "₹1,210"],
    1
  ),

  q(
    "aptitude-hard-2",
    "aptitude",
    "hard",
    "A bag contains 5 red and 3 blue balls. What is the probability of drawing a blue ball?",
    ["3/5", "3/8", "5/8", "1/2"],
    1
  ),

  q(
    "aptitude-hard-3",
    "aptitude",
    "hard",
    "The HCF of 36 and 48 is:",
    ["6", "8", "12", "16"],
    2
  ),

  /* ==========================================================
     LOGICAL REASONING
  ========================================================== */

  q(
    "reasoning-easy-1",
    "reasoning",
    "easy",
    "Find the next number: 2, 4, 6, 8, ?",
    ["9", "10", "11", "12"],
    1
  ),

  q(
    "reasoning-easy-2",
    "reasoning",
    "easy",
    "If CAT is coded as DBU, how is DOG coded using the same pattern?",
    ["EPH", "EOG", "DPH", "FPH"],
    0
  ),

  q(
    "reasoning-easy-3",
    "reasoning",
    "easy",
    "Which direction is opposite to North?",
    ["East", "West", "South", "North-East"],
    2
  ),

  q(
    "reasoning-easy-4",
    "reasoning",
    "easy",
    "Find the next number: 5, 10, 15, 20, ?",
    ["22", "25", "30", "35"],
    1
  ),

  q(
    "reasoning-medium-1",
    "reasoning",
    "medium",
    "Find the next number: 3, 6, 12, 24, ?",
    ["36", "42", "48", "54"],
    2
  ),

  q(
    "reasoning-medium-2",
    "reasoning",
    "medium",
    "A is the brother of B. B is the sister of C. How is A related to C?",
    ["Brother", "Sister", "Father", "Uncle"],
    0
  ),

  q(
    "reasoning-medium-3",
    "reasoning",
    "medium",
    "If all roses are flowers and some flowers fade quickly, which statement must be true?",
    [
      "All roses fade quickly",
      "Some roses are not flowers",
      "Roses are flowers",
      "No flowers are roses"
    ],
    2
  ),

  q(
    "reasoning-medium-4",
    "reasoning",
    "medium",
    "If BOOK is coded as CPPL by moving each letter one step forward, how is LOOK coded?",
    ["MPPL", "MQQM", "LPPL", "MPQL"],
    0
  ),

  q(
    "reasoning-hard-1",
    "reasoning",
    "hard",
    "Five people A, B, C, D and E sit in a row. A sits left of B, C sits right of B, and D sits left of A. Who can be at the far left?",
    ["A", "B", "C", "D"],
    3
  ),

  q(
    "reasoning-hard-2",
    "reasoning",
    "hard",
    "A clock shows 3:00. What is the angle between the hour and minute hands?",
    ["0°", "60°", "90°", "180°"],
    2
  ),

  q(
    "reasoning-hard-3",
    "reasoning",
    "hard",
    "If today is Monday, what day will it be 45 days later?",
    ["Tuesday", "Wednesday", "Thursday", "Friday"],
    1
  ),

  /* ==========================================================
     VERBAL
  ========================================================== */

  q(
    "verbal-easy-1",
    "verbal",
    "easy",
    "Choose the synonym of rapid.",
    ["Slow", "Quick", "Weak", "Late"],
    1
  ),

  q(
    "verbal-easy-2",
    "verbal",
    "easy",
    "Choose the antonym of ancient.",
    ["Old", "Historic", "Modern", "Former"],
    2
  ),

  q(
    "verbal-easy-3",
    "verbal",
    "easy",
    "Choose the grammatically correct sentence.",
    [
      "She go to college.",
      "She goes to college.",
      "She going college.",
      "She gone to college."
    ],
    1
  ),

  q(
    "verbal-easy-4",
    "verbal",
    "easy",
    "Choose the correct plural of child.",
    [
      "Childs",
      "Childes",
      "Children",
      "Childrens"
    ],
    2
  ),

  q(
    "verbal-medium-1",
    "verbal",
    "medium",
    "Choose the correct word: He has ___ his assignment.",
    [
      "complete",
      "completed",
      "completing",
      "completes"
    ],
    1
  ),

  q(
    "verbal-medium-2",
    "verbal",
    "medium",
    "What is the meaning of meticulous?",
    [
      "Careless",
      "Very careful and precise",
      "Very fast",
      "Uncertain"
    ],
    1
  ),

  q(
    "verbal-medium-3",
    "verbal",
    "medium",
    "Choose the best replacement: Despite being tired, he continued working.",
    [
      "Although he was tired, he continued working.",
      "Because he was tired, he stopped working.",
      "He was tired and never worked.",
      "He continued only after sleeping."
    ],
    0
  ),

  q(
    "verbal-medium-4",
    "verbal",
    "medium",
    "Choose the synonym of brief.",
    [
      "Long",
      "Short",
      "Difficult",
      "Heavy"
    ],
    1
  ),

  q(
    "verbal-hard-1",
    "verbal",
    "hard",
    "Choose the correctly punctuated sentence.",
    [
      "However I decided to go.",
      "However, I decided to go.",
      "However I, decided to go.",
      "However; I decided to go"
    ],
    1
  ),

  q(
    "verbal-hard-2",
    "verbal",
    "hard",
    "Choose the word closest in meaning to ubiquitous.",
    [
      "Rare",
      "Present everywhere",
      "Uncertain",
      "Temporary"
    ],
    1
  ),

  q(
    "verbal-hard-3",
    "verbal",
    "hard",
    "Choose the correct sentence.",
    [
      "Neither of the answers are correct.",
      "Neither of the answers is correct.",
      "Neither answers is correct.",
      "Neither of answers are correct."
    ],
    1
  )
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
    const j = Math.floor(
      Math.random() * (i + 1)
    );

    [result[i], result[j]] = [
      result[j],
      result[i]
    ];
  }

  return result;
}

function cleanName(value) {
  const name = String(value || "")
    .trim()
    .replace(/\s+/g, " ");

  if (name.length < 2 || name.length > 16) {
    return null;
  }

  if (!/^[A-Za-z0-9 _-]+$/.test(name)) {
    return null;
  }

  return name;
}

function normalizeRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function generateRoomCode() {
  let code;

  do {
    code = "";

    for (let i = 0; i < 6; i++) {
      code += ROOM_CHARACTERS[
        Math.floor(
          Math.random() *
          ROOM_CHARACTERS.length
        )
      ];
    }
  } while (rooms.has(code));

  return code;
}

/* ============================================================
   QUIZBASE QUESTION FETCH
============================================================ */

async function fetchQuizBaseQuestions() {
  if (!QUIZBASE_API_KEY) {
    throw new Error(
      "QUIZBASE_API_KEY is not configured."
    );
  }

  const url = new URL(
    QUIZBASE_API_URL
  );

  url.searchParams.set(
    "amount",
    String(QUIZBASE_QUESTION_COUNT)
  );

  url.searchParams.set(
    "lang",
    "en"
  );

  url.searchParams.set(
    "quality",
    "high"
  );

  const response = await fetch(
    url,
    {
      method: "GET",
      headers: {
        "X-API-Key":
          QUIZBASE_API_KEY,
        "Accept":
          "application/json"
      },
      signal:
        AbortSignal.timeout(10_000)
    }
  );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `QuizBase request failed (${response.status}): ${body.slice(0, 300)}`
    );
  }

  const payload =
    await response.json();

  const questions =
    Array.isArray(payload?.data)
      ? payload.data
      : [];

  if (
    questions.length <
    QUIZBASE_QUESTION_COUNT
  ) {
    throw new Error(
      `QuizBase returned only ${questions.length} questions.`
    );
  }

  return questions
    .slice(
      0,
      QUIZBASE_QUESTION_COUNT
    )
    .map((question, index) => {
      const incorrectAnswers =
        Array.isArray(
          question?.incorrectAnswers
        )
          ? question.incorrectAnswers
          : [];

      const correctAnswer =
        question?.correctAnswer;

      if (
        !question?.id ||
        !question?.text ||
        !correctAnswer ||
        incorrectAnswers.length < 3
      ) {
        throw new Error(
          `QuizBase returned an invalid question at index ${index}.`
        );
      }

      const options =
        shuffle([
          correctAnswer,
          ...incorrectAnswers.slice(0, 3)
        ]);

      return {
        id:
          `quizbase-${question.id}`,
        category:
          question?.category?.slug ||
          question?.category?.name ||
          "quizbase",
        difficulty:
          question?.difficulty ||
          "medium",
        text:
          question.text,
        options,
        correctIndex:
          options.indexOf(
            correctAnswer
          ),
        source:
          "QuizBase",
        attribution:
          question?.attribution ||
          null
      };
    });
}


/* ============================================================
   QUESTION GENERATION
============================================================ */

function shuffleQuestionOptions(question) {
  const order = shuffle(
    question.options.map(
      (_, index) => index
    )
  );

  const options = order.map(
    (originalIndex) =>
      question.options[originalIndex]
  );

  const correctIndex =
    order.indexOf(
      question.correctIndex
    );

  return {
    id: question.id,
    category: question.category,
    difficulty: question.difficulty,
    text: question.text,
    options,
    correctIndex
  };
}

function createGameQuestions(
  roomOrQuizType = "mixed"
) {
  const quizType =
    typeof roomOrQuizType === "string"
      ? normalizeQuizType(
          roomOrQuizType
        )
      : normalizeQuizType(
          roomOrQuizType?.quizType
        );

  const config =
    QUIZ_TYPES[quizType] ||
    QUIZ_TYPES.mixed;

  const difficulties = [
    "easy",
    "easy",
    "easy",
    "easy",

    "medium",
    "medium",
    "medium",
    "medium",

    "hard",
    "hard"
  ];

  const usedQuestionIds =
    new Set();

  const selected = [];

  for (const difficulty of difficulties) {
    const candidatesByCategory =
      new Map();

    for (const category of shuffle(
      config.categories
    )) {
      const candidates =
        shuffle(
          QUESTION_BANK.filter(
            (item) =>
              item.category ===
                category &&
              item.difficulty ===
                difficulty &&
              !usedQuestionIds.has(
                item.id
              )
          )
        );

      if (candidates.length) {
        candidatesByCategory.set(
          category,
          candidates
        );
      }
    }

    if (
      candidatesByCategory.size ===
      0
    ) {
      throw new Error(
        `Not enough ${difficulty} questions for ${QUIZ_TYPES[quizType].label}.`
      );
    }

    const categories =
      [
        ...candidatesByCategory.keys()
      ];

    const category =
      categories[
        Math.floor(
          Math.random() *
          categories.length
        )
      ];

    const question =
      candidatesByCategory
        .get(category)[0];

    usedQuestionIds.add(
      question.id
    );

    selected.push(question);
  }

  return shuffle(selected).map(
    shuffleQuestionOptions
  );
}

/* ============================================================
   PLAYER HELPERS
============================================================ */

function getConnectedPlayers(room) {
  return [
    ...room.players.values()
  ].filter(
    (player) =>
      player.active &&
      player.connected
  );
}

function getActivePlayers(room) {
  return [
    ...room.players.values()
  ].filter(
    (player) =>
      player.active
  );
}

function transferHost(room) {
  const newHost =
    getConnectedPlayers(room)[0] ||
    getActivePlayers(room)[0];

  if (!newHost) {
    return null;
  }

  room.hostPlayerId =
    newHost.id;

  return newHost;
}

function createPlayer(
  socket,
  name
) {
  return {
    id: randomId(),

    token: randomId(),

    name,

    teamId: null,

    teamName: null,

    score: 0,

    streak: 0,

    lastPoints: 0,

    powerups: {
      fiftyFifty: true,
      doublePoints: true
    },

    doublePointsActive:
      false,

    active: true,

    connected: true,

    socketId: socket.id,

    reconnectTimer: null
  };
}

function bindSocketToPlayer(
  socket,
  roomCode,
  player
) {
  socket.join(roomCode);

  socket.data.roomCode =
    roomCode;

  socket.data.playerId =
    player.id;

  socket.data.token =
    player.token;
}

/* ============================================================
   ROOM STATE
============================================================ */

function publicRoomState(room) {
  const players =
    [...room.players.values()]
      .filter(
        (player) =>
          player.active
      )
      .map((player) => ({
        id: player.id,

        name: player.name,

        connected:
          player.connected,

        active:
          player.active,

        score:
          player.score,

        streak:
          player.streak,

        isHost:
          player.id ===
          room.hostPlayerId,

        teamId:
          player.teamId,

        teamName:
          player.teamName
      }));

  return {
    code: room.code,

    status: room.status,

    quizType:
      room.quizType,

    quizTypeLabel:
      QUIZ_TYPES[
        room.quizType
      ]?.label ||
      "Mixed Placement",

    matchSize: room.matchSize,

    battleFormat: room.battleFormat,

    battleFormatLabel: getBattleConfig(room)?.label || room.battleFormat,

    battleFormats: Object.entries(getBattleFormats(room.matchSize)).map(([id, config]) => ({
      id,
      label: config.label,
      teams: config.teams,
      teamSize: config.teamSize,
      ffa: Boolean(config.ffa)
    })),

    requiredPlayers: room.matchSize,

    hostPlayerId:
      room.hostPlayerId,

    players,

    teams: getTeamStandings(room),

    leaderboard: getPlayerLeaderboard(room),

    questionSource:
      room.questionSource,

    currentQuestion:
      room.currentQuestionIndex,

    answeredCount:
      room.answers.size,

    connectedAnswerCount:
      getConnectedPlayers(room)
        .filter((player) =>
          room.answers.has(
            player.id
          )
        ).length,

    questionEndsAt:
      room.questionEndsAt
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit(
    "room_state",
    publicRoomState(room)
  );
}

/* ============================================================
   SAFE QUESTION
============================================================ */

function safeQuestion(
  room,
  player
) {
  const question =
    room.questions[
      room.currentQuestionIndex
    ];

  if (!question) {
    return null;
  }

  const existingAnswer =
    room.answers.get(
      player?.id
    );

  const eliminated =
    player
      ? room.eliminations.get(
          player.id
        ) || []
      : [];

  return {
    id: question.id,

    category:
      question.category,

    difficulty:
      question.difficulty,

    source:
      question.source ||
      "Tech Battle",

    attribution:
      question.attribution ||
      null,

    text:
      question.text,

    options:
      question.options,

    number:
      room.currentQuestionIndex +
      1,

    total:
      room.questions.length,

    startsAt:
      room.questionStartsAt,

    endsAt:
      room.questionEndsAt,

    answeredCount:
      room.answers.size,

    alreadyAnswered:
      Boolean(existingAnswer),

    selectedIndex:
      existingAnswer?.index ??
      null,

    streak:
      player?.streak || 0,

    eliminatedOptions:
      eliminated,

    powerups: player
      ? {
          fiftyFiftyAvailable:
            player.powerups
              .fiftyFifty,

          doublePointsAvailable:
            player.powerups
              .doublePoints,

          doublePointsActive:
            player.doublePointsActive
        }
      : null
  };
}

/* ============================================================
   CURRENT STATE
============================================================ */

function sendCurrentState(
  socket,
  room,
  player
) {
  socket.emit(
    "room_state",
    publicRoomState(room)
  );

  if (
    room.status ===
      "countdown" &&
    room.countdownEndsAt
  ) {
    socket.emit("battle_intro", {
      matchSize: room.matchSize,
      battleFormat: room.battleFormat,
      battleFormatLabel: getBattleConfig(room)?.label || room.battleFormat,
      teams: getTeamStandings(room),
      players: getPlayerLeaderboard(room),
      questionSource: room.questionSource
    });

    socket.emit(
      "countdown",
      {
        endsAt:
          room.countdownEndsAt
      }
    );

    return;
  }

  if (
    room.status ===
    "question"
  ) {
    socket.emit(
      "question",
      safeQuestion(
        room,
        player
      )
    );

    socket.emit("leaderboard_update", getLeaderboardPayload(room));

    return;
  }

  if (
    room.status ===
      "results" &&
    room.lastResults
  ) {
    socket.emit(
      "question_results",
      room.lastResults
    );

    socket.emit("leaderboard_update", getLeaderboardPayload(room));

    return;
  }

  if (
    room.status ===
      "finished" &&
    room.finalResults
  ) {
    socket.emit(
      "game_finished",
      room.finalResults
    );

    socket.emit("leaderboard_update", {
      players: room.finalResults.leaderboard,
      teams: room.finalResults.teams,
      questionNumber: room.questions.length,
      totalQuestions: room.questions.length
    });
  }
}

/* ============================================================
   TIMERS
============================================================ */

function clearRoomTimers(room) {
  if (room.timer) {
    clearTimeout(
      room.timer
    );

    room.timer = null;
  }

  if (room.cleanupTimer) {
    clearTimeout(
      room.cleanupTimer
    );

    room.cleanupTimer = null;
  }
}

/* ============================================================
   GAME FLOW
============================================================ */

async function startCountdown(room) {
  clearRoomTimers(room);

  assignTeams(room);

  let questions;
  let questionSource =
    "local-fallback";

  try {
    // Exactly ONE QuizBase request for the whole match.
    questions =
      await fetchQuizBaseQuestions();

    questionSource =
      "quizbase";

    console.log(
      `[QuizBase] Loaded ${questions.length} questions for room ${room.code}.`
    );
  } catch (error) {
    // Keep the game playable if QuizBase is unavailable.
    // The existing curated question bank is the fallback.
    console.error(
      `[QuizBase] ${error.message}`
    );

    questions =
      createGameQuestions(room);

    console.log(
      `[QuizBase] Using local question bank for room ${room.code}.`
    );
  }

  room.questions =
    questions;

  room.questionSource =
    questionSource;

  room.status =
    "countdown";

  room.currentQuestionIndex =
    -1;

  room.countdownEndsAt =
    Date.now() +
    COUNTDOWN_TIME;

  broadcastRoom(room);

  io.to(room.code).emit("battle_intro", {
    matchSize: room.matchSize,
    battleFormat: room.battleFormat,
    battleFormatLabel: getBattleConfig(room)?.label || room.battleFormat,
    teams: getTeamStandings(room),
    players: getPlayerLeaderboard(room),
    questionSource: room.questionSource
  });

  emitLeaderboard(room);

  io.to(room.code).emit(
    "countdown",
    {
      endsAt:
        room.countdownEndsAt
    }
  );

  room.timer =
    setTimeout(
      () =>
        startQuestion(room),
      COUNTDOWN_TIME
    );
}
function startQuestion(room) {
  clearRoomTimers(room);

  room.currentQuestionIndex++;

  if (
    room.currentQuestionIndex >=
    room.questions.length
  ) {
    finishGame(room);
    return;
  }

  room.status =
    "question";

  room.answers =
    new Map();

  room.eliminations =
    new Map();

  room.lastResults =
    null;

  room.questionStartsAt =
    Date.now();

  room.questionEndsAt =
    room.questionStartsAt +
    QUESTION_TIME;

  broadcastRoom(room);

  for (
    const player of
    room.players.values()
  ) {
    if (
      !player.active ||
      !player.connected
    ) {
      continue;
    }

    const socket =
      io.sockets.sockets.get(
        player.socketId
      );

    if (!socket) {
      continue;
    }

    socket.emit(
      "question",
      safeQuestion(
        room,
        player
      )
    );
  }

  room.timer =
    setTimeout(
      () =>
        finishQuestion(room),
      QUESTION_TIME
    );
}

function finishQuestion(room) {
  if (
    room.status !==
    "question"
  ) {
    return;
  }

  clearRoomTimers(room);

  room.status =
    "results";

  const question =
    room.questions[
      room.currentQuestionIndex
    ];

  for (
    const player of
    room.players.values()
  ) {
    if (!player.active) {
      continue;
    }

    const answer =
      room.answers.get(
        player.id
      );

    let points = 0;

    const wasCorrect =
      Boolean(
        answer &&
        answer.index ===
          question.correctIndex
      );

    if (wasCorrect) {
      const remaining =
        Math.max(
          0,
          room.questionEndsAt -
            answer.at
        );

      const speedBonus =
        50 *
        (remaining /
          QUESTION_TIME);

      const streakBonus =
        Math.min(
          STREAK_BONUS_CAP,
          player.streak *
            STREAK_BONUS_PER_STEP
        );

      points = Math.round(
        100 +
          speedBonus +
          streakBonus
      );

      if (
        player.doublePointsActive
      ) {
        points *= 2;
      }

      player.streak++;
    } else {
      player.streak = 0;
    }

    player.doublePointsActive =
      false;

    player.lastPoints =
      points;

    player.score += points;
  }

  const leaderboard =
    getPlayerLeaderboard(room);

  const teams = getTeamStandings(room);

  room.lastResults = {
    questionNumber:
      room.currentQuestionIndex +
      1,

    correctAnswer:
      question.options[
        question.correctIndex
      ],

    players:
      leaderboard,

    teams,

    leaderboard: {
      players: leaderboard,
      teams
    }
  };

  broadcastRoom(room);
  emitLeaderboard(room);

  io.to(room.code).emit(
    "question_results",
    room.lastResults
  );

  room.timer =
    setTimeout(() => {
      if (
        room.currentQuestionIndex >=
        room.questions.length - 1
      ) {
        finishGame(room);
      } else {
        startQuestion(room);
      }
    }, RESULTS_TIME);
}

function finishGame(room) {
  clearRoomTimers(room);

  room.status =
    "finished";

  const leaderboard = getPlayerLeaderboard(room).map((player) => ({
    ...player,
    total: player.score,
    left: !room.players.get(player.id)?.active
  }));

  const teams = getTeamStandings(room);

  const highestScore =
    leaderboard.length
      ? leaderboard[0].total
      : 0;

  const winners =
    leaderboard.filter(
      (player) =>
        player.total ===
        highestScore
    );

  const highestTeamScore = teams.length ? teams[0].score : 0;
  const winningTeams = teams.filter((team) => team.score === highestTeamScore);

  room.finalResults = {
    leaderboard,

    winners,

    winner:
      winners[0] ||
      null,

    teams,

    winningTeams,

    winningTeam: winningTeams[0] || null,

    battleFormat: room.battleFormat,
    battleFormatLabel: getBattleConfig(room)?.label || room.battleFormat,
    matchSize: room.matchSize
  };

  broadcastRoom(room);

  io.to(room.code).emit(
    "game_finished",
    room.finalResults
  );

  emitLeaderboard(room);

  room.cleanupTimer =
    setTimeout(() => {
      rooms.delete(
        room.code
      );
    }, ROOM_IDLE_CLEANUP);
}

function resetRoomForReplay(room) {
  clearRoomTimers(room);

  room.status =
    "waiting";

  room.currentQuestionIndex =
    -1;

  room.questions = [];

  room.questionSource =
    "local-fallback";

  room.answers =
    new Map();

  room.eliminations =
    new Map();

  room.questionStartsAt =
    null;

  room.questionEndsAt =
    null;

  room.countdownEndsAt =
    null;

  room.lastResults =
    null;

  room.finalResults =
    null;

  clearTeams(room);

  for (
    const [id, player] of
    room.players
  ) {
    if (!player.active) {
      room.players.delete(id);
      continue;
    }

    player.score = 0;

    player.streak = 0;

    player.lastPoints = 0;

    player.doublePointsActive =
      false;

    player.powerups = {
      fiftyFifty: true,
      doublePoints: true
    };
  }

  if (
    !room.players.has(
      room.hostPlayerId
    )
  ) {
    transferHost(room);
  }

  broadcastRoom(room);
}

/* ============================================================
   RECONNECTION
============================================================ */

function scheduleReconnectExpiry(
  room,
  player
) {
  if (
    player.reconnectTimer
  ) {
    clearTimeout(
      player.reconnectTimer
    );
  }

  player.reconnectTimer =
    setTimeout(() => {
      if (
        player.connected ||
        !player.active
      ) {
        return;
      }

      player.active = false;

      if (
        room.hostPlayerId ===
        player.id
      ) {
        transferHost(room);
      }

      broadcastRoom(room);

      checkMinPlayers(room);

      maybeDeleteEmptyRoom(
        room
      );
    }, RECONNECT_GRACE);
}

function checkEarlyFinish(room) {
  if (
    room.status !==
    "question"
  ) {
    return;
  }

  const connected =
    getConnectedPlayers(room);

  if (
    connected.length ===
    0
  ) {
    return;
  }

  if (
    connected.every(
      (player) =>
        room.answers.has(
          player.id
        )
    )
  ) {
    finishQuestion(room);
  }
}

function checkMinPlayers(room) {
  if (
    room.status ===
      "question" ||
    room.status ===
      "countdown" ||
    room.status ===
      "results"
  ) {
    if (
      getActivePlayers(room)
        .length <
      MIN_PLAYERS
    ) {
      finishGame(room);
    }
  }
}

function maybeDeleteEmptyRoom(
  room
) {
  const stillPresent =
    [...room.players.values()]
      .some(
        (player) =>
          player.active ||
          player.connected
      );

  if (!stillPresent) {
    clearRoomTimers(room);

    rooms.delete(
      room.code
    );
  }
}

function removePlayer(
  room,
  playerId
) {
  const player =
    room.players.get(
      playerId
    );

  if (!player) {
    return;
  }

  player.active = false;

  player.connected = false;

  if (
    player.reconnectTimer
  ) {
    clearTimeout(
      player.reconnectTimer
    );

    player.reconnectTimer =
      null;
  }

  if (
    room.hostPlayerId ===
    player.id
  ) {
    transferHost(room);
  }

  broadcastRoom(room);

  checkEarlyFinish(room);

  checkMinPlayers(room);

  maybeDeleteEmptyRoom(
    room
  );
}

/* ============================================================
   CREATE ROOM
============================================================ */

function createRoom(
  socket,
  payload,
  callback
) {
  const name =
    cleanName(
      payload?.name
    );

  if (!name) {
    callback({
      error:
        "Name must contain 2–16 valid characters."
    });

    return;
  }

  const roomCode =
    generateRoomCode();

  const player =
    createPlayer(
      socket,
      name
    );

  const quizType =
    normalizeQuizType(
      payload?.quizType
    );

  const matchSize =
    normalizeMatchSize(
      payload?.matchSize
    );

  const battleFormat =
    normalizeBattleFormat(
      matchSize,
      payload?.battleFormat
    );

  const room = {
    code:
      roomCode,

    status:
      "waiting",

    quizType,

    matchSize,

    battleFormat,

    hostPlayerId:
      player.id,

    players:
      new Map(),

    questions:
      [],

    questionSource:
      "local-fallback",

    currentQuestionIndex:
      -1,

    answers:
      new Map(),

    eliminations:
      new Map(),

    questionStartsAt:
      null,

    questionEndsAt:
      null,

    countdownEndsAt:
      null,

    timer:
      null,

    cleanupTimer:
      null,

    lastResults:
      null,

    finalResults:
      null
  };

  room.players.set(
    player.id,
    player
  );

  rooms.set(
    roomCode,
    room
  );

  bindSocketToPlayer(
    socket,
    roomCode,
    player
  );

  callback({
    ok: true,

    roomCode,

    playerId:
      player.id,

    token:
      player.token,

    name,

    quizType,

    quizTypeLabel:
      QUIZ_TYPES[
        quizType
      ].label,

    matchSize,

    battleFormat,

    battleFormatLabel: getBattleConfig(room)?.label || battleFormat
  });

  broadcastRoom(room);
}

/* ============================================================
   JOIN ROOM
============================================================ */

function joinRoom(
  socket,
  payload,
  callback
) {
  const name =
    cleanName(
      payload?.name
    );

  const roomCode =
    normalizeRoomCode(
      payload?.roomCode
    );

  if (!name) {
    callback({
      error:
        "Name must contain 2–16 valid characters."
    });

    return;
  }

  if (
    !/^[A-Z0-9]{6}$/.test(
      roomCode
    )
  ) {
    callback({
      error:
        "Room code must contain 6 characters."
    });

    return;
  }

  const room =
    rooms.get(roomCode);

  if (!room) {
    callback({
      error:
        "Room not found."
    });

    return;
  }

  if (
    room.status !==
    "waiting"
  ) {
    callback({
      error:
        "The game has already started. New players cannot join."
    });

    return;
  }

  const activePlayers =
    getActivePlayers(room);

  if (
    activePlayers.length >=
    MAX_PLAYERS
  ) {
    callback({
      error:
        "This room is full."
    });

    return;
  }

  const duplicate =
    activePlayers.some(
      (player) =>
        player.name.toLowerCase() ===
        name.toLowerCase()
    );

  if (duplicate) {
    callback({
      error:
        "That player name is already taken."
    });

    return;
  }

  const player =
    createPlayer(
      socket,
      name
    );

  room.players.set(
    player.id,
    player
  );

  bindSocketToPlayer(
    socket,
    roomCode,
    player
  );

  callback({
    ok: true,

    roomCode,

    playerId:
      player.id,

    token:
      player.token,

    name,

    quizType: room.quizType,
    quizTypeLabel: QUIZ_TYPES[room.quizType]?.label || "Mixed Placement",
    matchSize: room.matchSize,
    battleFormat: room.battleFormat,
    battleFormatLabel: getBattleConfig(room)?.label || room.battleFormat
  });

  broadcastRoom(room);
}

/* ============================================================
   RECONNECT
============================================================ */

function reconnectPlayer(
  socket,
  payload,
  callback
) {
  const roomCode =
    normalizeRoomCode(
      payload?.roomCode
    );

  const token =
    String(
      payload?.token || ""
    );

  const room =
    rooms.get(roomCode);

  if (!room) {
    callback({
      error:
        "The room no longer exists."
    });

    return;
  }

  const player =
    [...room.players.values()]
      .find(
        (candidate) =>
          candidate.token ===
            token &&
          candidate.active
      );

  if (!player) {
    callback({
      error:
        "Reconnection session expired."
    });

    return;
  }

  if (
    player.reconnectTimer
  ) {
    clearTimeout(
      player.reconnectTimer
    );

    player.reconnectTimer =
      null;
  }

  player.connected =
    true;

  player.socketId =
    socket.id;

  bindSocketToPlayer(
    socket,
    roomCode,
    player
  );

  callback({
    ok: true,

    roomCode,

    playerId:
      player.id,

    token:
      player.token,

    name:
      player.name
  });

  sendCurrentState(
    socket,
    room,
    player
  );

  broadcastRoom(room);
}

/* ============================================================
   SOCKET CONNECTION
============================================================ */

io.on(
  "connection",
  (socket) => {
    console.log(
      `Socket connected: ${socket.id}`
    );

    /* TIME SYNC */

    socket.on(
      "time_sync",
      (callback) => {
        if (
          typeof callback ===
          "function"
        ) {
          callback(
            Date.now()
          );
        }
      }
    );

    /* CREATE */

    socket.on(
      "create_room",
      (
        payload,
        callback
      ) => {
        createRoom(
          socket,
          payload,
          callback
        );
      }
    );

    /* JOIN */

    socket.on(
      "join_room",
      (
        payload,
        callback
      ) => {
        joinRoom(
          socket,
          payload,
          callback
        );
      }
    );

    /* RECONNECT */

    socket.on(
      "reconnect_player",
      (
        payload,
        callback
      ) => {
        reconnectPlayer(
          socket,
          payload,
          callback
        );
      }
    );

    /* ========================================================
       START GAME
    ======================================================== */

    socket.on(
      "start_game",
      async (
        payload,
        callback
      ) => {
        const room =
          rooms.get(
            socket.data.roomCode
          );

        if (!room) {
          return callback({
            error:
              "Room not found."
          });
        }

        const player =
          room.players.get(
            socket.data.playerId
          );

        if (!player) {
          return callback({
            error:
              "Player not found."
          });
        }

        if (
          room.hostPlayerId !==
          player.id
        ) {
          return callback({
            error:
              "Only the host can start the game."
          });
        }

        if (
          room.status !==
          "waiting"
        ) {
          return callback({
            error:
              "The game has already started."
          });
        }

        const activePlayers = getActivePlayers(room);

        if (activePlayers.length !== room.matchSize) {
          return callback({
            error: `This ${room.matchSize}-player match requires exactly ${room.matchSize} active players before it can start.`
          });
        }

        try {
          await startCountdown(
            room
          );

          callback({
            ok: true
          });
        } catch (error) {
          console.error(
            error
          );

          callback({
            error:
              "Unable to create the game questions."
          });
        }
      }
    );

    /* ========================================================
       POWERUPS
    ======================================================== */

    socket.on(
      "use_powerup",
      (
        payload,
        callback
      ) => {
        const room =
          rooms.get(
            socket.data.roomCode
          );

        if (!room) {
          return callback?.({
            error:
              "Room not found."
          });
        }

        const player =
          room.players.get(
            socket.data.playerId
          );

        if (
          !player ||
          !player.active ||
          !player.connected
        ) {
          return callback?.({
            error:
              "You are not an active player."
          });
        }

        if (
          room.status !==
          "question"
        ) {
          return callback?.({
            error:
              "Power-ups can only be used during a question."
          });
        }

        if (
          room.answers.has(
            player.id
          )
        ) {
          return callback?.({
            error:
              "You already answered this question."
          });
        }

        const type =
          payload?.type;

        const question =
          room.questions[
            room.currentQuestionIndex
          ];

        /* 50/50 */

        if (
          type ===
          "fiftyFifty"
        ) {
          if (
            !player.powerups
              .fiftyFifty
          ) {
            return callback?.({
              error:
                "You already used 50/50."
            });
          }

          const wrongIndexes =
            question.options
              .map(
                (_, index) =>
                  index
              )
              .filter(
                (index) =>
                  index !==
                  question.correctIndex
              );

          const eliminated =
            shuffle(
              wrongIndexes
            ).slice(
              0,
              2
            );

          player.powerups
            .fiftyFifty =
            false;

          room.eliminations.set(
            player.id,
            eliminated
          );

          return callback?.({
            ok: true,

            eliminatedOptions:
              eliminated
          });
        }

        /* DOUBLE POINTS */

        if (
          type ===
          "doublePoints"
        ) {
          if (
            !player.powerups
              .doublePoints
          ) {
            return callback?.({
              error:
                "You already used Double Points."
            });
          }

          player.powerups
            .doublePoints =
            false;

          player.doublePointsActive =
            true;

          return callback?.({
            ok: true,

            doublePointsActive:
              true
          });
        }

        callback?.({
          error:
            "Unknown power-up."
        });
      }
    );

    /* ========================================================
       SUBMIT ANSWER
    ======================================================== */

    socket.on(
      "submit_answer",
      (
        payload,
        callback
      ) => {
        const room =
          rooms.get(
            socket.data.roomCode
          );

        if (!room) {
          return callback({
            error:
              "Room not found."
          });
        }

        const player =
          room.players.get(
            socket.data.playerId
          );

        if (
          !player ||
          !player.active ||
          !player.connected
        ) {
          return callback({
            error:
              "You are not an active player."
          });
        }

        if (
          room.status !==
          "question"
        ) {
          return callback({
            error:
              "The question is no longer active."
          });
        }

        const question =
          room.questions[
            room.currentQuestionIndex
          ];

        if (
          !question ||
          payload?.questionId !==
            question.id
        ) {
          return callback({
            error:
              "This question is no longer current."
          });
        }

        if (
          room.answers.has(
            player.id
          )
        ) {
          return callback({
            error:
              "You have already answered this question."
          });
        }

        const index =
          Number(
            payload?.index
          );

        if (
          !Number.isInteger(
            index
          ) ||
          index < 0 ||
          index >=
            question.options
              .length
        ) {
          return callback({
            error:
              "Invalid answer."
          });
        }

        const now =
          Date.now();

        if (
          now >
          room.questionEndsAt
        ) {
          return callback({
            error:
              "Time is up."
          });
        }

        room.answers.set(
          player.id,
          {
            index,
            at: now
          }
        );

        callback({
          ok: true
        });

        io.to(
          room.code
        ).emit(
          "answer_count",
          {
            count:
              room.answers
                .size,

            total:
              getConnectedPlayers(
                room
              ).length
          }
        );

        checkEarlyFinish(
          room
        );
      }
    );

    /* ========================================================
       PLAY AGAIN
    ======================================================== */

    socket.on(
      "play_again",
      (
        payload,
        callback
      ) => {
        const room =
          rooms.get(
            socket.data.roomCode
          );

        if (!room) {
          return callback?.({
            error:
              "Room not found."
          });
        }

        const player =
          room.players.get(
            socket.data.playerId
          );

        if (!player) {
          return callback?.({
            error:
              "Player not found."
          });
        }

        if (
          room.hostPlayerId !==
          player.id
        ) {
          return callback?.({
            error:
              "Only the host can restart the game."
          });
        }

        if (
          room.status !==
          "finished"
        ) {
          return callback?.({
            error:
              "The game hasn't finished yet."
          });
        }

        resetRoomForReplay(
          room
        );

        callback?.({
          ok: true
        });
      }
    );

    /* ========================================================
       LEAVE
    ======================================================== */

    socket.on(
      "leave_game",
      (
        payload,
        callback
      ) => {
        const room =
          rooms.get(
            socket.data.roomCode
          );

        if (!room) {
          return callback?.({
            ok: true
          });
        }

        removePlayer(
          room,
          socket.data.playerId
        );

        socket.leave(
          room.code
        );

        callback?.({
          ok: true
        });
      }
    );

    /* ========================================================
       DISCONNECT
    ======================================================== */

    socket.on(
      "disconnect",
      () => {
        console.log(
          `Socket disconnected: ${socket.id}`
        );

        const room =
          rooms.get(
            socket.data.roomCode
          );

        if (!room) {
          return;
        }

        const player =
          room.players.get(
            socket.data.playerId
          );

        if (
          !player ||
          !player.active
        ) {
          return;
        }

        player.connected =
          false;

        player.socketId =
          null;

        if (
          room.hostPlayerId ===
          player.id
        ) {
          transferHost(room);
        }

        broadcastRoom(
          room
        );

        scheduleReconnectExpiry(
          room,
          player
        );

        checkEarlyFinish(
          room
        );
      }
    );
  }
);

/* ============================================================
   BACKEND DASHBOARD / HTTP API
   Dashboard-only update. Game and Socket.IO logic below remains unchanged.
============================================================ */

const BG_IMAGE = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUEBAQEAwUEBAQGBQUGCA0ICAcHCBALDAkNExAUExIQEhIUFx0ZFBYcFhISGiMaHB4fISEhFBkkJyQgJh0gISD/2wBDAQUGBggHCA8ICA8gFRIVICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICD/wgARCAQABgADASIAAhEBAxEB/8QAHAABAAIDAQEBAAAAAAAAAAAAAAECAwQFBgcI/8QAGwEBAQADAQEBAAAAAAAAAAAAAAECAwQFBgf/2gAMAwEAAhADEAAAAfjsJ34AAAAAAAAAAAARIAAACCQATAgKAACSgAqYIkAAAAABJDY16CAAElgRExKhYAmJCJETAIlJETEgWIJQJFkCWQiJhUlAiJhUTESACUAKAQSgJLABEAoCYlEACiCQAAAAAAAAAAAAAAAAIkCCYkAAAAARaLFQIkESAAAAAAAIkAAAAWrelBAAEkAEolAAAETASABJCYEiBQABIiQRIARMEggBIhs6wBExMsJIFAJiSEogUEImFAAAACkTEAsoICpgiYAKAATAACEiEwAoAAAAAAAAAAAAAACAkABa1mNaoEoAAAAAAACYAAAgkAAAICgATAAJWsqyVKxaIiQAgzJiCpiSAJgTCUAATEgAAICggWgABCJEJVCRBMQkAAAQAAiQACEwoCJEJAAkhetQmIIAKAAMiY0ha2eYa7b1EpExdgKAAAAWrQQAAAJIi0AAgkslYksJETEgGT3vgdnZMeDJjxQMaAAAAAAAAAAAAAAAAAAAAmJSenzL5vceGyYqiJjAEAAASSiJEAJAAlISISISISAq9AChJCSQmFhKISpEoiYmESqEohIhIhMCJLCRCREgiYACYqJIRKk1lfS+drCIFhKISIASIlYi9uvhoo1dTHTFFdnYFyAACggAAAAATYvG/saVPXeUrHExqoiJAAiYJiQAmBMCAoAgkAAGfAZCUkSmoi0EJjECgQkAAAEkhIhIiQATAmAAAJJCQBIAQkRIAAgBIgAUTFEzVZAkJttNenG9qmJMNgkqtEQlESABKITBCRESVEiEiEwAQvVYiQJIWoAswUEACSFpSs3zzDB1O5yNPn83BFN3oWrC5oFTCglATE2QmJQAAAAExNTt6c5z0PAiMkRMakJiWQAImCSCQFqgBJICgEkEUJIlfJF8sdFritXXKjUInFMFAIIBQCSARN6UEAEwACSEkEkSAlIJImJBJBKRICSEiEiEkhLKwtFkErHX5N2o2dlhy5zVuzN7Xyf1vj8rzPgvsXyNedGXJ2epgjraEw7vmrVSqToRYlZItNUl6IhElhJYBCRAUBEwAoCJgAJigESVZsY4Uz9b2eji8l39z5xq05NGcfZ6KEZbAUABEiUCEwApMBMBJICgAJgSggKEIm6UCokAJgmXDMCViIAFAE2RMzkibb3RdPJm09i+KY5sW9pbkujBrQTEJVCUQkRKSEiEiEiABQkQQmCSABMCQhMEomAExZIBkpEolZKxeTHOWLKNirHBNmeXrfKbnS3ed5yM1NfpVstJvfVPlXvePxPFaP0b5ll19P675n2HmeHqfJ/sXkWPz3o8f6f6ft9T5J7XxLVq1y26vW118jKnqdzhTyeNTLV61ZtlxmCOnz8Mcc3210a58dypMwyiJi0CAImFJgTAARMKTFAsTCMnR5uxho/SfyryGtp5505x7+qIM9kJhYkACRCSImFRImaqRKIJAICpEAgAkhIgSkwgCJKAAM1YRAAlImZyVm9tiNzf2PS3a3Mph04TWHDhAxEIkmEzdjjnLLHBOaTAzkwTmGBngws0LiZYrFGSjKIsWspiEyVWFVoSJkQsISSEohYVWETJKooyyWps44z1cfK18nez8Gk096fPbFep5nIvNexhvh278fc8s6d3qeD7hq8jw23pd6+nx/QcXYx1fZvNdq/zvxkeU9Z5TZtp67yHr7eB6fXtr0/N/N9bnfQfYVwej8u35PRdrm4+dzOXpW3ev1c2vm0cuf2Pgo1cvZ1OdjvR2cfMqy6Olh3GfLp0+Zt6ijLdZYxrF4trF4KrFqsKrQQkRFoISthIWhJZUiJm2s5JuOKMwxMoxMwwswwsoxMsGKMlblRasoSgAQz4FWrKESARIBAmoSkhny3HSbU1qInHYBMAAJsWXzMmb1PXl5n0PS8Z3b9nm1x+fzqo5YhOICEyLMkwnr619fHtUw7OrRgyW2JMU72THVzrdC0nOjo0NFswat68zPbq4vU6u3d5+PQwz8+9BC8F6KE8/HoYOA9BMnnp79jz70NU8+75eC9BKefnvwnBegg8/j6fGz65vTpM8PU3eBp4MvuMGbn8ieX5fFs7vT87i029m1TWbevax4JXNiiLlm7nnZurc1YiZ72PVvMfsHV+I34PmvtVPjFJr+zZPilmX2vV+PY2V8unX0Ppb5tYy9N5/CmrNfVZbdmdZJt5+baY+g3PKzq5fV9PwWxhz/T/AJ36XsaPJ8Lgx9np9ry9Ojzt/o22NTeSkegvhw+cj0VLfPx6CV89Ho6L596Aefegi3z70Nk849DK+dnvjgR6LGcGfQSnn8nciTJj5u/r0zhy5U0nQuy5rpTHOtuk0I2a3LHfLo5Y25XQxb+nQrlx59lUxMgAgBEiJmASQmSEykX6vUx4uHknWyW14tlvpFatlRhsEpAUBMTZbPgybX27Q+W4OnZfXY9WtVGgGKJBILRkY36S+nhjNs/ReTyubyvJ8iX6bs/Kpy3fV83ySccvsFvj8n1+nyMn1fD8sqx+p/Pebj3dStY6PTtNBZUtlSWVFlS2mhLqC6gtNBdQXitVlGWp7ccHVyT6LzeXLZ9A8Ljrr55iu/t69WPX/b2n8wY/1XDr/Ks/qqZfyrH6sJ+Uo+yfLtk5tv1PfXl+VX6qhPyu/VI/Ks/pX8z2XZPvuen8/W/U8a9/5Yj9T2PyrX9WfH9mv5nEfW2fyef1S15flOetx8pa31D6zlj+Wp/TPxPXr8fFsVy2Pd/Pcmvj9b5KcbZ19LT7lnDjb09nXeccrecZLqiyosqLKiZoLKiyouoLqC98Up2/dfLJ5/O+pT8ta+b6zPyezL6xl+RzJ9ax/KYX6pT5bDH6b2fjHosOXX1fr3y/Zu53P6Md/qcyuXHn1xExMgCJhMSIkCUWbTDF6PqcvV4+Pl5abemMdMF6ZxZF2418bKgw2AAJggVMwq6irRARLEABMxZLb2l18eaOpw/tfB5Gl8w3PMEY1e33pUXLIxjKxwZYxyXigvFSzAoAAAAAEoEwICgCUj0PD2NfNpxauzpTBZtXrzTyu1w+9jj9x9rp+F7vO+jvlHttfZ6FNOPvtHxy/o+V0fmPX0cuv9KxMeZ1y+beW7/P+5R8LZ4fXfyr9E+daej9AfQvnX0bk6YnX+JdPP8AdXwjvbuf6xXS1uTp+B+78D7Pry+yDz9/5k876/yfRq+t/YPiH2/o08v8/fpX4lxY/LcOTG32r2ONcJRF2zMSeg4O5pYc1VmzphCAJQJQJQqYFCAAEwJQS00F1CZFBdQXUF1BkvhtMfUfS/iHseHwubq/Wfi2zZsc/u8Pv9HHFquqREBZRKJBZdjk95i0tHz1OTlrt69XHkw5dmLHE5dE0nHMkEyrMTMlqkmaqCUAmLAJAAABNqymXr8nr48Wv9q+K/a/L8b4nz9/n93u0pMbeqJgsgECYkCggASRNrTHGzQmFkrcqhVq2Src1WNWfJJqMmK5z1eTuY6tV1eTbMRN2iate/onJ5fH6DlZZ6uzrXw2/Udz5Z9B7Pn/ADf3T8+/pPb7/Y52/wAPzdn5tnW1/V1b/o/F+84s/wBCTWePZxOZ6+Nk8l4L7T8p24/I+dkrnPvf0j5v9I5Nmr+Vv1Z+ROnHd2OXfr1es1OBO7nt9H+X/Q9PR9+lHlb/ADej7Ka4PehZPyP6386j4FXJi2YLz7C83jnc1cnKGHWmBv62DsY8/Ib2jdoXM2sbDCywtI3tFAuYQAFBAUAAAAAAtWZM3U5XV1cv2H4j9v8AiHJ4/Z8/6Pz3pejhrauXoAoEhJtF2M+m4P1HT4vI87v85oxYa4NvpV174cuuxVnRaZlWtqrAxyAAAFkqTUTEgBAmUUEL0smx2+J3sPP5/wBr+LfavM8r4hz9/Q7vdxRMbekiVAiQAAAAWrdL97l+z5/J5Wny95lz8HpuXd3KjNj3dlCLnk2dPI149hrL6jzturt5OFOxr4dpDGkj0XK1s+zk7+Hj7Dm6HJjcz2cWTT6F/Q+cnHn3P1J+Y/07njbzXo/F79HwvU2tXHvn6J87+kasftVsM7OHwvJ3uR2S3mPSY9e35fX6N844ez7j9E+e+/2ceX8n/qv5Mz+UX+o7mO/5xX9NVun8u+t7fle3P9Esbl5OJ5/B8l7Z9X+h/mP9GYXr+T9NxOTL82VvXT37mGnpd3JwMP0TX18HhPR8bW2d+Ea+wREmSzH6bTxbeG/ITp6rbLSkRM3dCxKpgBQAoAAAAACYBasyZeryetq5vsnw/wC4fD+Txu35/wBF5z0vQw1tGfowJcuOJJJYzlpnmv13R6XB5/ksHD7XG2+rTDuczPtrhyYMuu1GRnEKkRMTKBMgAgAAlZAWYkkBQQkL0umf0XnvSYeZy/s/xX7D5nl/GNHb0+/6GkTGzoiQiQQkCggKCGTHkmO36fy3pufyfpPrfEb+G/Q+efUsGej4zo+q42W/lVzY93fUXLLbDkYYss4bd3Fr5tuGFnwa8xfG1ZbTHHv6856rYrQYse1TDPBGStz9H+ivz39k38PofD9fx3Vz/LNbo6nH6WD6n8z+l46/rbz8dPD6F56Y788C1dD8x/fPgOrt+wfQ/wA1fRNun6w4Bo9BPnJPRV4HjjH4TR3tnb+kJ8/TXw8f4l9d+P6e/d/QHwH7P2aPZ687nNzflbD6Hg8np5qY7ZLDJgjPGGeGMlLnAtt0tDHs1bOtDDO2zGthgmbs6Wz9nDm4MfQvPYcvnK7WDb6OOL1yzgKFAABAUAEAJiUydXk7+rn+2/D/ALL8Y5PE9B5r0/mPR9DFW0bPRgSiRat2OXrcz22Hneg5e/w+f5nlaNNnf9Dh5WxrZ9uKJi9NptSyiazJAygSgZcQAEwkxMKBISBLKJsCl6Xkz+k836XX5nB6/J7uieYwXx7/AE4QucokIEgACgAhekpn9R5PPp4/dfRfknV1+Fi9xTwntcPu/nn03h+T7HzDR9PyJ6PLjLXd20mZtyVplYa85MbPJWtsoz4+/p59Pe0e1p4uX6X0/q+Lk+V4vrdMMflfO+y5tuf5xwe38f6Pq4fT8Tvb8M2x9YjzfL+RZPrVue/IOT97+V+hn5boa/3Hq2/Go+w183n+Ox9klfjc/YZ1vhfP+l+e6u/l7H2S2nh+OvsU5Y/GdX7fXHL4PsfcfmHb0ce3d+kXV8Q4v6M+V8vV430vB6X0+fqPpvx/6Ph43h/CdPr/AD/q+d3vpPpeHm+NbH1yder5JX69NvwDlfU/mfpevqxau7pRZbGzgiYpjJE9bR+p6/H09zyvI9zz+91/mu5fQ95879f6TxfO+S4/feT1ezy2edvdrxsVMDJTLOEwoAUAEAJgXy4MmOvv8b0Pn9fD6TzHqPMb8MMTGz0ggBet02Po3zr6do8DD430nn3NyMs62/3ceLJjdFWfWuVoWWkTEyAiJSgIkAACSLT6yvJV2dcqmISBME2rZjn9V5X1WHl+b9r4jLouhivTf6kJMoAnNtTXzyLskglE0AEAWvimY7Xf8zsauT1n0b5tTo+ax+/6PzL0sPa+H95y/J7vnev6LHo9PiY+3jufDrs6+7tzVxbWU05vRnl9j5L23N5PH+j6PsPP8+Zp4Tl0e9j5L3+rb7uavO5eB8e+neF9/wBnt+l9Rby/KvbkeMZfSY+ffQcMMupm5Df8h+7fA/Xev2/To8D6rzfK6iLceKPCaXpbs3K4uHv9r7rPzLJxeN9JVt5mhGPwXXl735T0PJ+h6HrPpny76hxaZ+Z/SvA68vmcxHv/AEXQ9f5XHr8zofZfh/2Tj5ehlx5fF86I8Fq9+f0d8z1ctvqPkvb4noe3greu/tbnT4rnwwtemc+Pew0en3ez4P0vmeN6XzH1ni9DU+Y/ZPkk5cm5yu57Pu9L0Pze+Pme/wBHzmTzub0Xlel6LXh8yxeo81o97DF6bOsLQQFCAAJyYrzH3vjdjV0+b6ryfq/J78MUTG31FqovQJvS6bX0r5n9J0fPcznbnAuOTk7ett9bUsZdd8OeqYUGyBLMAbeSa9BuazKiy5VSiqwhInZ1VXoqqJiJRJMBN6XY5/V+T9Zh5XlaXph6GtW1c+iUSQmC1qEEWyIACgAgCb45k2vS+Sy6uP1XvvA7/T83wvYdf5V6uz2/ietv+b19PwfS0927o+Z6vJ83upmw5t3X3+H2szzPP9Xm7Wvp+2bmO/gfPTwO/GOrxXT9DO7daJ8Ljp0+Hye57nufWh83875v5P8Ab/P+v7Pz/wC4ea9Jz89uB3PN6dPx3b0p+l+n6/1P4x9g4/J9LOO3geH8d4/Q4n131U1xxj1dPJz77uf9AW1dn475bX+L/afhPs+pm519f1Pb9t9Z+QfXfA8G3kPWeb5uf41Wae/9XfJgtlOp9e+O/VOTx/UJjwPC81r+tdfZ4/z31HzHR0fHo2db0/ej0OjuuPDwbxn11yVyTZk975L3+Pz/ACfK7ej9J16XqPPYPL69e+bpTp5fW0qb56Dn83Wwytm+p/P/ADM7cv0vjejz/pPgfaee4eDjUyY+j3YFyCggKCAFqym3WJw0eq8p6ryuzhxRMbPTTEkJgXpaTY+jfN/f6fD4/G7fMzzxa2XFn26ZF68uLJgJgZQmFQR0c2m2cvV2OLnnP29fR3sefmaP0e2Gn5rHpeDl6uvGbG6KResyiLQsLFrM3sxiF62TN6vyvqMPL8xjyYsO/BW1c+hMSRMCSKlEhMQiVRIISBAAE3x3mOx6Dz3e0ed0fO5vZ+jx+3+UV1MNell0etwejw8eXFv7q3pGedutxsjV2M/L95zcX0vRy63ifJ25Or8o9D0/r/U+H/Xpq7OBPB5Xxn0flvae39X71heH8jmng6m7r9VHD6mrTseX9D5Pp7PmWDLh9z7V9k+N/ZODwvQW17+V8n8X43Y4/wBH+ihNzNhzZT7ts6Gx85+dT8D+8/BPQ+hi1Z9L6X0/2L4r9o8v5WOL1Odw+R8Spev0P6BFit76T8y91q8n6GxPnvkqannfnvp+z9e0fljd3xfNTd37nB28GeyM2vXbunNgza3v44no+n5XxWHr19j2+Zn9nvef5vzTX+hX4t3zu3Z4/Z6u9xdtdvV4Xa994vdz/G6GHOe3837n5xfmMWO1N3uxMTcgoIAAEEzEpmvjy4afT+X9T5XZwYomNnpyiQBMEyet8hv4cfo+Z3fMY+bz7UybvZpXNhXHWU2k1JrK2IlGS+KbhmnHa4bOXWq1dTs+e2Lw+znznZ0eL5TnfXfFXv8AI03dfP3sEXrNsQSxapZRKTatrM3q/K+s1+V5TXz4MPSx1lnuRIhICkTETsa2VjjbGAgtbVaoChCNjAi+O8djSjuaOD13zzD0/Uxpp5+h590GbD6nZu8GO/5PJ5ymTHt7rzkx547X0z5h9a4vP7bUz+T8FXn9KMs+d0oljOHZ8fs6/A/Rfmn1jv8Af7M47eV8j8w4+xyPpP0T3PvvCe58f46/h/aeCy2+Gx3p6v3T7P8AGPtXn/OdK2OfO+P+M8np8z6H9QkY7WbDmzw+27Gnt/P/AJlPwj7v8P7Po9OYn0fre99m+I+65PmPXRq7Xk/KUjJGW6sXW+G0Ov5D1/qPs1PNej8j5inO6kTDmbO2yzweZ9bx9vpfJ8GXH6v2OTFTZ6LqZLYteez9F+Z5tHn/AFDX+eYb5/rPMYKPVybWgy6Pcdn5jl0+R7XzHb9F38nzDH1dXo+gpsR6Ddz9v537Hxnhcm1oxHR6yC7W1SrXiiYbJAAABkzYdjHT6TzHqPL58GKJrs9Js6yJQLIVNqWk9jymzr8bjWz6m7vrjmLuxylsrW9ZYCokMmOJNq2tkurcx4r3XXYa8dnp8bI8703ofAeu0eJoeL+ueXbfAYehqbvqsEXrjuqmFAm1LWbHrPJes1+V5PDlw4elSDPdExIQJABEg6vN3sefQ7WDmZY+44Xqc2fgfM3X5Gf0qDTsbmndhSd3RXJuaFsce9paEY6MuTVtd3fjV3nFxe9Hm8Mr5ep0M8PMYcV8/Q3PtHxb1PN4nudPzXF7/I91HgMd6/oD57XHZ6bxuxrbfWxfV/lPR16vo8eAw3zMWhtac+i9r6X5T1HjfQvHaGPdeXS9OX3H0/5j0LwfSp+dNvk6+ht6uH0cJas4z4c+zH6bn+dt3zn0L5fvcfT6MSjX6vQ0drP18/suz84tq8P6M+csdX0nH4C0w9D4pXP29X6n872Lr+i5PnE4+X9Jv86u1fVo+f8AY4vP8Loeg83l9hQjd29vlYvoO/zvn07uho7rqJnaIURKzlw9fHTq/SvnHuNXh+d5Po+F9F2PbeR97w+d885m10+L2edT2fC18vncmzv3v4UTGfTEgABEhFq2L7Gvnx0+m8t6bzOfDjrNtno1WgrJBEiYF/R+a3Jy7er1+Vlq0165dlGWi1QZAQlFRLNk3FNEbLXyNe/l0d+cuHtczvOPudjg+l5flfC+V+zfLd3vcDHt62z6PGmJshJYtEpm9V5T1GHmeYw5cWPo44mMtqQCgAANjrcLd18uRsYsdXO+g+P5ezH2vl+xg9TR59t6vn+sGOV9rRyzXibukylBktUZcmCccM19bNcPUeQiJhMxOXRl29LLhp9toeawdHn+gxcGOrr7uHkMc+nTQnHOb455s+5r82vZz9TlHPujrcy0nUjm036y9+Lbh26Tnhv1056tLU27cm3Tb1dbS2LY9mW/TnU6sd/nraNtVr6rtbPMp16urbjLO3bhxcfQX84uM9DmtHT2XHjdq7l/Pk9Hm8uyw+h8Tg287lvp2x30kIy2tzTlj6zysTloqJ0olEHVmFNScDC3X494+tc/51uvB+h+J5G4326+DsdmG54Ken522mln0r06NZbvSACgG/oMcEwueTNgz4avR+Z9N5nZw4yM/RtECYgTNRMxItWU6s8rquPRpsYNm+oZ0i8LAliQpMTjbZMN7irYMuLYYYuhr4pr7uHX1Jy+j9H5jax8n3fK4ns9PifH9L1Hnej7TUrlxu6CJktWyZPUeW9Rh53mcWbDj30rauW1KCRQAAQmJTbpgTX0MmtTDQ2MWLbnkwRVsiM2GbAXLk1czXhbWqzBc+W+vjoyXwF2IxWuKaUmWzfTux22nCbVMOSXNk1IuO3XBMmxOpjXoxpWY7ubmTMexHGjHHt5OBdO7k4dWHo3mci+h2PKpPYbHh5mPssHmB6HX4OK3s4Ocy3dO/HudieLVj2MfNm5b2PSrc9yuCGWauNcszWk2I18hktgxm3XVsuxbXom5j1she1K25q68y58DYs0hlvQ2ZjmamNrTBukFlctx2ehzut1cPZ8k6XDpy6+DBrznnq7u+UTdgUAAAmsxfNhy46vReb9H5vZx1iYy7wC+xndSMtIgYyUCUSm409i6q02sGzKoZVTEqsoqMbMwFqktkwk3q6+S6pvgym9bFM5fQer8T6rV89ufMfrPzCbeTh2MG36mtqJsTEmT03mfS4ed5zFlw491YRltmASVBMBQAQAQL1gmacJMmfUWZq40swMsuTW2WvWjvcPGbmtta9x9n9K+YexNTNzehLwO/j3rOR8x+qeWmXnvSOCv1XS4fZuPnvq/wAv3k7PV4u+nyTW2uey+0bfkN1hjpt411PNfQfmi/VPM44lx+28V6mzlankPqJ8h+6+Q6MvH6fhPYG/xOxwk9by6aS/PNjSL9r8xk5aeu4Hb4VkbWpuy7na87Sy+5t66ciZ7K/MPqXifaHL3OV6tfJdn557Q+Y47RNn0/NXauvnxu6h2/mv0f58n0j5V9R+VVy9jFnjRW7a8zBbFclqWud4GMsZc2TW2ccMtow4aelxoi7LViM90xJQoAAAQJiYtmxZMdfoPO+j85s46xMZdyYGT2/hp2XJhRETE4CBISUC98M2Z6Y75wtFtUoxjC2haysWiAWckZWujLhs6d+dtTlzeg8r6DHj9Twp6OrxvnevsYN319ImJtTEl/S+Z9Lj5/nsWbFh24otGW2JgSgSKCBAvSURJUABKFTBEgAWrZPpfnfOfS+T5vwGl6Lhb/W142bZdOGclbMePZmNbJlGGuzZNOdysYGa9atduI1W3Y1m7DDn23bS6DpZZjy69cw4t+veXkO5LXxI9BlmHl7+oyTHyz02GvN4/Uyz8tf0dTz9e/S5eft6Cy8KO1grjV7ctnHv1cVnPx78XPnRumzVtsVsw49qTUbg1+3y0aeTZhcNdibNK+zEuPYjvY8uTs7HzLT5WGJjr+lTBQACBKJAsBQAgAKCESIlJbJXJjq73nPQef2csQZdqLVVMAAICpRMRKCUCRYIWZqJJsiQtCLJBfPqZ2vNimzDDlxbDKO3pZZw7novMet1eR83182DZ9NWJNsL0Lb2hea/U+Y3urz+f5euXHt9SsSZESBQQiVBESEJEJgkAAUAmEltrUTH1vlqRjoIZ9ILKCSgSiSUEmZzTHE34x1aFdjFltqhcpRMSgiYFpoMk4iZmJJmyapNvDigzRiMssY1ZJxDJFBZQt1JJQJhFTApBZgACBKBKBKFZfQebYaNnXhdsC5hQQFBAUAAAEABQAkXjJjhb0scbDzMOpanR6KJhnMwVEwBEgRetABE1BMSIkQmCZic4mCBLFoumO80L5MVrjbc0M017+vlwtHZ9Nwe3p8L55hzYdn09YmLsCFqyZdzSmafQeb9J5zRz44mNvoQSQKAmATCJQABIQJRIFAAAAABAAAC9csxz78e55vG4EfRrcXznxrS+pfNe76XQi8dHrJ63rNPn/PXrOpjr+fvfcC58B9H0sdHhXsOBt7Oc9pOvR4p73g28GPpWnho+fxmxdPsrW9Vjz+UfRPK6+Xix9C4bHzMeijLf51seluzysfRvKa+biz9E5N1+Oem7kz+e19j4/Z11TXb1TAoUAQiUTQAAAAAAgmAkABEgACJglCJmJTJ6PznoNfBzNRXf0xWa3amJUBEwJACYAIiQAiQEkAkZ4zEiJmKIRIJtNrhivXLGxTBZr7XqPMdrT4fiMVqbPokDIIELktWWv0fm/R+c0clK2rs74FoAAAAQmAAFBEgCgAAAAAgACdjXzzX0/rvyT6p5vyG0ieP5t8e+tfIO36TRiK+h9f6X0Xm9/j+e4n0LVz6eDl+d2NHp9X3ca23yeD5qOJ9M6PU5W3431Orl0vJ7+tv9b32ObcnzvzfRyYfU+4zfSvmH0/m8fx/oeb0Mef1/Gp2+TwPGQ2ej2fFOhTq9z3Pzn6f875/I+q8fS9NzeF4rucPa3epwfOeg8/2fQ0rau7vBZgAoAAAAAAABEogVICAkAAAAExMmT0HA9Br4OBS1d/ZRMXMkAITESipAATkMeXqW7ZyabTBpxnw81hKITBYZ4kwJiUgSzfHay8ViTNal2vBeb3LtbejXV5XCrauXswJQVEi6JYej856PzejjrW1dneFsTAkEJEJE5cKYwlcgAAAABJAQFCAoICgib47Mex2fKb2jzvplvBY+Xwd7zV9Xr+irEN3bs+i8o18/S3ODJ6Ln85J2b8OLMnX4Ztv2OJJ6jm8qJp7uDkrllwzGfTbf5tph6nh6bHR2aciGXR6vmpmPo9XjQnpeTz5Zdba8+s6+75xJ3eFDLdETGe4LQAAAAgKAEpABKwAACJASkBQAAFq2kyeg8939fDwYlv68YZhUoBMAAkgkt6PV3fTvFjNGvXrau3o8udr4r6rKYRExFhsxJgJCJgCFl7jdEXDOvDV0ePv8jCIROwAAJbzBh6PznofPaOOlbV2d4KFAABAAUAAAAkkARIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgKFSiUAAgEwkgkiQiUAKAAAmJkyd/gd/Xw8GYb+rGLsATEggkQgqZiT0GPU0+/HZnQrpyRRyWb0y1AsRMF4mM8ZBIqBCJkTWUmJhM27pbTn19Qw6UDIAIgLkImHovO+i87p5K1tXZ3AoAAAAAAUEAAJgkoEwEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoEoAKAmFkoRKFAswICygkoEwKAAAtW0l+/wPQ6+Hz439WNMM5RNqAAlASgTCLbOq2MmHOrBGaNdVmEQQTBYbMUxIAABF6ZESyZY5dPLr64gm0SRMAJYBki1Zh6LzvofPaeSsTGzugKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAtEpf0XnPRa+Dz0p39eJJmhNRIIksJEACJIAJRIFQIAsNmMgAEiLLKysWrGOQhhmBIIEAoGSJiYeh876PzunjxxMbO8FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAmYJk9F530evg89MTv68QZgEiJmaomBEiJFhIRKIkoCExAFhsxkAVMwJhBaqMUCWEzFZkQCBAKmLJmxZ8E1+i856LzunlrCNneCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATMSl+/wPQa+Hg7Otubt2hFoy3QSqYk2t7lZJrwVmLtAmJJEhAUBExBlxiJgsic5JCSgsomIETEwRZkyZN3Xt14bGhs9WvN07fG5c6DWhKIz4dqYYYiT0HnfQ+e08tImNncCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALVsmX0HnvRa/P8/atd/XkwbOvaJZwCUBEiJSQmAABEwEi1JgRMSslJs9j5Ca4aYGe4kQmKCLFcjNiWde2js9urpcTPstvDi9fPsAbGvnmGK1t/HDf856Hz2nRSJjb3AoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACYlMnovN+j1cHCp0NDf0XxZcWWYMwAISIBKJISITAiQBCYACREgJAESIkJhOSiYiMlLVfa1a5oiY1ITKRta/Uw006t/O6OHHhmm31IFzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAtfHaY+l5Wl6LX53CxdDn9PYF2kImJEJgJFZtWolETEiEwCSEiAIkASABMSImAiSRQCJECBKT6ny/pdHn8HWza97K1mMtwKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAmCXyYskw9L5zu8JxVI3dwLKJgCEiDJZjWqRJKTNVTEAQkWjPO3HVb+vGEa8hIRNiJLCQBEgCItBEklvTeZ9Po8/zurtat7qwZbhKQFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJiwTE3peY+g4Xd4TirFo3doKTCAokhJITJW1sucrjtQqMMoEAbMzG/VkyYpywwYOnpY7cI0ZEqmATAJglAlAmATEyT6jzHp9Hn+c1dnWvdWDLcmJSAoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEwJMdDQmDJjyL6Dhdzh3igbe0ACEiJmarNsmbFnz6u2TjNSK9fkKiY1kSIlJuxlpu5qplVotlOdGfDo6ISliUAkBESWEiEwSiUt6Tzfo9HB5/W2Nd3UGe0AIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAmCyYInJjySeg4fc4d4YiY3dqSIiVLTkyUtt9rrz5eOunmiqOHXMIxswAF8cwkknUpz4c/Qc+2V3XQyY83Cw7mpeyItGOyEqiQAZcQQQhIJHpfNem0ef5vBn1731F2gAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKBa9LzD0HD7vCvFCW7sgKCX9f4/Pty+l/NsdNuSk159YQAi0ARCbVbLa23TyEuPry5tTZ3a9j7L8U+g8vlYfC/fflejV5RavoeuJtgCLCq0EBYSEkj0XnfQ6OHz+DNgvfEF2ASEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQCULa9LzD0XC7fFvDES39tVhEWgTE1MIESiEzESWIkQmBmxZ8sbk7dfItW3D11zY4ybe9h2Onj+2Y+F6X5j4/4hzvYeR9z66qW3fCVRaAiS1TJVIhId/g97Rxeew5cTvqLsAkIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEwEwWcmO8x9FxO3xcuCEt/ZCSxEiEkiJESuUSgSkJELTJTY3MbRiarbs0RydckpvZN7Q6+Hd7Xnc+rT735n9I+c8XNji0dnqwkImCYlSJEJLBKO3xezp5OBhy4p6EC5gSEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAE3pdPQ8fsce8CLR0da1RCS1kIkIWhIWiIkkSlL+y532DzvL8/8W994LdMVM+p0+2WjVmmt06E4L9XLsWpva+f2/zz635Py/C8TTa1/R+jqllnCRfHKyEliLCq0Ds8fs6eXz2LJjnoQLmSAYgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQmGQlF6ZE9ByOvycvPhLo7ITZKWqISWEwQWkhLGRMylbTKfVfQ+C8v5vz1eZvYfV9znYLRz9/QxXdXPot2dG2mSY26sv0/5b9O4vF63K6HN8z5vs/LPrfgN3t+RXj1PeiZJalq1jsXKIsWq4r1uX1NPN57Hkxz0YmJyzBJEgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAERMWyQTet5PQcrq8zPzoWdHXVYY1xRcUi4haJK2mccYXTGOxu+25PI+fcD0fC7e7Hs4MufRxkTx925fWy9WnYpS+evtcXuea5ubZ7vms2W36Pv/K/p3n/ADXW8X7jzXLp8PXZx+r9LhnIytceaq44yXt1l1yrN4K9HR3tWjz1L0enAuQEiQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACBaBN6XmPoeZ1Obn50LT0dMLkxTkW0jLWTGvEQukoukqno4a/pOn1Ob43xXkfN9bme79frUpe+lpJcu7JsYNnp1VyYr5a+15f13keLRbc19rp6Y+r/J/rXJ8/wBfLS3g/NfJMP0TwvufWakbNd27BGetuLYxSYIzM9mGcsGPb19nVr85TJjvrQLkEWCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVFsSFr0vMfQ8/oaWfmVtN+jfW1jHFbKjFGaIxZ+57vi4/n+v8ASeZy+N881XN9H6Tp9Pke0x4+3h3p8v5b5vyetzPd+z1Ms9h0eatt11btbb1Oltx523qbJ6vwvrPKcXJn2tXZ6+qnsvF+i0cH1O3zfznk+H9K8R5t6f0HotvyfuMtfNx+98bp4tKNmm3dhrnnLLWbEGDNFtbzePLjy9msSyyhKWQxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqLkmJL3sau9q72K+Xgvlvv20ZrzXgjbtjjpb1PZc2PpqeTweV5/p/J24O7j4XM39D0/r9/wC1fEPuHnfNczxu94vpzzYL6vpe90cnO2MsNSEY9WDd0t3BrZ7Y7j3/ACfoPPc2rLvc7d3b8eTXumuNO+cmG+czZjp1fYtPxHt/L+Y8pj6mps2ajYXLVjarctam3iwy8tj2MWz3cKV2QksBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIFyTFpNi0XvP6GuTNPI177e9m0/S+p1fJ8/yvJ9z8168edzc2P2PqcGLZ5+jfdjc+W/rZMTVs/cPgvruXxuPrZcHf6OfU6uPZNHLfFnswszHPQ2tPPo25mOdmrZ5m7qa865MdsNl6TVCLTKFqV09rnZN/FkVb8/a7uv7bw/l/BujG3XoR61qx8npeg4mfR5TBua/R9Hq1yUz6YCwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhJVoyMdjIzzk7m7j6GHh4vpHH89xbfc875zhx5vpnxzreZ9HvtSuz6Hs15fR52jMlo2WVmxlp6nHm0OtHE7OLc0FN3dgplxc+29tWmszYJ1554tn3a8WPbrnjq22pwc+u9v4Xhujoa8smCVz2djT6m/m1tnWvsx917f5V9V8L5Xh6Xf4V4c/ofPdLTh0uB3tnm6viOl9H+f8As/Sc/Ht6+70MK9bsoJkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlaxmjZmrLs4vc6fK6/E9b871eLx+Xlj2vssODLqaM4vSefPpJxdvNgwZKc3RkxQwJJeimO/RvZOXr3Hra+lr47s2CHFmEokWrKZcmrGePTnnbO3TubODV6NXapxNvDDlWzY+Ptt1Ob2Orl5efV2Js7f1n5F9Q8v5nb1dmnleBzdjX8r19f0TY+b5ce/wCgfPfWdHDX4Tg/XNu+h+eMX0/5r6vuaoz6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJvk+g69XD9Z67W875zx/qrW1eDb5R9a+Jel7uC1c/tfT8/XyU4dtRruxak9GGCMu5g025qZ40rMaNnpOZ3uJ2efj181Hbl5/S5eqi3PsqIJVAAJtFbNqYno13z1jbr7HnfRed5+aetx9/Zu182tsLhyziPR6vE1ebTlvrTl3bWTX3t+vL9T+U5Z5/3K/zH6V834FfjP2rz97fj2Paw+372GMsXZji8LVYVWFV0UWFVoWEiqwqlEJELCEqgRC10xrCsZIKpLCRCwqkQsSsyIiwiLCqwqsKrii8FVkVTJCyqxaSi4osKzMlVhRYRF4KrQQsKrCqwqsKrCqwquKJkqsqqwqksEkRaCFhVYRFhVeCq8VCxKTYVXFVhFp2pr6n2rxfp/I+ariyZebwNfZ8Z4rv9j6/8VwX9b6Gmxjv193KtVwbkTGLLjicpuKujRgpNubfSMlI9hxNvQ7vP1t7S3nVr87a1efbN0YZUGu7EXnp1Ya7dcJps+DXty4g3Irn6deLOx3Do8fNjwld30Opr5OHTJq5dmy07TK2K9cNkTW2NjLjvnL5Tfh3PsPwTr8Hle98n5K+W3b2dW/p9PoeB3+lxeT4+b4t3becULmnATZnVJs68ZcbznQ1de/AzRc8TLMYWaTA2CYLZRiZEmNkDPryxmQyxiTG1Zm2JhExErRlGFlkxMoxroqvZMTPCYoyyYWWJaxeUpOSUws8SYWZbgZxhjOMDPUxRmW42SUxxkgxxkMscZFY2WDFGaFws0rjmxItEpMTFl8mqktBllETDKIuMcZoXXbELgtlViZpTDjzlws+ykXxxs0ZowRWatEyyTjlMtUsWbr89q5Xb4GN2/Yer8F9F5fg/WNDf8DzeN5HVzav0H3d+zxsadfiX18NkzXLz7VtnX26sMw17cql7rts9T22jyfnun2+H2du3rRbbt1uhr0xuLBkx8+69SWBLbJgzZ42tScsGHNjxyoMM73wrM99Wc5sZcWTbh6H6d8T+m8ny3kfM/dPC8+z5+Ov6ibUixFomSajerFOrVFYjRne2O1xtu6GXZj1enxMPVzej5+HS08/Srz5x2b886JenPLlOpblWuPZceuOPZrxpxvXvxkegv5ucdfop85MeieeSehjzuSO7bhVk77gF9BPnknoY8+O/bz8yegnhXmPaniXY9evHL3HCSdueHZe5bhzHdcOY7c8OTvONuTXvTyIOxPHrL2XHsdnNwIk9JTgZE7VuLWO3g40W9eeOt7F9DTTuU8+ufoI4Up3acSq9ynFi5dlxVnZpx5TpzzsFdtw1dynFhezPBi5+grwmTuRwS9+nFk7NuFFvfefmzvW89Fvoq8Cp6CnBm5d3Hxb53s05Fcr18fLrcutTmmXRjnl350B1tvz25twz6uDFs68nPpk4982Vwx6+vp7GzTilhu2Yw7GGeLFlxa85muwk4NnWuMZMc4ZbHb0fr+nxdrzHovm2v53zdUer91Sk4dGWXHDDKUTIBAVaoz0V2YWiJxtBjkAJGfXZTe63Eno5fRcXXmY61d3T09cWqwylF7KMl6xZpvnhrxnxYIm1rKzeNky46Zc5bJF89WXDWuOMtjLhjrZOhkmjlVVz32ikMsk45MjEjKxwmWcOWLWpikzxhRmjFYy2wRJnjDONzTiTHNbATYnGxx2MGAuxOsXZa8psMEpnnXRszrTMdrJp5WG7S/Pw1Z51Iy3bttKU2505TbnTmTcaY3GnJtNUbU6St/Hrb+OGGtMVzzRrxlnsNYy2Y1ZrZjXhdiMEW58uleTPSYSs4q5Z7FcEW5Ywxc9hrzWVgi3YvqrM8YrGRjjNkYy5JwxWauIuWcU1lYZssgSiFlSJcmxpa927M6U47MefBPPle+vJsY8cVMJ12MtMuUxV3dWys3m3FNkUWmNu98HZp6enqxjNnRya2G8m3PlWJgXpZIgUCJIWqqZrNiCUAIA2Jpbo1xaloya2Zkx5K3i84L5TOtG3Vly6t8sc+bTMe9oc+unVFs2s27DXrm3I16YzXxVcvbmvrTm2+pyp36PqHju17Dzflfk2DNq9/0d5wstmWcOSS9sOOTepqRGzGuuWxGBGe+taTYjWnFszrkzzr2xmzfFgmG7i1y54wQyzzgk2Y15TYnWmTYnWhN2NS0mxm1enjpvpa+JdiNact23OpLHaao2mojavpTW5Okk241S7LWk2t7lZsdOzh3OXMc1cFNm/YjBDPNfWVsRrybFcEW57apd3Y5d5r3cGPNJgUrntzVxRlcrAZZ4wsmZrl2YwRW7fRvcM0VyWUiwrWK3PLOAZp11ueuGDe14wXK03wzdacF8V4zRnMWPNi15VrniTAy1wtfR6kOPs25OHuwzada5dmJkwcueSsxJSuSMG7r699kXpfG018+DVnM1YAUAAAuso2PZYcnhnR0cuikWhnCclYmxmzmi6N85zL9RdfLtvYFwRlsyx2yMprV3K43TnYprypfDGN36auxuwrel2Pc5XQ5mHFbJrxn0bOnGvhsmatW9KUtn1Muyb/tvBV2ef6Lh9jmY68F9nWvROK9GdUWZ1TJEXiSqSiUiyItauTHGdumLDRhremW8mLSLRExKTNZSVZJmJkm1bTHJu4MevRgZKZ7oItlEqCBAVEikSJqL2xZ5hv6G3mw5eZTNh2dVYGcIi5WtRZMQVCFtNLFsuOZhtauTPNWhXJXZvrF4uVUrarRVZSRee7NMd7pfN8fOyNTU2+ts20smnbuRnjbz69c0M8bLks1te9de7Nrb+llW5rYplv6+C1kXicV93L1M+W+HWxdcvqzjy6NfLfDozx698XLlI1suTWy7ZlisZY2x2iXHOe1a1NzHLrs0a7iZRiXpKEAWy4smeGz9K8xv83zfd8rq8WZ6l4r2fQ5p1pszsM1kmJyl8lZ3TNk1ozx3svNm4b+lk9Lzc3isfX4+jsotXDei1VnY1smUzUrTPDY2dPLnjsxr59mGGmacMtGl6c+4TKtVZsRMbtfoeVucnDitVGXXMTBMRC2QJVRKBaa2SZZZjW1cUmRhMszDJlYhmnATOwjPGGYysUpdSxe9dzHVn0N3m46pijPpsrNqai0VmEWFZmCUQWVF5xyZLYZY7G5zdvDTjpmwXKIrTPZkYYZZ2BbsRghMzCZZoxjKxEyTjGzgrssNeJrdiEZZSrMSiKtuaXT2atJTHd2KtrcuzGJdu+tv9GnDk2sW/XgY7456kbuPXngraurJE5IwzEY2+3n7l48PJmvo7cNtevPt3dPDGrK00za5WnVydGPGr2bMuZl28expbCuGORWMyqNdqiME2rFWiGK845quPNGNwslNeWxmwt2jJimFIiZTOOmNy0pGOWTJgmtu2rbbjsTjnNfPTVzm9j0ZxLRk0497zn0bwHN5urF6Z+sqMkwL0AInY1r7MWfFVjbFaMc4TMVXvklfJs1ZZwRsx2GuS9MtmWNhprmfHRjldSFuqMuTBmYbmPUYa4rZltosWFoqFyUXGObTLSbEqmxXJEsb73O2demmEuyqYyyTUsqi00GSKQXY5lvOOUuqqYgsoJk2dTJMOpzdnTx01raM+iImLlBJAUAQEhkxwmfJqTMerp6+ZrwqxlvvfCTYvpym1OnGdy4rYcdk1NWYsTsYse3Ds4+fg249evLtXXtxMmLc0sbVstmwylOvydyYep4ulv8Ado1se3rZdOPTU4ckw1Xr7nHr6OvoYZzZ3XbGvgrE11iIkpF412LYkZa1qXY4xuSlIxtlb4oZJzmObKqx2wSmckomwBMZKxzONYxy05AZZpfZjWROtq61tvP9R8lpdjz/AA/GUtG/6StdvNtc6d6+TnT3senRxozMt2Cc63BGzfJp23Ex1WSq1UjHLIrNl8lJzxy31cS2qtqyvXJjyxQSpiYTOS4zjpEWiIZSgtlSXUF5xqyTiJliguoL2xxJlvgvJvYM+nNKsVu+0VW3VFlSWVLZUWVEzUWVFlRdQmScaTNs6O7NWtSaZbSplZVbZUWURdQWmgsqLzjkuz0a4pGS3GtC1rarK8QFbCjJEtLQWYgZMWaMpiZ6y4ryMazEFjoc/f3THBnIiMGvKsxOjKIlG1GXF14CMGxt8yNzepzY1Zbsac625r40WqYVekmROTdjjjJRIiWLHaYlmcYtMLJmBILRiiXJSGOQtFV6IErJiy5SSM8WXBlTJ7Tw9cOSMmuvdtNWcps219rZht/UfknV5/F9N4j1XnMZoMcdHtZK0llEkuRjnKZZquFtacWG0NOU2jcYa/stvvcnzXkPK+p8p0+pMVjb6F5rNZseOJLxQyuoW6gsqLTQXUJdQt1CXnGMiklsmPYmDDWpeKLldWFyMZMjGLzjlbTjF1BkYyZGMt1BdQZJxSmbNqzMMuLPrhFbndQt2OS8UksoLqC6kllRkYyZpwym3hxXuKqrOVYlyMcl1BsZcbfhM3bcsOLLj02JUxWjbMNbLalmOmfHM8fQ5u9nYxEjBmw4ZVGrII62GMXfqthmNGSZRrjRmMtYZyxlMc3grF4iJgXy67Jnx1tYiSVi6WFGNvFYiYJZAJqZrOUmlqYpQlTAywttxx3kRW0RQa8gGTHFbuLHbdrnJjJMYowzzMKM04JrMxQXpFsbW0SVGN6OxqXy4vR+i8l6Pk+f4XlvR+b3+5E2pt7UQZEJZAFImIlEgAUQiUCSCZiUvsUxtVYQ2ETaAgAVMSkBQhMECkwJgEwLWpaTPhZGGGJq2AoUQiUCUSEKlCJAmqrTVJkitrKxaqgpCNsjp10RTXkrVqzFo25wU6de1gjFhc2Ksasm3qbeaIvTZjTHkx6rA15Ji1bNL4unCVbYJRjKDRmy475yZpOULVIVY21YRMEoRM1VdSbP/8QAORAAAAUDAQUGBgEDBQEBAQAAAAECAwQFERIQExUgITAGFCIxMkAzNDVBUHAjFiQlQkNFRmA2JoD/2gAIAQEAAQUC/wD4Gd2W1/Q3P39jMv1ASjT78lKIvyqWyUz++DK34q35G3Rz/i/8qnG+lghtSwqzYM79Uzv7PE8egQp9IjSqOorH+OiNx3JHaGLT4s78CZ3L8fT57MRjrEQajGYdeSRH7mwt7Agl1SUH+QUo1H/58iDRMtIddNxd/dR470l6q0eRS1H79SMUf+/sGIbjyb4i/vGnnGXKjUn6lIP/ANSRBKLhSLAy96aVJP2VhYJbUpTUBqM1Lmqf/wDBEm45J/8AAsRSei2FtUJuKRFbem1uGzHlLTbW2kVDEZr25mZ+yJIJAhU1+at3utHD77j7nTKxqPkf4I/ZEgGr2tyw/GEEpuFsqSRpFg2Qpp/46pqIqa5ZQsEouNgeKisf4lKbhmMpYh0UjE+spbbWozMz/D28HQWSSPrkkzBWSDO+rkV9uP8AjkpNaumxS23YBlwEGfXU07aC6jFQjltpUZko8eUwUmNLY7tKsGW1LNKkt0hzz4CITKWmLE1sLa2FteVvbEGbXhMxKZTqvU+9uqUDP2JWyVYl/gSt1Es+Bbnh4HJUh1j8nYYiwRjcyK+jCjJyW2RmaTI9UGKKrnVKZ3kxRYi46Li4rMRchApVPchHWC/u1+f3VhcEm4gxm4zUuQqQ5oWinGzjiwbcwQfu0qsO8LxUu4M/zxEGmFuqcbbiqccUs/yyEKcXuyYE0uaN1zAdNmgqXODFKc2siC8l/uckLYdb0YeJ0lQXnXVJUlVguM822QguqTJE6mImOERJKrVFUUqVU1SdIVLaiOEJyzOSrzaYcfcNJkZECgPtHKl7QeY7rIBQpIKBJMFSouD9OfJ0qbMG7ZgOmzRu2aHI7rRaX9xcX/KFs9n0LCwjwzcJ6UlpClGo+lYWFhYWFhYWFhYWFhYWFvdnq22pxbi0NNYgiBgrjJRDbOkO9yh32UHJT7hXUMlXp85tyPOjomR7mQZnf2zjZtrZUaVoXm3pWIe3apEHYFpcSDycS2txyQ8iAxkZilU7ZlWJ+0O5gsgUyUO+ygcuSY7xIBuvGNo6MjB3HMMvbMSI2yM/e2FhYWFhYWFhYWFhYWFhbpO7La9cm1mNiRCyB4erYWDTDjyyisREvynHDUoz6ZEI0XalhAFoI/tBaGMIQwgDGnDGmjCmjCmjCmjCmDGmAo0J8KSaTt1LcVhYWFtTPVtpbi3FojtoTcU+mEJMyCw6dQgjv0ASJMR1RqZF2hk0PAPAPuhSkKRUVIJ5xLi7mRrkKW2lahT3M6dyHIZJF0Dwi6SElwkxDcUGZCmlKM1KaWTS3KvIcjeEFhe7Y/jBKbI82QS2Aw/DbUcynAp8AR5tPdclU1l5hxtTa2HkoEmMbKtCPSwsLCwsLexsCSZmqNDYGNNGNNGMEWiC0UWii0MWhDGEMYY/sRjBGFPEmNsvbpSpZ92NJ+FJGoGd+sRBKLhqjScnZEeChxxTjhn0yINNXD0g1k0w+8nuMobumGE0yaN1zRuicNzzRueaNzzgdInEN1zRuuaF0ucQcZfjOG9Clt7OljZUobOlDZUobKlDZ0gbOkjZ0kbOlDZ0kbKkjZ0kbOkjZ0kbOlDZUobOlDZ0obOkjZ0oYUoYUkbOlCT3NLekVtL7xvRYi1EnKmU/lUqliDUL9YgRjIZa3F/YpMU2o4nUIXekGk0mzIhk1JZNh3SNsdrhSRhSBhSRs6UNnShs6SNnSRsqUNnShsqUNlShsqUNlSRsqQNlSRsqSNlShs6UNlSRsqWNlShsqSMKUNvFipZYfkL3bPBU6cN2TTG6p43VOG6pw3ROG6pw3ZOB02cN2zRu+YH2H2CZkGglt4gy9oxDUsKW2w2talmZjEH5X6qR2VhRe516usvJUfUIgwxmHV5iHBXKcM2YkcqvECaxCIb6gjfcEFWoIKswBviAN8QAdYgje8Eb6gg63BEyUuU97e+rbS3XHHUQmSMU/um3qNULEzF9LDEW4LcNuC4uL6X6VuFKcgabaXBGKbUixqT0N9RiM+hbciO5Hd0v7iFNchvb8gjfkEFXIV9+wRvyCN9QRvqCN+QRvyCN9wQdagjfcILQxMjTIDkN1teIdawM/YobU4sorcU1umYUo1HiF2IXPW/UIwiQ6gsgZ9MiDDO0Dz2Qgw1y3D2EWNOlrlui4yGQyGYzGYzGYyGQv7ptKnFvWg6kYyF9I7JvSKq0SZjVLgEzuynjddOG66cN2U8bsp43bTx2riRmYVNbJ2rlS6cN2U8bsp43ZTxuynjdlPE+nQE00MtLfeotJhIp266cN2U8bspw3ZTxuynjtLTEIlDsjCivoKmU4bsp4qjZNVgdlYTDjm7KfZcGlNL7RMpYrqvMXBKGWseQ260+yth73NxcXFxcZDIZDIZDIZaU2oKiLWhiXGnQ3IbqHOT7BtGfXZZW84htuC0tXNarn5EpwX4D6txfqMt7RbjuQg09ctZ7GJGn1Bcxwz4Li4uLi4uLi4v7v5KFw2PEhEUpL8uOa3/Lj7UqLKhpyr/FUfpZDskRbk4jHaNOPaLsmdndK+jDtChOS+zK/wC8Exk3mK4h8qkemKjTwsr71FMrH764uLi4vqRinVJURa22ZkabBchusvERSGdi51UIU4tDaKdHWozI/KxkRINRKKx6H7shF9aCCEoaZqU1Utw/w+JkSX1JZ4X57j0QU3xT1mjGRVXGVnXFCkyVS4YM7BFfXifaATJxzFdm037SAxW6kuJUjr7g386N+Oh+suORx2QO9EDx2Z385jv1wUutbWo98jBdShJHaF1t+v8AZhdqkQMdpyt2iZ9fZ1WM/Ttmi049Gqg6zB4e8K2P4chSp6oy5zaHIJ+U/wCYPqwGChxFKNanV8yLwKUMrC9zB9EzNR+yIRfWgL+XcB+8Ir9BEVbkbyMX4CSpQ2bgwXqg7HQKhZ2rs4PZChJxoYmqwgmv+XIGox2X59oi8hKpMCa9/TdHH9OUcdpKdDp7Zq8I7H/RA98HPlkI77jL+95oXUZajW4p6T2aP/LlpLodMnSE9maKk2KPT4y9O2iLs64qGKhirhVIybU4ai6FjP3hCP8AGl/Jn5T/AJg+mQpcLvL89zN1bppVhilw/CFGC98QjetsK+XcB+0sLCwtwkZpNSScSR2B4qCGFOJUg0Ho1JfZD01yQxwsvLYd3rKWR1GSHCSaQRhDhkb9ShOU9T7d6cRIpVxVlY0d317RQ2ih2STeu/bS4uQ7afK5GCHY/wCihwrpuYzMEorZkMiCeSuz6sa3wX17XIvRT0QeK1Vl4LqEpanJj6m+Fo48dt6Qb6tWmHHhgQOxBCTWpbiUI92QjfHl/Jq8p3x1dIghJqVimFCUZrcslpRuKUZ+ZnqfuPvwJEMv5Gwr5dwH7Mg3TZbjZUmYJEJ6OZp4kqNClpJSQ06bS1pYkMOt7NfFsIO7SSjLuUEy7nCBxoZE8hCNSFPfjNm4lG3QnBsV1eFFd89OyX1e+lRrbsSpH2ikA+0cwVaqSJ7WnZH6PcXCisoISpxe6qkN2VIOxpEY6OrGq3FxUah3Av6gCu0hpJtebVx2jLPs/owhtQyHK3IEWRohwN38cOEyoSHmiIJSa1LUlCPeEI3x5XyivKd8dXCskEXAQosfORLf0e8S8A56tL9e3XSIfxGwr5dwH7Ig0m7lcfejrObLNTdTn3NdJcVIjOR3jLhSo0GtJGQadU0rwONuNG3xJUaTNSLoQTqziqIKbNAdZQTOtxBTtKjfTtIq1Hc8tOyJf3+lRoD06of0pKH9JygrslJUHuyjzMcdkvo+i+yLil/0e4InZVyLOvp2xLx09dpn3Haov7PIF4nIKsqaKqnOj6XK8c42aXqUJUmntx0KQklrzPhSlSzSko4dfMiBEZmaiaT70hG+YlfJq8qhykq6RBhvudKfRtAr4P8AqMrAzuZnwX94kQiu4gK+A4D9kQaOztfMlq7KsMuULYxFCT2VpxMNT1T3X2lNOnwpUaTWktErNIQ4kOItxlcj7y4DfWFOGsKtwUJGdeI9O0p/2ThctOx5ePil/Tx2YlxmKW2+09xGoiHa4yU3EOx/cdqfo+YbFHXlRg8naMY6IQybG1UNqoKWpSeJKTUe0JpKnTuPMX2SdLCwsLe5IRfmZXyavKp/Nq6JCEyT82ar+QklaU8WCSuFnwEQP3qRT/ipMOuJRGWYP2aRUFEdC7Hup3VUX3IrMKYchus0WmxKRDW9ON+O6woy4UqxC0W1QuwcRjrYWFhgMBiMRgMdaA+zHrO+KcN8U4V6dHlNukMQSR2blRYjW+KcQ31TBvmmDfNMG+KYN8UwS6xT1Qg08tpvs9VGGWt80wb5pg3zTRvmmjfFNFerDC4z76nzY+HvenW3zTRXqjBk0cNemhymU0vaoBNqMVCG9Fk2FhYYjEYjHhysXlr8JOpJCKdJcj7jSqM/TJTANIt7hheLz7qXKeryqfzZ9FIoTRHIkeKRNfxNfikHyJarg9S8jPo2TsvZpED4hCZOckgz9oRjlMpVImNUlBPxp8eRFmQZEGpR5L/aOKqbEw2cN5lTSjLhQvELTjrkdjK2hEE5MAzkpaTJWat0Tlg6LOG55w3POs9TZjaFJFgnwqbbkOpTEqJjuE9RHSZxgqPNC6TLQhHgXkZq7jPHcpw7lOHcqgO5VEFT6gYKjzhKgyIyY5OqPu1QBQ547lPHc547pPDsCesbsqAQhxgkJddHdZxh2DPWHWXWVs+lDhoJqpPkVNkG4x2jecdqTjLzYZiSHklTpgTTJpjdE0bomkDpVQMSYzsdfEVmy8zBEI8KRJTGgRmaecskDvOLzdRWQlJiy4qk2FvbkGJrjLBip/Nn0UiilhBW9YOrNxxB/wAy3L6GCK+l/fJFO5ukJEMmqSftUqMjWZVRDNTKlsEaJkN6K7SpNMqcdwVeku1Wcs44kMKYeMuFKrBSMT1IhTkl3hx96UaHJdScp9IaiJzWNq4No4M3AaFvxKnS5ENRkDjupKHLksjNYzWM3BtXAhxShUqe4y7HTeaazGShkoZKGShmobRwdpHD7t2cuVUyWNosbRYzUM1DNYzWK39T7POK75msZrHab6nHFxEa2z70tmDD261S605MVOoqVt03JQyWM3BtHBtXB2nSZuOc1cHlqQQkzNpKadTnJJID0oG8u7byrQqjsA4mBMORQzD0V5g8RiLAy9kQREJyjGKp84roEEiEWFEWYk/F2VmwZjzP2tumkUz4omGRdnj9sRjFqpuNVaRCW+0y+1MZOnz6XVkyRL7PsyVpl7yecaW25iCbUZGky1QorLQaD0IU1hT0KIXd51PhkwfDcVpz/HKulVR2yCpEVJQ+BCsFVJ9R0mHfevH2nP8Ah7NK/wAjxXHaL6l2f5TNO0/zF1EM3Awp/a1WXmEJJJqQ1KjNoQ03w9ovFTD5loRGo1WaToQIhRou0kVF/aPqylS3Oz8pLlV7vGpDSgSgmQsMzVJCJraicpsKSTdJaZkPURsykQJLAMvYkI9ldnBVvnFcNr6kEhnlRl83HCLavH/GfIH5loZe0pdIVUkLTivopFM+MH3luJ4m0G4uVGVFkddKjSqP3WeqmVKa/UnGG3mpzDlLfpdS2sSp0+HCgNSu+NNw1baTPUl5L6Zrbja2l6NrC0GgwkhGWoqV2fYJWtZmPsS01OWYpkuQ/O0ravGlBOzFIQoyJKRUX1R4BVV8wmoSFK0qh/4jM2pCatKyTU5AhPLfjaSKlIRJ3pJFQlPySp7zjEgqnKG9ZRF56OmaYyqpIG8ZImvOSJdDV/kdO0qP4tIsg4y9pktCjzgqzpwT6lz5ZKOoSxvKWFVaaQk1GW+j7CxmcaMZrdJKXdCDTanHF40+nPK8Da3Ikily3pkRw4koTkx254dgSGY1wlxaQmUoicqDyiZn2DVQFUacKYfsCDTqksiq/OK6BBIbP/CrWRBT3904ozUZXB+ZaH5ezQ6tvppFM+KF9AzNR+wSs0q2hToFHd7lOvHnFLiSIUmnze8o7QkRwcpc5NIJMSHUrHVKuRFPPRpxTLuyQ+2tGCkhhakrpdio+k6lNTXy7NskIVJRBkAzJJVh5Lk+mltKvpWlWgmZEcPxTdKydqQ4oEdyQoUj6ZpUPqIdPkyfiIxcJ5oD/wAovzuDVd2hn/k9O0RXpJ6XCD8TfrpJ3pgvzdojD0g+zzA/p5gVamop7HPWHEU4uW4hp3QgQo0XFMt/burVkt4Q653eJmvMkKulVwqZIcj0zuW2nbBqWbpiO05MkzKPKhpakuNGopFWpZkD9gj0Cq/Oq6JCN46C/cY/zL0V6k+YM+PYODurwOM+QMjL2qRTPjGF+6JVjzOpw4j5UULJFSp0phcCZUKkuox4bBU1E6obV9qKckpsgpMnRKTUFGUI32DcbWhTSmj8TCNnS+KtSnm3HHDvQCyqukqIxMQfZ6mmbNDp7DulcP8AxKyBLsW1FFO9HH3qS7VDaBSsgk8RtQly5sneOHvl1P3PagvVSDxqGldLKiHqn1I9VEVeNw15raUgwYiMKcVJlbHQysYIRI5yJdScNtLygfla4NogSSIR32mlytj3oeKyuao/Z6GqnRpTdOqdVqrc2GR2OlzHH0zI3dZB+wT6RVvnldEhR1kqnveR+pw7aK9RdHIEsyBPuECkmY2MZYOmpWHYchgrC3sE+dM+KYX7sjG1jTG01ZdME6bvCU2kozVXmmcyIw0tmTI27h6pWpAyMxJkGakEl1Edgzfk+F24W6ltve8Eb2hBp5DzVw60zITNxRK7Nl/PcXGQuMhkLiun/jl60flR7i/Oo/O8DfnHV/a5B1V2T0T6oB2lr5OXFV8VIPUvMhRT/luLh2SwwN4wgdVgEJdRgvwS5klBGt93YlYIPFch3bvghQ2uc5y8k1XPmYSVxsHTUtC214EYJNjUfh78koV+UWq1NBONOMOUSlRZFMqkViJUKC2e0mO7aafsE6VX55XSojuMyUk2wfoMJuFFzsL9HmEq5hK1EaXecWV4XIMCSJVLfjlYW6HmFoNtfAkUz4xhXTLn7AgmMlmO207VahhHhNuV6dtFNFJbjyFxjkRf4zLiQZpOiNbepOKydFVXjTTUaV7QQSwp4vYSjyPs8m0XR6ox2Ht8RhHqDEly4uK8r+2XrS+VKBedQ+c4EBj5UH5aF5xuTjvxhN8UDguKQ7abfSvcou3G0SYO9iKyDIHpbUhS1mmbUsdsplKghgiEemrz/sIjiKpBlJcpEV9MinSo+mCTBIIipL0aLVK7UIb1HjzJURRqceeg/wBrQj9iWlW+eV0or2wlzrG47fAJ81Az6NwSgfMEZloSglVlNrJYalrbD0CNNS/FdjrNItx2PHgSKX8YH1CbNTXWgfUHXnXHXEsRWJMtUgo1LdkxoZ/3ElRy1R1uw5Zx25ijLW2iPPs2mztxcOIbdR3CCY3fABEREH14RJB+KiJxpmlUctU9qYonik6V5XNXnpTvpoLznfOcCPOP8rosrL0jnZSlZHps2RsmBs2RsWBXWkJFOPF/y0cbaeQdOgAqfAIFDgEO7QhW4zCIZ6I81FY9CEeqxHGlw47yTkQIrE2rOPhazUdwzIdYUxW1kCRS6iH6G4kLYfbWaBgobNOKWzUKr/b0swwx3hWPBs/4epVvqB8GbfG2feKeoLTYyMH5n0+YsZnipIuYbURjmQZduTCsXD2UhudTlRzNIMumkUv4wPqIWpCnDQfS9fA04bT0hpp+mM/xOxGENGuVIW+4kpkKG6iIhbb9QeWhcd2qoJNQPRRaJFDTsqOTyDe4SIVKpRVNPeunpwpoLzqB5zMrDs/z0uK8f9yrz0hfTx95vznA36o3yWknlK0QdgitxCbYfRIY4Liv/KsO4I37AUZGSk8F7CqfyUewMXDZpUbjSmli4yCHVtqvzuL63BGIFSebfqaFLS8jFelPayl1x7KUfCjEKUaumQIVb58+nT39m86kkuK9Ivz6RGLgjGQxuPIJdMFzCFXSw/Y23LnPpuBLSDLpJFK+OD6zsUkRRT2osh6RQVkb1LkMp4cUuN6tPuMr3lODshx5dw26tpc5K5TUGaxGjvr7xMqyv8gYbYNZOqSaiCTEVBFTHHGI4OoxSLekUb1iDesUb3iCp1Y1N5XB+bVQiJYOqRQVXiEp9V1n50aYxGZ3rFG9IoqkhMiUr1aR6pFRF3tFG9YglmSpPA162KlGRG3rFG9ookKJcrQj8J+qm1GOxT96xBvWIN6xBvSIDqcUVObGkQSPl5CPVoyYu9olyqkMbyiAqhFMWS6lxjOORZGrVKkSW1oU2rS4vxqbWgMEiRRX7G2QSV1Ulv8AlmubWcVzMmDC2sdCQo09QgQq31A+olW3YV5qIH5/bpFpcXFyUkNH4drY0vEZtLJZNu3OowMQpIMuikUr44PqpSajjvqjqkxtmkUuq7Qqk27d9oj4UmaTUknE8cWSbCtlSQT0WGgz50+Cuc7VpLBIBBJimzSZOa1snbmDuOep8xYGXKMu6TMxzCy5n5tqxXzGRhfNKvVo38PmLmHvXwNfFud8jF+BHMsE3Fxz0IXMPLu4krns08BGLmIu0NyrT8G1JRFYPUlGk4bMKpQZUV2I/wBBltDaFvG65R5Ljrb7WDimHEhhpWUe8Omeo2IxGsqPIvUm2WHI7C5Dsp9sm+oQIVb6ieljPpMPbJx5BYqMGC6l9LhJkLBKgaScBGpBoW4wppzapZUpYqELYLWkGXQSKX8frNL2TshpLqI0k2DkR9npTaimQibHSwp1JHwpUaFLSS08dxcNNG84/U0sxL6kE3UUGSUplxCUKPEWSOQ5DkFWte4QrBa8TLkDsZH5hsyU3YhyH3toyLJFiD9riwtozba2Icgs7N6s2x5DkPCPCLJHhBqQhARa3Ich4RdI5BOI2iIkFlO0J15bzvBHkORX5dQbnsqI0nxNtpQlx1TqxCkKjyS3fNDlNXmvd9PfnynJUpCMCjpUp2o1PuzbTS5LzzrbLSoykxOibLfcuCrfUT1vfpR3uTiLaW6ZA+AjCTubXqeI7oVmRSDQ4RhxtD7MlhTLyi6BCl/HB9Zh5TK32UqTGk7E5LGyFxHlbZLreJrb4ULNCloJSehtDJPDcGDLgt0bCwxGIIhYYjEWGA2Y2YwGIwGOttbC3X8wkGd+hfiaYxZdcU6rQjGQObJNg1rWaPCGG1POSH005ltl2S8+4iK1HYQlMmQuS71qv9RPrMukonE4q65DEc0myu45KTGdxU9moQ5ZbMnCIVSLtmFkD4yFL+P7Bl9TKnMDVGf2QfhqQrZvJPOYP5hiseXAhZoNaCtwIRmDNq+TYybGTYu2LoGTY2jYzbBLbBraG0ZGTQI2gSmRtGBmyM2BtY42rA2rA2scE5GG1iDbxAUmGO8wht4YKTCId9gjvkEd5gjvcAFMgDvtOsc2nhU2AYOVCByYQN+ENrFG2ijbxBtoY7xDId4iGNpFG0jDNgbRkbRkZNDJoZNDJoZNDJoZNDJoZNDJoZoG1bG0aGTYu2LtjJsZNjJu60Gg+BkkJN+St/jQWIbQa1LkJprCEuvvOPpiNx2UGmTIU+516v8AUj65OEoKTb2NrgvCpLoINq8CVc0qWhTK9o1PjbCSogfEQpXzH2P2N2CZQ84gLceI9s6M1jJQtkngQs0GtBW1cO3DboW05iwsD0IWFtMhfQtDPW4yGQzF9DUL620vpbQz0sLaW056WPW+lgfLQiFgfA3zLVCSIlKNSuJJkQSpN+9IYbQlyQ6t5uO2w00oSJCn1ewq/wBTPiS0tSDLoocMgaSPrpMEF+STsLglHZpxV2TNQinYVRnaQ1g9Tx1IUr5j7H7O/IEhSi2SwSVXU2ZjZLGCxbRCzQa2+WjvrHZq39QtyKk/W6I2yz2xeqPaRsdmY6XqxVlFVezka39Bju8gUqqS6ertBV5UOodmqlIXMm1GROqlRjx5curKJXauoyq81UZL7kmWOzqWFdnVRm4XZOof/Fvf/BdoPpUCqyaYmuViVAV2bqL6J1fqUmRLnzZ0KB2ijMNyu1/1uOyuTKf2ExHZx1BriR9w0ygqkN9nKlUK0cLbTo/ZrtEhK6UYjSnYcqPWZjnZajTHah2rkzu0TUrs9FjvPK7TLkMUdlx/svBhyYnZalsMSeyLzS2OxUqSdBpleQ1IpPaQ/wDHwGESqlLrDsKtyaVD/rN2vyWqrRqgzHr0Knpoa1maliEtNK7LyVprHZaql/8AkZvLsLQ6vLkU5+qSZVQo9QqEtNSlFNqYa89EoIiUo1nzFjGzWMFjZrGzWNm4CYeHdZATDlKW66hlsX9j9qv9T4SFOrCYdLUdz6JGZDK/XIx9gQb8iT/KyvFxtfgbc2xSGjaePiIUr44P3zSzQcinuNRQ76x2cWSe0MWqqer/AGcZOJ2ndpVccFEfap9AiVKPU6TSmu+dkZlDkQYv9QVgiQ6t2odqXEqrnZqCtuXNprkOodoZ7zNYqK219palDqr9SlMqjSriG9s+x0Sa5LorSGqv2aqpsQeztSp6qnTZ9Pdp7nadaFr7OQV99r0BbMmr1SVCpzsp+VMr1LcqVSo9NTD7RQq/FdrdQPu1d7WyTcmUInHOzdRptUbhyai9C7Odo9nMauLCGpsuw/Zs0o7QSoVYek0CTHiy/wCnmYzNIdNnspT5a3uzSpWw7H1qXGl9mH2mq9Sa+thmlVSnqqUDuq6LUpdManVd2sRldsY8Z+NWqo+iTV+0cpa6NfSnIZqvZuopZo3ZpKGq12drS2ItCo1LciQDpSmKtVIMiS1LjKhyrBrzsGqc8qEtRqPoJcUlCJLrYN90/a1f6lxX61xy6paEEWxysZKyKOuwYUnaVlvGSriIUr5j7db7ewpk9Epqp004quTwPkehC/HbS/GehAwRaGXFa4xBFbUyGItqYsLamLAi0uD1IXF+C4fq02TBBaGLAgXM1WZFKpm3FVqKWEfgKv8AU/cX6JFcEkiFtErxCvS2fjT5NLsKpZ6mnx0r5j7H79JmR0+ciczUqacM+TpbMhsyGBDAhsyGzIbMhsyGzIbJI2SRsiGzIbNI2RDZENkQ2KRsUjYpGwSO7pHd0juyB3ZA7qgx3JI7gkdwSN3kYKmkCpxBNNzG6HFGdHdI1UpSQVOIbuSN3JHcEg6em27iG7h3AgcNNu6oHdEjuaB3RIOIQOKRA2CItiQ2JDZENkQ2RDZENkkbIhsiGyIbIhsiGzIbMhsiGzIZE0VNphyhUp6Yjajufv8A7Vf6n+BTqZW0SZg7kaFXbQvIlFtKErjjvrjvSI7clk/wDTqmnFVha0Ktf3txcXFwhxTa3HVvOXFxcX1uL+6Ib2lE246t1z35BmO3EaedW89wW5e+SYX5BBWdUnIkOESWCxXEVmwZ8CjJStCDMhyO9IYbksn+PJIJkzBtGDTb/wAqQYZbiNPPuSHj/B30M7j7pMX0Zuaaf8c+gYjyHIz01lhyP+NQm4JOIZgynSegSmyMgorcFhYW1sLC3DYWFuGwsLCwsLcFhYY/kSERthmO++4+6D6hmZn7pJ+NXpIJcLYU4/5j6Bgh/wAB+MINlYqdBSSNKhAQ82sgekKGqZIOn0lo6hTUxExKZDdgHAo4ejRyqTtKprIepLCo9MgxZaHmTafKmMIpVPpkeRC7hRxKZiomOUqmtE5SIrrSkqSoEQp9L72RUumOqkxTiyZlIjtRKbDZmLjxWnatUYjcWTiIESA7HXSae23LajNyZNHjojUyCzMDMNl2rrplLaVKjUtEX8aQP6Gf4YtS81nzuG+ZweRdD7EP+A/GJBHzTyToYlpJEs9KVKRHlTKWmSuUxJjrgo2tD3EoIRsapVIjswojJ0+FSHrVKptpKrVlwm4dKTlSjoSrG3sZ9SiuS2KfDVBakKJySCMRFGXZ6GsynVz4ilklyBE7tOiJ/wD0NZ+cMwRieX+CJPjW8TbsFnu8yH/9FOphzH59NOEj8aQV9DP2ZNrUnZuA0mn2VtCSL8yMMhLmzg9Eh/1/8YkEXKO6T0fR1aWmnfEo9KdB76O5VKO7V/pkQlHQTiVQIbeZqVXfeYExCZ1JYc2Ul1snpdWf2k6l3Oj9zqo2DzEuruuMRlmmo0dR8wQp+D1FiU6V36srQp+srNtlh1D7MQ//ANDVI0h+Uuny0Nsw5D6JbLq6Q607HdrazQlhSXmonLtFU2Zjsx6JPJo/xpBX0I/YpQpZoipSS3chmY8wsi9jcFzNR8tG/CmYeFO6B+RD/r/WWjD3xBpZWjTHIimqhFcJ2oxWhNnuSgtWrbi2llW5pE/KdkLaqstlnfE4LlPOyZE56UGKlJitrWa1t1Wa02pRqXHqUmMzvmaH5jsh6TUZEptifIik44p13RiS9HWdZmKSbijVKqEiUiPUZUVtEt5uVveaHarKdZYqMmK3vmcJEl6S6/OkSkx6nKjNJmOtyt8Tg7VJbzP40gr6CYLrkGW9hDUrAkKMyUi53Vp5+xToRAi8SOZVFzJzofYh/wBf/GkYQ6Erast1uyl3B+3v+cIK+hmC8utBik+qStSzMkmQcVZOifV17AvL72BebHm6vaO9A/Ih/wBf/QyvoYLy60Q7QFOGoidZMOPESVKNSi0T5+xLz8tFq2cfon5EP+A/QyvoYLy6zUjZxlKNQIK4LW65C4+wuEFdT683OifkQ/4D9DK+hgvLrkaXAacT5iwsZjyL2aS5qXg30j8iH/X/ANDK+hGC8vYZ3F0i6Rf2qOSVKyV0j8h/1/8AQyvoJgvL8ORXNxeXUP0j/r/6GV9BMF5fhiCj6p+Q/wCv/oUgr6CC8vwpA1dY/SP+v/oUgr6CYL0/hb9dXoBf/P8A6GV9DDfw+JlpTzs+EqDK/BW6JBzyH/X/ANCkD+hhr4XG44pxzrKQtHskNKWCZYHdkqSpCknbjQXNXqIf9f8A0KQV9CCTsFJK3tTUpXsS5FtlLCjMkpVckPLxmsE0/wASeTen/AfoUgr6Dp/te7ONB3L0jPRDhkOZGRqJzaNmh9k2H+G/8YIf8B+hSB/QtP8Ab93c7dO9tG3cQbzNkLJQqJ3ncJ+kR4zkl2Y+yln9DRHmXI8iO5HdH+3+LTcjfd2zvD/ojx3JLsiQhlk/0RHkNyGX2HI7v+j8kzHckKffbZZUYP8ARMd5uS0+w5HPpkdvw76zjwjMH+i2195pv5Kb8Nfmf6KIQ/kuohSm1nzPp2P3Mz0L8/0XD+S9jjy6NiUFNmn20z0Oef6LhfJdciHJPTLyJZkbiLe1mehfn+i4fyXWJAM+lbg5YrRgfs5nw1+f6HQUfuuhCH8l1EoUoKShojO+r5wu69Rwsk+zmfCX+iyEP5Po2Fg3GMycdIuitJJV0XCIleymfCV+iyEL5PoEQbaW6vYswyefW8fWtwuerpNrwVxzfhK/RkL5PjIUWlFVJFWlU6EhazUrqEm4xIG+vLarMZuDJwU9tEl2RFciuO+XspvwVfoyF8l0ErUkX6pFc+BGiHFNrYWxU4FTpHd4/spvwlfoshC+R9snivpQH0oW62h5mr01MJXsZ3wlfoyF8l1r9BPlrbRGkZ82JKVktp1hqS1LaSzM9hP+Ef6MhfJ+2T6dSPQjsG0NuJ7qsjpUhXdvIVqG41K9hP8AhH+jIPyfUMrdGLBflrlbNl/amNofCkrIIzIykyLQ6pO7xX/kPYT/AIR/oshC+T4OVusRCmUlxx19bMCDe+iuEi/x4IRPna98j7Cf8I/0WQhfJ+zplPcmO3HaJzxWHlxJUrZg7kInz9bK8IyB8Vix6E/4Z/oyF8nxcsepRGyRSlKsU15UiadwvTFXAn0gjUsRm/7yWltbL1JzJxtba+tUPhn+jIXyfBidutvTudOVUJhq2/MlbVWqk3BlbRHpDJ86ShHd5XwkKxUuJHnR5kRcORwJIjUoiJQMrHw1D0H+jIPyfsokB2UdSQlqV9xGLhtcFGcWrZuNaMc10g/4JPw0+bArv1Pq1D0H+jIPynHbpUuGT7y13FWK04uYLyQrHVCrlcGtRg1KtUdGOTxSXmRCcW7AJIbcwVWSvU7CwsLDHwiwtxVD0n+jIPymtgZWMEXTYRs4QrJf31rmk/CfPVsH5iwqvgG0CV2BqWocyOnbR6ATZCowZLsk+MlKTxVH0n+jIPynFbpQkJcnGoklchUFqXPSsmzT5fbRvz0+1X0T6x96YX+LH+kyFhYW1sEoRhbgsKj6f0WQg/KakXNVshbWwaZW86dImkN2yw/HcjaWEH6goFcxN+ecLwJ9KUqWZJUoYHZv1AuelXR/EG/UPvTD/wAaCFYjpUyaRYWFhbW2ltaj6f0ZB+V0ItbCwsLCnU1U0RojUNtZqMSHEsMynFumlZpDTuaoNPdS7iLEQnWKoOK/hZRtDuSGyOyA16zIIPSsJvTQ15gxQ5CtoQ8hUKhBcgbdkbVkYHjiLCwsLDGwtpYVLy/RkH5awsLCwsLCwsIsV2W8zHbiRVeR+VWdxYc5oEA0FURIfajokVdag4pS3DK6YSOalXPRs7LUP90SXFvUINaWsKQvCoO191Lj06RJ4KNPbaJ2kXcMhYWFhYWFtKl5H+ikaU8v7ewsLCwsMRiMRBXFp0E+0sYH2jiBFciOLqjqXZSvSfmwX9wK28gwYV5rPwsrMm8tUeoKL+Qg5b+ngj1hR+O9tbguehClS1yoM+CjA0iwsLCwsLCpg/0UkvCQp/wMRYWEeOqQ+dGsDpthJQiKHJDpgzMzB8hcJOygrzYP+daiShalLUo7BQX5NegfYN+og4mywx8sEnZVwo/FflqlWOlxTVutvN1JpBOPRX3TIWFhYWGIqZAwf6JT6SFP+CRAkiPF28hKEMNrO52FXcJdRBrUZGZYa5ctI021GCiuG2HXg5GRlslNFpYJ9RGL6J9OiTB8UNZpkHKeMXPShpS4T8ZTKsRiMRiMRVC5mD/RKfIU0v48Q22pbrTDLBKB+YkLN2Uo7Em5hwsGdftoheJtoU8pTMeIl6Q46R8ysshkoZmNoWhA/JPkD9QIX4DLSP8AMOfF07P+biScQpvFRIDUaMtDkFsydiutCplzMgfl+hyCfIiFPQomiIRGkx2pvaFKDPtFMB1+UN/OKZJXI+ZoUSSkLI08JJNRtUpBR1yzJszB6cwZ2Bq1IGYLzBoUZ7JZjYuBSVIPX/SI/wAyv4pHzPG9A0kps8EmaTJVyFSp5yELTY1EDL9DkQT5ISalNR8Yst9MByVIlS12MeYUZaEG0Goz5G75giK2sROcojNIbmvtmp9h08ELDidkDcPhuE4AsdLgjMXUPGGIjL6Hoj8fgb+M+Xi0pTjiKiH0EpAIMHzH2qlNMzUQMgZfoUiCSCRTIqSbLzrS71AcyDt8dWnMR9nDurhhHaQD8ha4P1cdwSzGadSK4JhwyZeRGW87FkuaEdlLuplK/FcUz6noppKxszIITZY+yrGg6M4pZdn5ChUKVIgjEW/QRCHSZkxhPZtxKNzkSiKxJFScS5U1KsE3xe9epHyB8zBNrMGgy1hptTAryCSB+rpZKDbvPvTmKlKVoz8dxGDuiPhWs4IDqGp7UuNIVpJnRYg3+m/9Qgu0ZiDOROj4kWiPGK5SCZI/0CSblS6BtE7U0gzUC08kuK2r33Dpkay1T6TCCIwnAgbnM1XPRH8dAC/NJc+qn1aEEcnaujGVo38NZ/zGZBSjs04aTZq0xoTKvKfVlwMSXY7sCotzEAjsJLSZkSbAfhP4i3/vrCnxFzJaiQ0wY56JISnNlCCyUpX3P1akfLz1UfPWX/HECr35ESzIi08i6ReX3vcEdjkqJ+m6ZmTRWM7FoZczO2t7BLnNKSNKTYIif2a6VOkvVPSrx1TIShYW96dv/AW/AIRkdJp70Jwz0sJ1XJsLnS1Jz5glmLlf78BedxfSwtpKcNSrmFeYe8wQPhsLa/6Qj0GEX0Qoji6F6VFzIxkDNIXwp8k3uKU5s6qtSUCZW4sU/wCoZpmp3NbOyNUmAhqPikeEeAZJGSRmkZpG0SNokbRIcZLGw5CwtpYWFhYWFhYh4RyFiHhBGgjNxoGaDNJoIzW0YyaF2x/GP4x/GLtg8LWSLJFkjwjwjwjwDwjwiyRZIskeAWSPAPAPAPAPALIFkDwDwDwCyR4R4RZIskWSPCLJHgHgHgHgHgHhHgHhHhHhHhFiFiFiHgHgHgH8Yu2LthLjaQt5tZXQPAPCPCPCPCLJHhFhYWFiFiFh4RYWFhgltOaRtEjaJGSRdIySM0jJIPExZIJjNN0CnvxWpiKpAcXpNkd3hhxVi8JBiLtCfVFSRrUepJuDQLGCsOWhECQHIb7bZNkFnkozsPM0quHPMFwEVxiCJF1GkHwN+Qy8NxcWDVI71EchyGEKB+fMWFhbgR56EpSF1CouTTuCWCsLimzNk7NpdgZdFJmRqauMRbSwxGIxGIxGIxGIsLDEWFhYWFhYWFhYWFhiLCwxGIxGIxGIsMRiMRiMRiMRiMRiMRiMBgMRiMRiMRiMRiMRiMRiMRiMRiMRiMRiMRiMRiMRYWFhYWFhYWFhYWFhiMRiLCwsLBRc8TGJjEwgsOhYWFjCIjbCH5O1SfmMhTqg8xKuK2/dw/JCSWavV5Gr06IMhkQNY8+CJTpMkRqYzFVUZS5UgcxYxYHYgrmfCRmXCfnoR2PMxkWlwmxinzO6SVkS259MXFIGMhloepeYuL8z8y0IzI2ruqxQg2Ki7GJ41vo2Tg2Tg2SxsljYuDYODYOju7o2DoJpwhslmO7Ojurw7o+ChSQVPlGN2yxu6WN2yxu2WN2yxu2WN2yxu6WN2yxuyWN2yxu2WN2SxuyWN2Sxu2WN2yhuyUN2SxuyUN2Shu2UN2yxuyUN2Shu2UN2SxuuWN1TBumYN1TBuqYN0zBumYN0TRueYN0TBueYNzzBuiaN0TQVHmgqNMG5ZQ3JMG5Zg3LMB0WYDpEwbomDc00bmnDcs0bmmDdMwbomjc80bmmDc80bnmjdE0bqmDdUwbrmDdksbtljdksbsljdkobslDdssbuljdssbsljdcsbsljdssbsljdkwbtmDdswbtmDdkwbtljdssbuljuEodwlDuEodxkjuj47q8O6vjuj47u8O7uju7o2Lg2Lg2TgJtYJtQRIOG466286lClBaySD8ShcyBVGaHJCnXDV4W+SNF6l5qI8NSIQoDsx0Vl1SYZ6GoZmM1dU+K5kCO+hHziTzfZLmVWhRc+QuL8V+XEj1i4d5xeO45i4NR634bi+lxYZC4vrcXF9SMxkY5meeAyFxcXFxkYyGQyMZGMjFzGRg14M5jIZjIxkMxtDGahmY2hjaGNoYzMZmMhkCXkwawajGRjIxmYzMZGMjGQyMZDIXGVyO5HcZGMhfS4uMj1uMtLi4vpcX4SUOQ59G4dUD0P1FpYwlI8IPAZFa/ML9WjXmp01a3EMmFuxHYhsuOIaRUZxPr0UZdMuolRGOQhzu6Lfqst4EeThkZHxpPnxEfM1kMyG18JHcG04QNKi1IrjAcxZQxMYmMVDBQxUMVDFQxUMVDBQwUNmdrKGKhioYqGChs1jBQwUMFDBQwUMFDBQJCjM72xUMVDFQxUMVDFQxUMVDFQxUMVDBY2awlBmtwnHHMViyhioYqFlDBYwWMFjFYxWMVCyhioYrGKhisIzSs0LJWCxgsYqGKxioYqGKhioYqFlDFQsoWUEkZg21EeChioYLGzWNmsYqGKhgoYqGKhioYqFjMGhRHioYqGKhioYqGKhioYqGKhiYsoWBoGJjExiYxMWMWMYmHz/ALg/O/I9LjMGpIM+WpKB+elz4WS/jJRpNc59xCltKGKbKVfq36ifToQkfE4MTGChsnBsHQceQNg6SRiYxGIxIYkCSLFoYuQbfJBd6SG5cXYlGS8108bDK3WSkKVfqkCBJwj+yVZbIPqkrkpvEW6nkORi1upcchbgyBkZnzIZ8hc+hsnLriyG04mMRjwlyiAzBBXp9yn0j7hXibGBjAtSGVj5jbOjbugnEGO6091CoD4UhaFElIxQCSgbMbMw4fjI7AlAuYsIEpUN2RTWZokxDjP4IFkixCyRYhYhZIxIeAgZJFkixCyR4RyFiFkiyRZIskeEWSLJBJQRnZRmSRZIsQsQskWSLJFkiyR4R4RZAsgYpBJIzfUg1eAeEchZAskWSLJFkjwDwiyRZIsgeEeEeEWSLJEck5qQSVWSPCPCLJFkixCyRZIskWSLJFkiyR4QhSCBoTYySLJFkiyRZIskWSLJFkiyRZIskWSCsQMmzFiFiFiFiFiFiFkiyR4RZI8I5DFtJqzTwWFhs8hsrA0DEW4E0h8g2mmRw9UXXSNalBTYsZaWGIsYLzdOyh9wry9ynyFxcW08Q8QzCVjIXF9SI1DJoiN5ZhSTOLrcwpaiTrewuCFDkWOTHbktPNqZe4LGMiIX6F+OxIBmZncX6pBiyEnxXF+C4uLi/BcEYkHkXUvqlZpNSSt1iMYGZ4OX2bgPl0H/AFktSQlROLNabmswSnBdWhmY2gI7lzFhYQm/5VyHFvZtqBkseLTPkayGRC5jnpkoZkL6L8vdcxYWMcx4gSVA0mYwUMVacxkohtVhEhSQpSl6xyyp2mChZJB00mfAk7aIWZKKupKM9Ldmo0JJqFySDMzPrEVzuTIPpX43/Ai/sr6M+NrW/HfiQs0KUklJ6hCFBemKmbCmMd5kpHe5YU8alEoj43/jBBXFglRpMnEKB5EMz05aMR35C93MMA3W0EpxxQUggfIJdWknHFGeStU8NhYXMGd+r5jANxWZVLfivR1cGCgSUkMWhZkWZGEcy2CMe7uA0qTx+EZal6hbSAq0raOENq4MxkXCWiD8RqOwp3qSblzcxG1cG1cBrUYyUMlDJQyUM1DNQzUMlDJQyUMlDIwS1BKnDM3TIts4NosZKGShkoZGMlDJQyUMlDJQyUM1DNQzUM1DaLDBrU4brhq2ixmsZrG0WM1jaLG0WNosbRwbVwbZwbVwbRwZrGahmoZqGahkoJcWQQ84SpBml03Fg1rGaxmsZGMjGRjNQyMZGMlC5i5jJQzUM1jaLBmpac1jNYzUM1DNQzUMjGShkYyUCUoQij3k1eO1GWtTi1HYr6IUaF7Z0G66YzWM1jaLBOKyUd1jyQv1o4orKVBypPuIuhYV4R4dLA9mFcNxcX08xioYDZpGzGAwGIxFjLjIJ5my02y2oiUmXSkJatcYpF7C/CV9Ei/O7Kh3dlYOE/Zxl5ojULnw/dJ3ChcEsyWqynNspIN01gySo9iZkpOJ8CfVpSy/uVOZF7Ak3F+WlhYWFhYWFhYWFhiLC2lhiLbKJ7a+0j2GIsLCwsLCwsQsLCwtwko0nyX01/BuDVYjO/Ag+QIjM9m4Nk4NmZCxloZ3B+SQfnpcR2FSXpJkkgvyQ6pBbVrA3DMXMwXCTThkTDg9J4ER3IhkYuOetxcX0uLEYNHCQp6EIZVUY7Ydqjyw4646YsOYyMZDItMR5cNlGLLJO90IhzVm6Wp6pPmZi4JYJZGLEobMySS0pDjynCV0Kc5jN+2l+qSeSl34bi4uLi4uLi4uLjIXFwRhss1yHSW6ahkLi4uLi4uLi4uLkLi4uLi4uLi4yFwyokurLBdxcXFxcX0uL8NxfUuR/E6UozNz7rBeeWqE5HsMQlw2kqeWY8zIzIZAySYNJ6J8zLWFBdmuuvNx0mYuD58NjMIiOqR3NNjTHIEbJA1qMGpQ5mPEQyTwW6R20wBGREalHx+YxMEkuIm1GMkNhchai+5B5i9F0+58B8OajHO5Fcj8uLmYZSaHdly2Q2Jg0CyRikYpBpSLCxCxC2hEQJKQhtF3SK/sbEOQaMkJ8IMuYtpYhYhYhYhYhYhYhYhYhYhYhYhYhy4UpSZPYqSdvYWIElJnikGlDoU2khYhYWIEkhsyvskg20h5WT4VxIeWk0qS8r+MxZGhnGsWFluIBrMwQ+wg90JciUt1JpMgehmRBR3PRt7ZFntQrbJ4Li4uLgyuPIX4+YuLmOYsYsLceQvwXMZmNoNskbVA26cVLUrgJJiMwcns8ttTa+mWlxfhsOQ5a3MhmoEpwwbxED8+hbEZXPWwsLaWFhYWFhYWFhYWFiFhYO2IWIchyHIcvYW4G7GXIchyHIchyHIchyFiHLpXz6Nwfnxf6dS8+Jsv4EqUhRSMhhmSkGklKyPU9EvrSLsrLZK47kDsMhkQyIZDIXPUj4bi4uOfFyFiGFwpNuBOpBLTZIyFG506stIannx2FhYWFjFj6F+Ak3Ctm2FLNRg/Pj9Av1ri4uLi4uLhovEZ3O/tbi4uCVY3S8XsL8Hq4r8Za/6eAz4kfK6XMg+tSnOA+BLqkjaNuBWySq7QugZIGSLX4CTcYixCxa20vwW6FhmQNaj4S4CMy0izHoyq8Su8DmYJCRkm10i7YjssSXpUB+ILGMRbUlGMiBkyYJGTikGR6XFyF9DVwK8+EiuL29uZ4Me6LxM+ybeNpxxe0cHq61jMYKtgYxFhYWFhbgR8pqfnwGky9gSzF0mLdc7EMzFzPoF5cNUMjpNwS+GK93eShaHWplMQ6HWXWVJNNzMjMXGQuQz0IzIHzGzSFEkuEiucajeKtERP4mMTFjFjFjHO2JixixixixixixixixixixjExYxYxYxYxiYsYxMYmLGLGEpupd1LsYsYsYxMYmMTGJixixixjFQxMYmMTGJjFQxUMTGJjExYxiYxMYmMTFjDdyUpJ5WMYmMTGJjExiYxMYmMTGJjExiYxMYmMTGJixjExioYKGChYzLFQxUMTFjFjFjGJixjEwlGStk2ZciGR6ZAj08tCTkakkLGLHofypGRFofnweZkdnVHdZn1yMyHIwZdO4ufEfCXlwXCjM+C5hJ89Ik5yMb1YQQdlyJJaWFhYhYhYtCUZDaGQUs1cLUZ54oUSOwRLFZO7/Bf3Bcke8VzR7Yj6LHN3mk8yMjRyMjLgbaJZHgXAZi4y/t9T8+BR6/fhsQt0rmMuhfrffppVYZEL6J6Jq4m9kHHFOCmekjFXP8Ak0t7kg571HuL9Bj4p8zGRkWShc9VKsZKBqIZkMy1/wBvQgfnqXM1+rgPlxefUv8AgS4D8xfS5i5i59BHoFPUZOkfOqn/ACDy9035mdz95exr8/b3B8uJj1D7n5ap9SvMX4U+iwPQ/PVPrX6uP78B9X//xABDEQABAwICBAsFCAIBBAIDAAABAAIDERIEIRATMUEFFCAiMDJRUmFxkTOBobHhFSNAQmDB0fBTkmIkNEPxUGNwcuL/2gAIAQMBAT8B/wDy+f8A40uAQNf0vTlySWpsZcbnofoJzqJr6/iKououMOmNsGzt/hBv6BkDiOaaIyAGiuWLmsWEm1mauomyh2xRx2uLia1/CE0TsQE6HjGT9iYwNFB+IHLAqtmz8ZVVV2dFVMc+KUte6tdnggUVjgRSTsWElbMyoK4QxIe+xuwLAYqx9jjkVjJRDHUnNYEZXdqqqrXvmnAiPNbt8fBVRcmOJ2hOcQMkD0sgqEWl1BTIJo/HiOguenOrs5NVcrlcrlcrlVV6WicQMyrpH5tNB4j6hWTk9cen/wDSLJxscPT6psOJDrrgU0T1zopMPrAo8ZJFLqphQbKqYyNoWCqmAkYmzvidVmRWBMZnbrtix2q151OxPxDpXXPNVhwGMUL3y8+nN3J2LdPiNRBs3lMgEbaNThiN1PipsPipKc+nkmMxAFLh6H+UGz94en1X3zc8j7vqo3teKhU6aquVVcrlVVVelL2hX8trS40CNsfiUXF2Z5JKkc5/NYiWNNHSfEIvi/yfEK9n+T4hXM/yH4fwqs/yH1H8K5n+U+oTQHdSXP3JuJOx7TXyJXGh3T6FcZHdPoVxod13+pXGh3Xf6lcaHdd/qVxod13+pXGh3Xf6lcZHdd/qVxod13+pXGf+LvQrjP8Axd6FRG8XKR1jbimuMxq4c1YrESYiTi+H95UfB0YGdfUqPBxsNRX1KsCtQCkgZJ1wmtDRRatoFApeBbnlwf8AD6ocBf8AP4fVHgP/AOz4fVM4Eoal/wAPqtW0ihRaCLVFh44soxRWq1GMJ2DY41JPqVJwfGRlX1Khmkwcupn6vanExm+MV7UxweKhSZC5ca/4u9CuM/8AF3oVxod13oVxod13+pXGh3Xf6lcaHdd/qVxod13+pXGh3Xf6lcaHdd/qVxod0+hXGh3XehXGCeq018iEWhuT5c/crox/5fiFrI+/8Qr4+/8AEK5nf+IV0e+T4hAtcaNk+IUZc3mvQPRSYoA2szKFzusgAFTlh1OUSpHlxsYsXjdR9zF1v78VBwU1zLpusV9kQDtX2ZENi+z2I8HMK+yovFYfAxwuuaqKnJoqKmiiojkKoDjFHHq/NTxaxhbWiwuEZh22sTiGiqw0mvYHoNVFbotVqsRar2B4j3lWK1Pe2Ol2/RbobR2xVFaAoLFYRmIZa5YeDUssCe0wnWM2bx+4TXBwqFRUVFRUVFRUVFRUVFPgIp3XO2r7Ig8V9mRL7OjX2dGjwXEViOC7G3wHMLC4vXjVydZMfabXIctzg0VKdiHTmjer81G0NCaw7Shl00ziGkhYyYwNDY9pXB+BDPvZM3IBUVFRUVFTpZmmSlNml5eCA0KYc1axuDeWgXXdigxbpXW6sjRx6T/EVE4v5xFND8U9ri0R1XHJP8RUUrpOs2iCnmfHS1lUMW+vOjoFxmHvj1WRII0FYf8AMPFOwzdbrhtQTC8k3Dy0xMLS7s6WioqKioqIhY7B1Otj6ywkvGWUftCw7i5gJ5RKxE3GX2DqD4lRtsCFdA6bEdQrhHrNUWzoqq5V0FB1UXgZlA1UoeR93tTC4jnimmaSZp5jajzUcjz1wnCqxMDo5WujG9RhOORQGSA0ZJ1KIZIJwqi2ooVxWIfkHoqAUA0gAbEUFPLKwgRtr7018p2tHr9NLg2MZBNJI5w0XtrRVyqmknPppuquC/zLCezHJK4SxJjZq2dZyw7GsbamtNecmjf+AxXUK4Q6zVFs6ErEzya1kMVKurt8FqsYMyWn1H8qPEVNrgQfFA6HN3hZPFCmh2HNNoQIOY0iNzK5k1VpaaGUpvMIq6tdE0QlYWlPyACqhsTzRpVydE1xrefVMa1n5k0g7FJtUbxvV7e1a9E1FVctS5+YcrDHvqg/RM/V86lU3HvLrREVI18ho0001opXPlFseXimMEYouvmdnTzdVcGfmWD9k3kuKvE+JMjtmxYfeVHmapoWzpisZ7MrhHJzFHs6EqcUxMT/ADHqFjcQYg0NFa5KORmOa7Kjm/BRTUdqn9YIHQRvCycFbaahA1z0XJ1jtqFgQcFVYh1HIOCa+oUzuYq10wKRrqk7tFVmcmoVEYDkSoM2qdwGZUbtYeZmmuqqDeuartLm37UGgbF1vJVUk7I+saKPhCB5tDkHdJKOaVwX+ZYH2LfLk4yXVxOcoGl1GNTW2NDQom00b+mKxvsipTGJGF+3YE0dFPDfQjaM1iGyuHM9pXMbvMKGUYk0flK3Z4+ajxTZ2hkxtfVQzHqv2/3NV0UpmFWuieTVsLlIHZOeB4+SfiIweaFxoeKZiK7KqKS4VUpa7NHER7guNBCYONvanytjXG29i423urjo7EyasJeUcazurjbOxDGsaa2pmLE/NopJ2xOtIWGxQk5oClaHGhTiyLEsEe1Ruc0gJ2MzIouNhDFN31UTq6SK6MfjDAAI+sUzAyTuulNVLwdG5uYTJn4BxY5pLVBjYZuo5XK7oSFAYy5xZtrmsD7FvlyCuFnfdBvaVgmhpQtcaoIGvTlY/wBi5TQa18Z7DVDTrG3Wb+WQpYic2mhWLwWsrJCLXMzd4+Xx7Fh8Q3GgM2SjYU3EtedVIPvBkPPt8kMQWVEuRHx8kJJaB7m5fEe5NNRUI1bzgq1C4Rc7V0b2hYouLgaqJhkNE7DubtVVhnkDNGTmWBCNxFQiCNqgkcDaCsYwvoQiCNGqcgymFtWocjkaIMLtiwETmy1KxfXqsC6k2iWDWTB5GTVigWiqGZVtU2Bzlh2uayjtAkEj7Ru0SOoKlQVxeIM52bAuE8RiMK1skNLVwJLVroXA3bU+Nrtqm4MjkzQweMbzGyZfFX43DdbnD4rDzCVgeN/QFQQ6tz/E1XB/sG+XIK4V2M81h4ydiiFozW5Dka1nag9rth6IrH+ycht6SimgD6EbQsdhzM4yD2vZ+6hcOEWamXKRqwzX4bCgPHPzoFhojC92KmyuWEYWQta7bROpShUcurOfVOxSgOasQedb2KOUxmoT8bI8UKiaZHWhWWRFx7FVYWaJjaOKxkrHEWFYXOQItqMljmWR3IHNRMJaCrebRGMp55ywALgaJjKbVj+ssG775ugjJYsZKq449YfFufIGuQNVO9zzqotqiYI20RXCUxcRhmbXfJYWERtoFLBFiG2TBE06oW3NAZrFRSRRExjnblg9fLB/1QzWDJhlfh3ZbwPBDoN5WA9gzy5PCo+6DuwhQOo1NGS3JvILAU6FvYiJY+q5DhMsNs7feFFiGSi5hqq8orH+ycm9KVibMq7d1NqOowjg+ysp2/v4LCYZ+HfrJ9h+ak5s1ZN+z+PNBbU6NpIJ3KS5uQ3rES3SOcFgsKJ47iVjsOMM0Gu1MkNwosW+zBkrWlCOc7Gp7nxmjlwe66aibsXDbrYW+abIaqH2Y0O2KWQh5XAjrr/d+6K4UNKKCWkrfPTjG81axYXCa+O9M4Pa0g1KuULbArRdcnKVpbjquzqEJ2AKThQXUiFUOE9WaYlhb8lHMyUXMNUC0bEBe2pKfI2ylFhDrcVLL7kOgKwHsGeXJxcWthcxYXnsFUdibySNFtVLFdkpYXQuvjNCsHwkJDq5cnJrq8rH+xcm8p1dyBryQUU8iOYOcNuXltVrIOcczuQlkYazbD8P72pzGvbYdiFYpBGTUHZ7qIKtVi3athenEjam4mVgo1xCfNJJ1zVYKF8kgLVww63Ctb4oKGIatq4UP/VOHl8lwRniPchsXD/smeaBzUPUGh2xT+1d5rgA8548tHCcMkjfuxVGrTQ7Vxubvn1XG5u+fVYUvmwbSdqmhki64om4mVgo1xCGNnH5ysBjZHThsjsimo83nKocKhYvBsxAAduTeC3HmySEhQYWOEWsCcwOFCpODI63Qmw+CbicRh5RDPQ13pktRVYibVsL1wUwtw4J35oA126DUmg5TlgPYM8hoI5FurlLd21DMIckotVKLrbVJHdksZh6Z0WAx7mu1UyY6vJ4Q9i5N5ct21m7d2o0nj5hoo8Xi4ZtROfqmPDxXQ4V2Jrrk5gcKFNw8bTVrQEWAihTH6gatwqN1EKzSCSlAP3onYn74YePM7/BBtBRcJxPki5ihwEUjQ4mqHBMHivsjD+Kw2HjgZYxY7CNxDBduTOCoNqjGSxXBkUkpkdvWFwMeHfe1BY7CsxDQH7l9kQKPJo0O2J3BULnXFYHBx4cks0AhhUvBsMjy8719kQeK+yoPFYbDNw8VgWNgjxQAduX2Th/FHgqHxXFHNmbGxQOvqRs0Ty8TF56vyTXNeLm7FTTI4MFVwo15hbJvaarDyNLdq4Uk5mrbtOSvbCwDsUONbNIGMdVOlN4jbt+XLcsB7BnkOVPHcKjaFE67MLcq8qiITxbmpzzQaLEi3cuDMZrBY7aE08jH+xcm8uWM11jNqrX72LbvH93qfDx42P+5LD3xGyTaga6HN3jamuu0kIg05qgwzIBzN+hwqm4IB5c00B3IYfxQhpvViPYmxU3prbU8XLV+KqnEEUVvig8AUWsV1RRCNAWqqLLjVanxWo8VxbxTm1C1PiuL+KOG8UzCWVzzO/w7ExoAoNDmhwtdsUEDYBZHs0veGCpTGmtztqljEjS0r7MljP3UmXioMEMOdY43OU8pcdW3NxUELMK3VQ5vP8Aa/wFGDdbH7z/AH+jkuBNKHQ5YH2DPIcuRlhvammoryjocU4B4ohFUFpU8IeywpzHYRzZWrDyiRoc1DTjvYOTegsF1wVrrr48v3VHOzICAIQOgj8wQNdHWzKtCoqBFgWrCtA/9qyv/tWD+krVj+krVt/pKMQPb6lcXHj6n+UcMzx9T/K4u3x9T/K4u0f+yuLDx9SuLBagIYRvj6n+UIGjefU/yjA3x9T/ACuLN8fU/wArUNGyvqf5QiHj6lWD+kq0f0lWK1WAqxWAqwBUVi6uegmiEYLr3bdJU1/5RmmR6nJubzt/vYhH+RnvP9/oTGBgtHLcsD/27PIdAW06qaeXRW0KIRDcwsdHuXBDyKwu3JunHewch0eaoVnocKc5qjlZKKsKZ1dPim+K2rxW1BU0t2Lx0BbdG7QNOSrpJ0+fIBT+qpJmRirymjedFSs06/cvvvBRxhgVOgKwX/bs8hp2cqnQEhBOZnmsUwUtUYMOKadxyTdOO9g5N/ATxPwMnGIeqdoUErJGaxhq1XhXBXhXhXgLWBXhawLWNWsatc1Gdq4w1HFR9vzXG4u35o42Eb/mjwhDvchjYD+ZceiG/wCa47F2/NDFxdvzRxkXahiIyuMsXGGHehKzctYFeFeFrAr2rWAq8LWAqaZkTdZJs+aw0L8dJxmfq7h+AKwX/bs8h+BcFsKdsUnPasZzaOG4gpul7Q4UKY44c2P6u4/sf2Q6dzQ4UKhw0cPsxTlk0WtageVRURYDkUGACgVqoqKip0kkDJeuKoNAyHTkpzjiDazq7z2+A/cpoAFB+B2qieKpqxlTG5N5DmhzaOWEraW12Gn4YrF4tsLbnL7WkurQLBYtuIbVuifHxwusOZ8E7hKFsYl3FRY9khoAfRN4WgdTbn4JmLY6R0W8J3CMIaX7gaKLHslNoB9E3haA9tPJA1U+IZA295yUOPimNrdvimcIxPiMw2BDFs1gi3kVU2IbC24qDhCOc0YChwnEYjLuCk4RijcGmtSKrDzidtwBHn+HxWYDe0prQ0UH4OqKtoFi2lwt8vmhycL+fzP4Zy4ZGTTo4EBuc7doxNgxBdFJa/fXYsTiDPhWPORu/pUN5Dr5Q7LdRM1hgijefu3H91incWxIm3Fp+CmgMWAZ4mvqoHOFQ+UP8qJmt4u1rjzCVG2jQFwuKRtPiE9zH42MsNaAqj48PcNj8veCrg3GMLjTmrXRW3XCnmuCZBq3NrnUotMeGvGx/wCxUt3GWWvt5ozWEcSzN9x8Pw+J2s8/5/BlUR2olWXTNHv5O5YX8/mfwxU+HDwQRUL7LjLt6w8DYm2tGiXCxS+0bVHDRObY5uSbhYWZsaAuKxWau3JPhjkFHtqpIWSNteKhMwkLDVrQEMNEGau3JAUFAnsDxRyjwsUfUbRcWis1doon4WF+bmhDBwhtloomYWGM3MaAjhYi2y0UTsJC7NzQVFCyIUYKfh8TtZ5/z0OwV0DoSdMLMy/k7lhfz+Z/QeI2s8/56EjpX9gTW2ig5O5YX8/mf0HidrPP+fwhRTG7zy8L+fzP6DxO1nn/ACt34SnQYX8//wCx/QeJ2s8/5W78W3YsL+fzP6DxO1nn/Kf1eRR11a5fgalXdvIectGF/P5n9B4nazz/AJW1N6aKMsrU15diGzS5PeGC52xYQG0uO81/QeLBoHDcapjw4Vam/iZHBoqU0Gd17xluH7lAfoMpzTAb2dXeP3H7qNwcKj8Tic3sBTB+hSsOLXyNGyv7DlHl1QPR4j2jPf8AJM2foUqH2snmPkOnB6LEe0Z7/kmbP0I11aoqH2snmPkOlqqqqB6HEe0j9/yTP0KVD7WTzHyHJawnNEjY3kjRqnLVlGVofqztTDUdDiPax+/5Jn6FKh9rJ5j5DkBOcTlyyToIWPjqy8bQsFiw77t23oZ/aR+/5Jv6FKh9rJ5j5Do3adqe9mbXI/dyZblC+9gcOgm9rH7/AJJv6FKh9rJ5j5DoqrWtc/VjarTpD7qqRjLHZLg01g6CT2sfv+SH6FKi9rJ5j5DosXirOY3auC4rYzIdrkNJanm1hBXB+LYxljsk01HLk9rH7/kh+hSovayeY+Q5R5D8HLiHOeDRR8wUpkEEMleBtVQcwuFcmKPqrg2Zx5u5V0Dbpqn+1Z7/AJIfoUqP2snmPkOXXRjMdqzq49qwjvuGk9ifm0jQRmqALBisAI/ualhvdzlj8LqBrQciVwdIA+iDlVAqqqqo+1Z7/kh+hSme1k8x8gqqqqqqqqqp77Wl3YgS4lxWFBbA0eCpnoftRXB5rh208fmnnNcM+yb5qM2moTJaiquVyOauVV/5me/5IfoUpvtZPd8gqqquVyxGLEQ8V9pzOda0KJjyyrtqxkgijcH7wg8UWH6jPcpZbTQbVeVIaOT1wc0shsO4n5p+1Y9gdh3BQ8Ezuzfkm4FjRSqmgsbVibJVXK5XJp++Z7/kh+hSUHfeye75BXK5Xq87liMLO81DVhcJI3EDWtooti4c67CuDsHGYxJIM0wbKJ7DeXHRJtVahYVtt48fmpAqaCNE8bo5iGZqpGTler1G775nv+Saf0KUT96/3fIK9T4m3YsC+TETWuOSYxrdgQzVE0UXCmEM1rm/2qYAmytBpVVDswrk8KijFEUNL42ukzG5BY6W3Eu/u5a1a5Yd1Zm+9NP6EKc5SP8AvX/3co2uk6oU3BuIfsC4NwUmHLjIjkMlHWmemeeOIfeHamxySmrsh2b0xjWCjdFgRFUTRByvcnTNY25ya9rxVp0SZSI7Vwoy2evamGoRKgeWmoUEtwqmu/QbnLFYgQtuK4NBln5yaA0UCGjOuaGzSeshE0GoQCpyLQnRkIB6dA0HWb1dXNTGlCiBtXCrHGQOpuVaKLCYiYXMao8BiRtb8kZJsO+0LD45xIDk11f0C+QNGam4Tb+UKaeSbrlcDx84u0btJfRBzjow7rnSO8fllob0BzCwdREGO2jJSioRyWRFEzBQXX2CqtRFFi8I3EDLapoXYd1pWFxVptcgVXkV6Kuiv46vRV0VVVVVTnUWOxjTVrFSqw3BcjxcclhcLqARytmjDNtjFU45JmzkXoHQVtTGWkntRxcTzaDmm5qwIcjGYMzvaQosBCwZiqLBSgTZXQP1Ux8itqoFaFYFS3NqEgKuVyuV6uVVVEArJWhZLJZK5XK5VVVcrlVVVyuVwVyuVyuVwVQqqquVyuVRoyVra10ZKquV6uVyuRfRUrtVgVAqBZJrzIfu9nbuT4RI20rFcE0bdEVg4tbMGptBmnhzhzTRRstCKq4nTiuEIocq1PYsO6R0YMm1AURFyGzSdA0UVqK4XwzqiZnvXB/ChedVNt7egdsyTohIKPzUcZpl4/NWO7VY7tVju1WP7Vqndq1b+98PqrJe8PT6rVTd4en1Wqn7w9PqtVN3h6fVauYfnHp9Vq5+8PT6rVz94en1Wrn7w9PqtXP3h6fVaubvD0+qsn7w9PqrJ+8PT6qyfvD0+qsn7w9PqrJ+8PT6q2bvfD6q2Xt+H1VsnajrBvX3navvO1c/tVHrnBc5UfuK5/ag55Vr+1Uf2qj+1Uf2qkvb8FbN3h6fVUn7w9PqrJ+8PT6qyfvD0+q1c3eHp9Vq5+8PT6rVz94en1Vk/eHp9VZP3h6fVaufvD0+q1c/eHp9Vqpu8PT6rVy94en1Wrl7w9PqhHJ2/D6oMf2/D6qx/b/fVWO7VY7tWouyfmE1loo1UpoEMbTVrVTKipRBE0CbXfox+LfAKMH8Lg3DuknD6ZDQByqckhSxNlaWP2KKCOIUYKIGo01CLm9qqNyqFULII03IAol+5qMpaeeKac1ms9GapooVQrNUKz2INorVRUKoqFEFNFTVWq0q0q0q0q1WlWFGrSgCqK1Wq0qiLVU7Cs1QqhVCqK1Z6M1RUOiiz0UKa3tVqIqrVboJG9BzSKgqqqqoZ1TYms6ooh0p0V0EFbUWrVtKEMjdj/VA1CtParXdqAoKK1SMEjSx2xHEyYObVSGrUzMVBVNFCrPFW+KtVqt8Vb4qipXegxWqitVqtVvipDaEyKgpVWq3xVis8VYrPFWK3xT2Eiijq4VKDfFWq1W+Kt8Vb4p0dVQg5qitVqp4q3xVqsWzaqjtQVPFWq1RtyqdFFVZ6Xuke+yM0A2lDCx3XPzPj/aICnIDaDQOVVT4psNC7YmvDxVum5XoyhXVVVVXKqoiEUwESOHv/vorXJjM6nSQsRhIsRTWDYogIy6NoyCBcdiAOjNZrPSaqjnIV5FFRUKIKIJf5LNUKoVQqhVCqFUKoUQUCWvp2oVVCqKioqKiIrkhVu1ZrNZrNZqV9ja0UTJMUb5RRvZ/KELD+UIsFMlzlmqlNFBRNW1U0PkeTbEE2H/Ia/L0QaBsVENBCpoqqqqryCsdfO7VxjYsJg8REa3U0UVNNFZ2FSvnjIsF3wUTrm1OkqiLN6taM1c6uXJDPv3E9g/foCaKldqoqKioVQqhVCqFONM1EDSp3qnQUKoVI3KqbnsVCqFWlWlUVFRUXV5LusAhpcM1zq6K6N+iWbnaqLrfJRssbbpKDgqqvQV0HPagNFFTRRU0URWCnuMkZ2hx9OUQtqGiqqqZ1VpVCqHtVFRUTkGGta6K6KqqqqqqJTxdzUMujcFGLeb0Jb4oNLd+Wiitd2oN3lAadqDVarAFTRI25tqjj1QtaMuRTl0VFTRVVVByc+TYRtKjhfDj6k5PqgrlcuMsEmqO1XK5VV6qNioqaANA0kqipooqKioqKioiE3M1QCp0NFRPFCChyKKioqKizrsWzk15FdFdB0DlUVFTl05FOSdBUmH1kjH16qorUclwhgjPz2dYLANxTRSXZ47VTfpoFQoaHODRVyxvCLybIclwfXi7Vnopys+S4oCmjNZ6M1ms1ms9GazRFck2tFms1ms9OazWazVCFnpzVaGnIvFaLNBHQNJFUORVV5FNNFTkjoaU0UVFRU5BbzqrGs++JWBFIG9Ntd0+w/gCM0NNEAqI6Byz0P8A/8QANBEAAQMCBAUDAwMEAwEBAAAAAQACEQMSBBAhMRMgMEFRIjJhFEBgBRVQIzNCUmJxgXCR/9oACAECAQE/Af8A63H8jPQPWCP24R/kHGEATqeq1sot7/YHKP52VeXaN67XQi6fsAEKcavTj4/gScsVUsasLUvbkDKj7V1UNQDqnu2QH30KlQdU9qdZTPo1TnShH3oTaZiZRGWJERU8KniA8aLFVL3QsNVsdBVWvYFh2wLvOcEnRHIFHrFCmgPvYQaqeGDW8SroFVxEixmjUT91KknZevyvV5UPBmUHOQqwnVSTqifCfqIQJadFSi/1Ktbd6VcXbpmjU10oVfVAV6l6c17u69a9flS4IGf4S3mATKMr0UPkqrWc8y4qeVx7BXAd1xB5XFb/ALLiN/2XEb/suI3/AGQM7OQqeQuIPC4gXE+FxPhcT4XE+FxPhcT4XE+FxPhcT4QMomFN26e8uNrUKIQpAaqFGUnIJ2FkzK+k+V9J8oYWO+UICNsoUI0wdUaITXGmbXIyNQgZRK4nwuJ8LiDwuIFxB4XEHhcQeFxAuIFxB4XEHhcTwEXAbuXEb/suK3yuM3yuK3yuIPKDwe6a7senPhAdBpQtD+ISnvlE8rndgqtW30tTcMCPUvpWL6Vi+lavpWr6VqZRazUdaL9eycJEJlMNWy1iSrlcpRBAB8q5XKUFabblKlMaXzCgkEjspye0s3zfTDhBTGWiERb6ggZ6r6DXmSvpGL6Vi+lYvpWL6ViqYaBLFQr3el26a7t0ZLkNOjKlTynZV6lmyo0o9R3+0cJzM9k5MY/EtDR2VXCOpNuJy+hd5WJZw6bG/wDeTMHc0OuX0P8AyVWhwe8oqjQ4s6o4KBNyFGof8SqLTw6gOVL3BY73tPwgdIyE982iPtK9H/Ju6oVOINU3Uc5NxjstvsXbLE9k3pzyzk6eyE984J2QYe6KwNUU6kO2KxjwW2gqmPUE6qGmCq9S/bLiPiJVKq4O1KqvvRVCpYhWBK43yqRLmvykhOc53uOdrjsrTmdNkPnKch1n7LB90z281R0aBNECFH2Ltlieyb0nkyAFa8Jr55abQ8W90WluhzYBbqm0XHUKLRrkQgqQ9YVX3ZQhVpNAFqfVYRDWoygiMrVhf8mqFS4dvqaqwbEtEItya3QlG/8A1T6Ys31ziU5to13Wy3679lhO6Z7eb3OTUPsX7LE9k3pO9wVpqPsCdTI0cmu1tPICrrtCiIylNqFuyNQndTlTYSNAqVNweCQqp9SYJOi4bvCsd4VjvCeC0aoBlotm5WO8Lhu8Kz/bQLDhvFNpXDd4RLmmFbdS0TtN1Ka4t2XFd5U5h1uyJnMuhcQKeo/ZYXuqft5XmGpvhbIfY1Nk62RKHSe2VTAJ9WhUfUNg7p9MtMFNd2PLKe60SneXJ+KaD6Qvq1SxN7rU0ptc02m1H9WejjbjMLB15IeFjMa6gQF+6v8AC/dXp36iXbhMxBFPihfur1+71E79Ve4QQv07E8SrHwsX+qOp1LAFSxfHfssJ6WSsbbYi6CqmLtcQvrPhfWDwqbrhPKbiQ1u5VPA4ehJrGSjVoYj0uaq1B1F54bSWptQFSp6TY1hU/aOWtsmdYjlqe1ObcRySJjoObOyw9fW07qpTFQaqtQLCr49yuduQgc60wsVUPtVGkarrQn4EtaXTlh9KIKfiLmWKjhHVW3BVsO6jEqiTcAsRhX19QVWwb6TbioQ/Tqh7hDCPFPg90f02p5UQqGFdWEhUMG+i64lfqA/qrBn+ogSvU50FfqAhrSFuvoH+UP0957qlTdTFp5CV+m098Q7/AMVQuc8l26ZUtdKY53ZVaVGt/cb/AOhHABrov9KfgarBew3BNdI6LWwSqftHLV7JoQ6k81T29Z7JWGxEG1ycWhmuxTMOKr/TsFinMawUx2VMQ2MhtqnKufWqdV1My1OxVRwgqhS4r7VUHDpW5YbEU6dO0rF1W1CLVh/7gVMxuv1Fw4UDygqbmholXeuUXNT/AHL9MIAMqo8HZY/3ArDGKoyCx4mnl9XUCoYt94lSiTsFGTabqzxTb3Toa0MbsFWpOcb2qjh2T/UMIEslsqpWLWplfiuhxUhrvQdE0WOLSh0aftHLW9qbt0ICt8KY3Wh5Y751Pah1qkKlSrVaWp0VA1ZIYjo+XIZvMJ2riVhsKyoy56xWHp02y1DTZYl39JQhhqh1DU9jmGHBYQf1RljPYhmN1UHqKwPfLHDUKno4Z4oXUyoVDC0nsucV9HSbqCpQXZFfp77MQR5RpOJVfFUqYtBkpuLadKoQLSPQnipUgO2RdY+AFTpv4m63qFDo0/aOV4kQmbdNze4TX+eep7UOsTa8FV8bNOGaKlVdSeHuVdjcQzibvPZQWOtOThCrmGqEHuGgKJLt1Spue4ABYz2xkww0BYzWosGP6mWM9oyOTN1U9xWD75YymTEKCrneVe7yqHrpQnMc3cIOcNiuI7yqVQ3CUE3XRFsbpzJRNVwtc/RBgChcKNW6LC1nGqKVTuqmHAcgGsaXeAqI9M9Eqn7RzDQx1HtTH9jzVPahzunsg6dlR9T7XqpTLDHIQgwBEKhWfhnS1Fxe68oO1hEyqjA/dN/TcOWgySv22h8r9uoplEUdGr6enWdbUR/TqHyni1MwlGt6nbpuDpU/UxHdNoMrGHr9vw/yqgh0ZM9wRwGHJnVPw1Oj7MuGXjRHAUjqV+3UflH9OpdpVGk2n6Wp2EFT3r9uo/K/baXyq2DZTOhTTKCfUDxrvylOlsPHZV5dFRoWLfZQg7lU2SuICYCLtYHOVT9o5igZ6ZOicmOnlqe0oc7gdwv+TVIIXvppzS3nhARkQqFY0tF9V8I4n4XH+FeZlHFT2VSrf2VKrYV9V8IlMqWGV9X8J9S50q5MdaZX1PwqlQvM5Nr2iIX1PwvqPhfU/CZUtX1HwvqT4X1cdlUJqGUBzEwoREqnUrUtGO0TKZe6XFPcKQgL2+lu6b4bykZFM9o59umE4SIVtqHJU9pQ6Ed1HcJrnjYoucd+lChQoUKFCtVgVgVisCsC4YXDVgVisCsCsChQo5IUZRyxmAgQ0aJ7tdN0B2CAjnKZ7RmGyiI5Aeo8Kme3JU9pQ+wBB/hS4DlPwvUmtjolM9ozDk4zygq4dJwXtdyVPafsXA0zcE10jTKc5UhSpUhXBXBXBXtXEauI1cVq4rVxWriNXFauI1cRq4jVeFe1XBSFKlSFKkKcnOgapgLzc77Aqn7R1J6B1VTbk3Xs0O32BCawN26F3RhR9iWg7qPsAL/+lt9q/wBp5SJTPH29SpauOVSqXZOqhuiNZttybWDkMQ1CoCYRrNAlNrB2iGIapTnBokptUOQrNIlcQTCe+0Sm1g7ZCu0iU6sBomPu+3d4Q+2q7cze/wBsViO2WG75VPfLXQU99zAU0nWTK1tE7J5sdcniKSafLpQm34QWI9qJBqCFs2fKmKgnwrxG6w50IUQ2fKJ9YgwqZkbz9u7cdECU3CwJqaI02f4oiOm4SRzN7/bvZK4AlMZGTqbXbhFgIhCm0bBWNiEWA7osB0KFNo2C4bYhQiJTWNbsrGxCNNp3C4bYiEKbRsFY2IRptO4TWBu327tx0cNStYax/wDFBmVVgOQOv2Le/wCBu3HR40MAC477YRdrKb56R529/wADduOi19qdB2Vo6Z529/wN24+1J6De/wCBu3H2k9Fvf8DduEeTWelKlSpzAlMFMCd1ZTftonstMHlb3/A3bj7Bjbe/MDGyDm+6VVIqU7+QmEzz+Bv8oGftgrobbmTC9+p/BfZqNkNfuavZD8Gp9+raiwxPTqbhD8Gp7noBqPK0kbKoz/IdKruEPwQGcqe55g0nQIsFP3bomU4RzA6QiI6NTcIfg1Pc8gCpYcu1OgT6rWC2l/8AqPNcpQeLrO6dv0am4Q/Bqe55Go1Dbbz2jJhWLp3MvG4WGxN3pfv0au4Q/BqW56bd8xoVGiq0zReqbw9oI6FTcIfg1Lc9NrhdCuGY2VSm1w1Cwv8Ab6FTcfg9Lc9LE4i30NWEYQy4907TMbJ3tWHrNa2HIGeepuPwel36Qwbqri86Jse1OMlbp1ONU32rFf2lT1asK911vbnqbj8Hpd+jVrQbWpnsC+cg70qSVScA1Rcq9HhgvCoObfzv3H4PS79BxgSqRJkpmjAhqMme1BM9qZssaf6alUql7ZynkfuPwel35a2KazQbpuKqFNcf8lVe0NMq+NkPYENdkGeVTHpTdkwEaJuyxDbqZVPBudvoqdAMEBVGlrbm6plQP2ylSnbj8Hp91KlSq9Qsb6d0cPWJkhUaTg/1DLFbhYeg0tucjoEzbJh0QUQ4pmynJp8oBVMI9jr6a17qVKO4/B2blOdAkp2Lc4+nRYRzqr4Kta1VDCnKtTL4hQtDoENBkw5PHdBHIiEz2oFYioWVirlxwNCg4OIj8HadSql9d1tPZfR1FgKXDuuW7lWIu0zLoTaTjq/RRAgIq9AwgJRYO64bU9kCRkTKp+1BY9sVZ8qk6WqqJTXFpkKm8PE/gtR9glYP+o+12ysa3RqqOjTIJ2rs6f8AbXEcwp9XSYRJO/IHlcQHRNcAnAVDJGVHuEFj2kuBCBITWVKg0C+jqnYKX0CQU3FPnVMeHiR+A1KgYJKOJeU95fuv0wepxQElP1ecgdE1l2qcxoGVD2p+roVXYDm2yanbqkYTSiFUpsmQEHeVTg7Kvh21m+o6rE0OC6Fhqxa6DtlGcfzMZ4h9zoG2VPAvcJOiwlIUQe6bEypyntkdcqJimAm7lVTJQ2ygqERClDUJuifqqVRhMSnaFXko5N3Q0WKw/FcCqeEot3QpthF3DdY9WhWBWBWNRZ4UKOeFAUBQo+6hQrQo5YyhQrArArQrQrQE0X+1PpgiFVwYiWFYanfUATyToEHWqpUJygDfKU6s0Km3SX5bJ2+bTkcg4hB/lNWMoF3rYqOIJNrspzJRKBTHGUYiCnDXRa5arVEK1WHyrHeVY7yrHeVa7yrXeVa7yrXeVDvKh3lQ7yod5UO8qHeVDvKh3lQ7yod5XqXqXqXqUOXqXqUOXqXqUO8r1KHeV6lDvKh3leryod5UO8qHeVDvKtd5VrvKtd5VjvKsd5VjvKtd5QYfKgrVarXJgBmVMJzy/KmyNQjoZKbqnbpokp2VZ5aNAsFQudedginOKmeQKeUOhTITQG7J7bXRna7wgHDstVBUFXOK175Enwr/AD9tvlChQoUKFHQjnjp3wFxQpQcUXE5AwoKg5QgLWgIGNAqruw6vZApwuMoAeFeMp8KEWRs5NM5TCnug/wAqAdCuI6g+x2y316kc7kBGUKFChQoUIhNyjljpTnORLRopG6uCsCdYFaFaUyned9EKFNmo1TngiCEYC0UK8FBP35oVQ2alCDtkATshTJXB+UaRC4dqtVo2XDCthXEIPc4QUEDBKDk45td2VVjakBybA0HS36BW56ex6O3MSQqYdUNz9AnwFeVrmd08aBBxaEXygEA53tQoNAk6oxELVuoKe4k75NKnIUz2TqblYVaVGYVYmobQqdB47rZXq4LVBSEI8Kte2LVcTm0wi5NtWqdajvkEV/l0J6RTR0yh1mA6lF0Bb5Ma52yDWj3IWosHZH5UelSmS91oQAaICvIdIT6znIJuHqOEgL6Y93Lh0wgAFPhFSpOU+UQEQrRncrkCPCvarm+VLB8o1nRAQTXeojkOTXZHKMoaOy9KtG880dIodQeOlHIHQnHTOS3ZcWN1xQRsm1I1hOqlyBTGXHVUyALQITgRqnvu0yFUjTsvS72lFpG+ZCu8q4K5FylWqApK1zARtRyG2QKLCyrPnIU/K4XynQ11sq1WKxWZSpQV8bLU6lH+KnKMyCVYVBUZUt0SnE2xmcm1nDRGt8LiFF5OQQDeyiM55LlJORybk1VG3QUHQr03VYihfqN1R4mzspK1UlT5Ti3sMpA3VSsTo1UvYP41kRJCj/VOnICVaiAqR3ydm5ycZzAlWqFGQcpGcqeU8kcgMK6crlcrlct84G6qN9RVP2/xo9gUwpORfqnP8IuJVPdFHbIbp2+ROTc5U5ypX//EAE8QAAECAgQICQoEBAUCBwEBAAEAAgMRBBIhMRATICIyM0FRMDRAYXFzkZKhFEJQUmJygZOxwQUjcKI1Q4LRYGN04fAkUxWAhKOywvGD0v/aAAgBAQAGPwL/AMgxxFbF7K9/6D3cvJAJlf8ApCZEidh5eQHEA38/paJExrGlks03u6P/ACu1Kjb51tv+FjWBu2ZFilt4a4Do5GHbDwVKpUSmQmPYBK3V+90oic/R7W0qOYEPa8NrKrQ4ltlaEBY2zf6CaKoEt230hSmRKJDjGKyqC7/l3IKz80KpCu3+jHMDiA68b/SMyZ/4hrvtduU7uViDAhmJENzQm4wVobgJP59o9AMcXDOtkP0Br6LN5Um8tESE8seLiFjo5uaGgbB+hUnNI228lDWiZOwLH04jmYqrcyFu/wAB7z/gF8RsQCI02MJvGUxkZlZhBTWwGVW1J5XlVJz52NYJH48otM+SShNzdrzcE6Gz82kb/wDlyrxXTP04QAmQ3oyM/SsypDktWqJzv9H3ZEL/AJtUUn/lqswz9GZrS7oCx1NzIYtq3dq8m/Dsxgsrj7KZ9ETn8OBzXVuQGQuyYdIfCc2HF0XSv9H1RwgpBjEEtnKWU3pUoeeawutUiJHBDg7HOkmwQZhqfALqodtUSA0zDdpwZjS7oQY+TXYrbl47HF11kvQoikhoLQXRDtRbCmyDPR38jEzII1TMbD6Ct4Su+wKqwSGTDgRIznQ4ei0m70vntJHMVZhb0oOlInapHJit5gU+ktiSIboyvlgfGfV/NALZYYboMIFwOdgiOiPDq4FyHujDmA/HCaZHtIuG5Fztuzdkth4kBw8/fhe0sDg7w5bVrGW6f+AZMbNCZrvlNW9npcMYJkrQb3wtV+4LVfuC1P7gtR4hSpEMhnMU9sOC8snYuLxO6vzIbm9IwYqJf9VVZaJaRRa4SIvGBsR8Mta644IdVxE3AYGPr4urubepASCxEGYiuE625CjxpmKBOtvwPeXYytvbdgizM84jBi4TZuUjgYXioLy7csWyyG27nwaiJ3VxeJ3VqHj4IAsM5XgpwhQXFuxagrUFag9oWoPaFOJDLROX+EH1i6v5shZwdeJY3dtKxVHEudTcZnn9LhjBMrEQDMnTfv5snSParIr+8uMRO8uMxO8pPjPcOcq9TBRxlkRl43oUmj6f1wOgRs6Gf2qV42HemuGwzTX7xPC2LDYXRQZWblj4zXNi2iR3ZDnbygxgm4ryWAfzjpvV6FJj6R0W7l5LAOaNJ2/mV6nNcZid5cZid5cYid5a+J3lrn95a1/eWke1aR7VeUWRBXhO0moFrq8N1rXelnYmti9la/kFyznchqQ2zKrx3Bzlm5jdyt4QxIhqQm7Vro3dWti91acTsWsidi1sTurWxe6tdG7q10burXRu6tdG7q10furXR+6tdH7qMOjR346WaHiU0QRIjlgYxs3FGjwHVnHWRB9BgEekNnuaUYYojIkryAF/D2+C/hw8EDDoxhcwWi5aLlolaR7FpeGAOabQpNEuhVwJE3qaDLbLlpFQSTbKWG8LYti2KKQfMK0iqwLp9KLiZkqvVrHYsVOqTe7mV6tJV5V5U7XLVu7VoO7UTEoxiWXEr+HeK/hw8FUfRGQucgKUKGxj7wQEWPEiEYcVtaC68budAg1obtF2/lgaBMnYhDpMd+OlnBgmAtfH7i10fuLWxe6tZE7Fpv7FpxOxWxIndWsi91ayJ3VrIndWsi91a2L3VrovdQew1oTrjyeTRMr8w9ikwK/kINJYYLb7bysVBbN27+6dEeZuPC1nWNCENtkMbFWhwnOHMuLv7Fxdy4u5cXPaFqfELUeIWo8QtR+4LUeIXFz2hcXK4s5ARWOhuvCDqW50KOLC5jdJcci9xccjdxcbjfLXHI3y1xyN8tccjdxcbjdxccjdxccjfLXHI3cXHI3cXHI3cXHI3cXHIvcXHIvcXHI3y1xyL3FxyL3FxyN3FxyL3FxuN3FxyN3FxuN3F/08aJEdztlhbCk8uPqp0CDWeLnxBeeYI1AQ3ZNCkRx7rUYEB2d5xGz0SKPGdm+adyrs1o8VJwkQjAjY0w3ftO9VTaDa128YatIc5sPe3YuORu4uNxu4uORe4uNxu4uNxu4uORu4uORu4uORvlrjkbuLjkbuLjkbuLjkb5a45F+WuORu4uORvlrjkbuLjkb5a45G+WuORu4uNxvlrjcbuLjcbuLjcbuIuobnRIxsDniVVEQmOiOvK4s5cWeuLOXFnLi7lxdy4ufBcWcuLPXFXriz1xZ6GNhOZPejDdnQzsUxa3ktaJmt3bVKE0KbjgtPIDT3NrRg4tmfNXk1DzpXxv7cNWdYwXlVWCTAt0MaTl6kNi/md1ef3Ve/uq9/dWk/urTd3VrHd1a13dK1ju6tY7urSf3Ve/uoxH/AbuViHDE3G5GjUZ1aK7WRR9BgrUt8mtuG9YmiunMWvHoazJxNJddovKrwScYOax2DySlarzX/APbKxcT4Hfyus21h0m71/M7q/md1fzO6v5ndX8zuq+J3VpP7qvf3Ve/ur+Z3V/M7q/md1SMnw3hSNrDouVR2iVZdyIMY2s4qbzWf9FuGC1XchIZFe0G8B1/DTNjBeVUh2Qx4rdDF7lsZDYFO6GNFvocMY0ucdgWJhOnGl+Y8bObLhwhYXmSxbGBtVoFglNMDqFAJDRbiwuI0f5QXEKN8oLiFG+UFxGj/ACguI0f5QXEaP8oKDiKPChurEzYwBUSG5oc10ZoIO21cQo3yguI0b5QXEKP8oLiFH+UFxGj/ACguI0f5QVLcKFRwRCcQRDFlmBsJgtcqsWjwozw6172AriFG+UFxCj/KC4hR/lBcQo3yguI0b5QT41GhCG1rRNrWyGCk+U0eHGJqltds5XriFG+UFxCjfKCpkNrQ1rYrpAbLcETyiBDi1mTFds5WriFG+UE0GhUdpP8AlBRmsa1rLCA3o4AUSlnM8x/qf7Iw33jx9D1XZ0E3jcqpk+G+4qq61h0Xb1Ufo/Rb2m48gEOG2ZKqMzopvcrTbgtWby+U5C9YuHZDHip6MIXuWxkNgXqwhc30Qx8F04ka9+4bsqtKzfgY+Hpg2KAxwE80Osv4Cjs5nKhD/Mnl0vqX/TB//V324Cl9IP7Qnt/yvvhpg9ufhgaN7XDAauk25TpAIc5glPdhLpGqNuU6jxbTDE4b93Mpeh6j86CbxuUnSfDfcVVda06Lt6xUW2GfBVZz4YMYKzjcFUEnR3aRRO1TU1MlSny93unAABVa0bFIWQhcPRFyMKQLefZlQ6NVDGMGzzsEBu94RiSaXNFhRaXv+C1sRGM4uOdITwTNy/MiRawvktZFQLnucWg6SonxP7ThbDa+IBiwc13OVrI/eWsj95a2P3lEZjY2c0i12A9c77YIhGxpQm+N31rI/eUKFEfEqmc6xnsWt8FIxv2lR4kJ1Zrqv/xCc3fCP1GGk89U/tGCB0keGGjRfWhlvYf98MSiANqv27srFgSHN6JEJ9sJx7FGD2zk0nB/SOG8rij8x+iNyLnGZKqhAqzhZm/kjvdOB3u8us4Cu1jiehSys0E9C1buxaDuzI8kiVjjTmlOIdMHBRvam7xwR37obj4J3Phgcwd/8cOOpMGu+Up1iFxX97v7rin73f3VHdRIdSuTPOJRwP64/QYInunDjIZk5oWtHdUzEHdVd9pJTOdrsJpFJo9eIbJ1yFMUP/3Hf3TXwYFVzTMZxw0OJuc4ZGiVolaJ7MljMWzN5r1KQHQOBs5azpCj+476YP6Rwtd4/Kh+JQA0QqjRMrOtJQb6Cd7pwO93l0wsYy/zhgsElWaQpHD+VFc3oKEKKGkznXlacoRYZk4Kf5fYvN7FjNuRDhCI6s0DzUbfBURv+U36YKU7/LIROHohOyqIR65+mF/Xn6DARzYb1fgCo/SR4HgGO9WMPocLXbjNZoZPoVas3sRhlwkdwyhGdKNFNzDc1WsYwDY0SyMwXK1wUgFVCxUL4u38th+8FH9x30wf0jhA1omTYEyjs0pWlE7E5znTK3eg3+4cB93kzYjYWa661ar9wQEVsp5cwsbD+I3YKwWMH/4pXjZliK2MTSZaE0K06u2Sn5T+4LjX7grKR+5Zjp5EVtJGa9kpyTmwjNk7Cms9UAYI3PIeKOGKd0E/UYYtGabGylmz2LT/AGBWEdwKG2NKTHWSEsMTrj9BhI58AYxpc51gA2r+H0n5RXEKT8ooeUQIkKd1dspqiH2xhhGTTXnpFaELvInEwz/UmP8AWAOCkezVPjhiGI6VVsx05EgjFi0giNI5tYcATSZ3TlO5YqjghuCq29YqH/U7l0P3go/uH6YP6RlNqPrTFtkpHKMd2jDu6U6IfgpockNvA3Zb+rOB3u8laOcKA2DFdDmDMNKn5TF76Dca6KPVNs1fGYX9jUYcS/KmFXZd9MExcbwvZ+i3jflTCmLFVDgFphWlA179+TRofrRWjxwy3vGRSXbof3wxaU2lsZXlYWncv4izulfxFndKzvxBh/oKixvLIZxbS6VU7METrj9BhLvLmWmegVx+H3CoFJNNY4Qnh8qhtw0I8zx9FRnbnt+uGjP3RCPDAAqM7fDb9MFMb/lOwjcpx9GV0lq4fcRdAgQnPuGZcr7VzZUmia9aIUWNNp0jgkFUZpG88vh+8FH9w/TBL2RwjGee60/FAG5ON0lPBP0E/qzgd7vJWH2gqPEba0tOcNqBfCY44x1paCiWQobXczZKNSGvjMLWl4AIkodGpMJhDzpi8JzHC7LrN0TgsKk61p2Ks21uXMK4K4K1WZFEHtz7Bhgt3v8AtkUx3M375dJ6p30wRGRo7WOxpMj0BEwYjXy3ZVpAVDcCDa649ChO3H7o4Gu9WKPurkCqN7ssERnrNIwxHvi1Xt0WS0lsVwUjlyCqM0lz4ZDTN/N6Ahe8FH9w/TB/SODhQjcTb0IMFzUXvuQYLyZlTR9Bv6t2BznukKvJqHV3yUWFWzsaTL4BPewZ05BNrHSsc1R6XRKNio8ORa5rjZao1Hjxa82TZW2FVYrC05W8blWba04bblMWtPDQ4sd9Roa76LjP7SuMftKgCjxK9Wc7EMNJx8WoXOGxcZHYVxod0rjQ7pXGh3SuNDulcaHdKpDGUkFzobgLDuwSbvVI8rjVS5wq2LjQ7pXGh3SuNDulcaHdK40OwqEyiRBENabrChWAsTVxkdhXGh2FRIUKkBz6zSBI78AUOE+K0PDjYtJTknsiQnMzjKYv4SQyPbPhkiMyFWadyaRGIiyztoUzDrN9ZtvKmOOwhRnsdNphm34YP6RwcSIb2tkPipb0IXxQ5AXV86ejLksTq3YALmNuHJodEgkY+G6dU2T6FFg0tzoUWvOUp7EH6yG9PpDLYbXTrA7EyrEnK0tKg+QwMZFa+ZqiRlJGhU9/k8cPrtETcpOkZiYIuIypG1pUxa04auxc2FkaQM52OCxj6KA31sWg1rGEnZUCreRxRP2FxSL3VxOL3CuKRe4i99FitaLyWnCHDYq0CBEi+62a4jG+WVLyON3Ch/0cbuFcUi9woudRYoA21Ci3epLiUf5ZXEo/yyuJxvllcSj/ACyuJR/llW0KP8sriUbuFTjQHwwbqzZIw4MN0R18mia4lG7hXEo/cK4lH+WVxGP8sriMf5ZQ/wChj/LK4lH+WVUiscx42OEijioT4hGxomuJx/llAeRUj5ZVSLDdDducJKXOpAqRfNBzp5ydCNoZoqcSE5g52yVaHAiPG9rSVxSN3CuJxu4VxSN3CuJxu4VxKL8sqpGhuhu3OEsusdLYFM4XOgsrBqHlMNrn3u/sg2CwVALjsRlFk5fmNr84UaKyBOK0bBbyqLCvZEaRLdg/pHBxYu9yL3p8Z224ITUhd6EidU7BCjzm5xn8DyaYMioQL2spLLM7z0KFSIDi+HtabChMZkVlyZGY6s3YfsqxIrEaM7QvKaPEY0VQ2T0yg0lr4caB+XXbaL06E+9uVVda0reNhwywPe4TDIbnWptc1nXBNobvy2XZrbulExQyLEnMOlctN3atN3atY7tWsd2qNDNaJWkJTTnuguEKelswBzobgDtIUKjwIz4dZ9tU3rTd2rTd2rTd2rWO7U9riXzYbJ3oRGwXBnRcoI/zB9VpFaR7VpHtWke1aR7VpHtWm7tVHDiTNxUQgy/KP1C03dq03dq03dq0j2rSPatN3atN3anc7WnwUeRlmfdabu1abu1Qnb4I+pROBrN6iNL6j3tIZYmPvIcCnw4xe6C12bMWIXsm4kLSPatN3atN3atY7tWsd2qiRvWhy7D/ALqfAgATJQb531KltKtPwCzm32qbSqroVasbxepPDa3YVOjRJ+y5Siwi3k5pIscxx+IwH3RwbecfdWr4IvPoWL1TsEEE2kN5QytFMKPVkbJhybQnwmOxZqTWKjNrNQfBnUaQWn7KIBCqlvOo1ObSntrTiVaqECLAhiI+6IL5oseJEYJhpPwVolhqP0T4LeDccilgGrWFWZTIgGMqFPpFdznxb55bIJ898/BVVDhmsGhob4Ks9rXOrTuuyawVKBlKpsVGbP8Amt+vAUb3nKJ1X3HAMO+EPqVLfDOGjO9gjxVjiFpntTakR4PMU2jCTg2501YbZJmNYHtc0GRQhwxJouGVCP8A24n1U8MgqjdLacnHuGbDu6VUac1n1QYy0k1WpohxGxGE2m6SLCxpkMXDmFVwW5yk2KRzOVWMz7hVoOYd7P7KdIiNfCIkJ2WqcCLLmcpvhmr6wtHI4wBtE54D7oyid2TA5wuhT5keUx3Y+HCxbCRN15/tzotsMrLODi9U7BCDjYxshlhglM706E4gy2jkAc0yITsdCPlNWdeteVBhRqQXMN4MtyMOK2bSm+TucwOGkNqYIkVrnkSc2aNLocLFxWEVXAmxOhU+NVfP8t7mp/lH5UKGc9xRZQIxZAlYGoQqS+rGZOUVxv5iix7arhhxbrWnwXNhqUV4rgkxBtkqVGcJhrKvaf8AbCxsKK5gDLZFcZf2prHxnObIkieGAz2SVDh73geKzmgyumrBJPiMMnTC4wUBjzhpHQB4pkVpk5pmrY5WvVd7qxrETwxWCNINeRcFxhMx0UvqzknPhPqGrJcYK4x4BTwRniwtYSFr1xhTiPrVRJQxvDvphor+dw+mGu0AmUrUXbcFHPsy7MARGPNnQuMFWUkqXlJRgxI5cw3hSwSCqNNspuduTmtNYDbvyGsYJudYEIbNK4dO9VZ2lNiQ3CuLljY0MNtkCNqfR31IpZe07E9tGbJjLL9uARzItlNw9XBYVZmu3hDHODgF+XFq8yAiM+LVEiGDUh7CBZyKM0GxwkcB90cHAOA7rlV5S6o8trCqZbRwkTqnYG9HATJmeQgtMiNyiQnNh+VAzaZSLk8Upxggs8+y1ZjmRmt3Wp8VjS1jX5rkC8hr5ylO9QiTbX+yZAhtdExTbh9UW0iUKIXkydeqRK6uv6RhERl4RiQ9Da3a1SwBzTIp0SQDokTZhMU0pzJgCWLn91Z+IP8Alf7oxhSXRZtqyLZYJkyAQqODg1gFigD259mFrfWf9kVAbviN+uGJzuaMhvO44aR1jvrgCPRhaeYYI4/y3fTCVA6SPDCx3qxh9DlD2XkYYkXyx7a7i6WLu8Vx1/yv91x5/wAr/dQ4sOOYtY1bWylkSF+07k+FRYhLSJOO/JNLidDf7onzBcpqaFHdR9AZpaVXrGtfNVndKtWIiRKzfFP8tLZSk2tcojYGrBstmrAodHabXHsTolj4Q84FNLTa221MeJQzWu2O5E/AfdHBs9mf1QVvSp4DwWztVgB+K1ZVolyaL1TsDejlUwhR5tFIa6tNxscnwKWwlz88Yu1BzRmvEwCqrr9IJsNtFcyTq0715Y95fOHawBBzYUhLaotJjPMGGLQ6rOZ3IxQCBIC3CJIMhyMVuk4Gw8yZEaKtcTluUigqJD9it25YZJ7YUr9jipqfqsJwtbGdEFU+ZJWxaT2t/smRYb6RWYZisR/bCOeKPocEpK5QTvrfXDH6x31VyuwaKuUP3R9MEX3D9ForRwUbrBhi+y5p8f8AfJCjM3EHKc7/ALbg77ffDmi1Yijvuse4bcFuGHC3m3oTYLLJ3qphsVyOMGkvyW5vNgrSMt+CEykMc2PKbntNqiPhNx8Ns2tJss3pkOCHNtm8HAPw+oGtqEB7b2owa4fLaOQuwH3RwceDtB+yCmhgPB2OV6k5gKzoUudq/IjfBynEhkN37ORxeqdgHLIbKW97IjBVa8fdeQ4psZsKytdNNiOZirKt802EzRYKomqTBq7d6iUiMTUhSzR5ymG1GgSazdkZpkrTNQ2tOrbJEgdITWjaZLFtuYA0YHRIhk1omVrf2law91CJDM2nAGRobYg3FRQ1sm1jJR4m5oHAQh/mH6ZEAdP1wBRusd9ckqF7g+mB49k5EE7nj6pw58FJHsz8cqI3eyeEY2JVncteOwrjI7Co8JtIE3MIuOATWKhOt84jACjElKeGJSD7oURzhKqp4JBBrW1idyqxGFrtxyMU1lV8pcyG8LyeFFdFxmYGuzuxYuNDdDcNjhJPi0qFWxjs07gE6jwHuc0X1tijRtwqqM/2uQnAfdHBvhk6bUW7ip8PbgsKt8EWuzws38t/s2eCrayH6zeDLHSmN2VF6p2Acs8ppjHBnms2uTiSGWTPMEyEYLHN9Z4CeGmHKdlidS408Y8FxlciKtaG/SYdqbSoDDiIgn7uXmqBzOmfgnO3nBE9qTVzLSUBvs4J7rVbtUZ+98vDC6E+tWbfIK5/YsXDrTlO0YaOOdx+mRR/dwBRusd9ckqD7jfpgOQCn9OCkD/LP0yoXtCXhhhRNz5LSK2qQUpW8A0GPi2bbbCmgC2VpW4rOTcY2qzaorsaK7Ra0m5VKVDq+8JhYyixav7gpuZWb6zbciHGpVaoy6qJ2r8iJDjOiOkN7f7KdHjuZzC5OiRDNzjMlOjbTN3JHe6ODhxfVNq6QujkVqngk7OCxkE1H8yqRGy+/Al0rBtyovVO4YxBbK8cPAn6yk+I54rXEqNFgQ2QnBt7QpOc5x515QIrGttv5k2s+TRbaUGwGufVULHlzGbQbpKK+hG46s3y5siZw0iP/wBuH9cNSLDa8XyKtokPsXFIXYgAJAYI7tzCgmn1nE4Yx55YIp3Nw0dvsk+ORR/cGGN1jvrlQerb9MLhz5AdvAPhh4vB+U1cXg/KauLwflNXF4PymqjlkNjNLRaBuUB25w+uGpGhh7dxXE4XYuJwuxcRg9i4hA7qgR4FHZBzyx1TbZZhkbslsKOypISttCr0d8vdtCLSWRYkO8bZpog1oTRfbaUXOMyduCtCiFh5lKkQ63tNVlWvzZrlOjxK/M6wqo+E5rudWWYLVJvQodHbtk3swPAiMZVbWzjfklxv4V3QMl4bCvuLjaMtp8+HYcAkOQc2DnWaqrr0DOSxcZoIVeHN0L6cNE6p3DVmqsyyd44LnyGRW3tM1DiUeCxsUOz2ttK/NhucwiTgm02LEkxrjVZ5zljTFNbZLYq8OCzylpm+oJTbvTnRZzfZJPiQWzYLLTKSLHWPadidVaBYDZhHRhjRDfGfV+AWKBzpTyp7FFo8IurTldZgo49meGK7e8/VWqkO93DBG6F9zkUfq2/TDG6x31yoHVt+mGMPbP1yGNcX1mtAOamxoei7KhO3P+yrbkc93dQcLjlRmT0SHjIquF/gqrsitDeWHmKnty4cOLH/ACiba1sk2KHCoF04YLdxrFMheo3Kt4Z3QOEqOOa/6ojZyLNwW4JbVi3Ko60FGLAGbtbu4WJ1R5BDpEOJjGO0vZODE0guY46JBU6PGBHtqbiw9GVNmkLxkV4Ty128LjLvBV4ry9284A9jqrghT5w7GAPE7Zqq4PLiZmQT3QmuNc2Daj7owF5saFJuGjw52Bk1Wc8W7lpE/wBKvd3Ve7uq93dV7+6oYocR7Lc43KZwQwC6QaNivd3UDn91TwRREnWJ2Bef2Lz+xBzJ1agFuRCYa+awC5ef3V5/YojhcXk5UKG6vNrQLl5/dXn91RXNuLyRkFQ4UStWE9nOr3d1Xu7qvd3VpO7qvd3UWNJrTBFilghNeXBwaAc1Xu7q03d1aZ7q1h7EJPEiokOtpNLUWjYCezIqmxwVV3Bis2U7U1sHOqtlbvU9owAKJE3CSjP9pSC0grTgc4Cxt/Dv6B9OFrecL+R234As1CsOxV2OVV6MeCM3aN3CReqPDyCNlZjrHsO1CPBNeA+47uY4BRaSc+5rjtVac4W7ci8X5MwsYy/aOAlJrobtNpE5rWUnsCe6h13RXWVog0RzK1S0YTdJybQaK3NhXkZHk0W2C/8AarLuBMPddhnhvV6nuyBwAwzyApyy6u7BdlNAzjumjRYbs86XMgXNrR4g2+aMiYvTocpRRfO9p3owoo6Dv4HHx9HY3ei9ydRSBi2NsdtCfCDpysmt/QhYS43BRYkRtV1pW8oNrAE7StYySEKHEc+INLcFi4fxO5Ci0XVN0neueHf0D6YbruCns2rGNNh5FarMFl6kUHAEKYBB2hFjhMKs0fluu5uDidU7h2vlOWxeUUe7a1EEV4TtJiEWEa0B2id3Ng8lpRz7gT5yJY8Ob9FWF+TMLGw/iOCq7NpXkdEh4vZWnk7LLU6i0p7RIZjjYi2u2Y9paTe1aTe1aQ7VeO1XhX4A4bFWDharwpTGEW2rSClMI4SFpBaQ7U23JtWkO1XhG3IvCvC0h2rSHatIdq0m9q029qLpgy58F4V47VeO1aQ7VpDtWkO1Wub2ox4bmOjOsFs6qjUyOQ4ttArWkoxHmbjktjQ7x4qo6BJwudWuUsvHRrtjd6rO+A3YGuxjmtnnS2hTY4VzusKzHgt50wuJa4jpT6j3Yq5rVzptUTK8nhOnGla71VUZnOKNEoxmP5j/AFl5Q41QTJo38EI2OGMLpVMl/QPpw2Jfom5S5K1yrNNiYFMIsdcU6G68cFF6p3IJi43hY+Ba3aNyLHivCfpNQiw3V4LrnYKkTT+qmLlMZMwsbDu2jdwNUWf4K8pjaHmj1lN2SYJjOLCs5xcedc6DGNmViYcvKXXn1VUYKz3I0SjOm46yJv5l5TSbIQuHrKu6wbBu4d/QPpw+LifBSBnySRVQ3FNLb2oNi2IW5p2rGtGezxHBReqdyGy7aFWZZPYix4rwXaTUHQQYkJ1rXBTEN4I5lbW7FonsWgVbkWKuy76ZO5u9WQvFakdq1I7VqR2rUjtWqHatSO1agdq1A7VqR2rUjtXFx3iuLjvFcXHeK4uO8VxUd4riw7xXFh3iuKDvlcUHeK4qO8VxRveK4m3vlcQb8wr+Ht+YV/D2/MK/hzfmFfw5vzCv4a35hX8Mb8wr+GN+YV/DW/MK/hrfmFfwxnzCv4W35hX8Lb8wqz8Lb8wr+HN+YV/Dm/MK/hzfmFcRb3yuIt75X8Ob8wr+HN+YV/Dm/MK4g35hXEW/MK4oB/WVxYd4riw7xXFR3iuLjvFcXHeK4uO1agdq1A7VqB2rUDtWoHatQO1agdq1I7VqB2rUDtWpHatSO1akdq1I7VqR2q2HL4rm35OMjDN3IA6LbsvnUgLUYcOTqU+8+opCb3uRo1HdN51kT7BY+kWQR+5TNjRot3cgf0D6cgk+/fyO9W4BO/BmlCd+1OAGabW8DE6p3I5AExN6k2I5o5itc4jpWsd2rTK0ipztysYzR+mQGC6Xpe44LuGcw2iU8iu+7YN6meAtK/KM4h8FVbnOKNHoxm46cTf0IvjRA1jdm1y9Vgsa3dyF/QPplvc1pLWCbju4KRtCm3kkwqpKIJTeexF3nMtyRVJNltmRF6p3JZYJhXKxTaPgrldh5tyrs0fph+GCiz9r/wCJUWhUigB9ALnNrGFZLpVKgwNU0PDe0KK51BAhNnaYWxCK8ipR2mIZqB+IynEgxC11UXD/AJJU/rv/APODURO4UKLCayq+IK1dtu5RKHBbCxboe1ltqgfhrhDxDWu821QoUepVgx5Nqtl5yhRYkv8AoYleJ7lWf1C/CngaQYf3KKyhUIRIAlVdip7FFjxZV3umZYI8KPoRY2K7wAVKokvzmQq0TpJX4Z75+6o/X/cr8G6n7NUTyap+ZfWbNUUQBC/NhVnTZO1Qfw9oZiYjyTNttyj0J4ZioMU1ZNtX4Z5FBEStBFb8utsCoMdsIQo8cVorBvsTeqH1KhQGCbojqqpv4EwaiA2qQLZj/gVJ/CKUajaS0ttvDt3/ADcqZTKRZSHkwYQc2/n/AOblTYlDh4yOImaJTncjBp9EEKFEsni5c6/DXfh9Hxz3CTvy6yoNKpMFsGnP0m3WYGUmDKuy6YmqV+IOxePhRKozLNn91Aj0gNrFpFgl5pUfF0P8ljnVTifNVLpkdgieTMxgYbibVSIFPokOPDiaDRm1F+Jw4TC+I4gADavxVtKgOhFwmK3QoNEjGr5QXMafamSPonwYoqxIdJqkfFUAUCFDrUhleI97Zk3f3VC/FsU2HHj2Pq3Ffg/U/Zqo0CJOpEiBpkv/AAyBR4DaI0th1Kt8/wD9UKhtbKDE/MLNlxMvBRqH5G2JQYRMIwobNlyjQTCMGi0k1MU4TLdy/EqfHug/lwJ+dO77Jz3XkzOAficCGx1KjRKld40P+SUT8QpMJopNHfVD2CU7v7r8J/5sX4f1p/8Asqdjan/SwRi83mP9lDp0WpjYcpSbZYolMpj4MOhQRnOxeko9KayoIhsGB3unDXfdu3qeC5aK0VorRK0CtU7sWpf2INxDxPeEaNRz77/W5I/oH0y6XRjAguc9uYXMnWt270TwVnJQMATmPknwz5p4CL1TvQG8G8JtLbbCf2jB8MFGLiAM6/3Sqf8AhlLpDnUeO5zGW6HQosGK4ZjHCc7CogP4sww3TzTSDcqfS3tbEcTVxTjpf8mvxGhtosKhfl1gIZlWP/AqVRGRYbIj41ld0vVXlEWPR3icpQ3zKkKc7uj+yZGium50QOcfiiWuDhi23KD+JRI0EQi11lfOUOkPjQXtix7KjpytVLhUeMMXGhta+Vs1+EOD2kBrJmd1qjRaJ+KMhwTot8oIlYokB7mucwyJaZjBSS2IGxRSA5ttvmr8ajUqI0xogbzTsVHoNHpDGUmims5sSyd6o34RjmxaQHYx1S4X/wB1+GCBSIDcVBzq75bAmsixYUSsJ/lumqDUeHSgWyKgfiBjQWwmOMw58nXKNTjHgvZGimQY6ZX4YKFSKk4WdKR2BCPSIhiPLhaU2PR6TRg0MDc6ImMpb4L6kPGhwfYCmz/DYMF8RxaY87VHNGJh1Yk2FrlR4bYtaHi5yBsnNU2DApDYEd8TNcXVZXIxqZ+IspENh0ccXL8IdRo5a8aQab+lUb8Wo7psitk9ta1p6MNOhl4rmLozt81UdznBok60+6o+L/F4bYL3uk00g3KmUClRAwR24vGTsEpqPF/EfxCG1rBmYo1iT0L8ScyLi4s82Rkdi/FRSaUYj5ZuMfM3KgOhRQI0OkVgJ2i1yx0EtDoz2vc2ds9qoRo1JhQ4tGbUeyIZbB/ZUL8KZFEaLAE3Obcvw3EUiADChSdXiS2BUONSIsKIK9f8p07imfisGnQfJXyiuJNolzfBQ6dZiGGpXG0SlPxUanQ/xCC38PiuMZ+eM4KkUmA41XPm0r8KGOrV2Vn23mQvw/8AhTYoh0mC6u0OOkh+GG2kUiTnSMx0+ColFo1Jhsj0XTbFMlQ/wgRmxY8I131Lhf8A3VNESkUedKgyZJ91hv7VR6DSI8P82U3Q3TkFCoNBjUaFQoIsBi2uPOn0eI5jnN2sMxgd7pwOpjhmNtA2nKvyJBxCJxjp3Xq2K/t5K/oH09DWLoU1V2FBwM9iETY8cBF6l3IL+Q+S0iVeUveCxkO2Cf2r1X/X0+2hRntdCbKWaJ2c+XJVRa838yEeOPytg9ZGjQJVzYfZ9Av6B9PREt+B1qZGGw8BF6l3oGYMijR6Ra+VvtBCJCcXQz+1ZxDX7961rFrWLWMWsYtaxa1i1rFrWLWs7VrmLXQ1rmLWsWuYtaxa1i1zFxiH2rjELtWvh9q4xC7VxmF2rjMLtXG4PauNQe1cbgdq47R+8uPUfvLj1G7y47R+8uO0fvLjtH7yNWlwD8VJseCfipGPBHxVtKgD+pcdo3eXHqN3lx2jd5cdo3eXHaN3lx2j95cdo3fXHaN31x2j95ccgd5cbgd5cbgd5ccgd5ccgd5cagnoctfD7VrofatcztWuZ2rWs7VrWdq1rO1a6H2rXQ+1a+H2rXQ+1a6H2rXQ+1a5nataztWtZ2rWsWYQ5527ljo82w595YiDZEl3Qpn0C/oH09D1RtVqDlMKILpD78AIsM2jxRplDHWQ/V9AtiMMnNRbEhNcDerLvQQfDdVcNoVeK4vcdp9BhjHBgAlYEXvdNx2+gRSqW2ZOrhb06LEM3H0JLCMFQizenNUWj3ZptyZhobzDIESEZH6o0yhjrIfq/oSKXSxNx1cLfzoxIpmT4ejHj2eCESGfhvQp1GzWudVczcfSExDkPasU8XWHs2q3/Cvl0fPkarGbyjEiGZPDTJmeXVRen+7wZ6/7ejxSIom46I3YXRYbZRR+7IxYsaNI7li4sbPF83yQiw3zYTKRTI8UuExMmsuNf+4ocGA+tCcWidaaGNiuZO6b1jaFFL5bJzrJ4jF2MabgdifDcJVSvKI9ZkWqbzt2LHRi4GZuK41/7iZDoz68MymZzU4sRzBzvVaiRiSOesi1wkReMOMiEshj9ydDgxjjPenJGC8z596fEgl1ZttpUURa2bKVUp1GdPFgu22oQ4U5VZ24C6lRar611eVixjnuDN9dNZRn12Sttmnvg1q7RO0qLja2bKUin0Z08WC7aqsSMWHcXqI6BHDoguFefo+H1x+nooKWGM7c3gRgPX/b0eALhkRWC4OOE4zRfZW3J8eDFzjs2INjzO4zmmQpyrMImuMjupkKc6sUCfxUIQi3Nnen494vrWJ4q62fwQbW1sj0bFDo4Ew7b0KrvJXGR3VipzqxJT+KayGWgh085RXRojTO2xRIouc4nDMGRqO+6gSMs8KjfH7JjHfzLAqU3zTIt6LU/wB56b7mEe61DpUOG7+ZYFS2DRMiOi1Rel6EQRQzNlcmuMUPrHd6Ph9cfpySs1pIWg7sWcJckmcikv8AZlwIwHr/ALejppkQG8W4XRH3NTnG8meF84lQNTm0cPlOwg2FVXkYwysTWs0jDMloxO+oDI7ar67TfzqAYUQtmTOW1Y1gtlXaobw+rJ16o1IZVcxs7foi0RKzGbNx2qQvzloxe+oQjtquJBtPOmuhPLDXlYi4aUpy5wpGzDiGPFaqWnmnNMMSGWNY6c1BhA57DaoL2mRD0yO0aQUT3noOhQy4VUYj4JDReZhF8GEXi5YljJxKrbEGRmVHXqjvbeHzTIzfPCie89AwA8tq7Ci+Mx9Rttrpy9Hw+uP05FJrZlVo5/pCAAk0XAK+St5OE1u154EYD/qPtw8pg9HL6pVmc03tWsqHc5ayv7tqlowxc3ID4bi1w2hXsP8ASq8V5cfomwoZbVbdmrSZ3U2kPIrtlKxNxxBq3SCxcJwqznaEXG8mabDY9tVokM1F7ryZoQoZbV5wtJndTYsQis26QQZFLZAzsCcILhJ28J0R2k4zMsNaC8t+6Imxs9oCrOcS7eUGRiCAZ2BFkJwqznaJo0lpGMM9i0md1OhPLarr7EYcEgNJnaFps7qESKRWAlYEGxiCBbYFioThV5wjSWkYwz2LSZ3U6E8tquvzfR8Prj9MB5A6K7SiiQHNgmQp1lfycJkMXMHAjAev+3o+1WhWD/C0Prj9MB4cxH6DPN3okiWyStE8EheeTldCc/fwIwO6/wC36Dw+uP0wHh6R7zV+YZgb1a1w+KAhgDnVZxmeUS2u4IYD/qPt+g8Prj9MB4eJBqTLyDNSPZlc/JAFZcLOCGA/6j7foPD64/TAeQZ2kpYbFz8l9p3BjAf9R9v0HhdccB5DnCa0fFaPipbOS1jcp8GMB/1H2/QeF1xwH0TIXcIMB/1H2/QeF1xwH0RIcKMB/wBR9v0HhdccB9DyHDDAev8At+g8Lrjgd6VZgP8AqPt+g8Prj9MD8tsJkqzt5kjBL2v3EejWjdgP+o+36Dw+uP0wP4AxHmbnXnh212FtYTExeORZos37FriP6F+TEru9UiSquaWnn4E4D/qP/r+g8PrjhBHJhWcTKwT5DWUnGSmFO5VX1Xt3PtRMPVOtZwX/AKj/AOv6Dw+uPLxE8ozq99S0ndwstmC3Ob9EYUSZYd2wp0ImcsoYf/Ufb9B4fXHl8p2cMGuGarK010Jx5h9MpuDFw/idyFCownDaZl/rH9B/IaTmtJrMibijDiD478B9GTCrylYMpqxcMdJ3LyOiHM89/r/oSKHSzIfy4nqow4gkfqj6TZDhjpO5eSUQ5vnxPW/QsUSlmUtXF9XmTocQW/XhLWg+h4ECFmiLDrvO0/obHbFtMBs2O9J0PqB+htP6scKHsMnC4qfoWidQP0Np/VjkVvBSK3jk1D6gfobT+rHIefha2w8lofUD9Daf1Y4eblZw1U8lofUD9CYhe9wi+aJWZFP6scLYFfN+RBFHxhjS/MLrh0egaH1A/Q2n9WOErxcxiqwrG8DIODuccFZyOh9SP0Np/V8FUhtrFB0U14mwLOu3cvrVGuslJwnwFD6kfobT+rHAva6LUZDEyBeUyifhgbjG2OIt7TtKLnGZO3h7LAtJXq9eTxLC/RfuKqRR0HehyOh9SP0Np/Vjgc1xHQeSh7TItM0Ijoc2uvadhTqRBiThi9rr+R0PqB+htP6scviUe6vnC1OhRRWY68JkSCXGG/fsPIqH1I/Q2n9WOHlw0sEOKPNKD2GbTaCsVGbWaVGhN0WPIHIaH1A/Q2n9WOXWvqO57k2Tg6tdJCBGEnMs+GB1JFsKKew8hoXUD9Daf1Y5NKG3N2uNwRhQDWaywk7SrlsyW86mLFrn9qhQjGrsLgM4TUPrPtyGh9QP0Np3VjJObbv5BjKXRziKvnWTTiGhrGCwcA3DB98fVM6z7chofUj9Dad1Y5IHmyC05zvtgh0cT9Y8AGzswWiSg9YPqmdZ9uANtvA0PqB+htO6sZc527uFa4XvcScEWI4+dIKxSwXHKBcZlQT7Y+qDYrA5s0X0V8/YKLHtLXDYeHofUD9Dad1YySZWDh6PAhMnExYMzcET5S/tU8RDJ51Ee6ydtmRzq3IATnVROd6HSrFKK0V5SDtoRgxJE3zG3JkUQDPBLKofUD9Dad1Y5HOVWFtemQ23NhtGF/u5NylDaSVViMLDzjAFFG4odOCS/oHDUPqB+htO6scixsUThM8SpNzWpvVhHA7nGEzC2BXrSPaqL1AwyhRC2d8k3GOrOrG/C73R9Mmc+BofUD9Dad1YyZHhWMlKTMDerH3Usk5FD6kK5VgVa4oEEgjamxY0QvLpq9OjQ212y7OAMtuVROpH6G07qxyGEx4m0m5W4IlYzlYEXHdwND6kYBhgdH3wOBuIlwE3nollUTqR+htO6sZFtyzbspsKGJuctBveWg3vIY6Qnz4YPTgsUXpRwVWCZVgyqDEnfClkwPdwtpAkC3NNl/C0TqR+htN6scE9znFkNvnS2qUIZ21x2q1OiO2J0R5mVYqsrU2kRc2VzVbgjS3qSDZyWLhirvO9VciWCgxNgEvD/bAcLqN5sq2F0NtJYXTFi1gWsCa6VjrQd/BUTqR+htN9wcDi4Y6TuCxMKdWe3CyH6xRwQC8ybWwV4rpBVaO2oPWN6L3mbiijEOiwInIGGEXmdSLV8MBwSQ9ppCc2HAbIGUyV+bGJ5tmR5HSBOG82HciYURobuPA0Tqf0NpvuDgcfSIgY+LbzyXF4vgtRG8FVcHwhvchUeHNDdhwwvfH1wMgDTBrHB8EVLflDAN+OnwjXvdOILHJ0eEJHaOAovVfobTPcGQ2E3b4LjH7VZGHYs+KKxubJZjS0Kbr8F+TD94JziZSCLnGZO3B8Ecsc2Cl9V9+EcRWa0i9OFIjtR8mnzgiWXReq/Q2l+4MLYdwN5QYwSAwlo/lirgkTPpTjUAsy40J8Su8uqtBNww5ozZaRuVUUhqvB6Mq3A8b28EBIEOvmJotmGtNkg1ATMhgpTHiYNX7reNhyqN1X6G0r3RgaxotJX5bAOfIixJzm424STts4CrCaXHmX50o0b1AbG9Kk6QYLmi4YNmC7LPAsTunDSf6fui0ojADbPbavyzVPOpkTG8Kj9X+hsd0rCBgMaLJpO/YFi6E0RD65uVsKF2FaqF4qJDjQhnNIBZsw3INHTlAC8oxqRGnLzIVqxNFhYiHzXnhblY1aKk4ZBwM6U7pUlmqk/wBP3wdOCYU8DYkHSaNHeiCJEfoWGgWlCDzSTW4sPeRME3D4KcWLjPZFgHwU5K1WYZKSGC3IZzGam0yPMrXVxzomI2oebavynj4lZz2z3KzLslhsKvW/pTpxcXF59FfmMs9ZtoyGdKBlhhta4hr7HDfgLtow1cAT6XCt2ub+hYpDxnHR5sFX1WAYLCr8i7B0ZU9zTkngbcmdjR7ViBMatzMUhRKrjPPnLCCEHbVLBA6fth3FXIHAE5rriEasVstk1ZGh+Ka58ntd5zbh+guOgwxUnLOMpqcSkMb8EJxpj3VIXYIxadssEzlzwXK0YaXF6G5J4O9ScwOVVtVnuhZzienBD5zJOZOdUywjowwokQ1Wg2lVYMZr3bhh/Oiit6otKsox7y4r+9cU/ei6VV21s8OLeA5pvBT6bR6rYW1m7o/QNtKpmqIrNZv6VVhgNaLArcPQnxJSrOmhPfgsyrVYJKxTOFtUa15rYByNh9oJjgNJuFqmr1YCptcWu5la/GDc5Oa12Kh+qMkRITpH6qV0TaML6NEcQHbVUiiw6Lhc79AWwW3XuO4JkGHY0CUsmNFFpaw4BLAeEokBurxYifE8knKSmFBiucXRGGocMhuU3GZwzybVWxrB8VbWed1yD4DBDcNt5TWRY73gtNhOEYoTex05b/QFn+IAAJkp8aKQHObVqjIiQaODjAZVjsVSJSYhb0qQJtwWt4aED5sJol8MgcgOCPDO6sPhhGRfwNHO91XtQrODZ70WM/Oiezd2qxkIfBOeWtm4zQxok3eNiEeE4RYZ2haK1YWqatUxapi1LFqWdi1EPsWoh9i1DOxV4d27dgu4K5aKuVy0VMsnzLize0rVAfFWwQ7pK4u0dBWpHatUO1arxWq8Vq/Faodq1cvitFaKuWitBaK0FoLQWitFaK0ForQ8VoLV+K0Fq/FaC0FoLQWgtBaC0ForQWitBaK0PFaHitX4rV+K0ForQWgtFaK0VcrlctDxWr8Vq/FavxWpHatSO1cXaekrisNvuzWqHatWFoLQWgtFaK0ci5XK5XZGc2s76LUsWpZ2LUs7FqmLVNWqYtUxapi1YC0AnuEMVWCZK0U2JGNVrbbtqDG0gTdvBGGJE5pDBLAHF4luaU7F1i4c9mTZl4x8OoPa2q0qeEoZVmDOcs0ZJymx6NGFt7Hb+lfmQXADbswWcGHNsItBUMOdY1to9rBatmAQIh/Jfv2Ix6La3az+3BWKszs/w/YLMifncHjac+ruhjSKxbG4qFsYMNiYIkVxhGwg24G0cbM44HEzRybcFgyZhtRvrOWOe8vLd9wR/wC2y4ZN+XZwwnqn2OH3TmOucJLGMJiQ9tl2RdwkwqtgPOVnPDuZqcITWitv2KFFIBc5tshLatFaK0VorRWitFaK0VorRWrWgtDxWr8QtV+4LVfuC1XiFqvELVfuC1XiFqvELVeIWq8QtV4harxC1XiFqv3BarxC1X7gtV4harxC1XiFqvFarxC1XiFq/ELV+IWq8QtX4havxC1fiFq/3Bar9wWq/cFqx3gtV+4LVfuC1X7gtV+4LVfuC1X7gtV+4LVDvBar9wWqHeC1Q7wWqHeC1Y7wWi3vBaDe8Fqx3gtWO8Fqx3gtWO8Fqh3gtUO8Fqh3gtUO8Fqh3gtUO8Fqh3gtUO8Fqh3gtV+4LVfuC1P7gtV4harxC1XiFqvELVeIWq8QtV4harxC1fiFqvELVeIWq8QtV4harxC1X7gtV+4LVfuC1PiFqv3BarxC1X7gtT4harxC1XiFqvELVeIWq8QtV4harxWh4rVrQ8VoeK0PFaC0ForRWitFaKa5sFjnS87YnxH1mONu9ZkncwKLXX7siflT0YkV03FSCOCalkT2ZMmCTBpO3YMWzzzbhv5SHOZbtqqaxjYzIMTa3fgu4YYaP0OHjwW/hc4yVlnBXq9SCk027ThvwXq9Xq9Xq9Xq9XprJ2uzir1er1er1er1pFXq9Xq9Xq9Xq9Snaz6K9Xq9XlXlXq9Xq9Xq/BepOPQcF6vV+TfkWqwz5PDb7AwnItK0QtykDlEqWzI/6h7mQxaaoQZRHNqDY1F8R0gpNuHKrbFenlrK0xtKlXxY9ixTJmSpG/hwr8Equ3BaPFWjDYrVYJYLsFyuVyuVyuVyuVyt7FY2SuVyuVyuVyuVyuVyuVy3c6qtFn1VyuVyuVyuVyuVyuVyuVyAIs2ouqq5XK5XK5XK5aKuVyuVyuVyuVyBlZtRCuVyuVyuVyuVyuVyuVyuVVws+mC5XK5XK5XK5XK5XK5XK1vxW9XK5XK5XK5XK5XK5WK0Ky1XZbubN7Mq3BZwsQ9CrNJB3hBsZ+Ma3es1pap11ZykZFfY7JuVy0Voq2GUXGE6Q2y4SWJhv98LikDsKLY9Htcf5YlJPi0V5iNZe0iThwmdYs0S4aZsapASG7h3P2vzR9+Rtftbmn7cPVda36LeDceFsW7hd+XOc8EuCli3dirPhFo5+AFuk6foK3ZlyAmrVprSQx0JrhzWFVodMxR9WIvyiyMPYcqr2lp3FWuVjwrYoCzXTHRgI3ZOMFoNjhvTaRDfi6wndejCe/oMr1rB2LWeC0wtMLSWktMKZfILNeBzyWtC1g7FphaYWktJaYWsHYtYOxawLWDsWmtNawIF7rFrB2LTC0wtMLTC0wtYFphawdi0x2LTC0wtaOxa0di1g7EAIgmeZBgiCTBVuWsHYtMLSWsHYtYOxawdi1ngtYOxa0di1g7Fphawdi1o7FrB2LWDsWsHYtYOxawdiLDEEniqi0xLRzLWDsWsHYtYFrB2LWDsWmtYOxawdi1gWsHYtYOxaa01rB2KTngt3SVYPzVp+C0x2LWDsWsHYtPwWmOxawdi1g7Fp+C1g7Fp+C01phaYVjpFaS0lpLSWmtNawLWBaS0lpLSQBiyN9ytHxyt3AVo72QWATJJmq1WJHf7Sk38sdKzjPpU29itGTJCGLmZvoK9WGSvV2CUgrDk2bFaS47gs3MHsqFF3TZkXlaRy30d777WAow4g6DuToTxnNyZmwLN7eQZ2l6qmeQOjnzbunkrI3ri3p5B9lWZa36cPbapMzidili3T6Fq3dilwA90LNcQvzBKy9qzZnpUpLarRgvyvKIzDiYWebL9wToxdnOWdmHwV0xvCvwXzVgw34LbVb6DvV+C7Der1otPOs8zw0kG2oQ8D74bRJWv7FJt2TLACzSCE4daNtGxRTFazMbMSF1uGezes23nKmeHkFZbE3+ryJkHdaenksSDt028hmFXZ8Ru4bMEmC95uQg0Zw8pN7pTMvsrKREE/aXGYneRc41nHbwBwHow2iqpgVhvwWjDVgwnOX/WUkVv+3DtKLaPAbDG82uWc9x+KncrVmuU5y6FfyoYuExkW6tzqrEb8dmVbarlcrlfJa9s1MZ3Qs4EZd6sy6hNkRpYpVitMq08BaJhSuHNgpP8Ap3rNJVry4+C0ytMq1xV6vV6vWktJXq9Xq9Xq9aSkHFVWumd60ytMq9Xq9Xq9Xq9Xq9Xq9aS0lpLTKtcarbSi4uvWmVpLSWkVpFaRWkVpFaZWmVplaZWmVpLSWktJaSvVjkDWuRLXmq60LTK0itJaRV6vV6vV6vV6vV60lpLSWkqzHGYvC0itIrSK0ler1er1er1pFCLTKQQ28M9ZSor5vIzZCwIveZuNpORNpktYVa8rSWktJCbkTgGA5RjxtSy/2juVRwbUncLFmukdxVuCzBf2cHcrTgvV/CAKpDEgiw3FYyA+rK8POC21WWcBYZKel0rPhS91TZElzKbG1/dU4sJzAfWHBgtvFqc+V5nJWED4LOkfgrpdCmLlKYPRwEUG4wXTUgKrdw5DzKTbsq9Xq9X8FLzov05Pzs+mXer1er+AmDapi/aODg9B+uG3ItOCwTWgVoq8K3gagsF5MlDgNaWNhiUjv34at7dxVrTW5lYKqtOVMNV0vis8FWhaIw38DZlGO6wnaVYS88ylDAh+JU4jy7p4awErPiVBuLkyCyFjSGgEvuVHikNBcy2qJeceBuVyvVlqmSGrRrHnQFw3cC22QcHN8OQ1nWNVlg5GG70ZXCwcnE9E2FFu7kUwrNLdv4JoOxgwDJlMDpWc/sCkzxVr8F+C7Lkyxg0nbkaNQ81vnP2vwzybASq1jeYrOjBSqTltVkPwV6vVqvW7kFpWa0K0zy7uAukrbXKTczoVuCjRw2dUua4/HhbTPAbeBa/crXgKxwPQv9lpeC0wtYFrAtMK9aS0gr1etILWBAviCSnjWnoV+Xer8F+G9Xq9XrSWknPrS2ArWBaSvV6vWktJaS0lpLSWmFphaQWktILSWkr1er1er1rAEx4dOyRK0ler1er1er1er1er1er1er1etILWALXtQlEbX+q1zVpLSWktY1a1q1zVrmp0nTFw4C+Y3FSAq9JV47Vmm3pwSDLecqyrJSAmtmQX0tjntFwCMOjybR/Vh2dquy5Ytrh0IYuLUPqrOLu3Lu5ZfguWr8Vq/FZjJK05JgA2zMu1FjxJwsI5TerytIrNzjvPBTN+5TPDX4L1er8LYfq8pdD34b1er1er1er1er1fwPtfXlj/AHgqzTIr84D3gptfNTdYMuWkOdT0CrLeAs5Pdhv4CsXT6MH9RWYJV21j08q3lbubgufk1Y3NtU+UgqsLncl5+Vn3sNhkpE2Dgb7Nyk4SUq601er1fym1WcIyrEdUB0J2FQoks0slgsWefgpNaFq2q2EFiJYtzhmu50C+Tmnzm5drG9isrNVVhmN635dnByHbycN2ut5XLa3kdYMYeYiaL5AT2DBI38Ndwh9/gZy5Bv8AQNFzs6z6ZbYtWtJAiTmOVejVYbvV2FSiw3N6VnTVglkWqw4LFogq6XxVhnkyValO/oaoAaJAMuHSrsmQV3IrsmeRcrlcrldguVyuVyuwXK5XK7BdguVyuVynkXK5XK5XYLldk3YblcrlcpO7Vcrsq7BnbpqbSSpVe3gbMiGjwMyiRy2zkVpnkXq3CGznDJtClBYXHebk4RYkx6uzgbCr1zZNZjc31jYEIocIz/W2DBB9z78tLuWh3J5HgZcxXOs4KYtyc54apN7TlQ28COSX+g+bIPRwNmUHOhz5prOuFwFwUX4YIPunDbyoN3ctLd/KJHgJ7gUTgsKvV+TM5LeAl/gsYHt2EYIXRgt5VPcp8tmp7+USOW73TljgBwA6eV//xAAtEAACAQIEBAYDAQEBAQAAAAAAAREhMRBBUWEgcZHwMIGhsdHxQMHhcFBggP/aAAgBAQABPyH/AOBnpS7Dqj/B0mmGcVcZfnpcIsslb/0Lv/4CCRmg4lafnoVDCJ2b/wDWfKgDnVcdH/uYaiVE1X/voIGND/5KWBr8Wuv5SQ/BXazKdHL/AMRBBHiOskUolFcsUGkJTN6COdxY0vxZ6dAkqI/DaWFoPwrJ5E2zVh0KJFJERO6zH/zUMynQXkNT803kO3Xjcf8AwbKLEpWqZf8Az0Q9zo7yqOuiaVlIblt+LGAu3WM2QJhMg35KwGvHYRLNJTpByp8xv+emSxNq3/5KfEggmcIkXXoGx6LQhhv8hFhXpqyyYQtT6DkT8CfHa4MYMlpb6f8ACn/kwQR/0khBst03rchrqNRsSTwef4qHCdluGhBrEC7Cq/Nyxq/8OCP/AAsg0NyEH5qkwtKCRR2fFTxIwIuR0yRLZHGep76vYbxwUS58/gb/ADZJ/wCFAyxDSIB8KSd3H/bhUxQKhLeJAiQV/gE6ZE4fRlLdZZMGiMEEUEyvNBXD40SRSfGZy5rVf4KQx4FGFX3C+w8SoQ/lo2uO+ktE0Q34ayAnD0CJKAnR6/8ADSHH4KRQsoo2UP8AE5gGvl49PyYGuBCYSFuvIYhVETkTOtH7iyKkqvkGY20odQxhWgp2Dxgj8zPHLgRMH1WSmJKCq1Krk17EQgSFBEcv7GljbdW3mSf8emiluFm8BEDiReIr48C9pFU2XDqx9+CJPRTUQcMf/OWYZergivDAsYENW8oozHqjUMjgJ0hSKpRzieeRk6EQOZ0Sdq6Qx3aN85GMkVKZVkU9HVFx0nDGGiukkVRNKIp2ZUGiCMSMWJScbjWEYkEE8EEG5X8hQSXbsGSVv4ZxCUr9X8E5N+CrImHVxMIVTHuoolf8KpRPn4MEEDVJiyzEiMk4JkpDawpD44/4m/DBBBMbRMYEW0VoCYhC3IIIkuqKxIrT3m7ccEQ0QJCuKkljAuO/doakRcUTCWJcVdepDA3s6ShNqPUo6K5Ro0UqHYWuBSE2JpIJ5NYgYySUtjWUhr/Y3oSlRNCCBCBYp3KOoawRDBndtcEfh5WrxLCL9VgfmwH/ANyMDmbHkhObSexVWmSWQ34MEEEEEEEEEEEEEEflZYyihb55I0XcvlGsvduQK3u3LLseY1WXduP0pXRcWy0HiZR9gEqad2mUioXf5G+1RIWpDVjkxr9+GZCN5VIrlLKiCEOJUjgV+ZYaQ7hZWRRJZC4iBaISR0k+WYSRqVAohFCizECdmCEuaSVBXkSmBiRDVGMbhKWTuhV3RzJKb2hlxI6dQNr9weJPfs0K+DZqycgam1YZf70Jyp118ncD3O2P2Z3kHadDMlEBxFPxk+EgggggggggggggjxnGVfxlmLrEUNq1l5ccECwFybL7EEASKkbLlrzGV12bSN+CkLxn/wCYa8CCCCCCCOOCCCCBslgkTcUdsrv0NhbSFEtSpd9RJUX5h2C5ML+2Ej5RB+qxIOe8S0ZTVSXCUlWTVDV00XTpzQ371Q90KRWr3IkFyKUZC50pCOLKE4RLmrCcccLqKglCdRwUjH2Yxh92EkNktdLId4H1GqXet7i6hZSzaB6odHV2F/lE3yj5Ck93ecuzfManUChEzA7zHs9o/wBi3INk4ea+RIwTguQQQQRhHhwRxQLxiABiB+BuCy6N48eJsjRHMSE9Ai35kLkvESEEUFv0lzIHjZZeSzKrPIR1fMay0jfgpYCIPEvXywS0WKqypwVgomtwmbzt+omv0ZO1qJk28xlZiGnlgggggggggggjBBBBBHCEEEVFfBIYudhJCenND9BmhFIJW3qzJKASnQY+L4Dzu9yIokobVDGvkPuBV00yrzbDIZRMNRCZ3ISwS9K6tWSOTdZoFFB6ILpivyFeeqb2cFWg46DQEl2VpfUSJkVTqhrsO3d5jeujEqAzs1LbLYHNVIclagR6B7vQ0G2Q/wCOT/GIVllYUmBXWR3CzRo5RsKJAdnS9hnQdlTsxyl6GmdUajaNy7gq7J8jWED2Ep40IIIIIIIIIIIIIIIIEHMmoSZkHOonZ05n1gcFOkHkeahp4G7jCoKMIpSNDcyUqkTyUqnXSckWhr8OCCU/SQ49KhVQl+4zI1WA3lw8/DRIOZJKW8kU4+oWXLLzI9E5ddxPwMt4DfgpYHmRPU0cCmYwJNxKDaBMUN35l8i709yTve4td3bne+Y7nyGYfL5h96e596vksTPNfJnKCe6Zd36BLq9xz9/0O0/B3b4O0fApe16Hcfg7r8Hcfg7x8Hdfg7b8HcfgXYf0d3+Dv/wds+Bd3/Qs3t8jtPwdr+DvvwLuP6Hk93kItMXpEsJEl0yTJyvLxL2BDrphQ8uCDfLvdiV0d6IiYYbH4jQPi7JLN9Seo3OeCdZjd5jb1YyPDTJExKL8yj/RyFwqS6bdB/cYhp5FF4HlyBLCyFspoeDOrcypbCm7Podl+B5fb5Hbfg7L8HYfgp9n0O2fB3n4O0/B2n4OwfAszvcih3fQ7J8Hb/geT3OQs7scih3fQq9z0O3/AAdl+CK3d5CyaNK6rcyGIK+bY1fz+TMekL+J+Rf2F8i/pL5Psl8jh/f8iP8An8jWvi+T6YQuvTEtfqGgosaXEc5lsh+aLPAa8Nqo78MEDRS9U+BmUcu6lVgrQlUk3IQQegr4aLhqMK2VUW3rcalKSPdXz+yqNjfgpYUlsKKbQBamb3/4LcmThCneo3l2cy9EljRf+sjWX5z7rhFPozzD/sRof7BAcNYZxC8tRsnCSSSSScJwkkkkkkkkkkkpJkgY9fhEJW0WU7rjpFaFrGpw+5QnyA2WAwqkzmQ4DIIwQRwIwnc5sSRhOcIKEcCXCQxouGX8ChIsPgMeldBu0HcktanvfAMaFqmy6ojBZCSSSSSSSSSSSSSSSSSSSSSRMW8oaD54IAhaoyZitIKNsex+6OU7PMaez9lx6E17o9w/P6KzPpFYaXsxPwXdrBIWE1qaW5BY67J7eQtToOqFVhNtlEtyXhogENlaZJcw9+A34KWBOnIUasqhn5/+S3Eb7Z7l8vuj3JgnwGRIlqSJa4zDZJJOEkkk4ySSSSSSSSSSTi2sMLMGUkGumM+X5HhDhci4/NIVbykUFVpcIuKGYNntuOR27+jsH9HcP6O/f0di/o7l/Q8p2WFpK1OYgcCEpISmZBHbod8/o7V/R2r+jv39Hfv6Es3w206qhFCeE6FoTnpkx0WuQuwfYfevsd2/o7x/Q++fYsdoONVA05GFSgcVFJElTs9h5rF35CqwS0JLEsHe4ilRJLTzO8fsW0YtfCM3JLUJJrlzku0gYoDVZjdjckkQTzrhe+g8k1WMkk4SSSSSSSSSSSSSSSSSSSLwwuSJkR3tv5SKDUlHujsJB1EZh9QmOcqieMkexy27GiBDu2EycjepSlYTmlAzYtSTq3hCKDJ+BLiJpwTiT4SRXcBSewlUATJLPO2QjwyCqW+du98BsknwgBP5TohKSukHPBImsjxcOFBqjjITb7jQ1pUM1RJUKi4JJGOP2mfoI0Veio8JJRKJG7zOVpEi4XK2ERYkklE4LQSjr1wK1FX28xOmC9S9VH+yITsqsUu1qf6wygDaRfYm1xzcn6JzUbEhXMhwonhJOLlbc5vbDmtdfkySSSSTxAkkhE9jb+Sin5JR7o9BCE+RvHZGkiU9hrxEh89mEZitAM6H8GidVW2xHNHexIZooUInuLvDzxav5SwKdLAlnZ0sirh/n7suGTxT+ck3RDmGG3ZOVdLYmR8CdpRPPBZiuInMNI1cZldwHQcDW+M7D+JQsiN+RSIEK7BSyNVlZA2HBqRwIVJk+kCclCHRFFiqCNOx5knY9zuPyMnDkrVcxODkP2BcbfDC6CohcVj+jvvyNrDLQqMd5vgc0b7Mi0LVw1kZmmCC8gsLBr0W9xyLvImTz65sIO6gGGnCKGoorq58MEMJFDdElyP+FOEiLxhTjo16oQmVLOTSoxQlHiBISG6hqmT+k0BS2T5JXKwJ3Fg2SZcDZjYho425weXy13+Esasp6j7F4w/w4II4mo3VGXgV8xRpoY02NRrImLEnnwOIa7JH/Yn2DFkicCLWCQ7c9hz2eG8j2GoadRsG2r3gOSuYkJVVxJer9WA9BSZQuUFye5vyR5iN0ujORCUXZ0xiUsQNsV9lQUk5DYsugnE3KP6ZKGfIPLoSXEEK9J6T+iwuORoJrUrWZKAmJ1+ap4fm8dBetpP9DWP1h9YZ2Gkl4NgNLE38wvMktjwUxCN8vy1h79qdu1YS4A/BQhftUfpIa4X433K4aX36IWlr4SOMkZh2wgj8lF4o2Q9d9i/C/wAJIWC8KOBZfDGVMJ9pImE+Y1SRmijFV1NVwX+gvQE8TOqrYY+CD3Pd2FHI7Sp6jruUCOGutcIBDabXIjBOq2SqThM0FgUR7DAv74U/Y8LXTN5dBtzXQiXrPZfsTSEp54QWaJM0UtKidmfTA0m9zdZiNI5ItVU3gHFR1KloPU16glRHmStSVqQ1JWp5m/t8mjFCl0CLWNnKPcZ2VOVqI9Zh0OJR370D1FB6RcZ4sGpYS23CIHHkB1QHuJ91+hlC/LiLjuGok99UXCx3ULh+AhCX40jVivDfIY61Fois4WZM7MkX5IqK+GQ2Qlg/w3Rw74OE0OVrwIuJB8h637F5eP8ABQhOzRLNVKNHCihJUOSIaGuBcfVEPKddgp19VqibbhXh1YZUSVbXjT6gB5FdI0JNP50cKvqULHeD5BdDJ5ziwp3ISs0PSGhrIWmt0RYdj8oPV3xnofVFUJibKy7cjMgJJ1/MHuzDg3IbJqMx9BSZtMywbeaHltojtn9HfP6FSxWZHlSbjr60xqYZ0sWj5HT+4L5CVpFPY9VUiO+m6KjGT5SVpxIqG0StRudiPUQCeGJLVqRxqrgUuSsIDWcDb9MFxEsX3PqbfnO8ane9ReO02Lh8Dda8qu9W3yrwqLX6PU+ELTkw3CexKala40JXYlTTbnYjCNBpPLBi4kNbj8NSTQUa5+C2naHCi47roZD1n2LsD/CbtK9S2DCGkEgzcyGYxXXTzTzFZLY1f4EpKFU1ZrXAa4J681qeYasD9VoMszzwMpu2Ti9Nmo9Iquh9ZcpVz4RI1SzoJQ6aUWZkRih3cSFTGxzEf22NLPV4z6BXVfgRIsk0HTUIv0LAqlAkmWoOgrCq0JgSqJBe2Jw5EGXJD+xL2XqMsZlRQ5g5sQhD+Z9A7sF/eD+RqbaTl4UpJv6zop/RBAkTKh1I6tWVSXuIr3i+y8iuaxr2vQdsrcVcwKqR6E7eaRghIlscXTY/bggj8hFx3TU7vqLwvc7Fw/ASFJVUJ8z+KCpairFVdpFHq4CdYgW5Jng9H4U+Ci8cqn9JlHpb/YuwP8BYK6RDJfMhcilRVIVX6JRkOgIw2hmtCLkCdaTcWsRg0Kg+LobnTZqqidxBrgnaqndaiSv+hgiagTuhBN/oAt5ZfTigZBkNVJrmxfpjJRVNCVqLWs8EjKUvVH+sCZzItfvo3yQIt8IIY2TPmJJ4VVXvchJjYmUbdArUtLbzBOEkkiOVm7gixq6DyDNMWG+sSTaimT6INvuO51GSHT0m0SZg+rocFUZSUq8ECiMCQqUbcaCSoS2uOymq7JbcsUtCUtjS5XGCMCxTRH5DuWp2PVhJX30LvAQgt2Z67KslsAZSizHZJeQB8Gt7maoMzwkc5C0/MRcdu0LYrYu58itgf4KFQxqom5pMy8XdCf8AQo7KSWqWXa25WjEcUJctDcmZWybLyOaas8B8D2qpbihZkHpgiTFT3Qh5cgxxNBXwLDTEiZMloN0NYXKjIbq4ZGy7Nipb2bEbQ71lExF/Ml5hhhE1DVJ0SenMfar0Owf0dw/o7p/Qu7fYi730F5GO82yWQ5bHViSkxRzxqtRDmx2T+jvn9HeP6O8f0d//AKGBY6GiFFCERsFtCeranCnW6DR2XoNBeAkxyElThEJFO6xM/sTVCUVpJJ7iHRkyE3QwsOWCYw1wLLs3ZLlq8VEn8heohImHzrOVegrZDGqmmxOQrZEAxH4qEKtRp9RURxSZ1DC730Lx8aEEfUXY5CJLam/IWvzUkvQdKOqoh055IhQsxoROFAk5eCpxFUSmqtZ/DRcd60JQPWt/eWTD/CREXdDPo1u8xlZ3WiEVQ/LSN4amGPDcEuJZomSanHREDdBaqfsbuiKB3L2uIbkSfOqTwGuCoRmESkzIPFKehtqTKXWFhKmRQVqa1FNv1TxQzjUJKzEw82RJH9NIWJcesK7k0pIamMM7oaRkQN72D+qe3Qbhq/dY7cHQzXabCkjS2gS6E9Oew4wpbcJITX2/QWf2Ow8vvdjQ7HYfdfsM47fsR+26CZdadLqZzHE0eQmd/wCg+q93sdk/ofYPsQ9j6DehjtsVO/6GaGriPJkcUktuPQfen0FiIFXvQ1r1TPboyTgCxCgS6BqpJ4kJbdI3HcyYSK1LkJEuq8zIOcE9Dt17HaF6CZ3XoOwZ3aChJU+6xn1mtDXEqFV/I3G2xktiWBnvTWOh1ytJ7haqQkiBOavctpwUNCchlkl1CXlce0QMNEEEEfgoczs4Hc1caUX++hePjWHUBnohSvpKCmVYVQbMfP8AqGPYY1FgxFJH+RTFFwnbLFiIokrNKyKLA/w0xCeRVNZCw+V0JOepOIeiaG5XuM58JvMk0VP05lfViHoQzgrC2zSomtBBMybwT/oIsrQ4wIIIwXJGaWg6k5fMxmkrEggiNiE5UFE5SjSJg6TpsMrD2mBiiRL+QfZCX5Iv7gU/C2CSlKBRzb4KOfSmUmhdALa1NIioutJfkCR8w+xlLmEwd+tXcudkl5p9B/SDHfbsRSht1x9kNWELnJCsFoAj+QfaD7Qfbh/1xF8g+4F/m+3s/Qsl6NLPT+if5Av6AWWG257edAVcpiD8qavLMvgRJqiFI7nR1syVVFYrMhRwpAmJTzw99wF/aH2A+8DyS55vNgkxrseMNuiFVI225eCEiYQksxgogpe736DSTmpeBntEnOlSTpQrIS0Y2S6qqwJY2t+8KT0p9TndbVH5kuBGvwbhlCan5CgWjF7vIuH4LI025H1CnRE1uLLJaDU3JYImMHKLDEsH+Ea8FFwpE0ECFDrXC/xE8GKVqnQc9mLn6q7TatPQeqhmJipJVaT9hOxgSnORsQeQjh3iSFpYnpISp10HiX4aeCHG1UhzDG3Q0QKNU7jI080jPBD1FoGUmVmxixRlqJ0akcaodLUkuQRiS62mN5f0K29dNyEyiLJ0SKjwimTdCWE4OhE3uQJmdURdoecagK4Twwp7IRJzwTwsYsT/AJAVbUeqeEiPd9LP9ntIeBmENLo3SMZJGmmbdMxlkdxnQCFhZ0/QwjCSC1a0nstfVId0FLDwUVy2O66W+rFMKU99P5NjjzzFoxgklBXS6wLAFUTNPXyVR90QlQjdHDQhlT1I7oGIWkndpSeQzsTMygd4yWqGZ58qi6iVskwQa/AvIjatNKyZM7ToXDxUVlSUJEoTV8KzQThIn1GgWDZCRNx4LV4F7eDFyET+CkKCopKlGqyCe2x3JpT5PMfgIuOwbEkxVFWiHxVTTClCHJ2xl/jxpEx8BqU1kRmdZFZRKlNRho2kEmrYW9XhmZyQC2sppJfkTH5t127ESyq6RupWVhVEKkoXlrInBkjRWK3Ew1GiUoOLXCeEkyj0giN2s9RCmWVMG5oQToUTUoEJKEowVnm0iltv9QIJTUU+4wUOn9Jwj+yXH6I2fukFZyqYJgmI5OXCII+hPzEsqpyJzUtLIiHhA3XqlKLwo9GmMRhbpDn8I0MgFtglVEN6taDHHd0Qn0LQOKDEDXZrSURa9JEs5dmwm0TZpPB7MotIJkL0obbN6C+86Fb0v+yJTJer4xmiWm+TDwaXzyBUV1Ry8e1f9zRJWh50KiZmnT4CV1rkh/EUPodFfBG/yZKrG+QMSpEtka6rDJsKDsRHAkITZBANktk1zB0kgm4m8qtEjBE5DTfGQ/kRnm454xJVboN2NOiJEOXuKkcy/lkNTnksgZlBa0HUM3LErqTcfwH0GNKsKbCD/AOQJNCd6lzvGhcPwRcbRL3HNcxjlvM7KicmuFShNi14Xvw0XpHKiS6ew2PwEXid5oMtB8SY8vMu3+AmOy1ibQ0JqBRJV8663EOKyVSOSKq0IcoJlgrhjkNWc/YoIySUrWoj5pJpnKXsWk7CoQiVOmzOUPC74wMik3LMi3LVzn4Hz6rJ6jQQICzMxCtUInDRUICFFxZz5A4mssOqrd6CH9a4byI4SjaVm/2VW/ib/WOyp6MIRuIZT1YHoJwh/wB43+hz6kY9SBjqfU+pInVFHeVDZ1IasE2RqNu3tYPOq95jpFuVvXqGFbDvQP4hicQegh/ZJ4KEtBULAN1OYDPxD9aCUs9rtErN7ilUYquEIC7allEgT69sQQJgihE3clmFyuTy6kh0iKka2FqiGq6PdPcmesuU6yMNNqm7HK1cLUBadVk3IawxEdU1ew2VszlNdDQhbiqX1PoO7nsaOaZUr1FSFnzzbuxSmhE2vwCG6C9zItO2C4fGsK76SmzmtHNsgSUGVYxNTjTsgToaB6BC23paVGsObRqMIIII4Z8JFx2DbBaT/ITHIZDTlNZCyDrpFZ5XtsTmSmQSLZxoMz5YXcVHUQ9VcSKXV7qpGg8vlqImHcdk4ZSLzNYmk1I2aCuoh4PEjVxLyGzZ5iXo0EpUqTNAb3RMgpVDq+rFkkiYrrFF5gapQ1Pekv2JkkhhGpVTzRKvKkc1LrbUrXBJGrSBa5kfUjcn9xsXEmjzkisLemfcHfJAigmtxMoUP6NDQTnX2xJ3nUViK8yf2FoJZs9XBMUJEyVMP6OAakaOYfezyvjgnBDC6b3BFGFGqtm7IVox5kd0TIyBGmsmISRU1TplWNsisotNCik8xEpNjRao2ghrnqL9zSJTEwtxrcoK+jY1BGqsUU6ivNc2HpzSFG6xpS1iRYHiTl8Bq7fKduf8KhEjaPNEC71JocROCMD8ZD0dV+xWO66Fw8FwoYkVLTjZ/wAFTtGI5akRkJlSeoGhmXgLWi/S5My6+aGamY5Ec9grCX33RWPERr1LEgjxVhdo2weyP8lYWcswk1kLvC0Zt5V31IrUSQVib+pNfDkVhKCddTGVRZDV5yO+zynJETEdRylWgw8Kg99UNptjPNlHshGs3B+jCFVeJPMZW7lwkTKvgiCjcH3wy1jcRhSBLlJmpBJTqslNhtNSV5uf14Gnnt3T+x7Yu9i93CnvZlbOyXD6AZ29hMZqSPQqwsG/D9Az0JvfAvckI/1wLPMpaI/p5rFWR3nUnXoNSr3mw2r3mw2zQNTLLURyi8zuBlNRjJbIcSdVMbSNbpQsIeBUBav6v9D2YlCT0Q5lzZV1GtBL2J3aFKoflNkwNqXM8xc0yQMxSSRC1Xc+Y2bpYNCIl0Jum6R8uicYUtpJGnoHznoK5qtRnWNzTVC+dX7IrrKbJclTA/GRZyCsd90Lh+AmRIJWdWv5IynynuMpM4oM25dWVIVineo0gl4CqUv4GKpRjIo1IeqPmK5putxzQnZ/UGdVB5HNZDLDRBHCk2SVWx1zUXKVwIuOwbYHnyD8JHZ46wz7WilDeeSGZKoixSmpp6WYb3bF4psrtOZKytAllQbhFItVKXMQnVtmnhNDxRPGaFI0pK2qF62MbGKq7ep/B0TdQkQmS8X1r+yRTN7I+gal5kjtIuj+iSSYrFcXUkPb9xhoOQUxOd/TC5YrA5vUkbrDdtm4bw/dZCStWqHhb5jtJk5PUGSI9RFdXwSLYYjNzrYUkSI1raym6/hoYPIMTItxd7lcz1aDlhbydj0DFhapfLVw2R2zZamhWfOQiaaeQsxL1MHXkUfUUi00ReM/dZFEq7Q5SQg+y+cHlIew1KZnMbHUtuQN7CskAfRpu3Dro8zdA2Vc1Zj0jt/NsjkZ+tewox+Mh6MVhu5yLh+AmaR9FZ+gzLmSRoKspwlVFGZCBYu3FIbYYZhQTcSPmAxUZgUynVZaEB+3Q/L57Sj5ortsnlyYDDXEnoO4k4UU24EXCdhoO2B+EnA3FSQi638JJtwlLGmnDxRFrSVG5F9Xhtq4woakEeYJkZpDKc+gbW03kLCbrJtpCJY3ets9BsJt7optXwIW0x4KhWGTUjcWyqw9G2JXwdDNRvTgRUNkISWRIv71qP2Iatjsa3H6Jwctev5JLBdvdHq/4LDuy7IfGkGSNTzHntquG8N3mTBmxjL1wV0XEUg/mCRpOjSaeTrJH3nodmfo70/Q2956DqUIOs+QTNjNSa0JK7nmGVIyDNDzfJYH+f5Mz13yOcUIkKg/2HkZFveKpPKZWTEIZWKFCUSh1R5sDCUwmJGR9chUeQxg9La7wcyKLkYuvJfSxUK3sLMkkl7h2HlQVhIFty0txOcOFuKKkl6kUjYPKLvJSf0MPYgyyoyQ2iadeCFQS18JCFY7PoXjxaFQlVQ1bRxIzz82X0UumYligSCwKli+NJuxpgSxQOV6kIkEMS6Wc7D62ks3mQ51xpPWv60HiYZ58+OtcNYieBFx2zYdsD8NCZD9xmkT8jjBHCm05RRdF9Szh4JisU1kmwzPRstK11iw9VsFaNpoV0mkqit9kS1HcjylfK0TIMlnXQdOjoqqqBhx2EQZlRSmGKlS4yRWBBlCdoCuIyClAnZqxucayUpxIiVlyc8o70HWo3pOXvqr+ySpEb4EJKJCKFs9ycE+kPXglYX2QwVh3zVxTy3shimyJ9WNAznBgRKB2LdqVGccR6NZHX+CunE5FIk1vMeTKJXC0SrFTZU6HmWqNdGNsEk5RY+pn3Dl5D1wQVBv52Ic2ZyzlsZYkkQrSTBIn7TIhXuIm7byHy5VkVGfVgVFJHmPm/oeRrgdHPUPNtPEWHe9ML8FCGRKFcsgkdbkVMkSOdWDvg/A0pVoJc0QfJsyG2jQh+6KSZeVAldCbFM7aonUT+hsVcFrwEXHZdh28daFRko2nhkSjiTejEiBaqh+gxxzJnX0M68Fh2zVzMUxTUagJ/j+BSzEbAyytYNCHqSIzsWG98sBHuXozj/QRDmkvoVEjDUTq9CGNFScEAg6wqHm6v3KUzoipk+5ZMI88DaSwRIZmheRe5KslurNZ0ZAVAvKIiZhxTyHN0vAZdFu5SB4CNK8oUZv5LmNYYyjShDd3+yUSFTu+H2Cog7GdIYz775J766aN40caD9YjKtsmqsz7sfdhf2wm/MJf7hev8RzOVCchFy4ldIWe/MNr9wmt1x8oRPTSJN1WPdDWRS43DIYnDlDRnzluiInJ6kk4kk4piKknSCegmtwEtcbisstEZSI3wa9Jr5/Q6ow2S5KgiapbGgh0CB7dxS08RYLMJrx+EmRO3CRQVpQoU+GbLBYUkoQVGIoTozOqosByFyVHoOmFLsxa7B/VyxxrjRcN2Og7YH4kDpYknDZAvyLZXNb+4IR9MmvcRRX9UEtCql78KTSaHdMLjySSSJjmzqkjgJ2/SJ8qukLUcMxjds23dsvkx/FbirSdDVJ033eJUQMFU3bu1HvSOVUx6hDmNsVGJBp2Y2Tgcw5o61chaNjbZj4C4NW5o6Mlc2GV64XMIGb2KE6hah61cIxrQObDNwlDZ2U8CxTe4qEtSdRLGcDdRJDl5L+ZyQS3PvEVEmOzbFqDJNyTYEMCOpZNBPFpR6PUW14Cq+EJIFK2nQNiokuiy6rwVCknOcv8vLQm3A0UkdvcRHlwsyiHG5QVUkyTRfRFYlUELoWKiEE88pM6rCPsEdCm7LLqx+XWNbl4iwWD4GsSjaZpJcZYQRxsXe9E2I6doEUUOXA0hrw0k5HNg2UOoWqlToXMgLMZMnomWTExwXFVCChN37DK6+oKmA+JFw/eaDsMfiU1zzIu2aucizXbrPfmdoqpbiWZFM4aM0e5kWik5ewlKCevCuPr7j8j9eM4oTE4ygpS7QRZ+KSTjXzKsEMTCUIXOCOWdJDYdTbEE/ij/hRr+WP6Yn+gmkklbjYMuJhl4Sq52mI56oqbBotMjljR8gr2ie411sEDKu0s6n3BGBKBHTJkYkCIjZKjvghw+YXDVt0oxEYXLQ7VZ3nhHZQj+MfRBfQjBvJRQqO8iLnnW+CdtBauiF/BCl8MSXshKL0cYNYI1UbqLk9CeUZY3PA8mL6yTNMhZcmsfpJS68a+kz4uCCFDg2fsQOttajl6JCJ4dbGkM010r0aiAanAbSa1gVqNdi4qNERyVN3LiKhty2/Vsm5lnPotiGqSN94/BRlbDRqlghCtwTZasxs1WT4K07dc8mPrVWTwYqPwYyKroWCoQujJxCVchTIWErkMPZEtVU3QtpOFDyuOQpGrfXfAa4kXnath2wPxb6POC74tjKrX7VuKTKvZbPcnMpwZnIr6fkpnX6GV81w9Ta1488SSSJvdX4UKBUpXmSVSwpijggggjEqxikJ9MPKVZCfQlocoy20G6HQaTwxGCDwQiCCCmMYwiCglIhZCgx8KpYbO/ElqqLuY6JlphJAJrzDMiLDcvrcS3YybSxElasSwPJDI9lU6xFl5yW37sseov0Nj1mjfTkWQlF2XTxEIVsRj8W+55nmLf8ABYNE4RxqjHVEYJNMy29TIsqU7oqLbE8mXoyfVdQccN7VyG7QdGGQttI4Cg+FF5X3Vh2H47I6muZkQhXGmRKsxZ7rcpIHGfJ7iW1wJzJLI7ltbhb3PoDTsNc+CXPR3Wo7m91wntLoXEpA1rIi+QfcCX5A/wCoPvglfIF/UkvyRDI84h8koVeE+GNE1DeDgu4TVLDrJxqpyYwlHLYCznjCWgzZD0kW6CpI8gyU8sUOKLENhRFCIOqi8DCww4Xge84qBWoe7BAt9gXkGG90Ea8MkeFkn3M+5n2E+xn3UX9yP+tIvniX80X9aSfNH/en3UX96fbT7gJsEpqmNYvbhLsjI2ZSHI4pRC4JJKuiIVbhOnMOxQbCFX5y2892WPXTn+geHetbRECrRFkH4iEKw3f5ONBHHIpp6C3etcYH4CeRNcFRyJyUIaK+YaMyutFDuMgeYFApKoFyzJZGiEHxp0wqCD4nfth4D/AcgdyJC+YbqIkUpZzrgBv+U+2FOqrk8+GQqqd1qZ6tdcB1gVHCwh6EPQSkloNFdBcsJG3khJvLC6G5NEiegnAIS0iRJ5EubYKjCWKVtjSJaini14XJTYiCejJkTZprEUyVEslJnDo8DoJOpTlrAqlKZRrA0OmBEnZSSaGoJegx5E9BIHOgsGzguEnj0kacdZbqM2aFMKpEzDVvy2/dstoQv0bBuvOWr8pCDSxNlG/FQhW4ziQrOpBUVuE35vAfgJTEM8rQarhI+NGZJkZLGUXFpeZZOwoEK6GkL1xOzKwDVR9R0SQhesnyzEwvBUrTMhD4Heth4D/Cnt4UQtcztssCq3ImLN5WY0/2b0kQyUqrX1Cs++K1yiuI0SQNqB21RcPI8izKlMwrAvniulVdZnQT6yE0ovVihuk8Cc8/JdYicp7mSXvPQTQwSWTjyEARJqUGnUZEOl178xUExWEQVehHzVZ1fpPUjUqKjVixFBJUTXnIgJGlpCkUMQbVtF6F6shHWQm18JDeYX1oVokVL2npsx7i5SzXkDfGvZyH5GSWkqJV/Md6ZxW9kNrXYoJmgqqqObfQdqExldQiVLmecaxyN/mxOyEE0MNxG9U16H7X5BZjXuRk6jPEqeeU7H5Cp3iSiq6EaQkqqhzTnHXA5FZnRKqLeYp+IakonL5ibplTQsgqezTTBuHPIkyimrJV6CMTzcmVbv3Fb1mq0IhwsFugow0PWCJCI6JoXGlQ0N0qLUjKxRbnnQgUTdCKobExgbbSMsWlclRKhNn7ioyG1tZ7KwzK+pB0XVXa8yRlJcGl79HUZxLzNWyWmPAqSRCqp2uJHXpBm4I839hF2qpkQzYgqiLmthLJyMrSpXMaOU0Im2i72K2fZbJKP1w48o4J68loRoE9wmNwbw3GDJ1gaswJlnFN2Gu1JE7fTzaLYdME+OhDs+gfEQfBAyXLSSbanQo4lLmFYfgtZaCpW41qNeLkMcuE4OmtxFKgxJOJdGKW26OjFUmRkstqi9nBzFHxO3bDtgf5tk9UFuTNLVtI6IWjlwRtVTaEDMRK6WTcSyUfoldXcVxQ53KEwHANso5ClCYBJFC5xURA5khInstA2fLUWkv0PKJXPLyIBAkoQpSPjm2ksuNgNOovT8nimVUTu0pOu1EQi6gixrldkA4sSKtx6U1pEmi3kqRjAHsySZDkGQsbTHkaDUChCiJoOTijyPzHQrOpllcMpSkme+EcMHq4qyqUTOUJwx1f2zQK3mUTFGsy6ryEp2t9mGZnckF2c70Q5AUjTlNv9k2PZVMhVpUUyJAvndNlmVPRmkTWU/Miq9/1SnnBfDAlRmuK6qdZTbiUnzHd0bspZJoOjqFyeQWjNeRJkmIMUWmSVcovkapCuGm1SNJ24UcshwpFJNBfeaDg85HyKYZlxSWjaWDZUinkCWU/oRKGQKKsFWFlHkSzsRjNhiVZD5WjUcxfKyhV3wkThTIUidCQmYnpZS7FUWl5trij2hDFBmmOBuIjVj5mdaPZ+hJnSqnm/UypESM7QIkq215VZWyyL0NNSrfIoGBN5JalMmivKtJIZVIKun5Cwj1HoS5tX1oL8hULqqO6sjqrMglTR+Y8HLCIarQub5EjdslijzgcZcC/fUhjhTHUJsJOVO/8NCths+GcDfiJtZi1ktmRxRxPKgdhoZPJuZBrmppQnp9geTkmbRD6/ZVPjA+J3TYYfjJKToeS1/AQuqijlU+Yhe36btGLlChLIVidGh1IGhENENyNSJEpZEjWBUyEHGhMF8sVCyGGpKBE8iESSVhDyEosLCiyRKdIHgdEU0JWhKcgglBOw0kXkIqFkNlRcJvBK0wonkRFiCjEhEYILsuk4is1EDQStCGhDQoEaEUtkRwKQ2Qkw63+9B5cKVWTTmPwZ/FQrYXP8eXqS4WuBOYYEHg+iKNiyzHJeQWB6ooVImS0vlNH64XwofvdDJgfizT8BCW8iqayFFqiR21uZnQOd2JpEZrBf2D7Q+6Puj7A+0PsD7LC32Z9kP8Aqn3Yov2j/rn3Z9qRPFAt9kwusPj+zkC1zf4J7Bh+WJCCsP14Q8oClCpwmiYnzNG/wI551D9EOpWRaixFrGFekQKZE2fb8ib5XwP+8+DsnwPJ6r4Oyv0e54+C5PkHwkEo1l4LicxzjFeY77soeQGwtzUhRXX5FIrYKCaxjbd2x/moSIDdvk/NTL8Dw4wRM2wdZEhUMY6zQiZoawJ0ziWB8KILGU7JoyKDFm7arYQa/OTJ+glMRmGE1JXatZE/HggjwZJJKECGI/pbUGPl6QQWXAJRKwQKEkkk4z+E6TqQGGRZA4c7LbMb/NQkIKrXxdtXsTuDXhsOVX08WkOvjTgnUmhLUWeeD0GKjs8mK2kCRFSBi+5i0TQmHjGG7keuLVINpdZJoyOClbu+q2EH+dJPjJEwisJqwy4a/AknCSSf+BP5yQhc+h131bHoDUmiLn4jURWf1+OqIMxvIKwtFlWVIBu9mT3D+4tR8SY1URBmqNrJoxkVUa36D/5iGvCEWXOaRPUT9uHoJqITh4JcAgjgEEEEcCjBCXgkRgmSIII/55wompqzqeg/SWiE6lz8OqcjE8yrbz/EgQ4jgVyJK0KcBtHUNSOmfeR6sfHkxO/+YtSuCBtS7JrzIwhbCWl2rhIJCo240QhWZ8EPga8U/gae2URKrNA6Rk5wJmOtTk4SU+g7MCNqBdiYkyjuPHaR6xmKHpkXLSiFXWdBHgQbhUI2HSQvTqJutRXcDhNSkaZ4ZEew5q/DMnjPY9SiF5oIAonRekE4Iw0mRkA70zJpXHholagvJRCgoyLFUDSrLmXhTRnJQWFkbsW0E1hSWdIw2kK6pf0G0uyV5+BY0UUVUsUmjMNUFtCtZV0wf/LXA0K47/8AETF+sJcWQquQsfKTdXyDsPjeI9/8tF5SIRLUIhLGwsC4uuBMiQkmbMoXX87PmNbkU0Jno0amSn2/UnCSmomCqEbSnFyZnDNKipavIehmppnJLFhZudTM/gaqwHVUCko4ilm7fMahqdSiYEu9HyMoeDopJbi9Wkmb1YyAkOQ9NXVRIQ0FOY87j9wVM5Z6FFIhSo8zGFdpmKlynuyoJgk7GxE3YKocs2ZSlI9YSZH1CopFUSRc9SQUShQgagf/AC1wFCz5eFJPHWh0SlnhR0k1nqvwL4KTIZArEDqVKA+excqsLWrp+xj43bENj/5SGqTIEVG/IPMnBpUKljNqbaacCJ1pbKZFDs0MtFtSRSJ2XrvOCd2Ji4c1g1P33GoGQXIV0EbCBXdjEVa5r3GuKJKZKakK8u75TVg6F5CSxHelk0UCcu56kw13RtBt8yPRDFIZJKtZXeo5Ohsrp5DZcL1ddtCRVYE72cPIlsSF0mIHrJdNcmLTKPy2O0NRTtqpTV5YrW82D1F4C5NNXENiIrWUSPEMhE2nSdhtUQnNIR0qLlewgyCvatqa7kaUyavcGH/y1wBCz5cVYmKPwpIophaELusnuR7BaJIc8t0eUj5nMQqoT08ZKuN5coqFgrCQJyFN4gv9j8MBfipJ5klM41NUx+c2Gr7HNDuStpnURFVW0JpJawvuyRjZJZrsyorKiV3d6mhW59CEZdKUsKuTKwoKlqCu/tjcdUrUJakE0poUCTBJDSw3SXm5sVGq27t8CsjFJUFnIxEiaNRXYyWpCJ+yEKcEyV0zWXMszLiF2hrcTlslshwyUaig9qF8TAAzboregjrMVEQiycDBVqThemQFCg8XMKJAznMSwTyqzboreg3Mrx9MQgyf+gMJRtuKXETRZeChH+43bn5FZS2RQQWW5PdCBPDjO4qJXn4yZNMJy9BqWyerJLaDNXWgptn3P0PwHgEO/wDmIhHKlSMmGK5gnjYyTwSSTwySTwzgknGSSSSSSSSR/wDNX4Q4UVhGqUu+nIjpVQ1I8iCSNWQVo+ATikDnP8GWopEpxFKiKFD3aBrjNTkPwiRb/wAEQsBH47QxlUCcIzl68yu8tkmPj12lX6j9IMzMxuWe346WK3CaQSq3qM8SbIl/4IhYHPx2hEiQEtB9ZgIlYyYpS4Ib/HMMSJGzSrU9WBL22Q8Vpf8AgiFg8/wHJQE5tSZkOVILBWBsVrwkk8EYIZBNLJEslocl4rIF/wCCIQnd5fhjYqFnONFZCmj8VUyilRzn8RoQr/wVHc9P+SascsJGX9fFKEK/8FR2PTB6f/irBJOSeM0IV/4Hli7Voxnp/wDhwPBK1sTaHjlCPY/8FP2GTwXm3HBH5zZ0y8f0gsCsf+CLA5iz35cdXiQo06sUDLsVjdZD/LnThgjBHgJLS1IpByFhr/wd4yCqVr7caYzW9LM2PxtkEduLb8FIm7C7UTzIFea/obaZLzFratTZaCQOHG1yyR6jED/wRYEq90DJb0dBR3R/jWAKomFpwrxK6ibJNSKkSKyVEQIki4hhKzswQvDPE5pp5D4mqYIzEx/4GsHZtB4OtWT/AC0RdTemwZR+CiTyKjNNX2iVQPU5bTcJHfMWU0KhvGq3U8VCNSBBorH/AIK71oPCalv+ZnaqY8JXMxRQIS0knUm4LkLamnkYjUmh8SSFtG77LqyscfXszyGP/BEO1iR6+xAwd0lk1Q0e5/xkPCSJeDZtJy/REzZQPhaFNqrssurGz1Rb4HH/AIKhMiLl276PYgLNnkmqPe/5EYqtCVELrxQVlDUssmrHrbK7/Aiw3+DpiZLd0Ou2rYgJI6NWTVeIpnUU1XLf/jIQLAaly5EVBh/4QhEG47ORo/8APghYOwa+K067KMhmxrvggjj2iHo/x8sTz/wlCO8avx4IEqlEg/AQqDlP0Hc+YuJUn8FN0f8AhKEdg1fjwNdibFQ23fwUQGtiTDW5cVIwzr4mWKZ/4PGCEdw1fjQQKwtCeiQvDVTE5wTfKj7kp2f4eQ2Ez/wd9ULUNRGYsHcNX4cEDWJhB59aDWl4Lci4zJ+GaJ+x8cDUoSjGupS1biarfx43D/wecFg7xq/BSFgSwirWjfwS1Ns8x+Axq65PBBBBBAm06M0Can8T14/8Lei+78BYCQw3JZDRtdT+vlkhaMi2Q34sDEEYQJRy8PUxUJVR4Prh/wCEoR2rV+Cjp0slbeXyOYkuikAzDXNrsbG/DiS3CNtsYZtoLTANyLWjy+FOYhW3TKcOjbkEqaEfh+vH/hKEdi1fgJkg2LUOhKGGx+HSC3A1Gm8HGkiNZMVrlpiWrcXMBWQS4o87jX4OQ5tw/wDC3YN/CnwL8K0b4bClUVy/FUWNq6gV1UjUGYDaivakj8GhZ3D/AMKRadkvx0yTort4jKJwYWHxw1vyzFZVUhmh606tG5I/UK8JjXFy4I8At/4Uhe41/HtcEFBtOygY0oUZYskt8ESqZSijxSZzyFWL6Qz6A/CfgZv/AApHeN/FkQ9J44IKDyMwr8VFc5mwNvhMYaiFNxIY2VmigJXITvOVKaG9bkfIe4f4DYLf+Fu+avhThOTRErfgEbKSJTbKFcj/AC15vJdRs7bzIbdFQopwqbmrW6iRRg9N8l7iB/gmP/C3fNX4z4ULIj9zOA5Ia3q9N6fsoG4N6cSUzNWExWwxr1HFeU3uwU4IIFKOORRfGCOPp/4Ujvmr44stUfLgZNIFwRgkIka3ErH6wZoh1bCVEhG5Cahr3jD6Iaao1GM44LWMUSx9DnhgBWMpBNWvk/kvAwQR+A0/8KR3zV8KaqzuPTw4xQ2mZ1Mz1GRnYSrcBpcgwmRwoSHVy74SKUMeAh5XYdmIYmJYsaK2IgZWRI6Jp1V5qGXIKFhMmQQRsQKqZToRsiIJHRjBBGKT/wAKR2TV4RhHFGEQsYIIEhdVkOp+tR5bao3fMgQQOWsywnCOsTWiyg3jsRDszyo5KfYaQJSPXrK2FojgaI4III/w3JHbNXwsgjBBBGEEEYu2ZadtIbkxRCHMPNvuJJ2VUVE13EqWMQnas7DriINEQzb00oPhO23bbd0RaCNptrMMZsFLVaGSNkiVYkonXwGFhyIwMRhBBGOT/wAKR2DV8CkNYiGiBjcIihBBBBBHAtUrolLWKjbIU6e+E0BS2RXD1YvgroqRFIVOSDHui5ITr/JI6onLKEpKEnHnYWcyKA32alEtBBogggaIFCZEOUQQQQQdu1/wwhOwzZBBGFJsQQIIwgjGCC5bls6FevIbJhGXG7SgXi3sKlY7sUr5Yph28GoJYOon6hIlZyW6EbgdeJBGBNr9UXYIIIwd21H/AIUsHcNXwIaWZhZ4xkkSwRWCME/PQkT9ZLNKP+REj6PCsiVQRXrPZjNy2K2EIOFzEfQZMihCTmKyFkvYnSlLYazYaoMkoKw9OUJjySf7wRNpyWFghqTTjJzwqaJn0gWZgPgyMHUOXEu1FgjDu2o/8KQjumrIIMy5BHCLRasQlOgbZ77sUOlbFZpWLV6EmI9NhnV5FTRa0Zmqh5j56DX4EClCCWV+hOyqIrzM7yajfR3mByLFh7JEpyK24UQPQNQ3XNQz0WDVlFC1WV5zRYE1U3CWZZR+PcY8xtU1Fok2GG+Iw2RN54IHA7xqMf8AhKUiF7rNibTAhGaKFw8spUq5wtYSXOjOXltsSouEM6z5LAGhjpCy98vUVi8HQs22TXmx6CMhU23nQUk3AhvYkM3IJpgiV6CJUO6FfzLi5TQ6ZKkZc+CYET1vNs/0TnARpjul74TyJKZsRDvV6qd5PYlrVUlytiu0Pg2BAgXpPfA/8JsbEjsrN4EVhLGsottB3ZEkOpqjPa44o9D5E3gyqeg61thzIawWAsk1DJKTyQowWuT2KcMKOjVOQVlh7ZkQN1HFVsqcynZrBqBRAxbCdU2JmuChcvxkQ9GSlNUgQTdcXp6CDEpyuz38BgT0fcQf+E3mBJ7irwIoXkbno1ErPq/omVBWJPolDSxzGu4lsmI3uHXYhcg9I1DTHgwd/UjOHOXkNKvS2zIBeuQQk9WCnIV0GSr0ITBfErBWnm9GEA2JGpTkcGtfBItKZKakgjf7eSZbBKZv0HS0bwJcirw62PQfcSov+E0hKncNXgSla2zQVkImLQoHSS2mSuWcUtzu/cTi1CjC8xEDSuqNtuW5eNlmeEkdWI4F6XwaIxwwTTSmo5M4zhxJNprt0bGZGCwNTlDzMKthmkndUa4sScDTXMby4V/ohF+4eV0MkkNqa5FFNiSNggg7q+YOrBPDA6A9xBaf4QkIYqSd1ViL0jhD5OtQ8zHTVR52CjN0HoqxbJp6HP3YiKktjY43b0z/AFwJ2E4KZKmRZdeQgSN/MmYlOsjgJtScTmOybGr7GqnQgumhXHGrGgSes4pXQ9VweOd+hreoVSGLACa6P0HtYlODdK7MaNQtT+YnDBnYNcJahr/BkILhZjYhPW5qDukVW8E+LB19vrzLPtm438XyFLDYKKloxTpYl92GBO7NCTnWpviQXLISH3mrlTxzJH4qw67GyNNxrYanboJaHcY7UwV8FCMBS6pSMDoncSUyLmdtooAPFCczvBsF3SpNdiMxsBKNZJFcSn1Qpa2ZJlhba23GOSgaeWINf4IhImEEtJkJFWkmq2+ZXKfef1FH9kwBpUnStMFKhJLqM06OBLRxLuxJZJxoeiEpJZ5MUNRWp5KowkazQeQA+eB1xw3BzvdBSVWnclUpLfhkM16PcTI8hI0V2kQsvYcd5UodAT0Faj+hpVb2qHmUywgV+VEpCDd9xIjcYfDQJDEQEp0Y0xaIhls7YX5Beh7pbrEqg1/gaWDREhE7XPZNRQpaZxzq/wBjE0VFyY1xnLxV0S81xOgbDkkIy4IOb36YUPgtI9Z4CZWbRkk7ie4cijIUTJIopY9uk83EDcrzP+D0krmUw3MKghDqCaqhn+qKWXJUSGk0sJPO+7BklSDNGaYqFgn0BUxLifIhmzzJgler/gT7+mTRjYf+AowZeAPzRaooUylwzFElTqqJXUWtUIoSNRMMSXzJJMQur0EZAahK0WFLxklYmg8uBLKp3oUMrYV7q3D3zwgnTd8GJVox5Ys34aRZyOptm21AkQfIGRtBtKcK1aPVQQrgbPWCKiINLzDp05lSIVJbNmVGPiMUyVgY84uJKCFKz5DVa5pP8leftyICWXtkIyqnFc1oJigpVnBDK3RlNFqARUm6eQWv+AvQOiiQQdV9iGpGKBKy2HlLNrc1ETYdZ6JHt6lHSWOIbHgY3KlCx8A0Jko1bWzgaj5gcoJRajmsqx64WeTWbWPogegSS0KK7hYpPwYLJFcEqaUhnqJSiU9Fmm8JKuQISNRNEGwkPOCYsM2hjX1N9SfsqM3qJZrfUuJPKSSDFZZcwqySOaiMNHhui6acorb1rI7yGiyGhBH/AC44YIxgggjwY/Cgjigj8SOKCMIxggVVikv+xmKaik0JYIbcUkCnMYqyRc4ERhpg9QZDwUq2NthKFhNTlwNQ6aNnWmox6r8iIKUEbbq8EpHiQ9OJWE2nKJNGKkokaKlTJCGIZDVicCde8v8AQ8EkoalcSctwgVFHLBGgyE2Xq74JmlDFRTQlsk9aiaPpah1MuEJtBlQzZ0EIXNPuhEMRy01DQ8BojGMYIIIIxgjwI4IFSMUEcEEEEEYQQRjBBBBGEEEEEYQQQQQQQQQQQQQRhBBBGMYQQQQQQQRhA8UeHBGMEEEEYQQQQQRgkNlQQksyMuAyYrNehPnLLiSCIW9GUaoHVkZO8T8+IZVWc7CFH80J0KrmO/mSPFqCMFjYkIMOxIQuVhvDpotCKDTHphnGy4ITIk4IemChPrgkpIjTJ4NOFgkq6Omz+xngvSEqgbrg0UayT4b6GR09CSgM/FFxMhSiSQBGTUcw6AfO/wBjlsYZKiGSSjqpuHLMy5qjULUcthBZR+4fRH1x9JgpJwGFXqiKrvcKHYh1kxIIaYkSBDQWZLzI+wj7ztsj7BRRVZncYtKUg5BMS7YmELY6hoeYw5P3CZWdROh1Ca6+Y+6DPQrayOwzsM7LIzS8yPuI+87JO6SPuOwzts7bI+wez8yBdsnKEfYcobHqdlkfaR9hH2naZH3EaXU7bO0ztsj7jtssK4uWOQOT1I+8j7CPuI+8j7SPsO2zvMq/PDTbHqJMhP8AoD7CIqtzNQh0/WD9n2gn+pjemvMmNnU5HUabT5nYZH2YsTtvAQEQrJ4l8JVFCKbkx9Xi4TZ8BXkfqj6I+qJM+SE8L6wKiQkhQpVo5PYSilCXuCHgi7NQN3Qb1csXRy2KWEoZNG3h/wAEsriEF9cLRYueltR6ukaLqBMzJgK0YM9lUdWratbbGu9kOmxMJU2UESWOZCPKFCGoaLDMPFt5dRurtLzKUzyGHZXCnBNFg4Qbpgz7qLnMV1CbHMofA2NK1hPUhkiU2IZ5m8iNsFRjMjUjB88uBk0N1xKMLUySsyK2RnSawHJdtjS/wREM1VY32bYDRHHKgtG+VnmWJBMkSJaEyZLQloS0J6EyRMmTJkyZMmTJkyRMmS4BIkTJEiRMmSJkiWGWGRInhnoTwsyJEiZPQnoSJkyRIkSJEiRImSJk8Lcb40ieGZMkSJcHVaTlIksEojYFpYSJupybDq5ZBGEEECwJmkk23RJCFCvtthkdS51OrebFqQ6GlJGCHnoLdECPlFTJz0KGbohiLJWECYYbT2GtxQbSXFByP6g22lsgSETMdii0ny1E9M5To3BbWY0pz5icOVcSa0jRdEXkaLKyHga0wnga1NSXu8MuEfSdMzWRNhyEiGPmektArCXGWzE3PNdz/IxnJLScCg1RKk4NTGpzIRJN10RdKhooo8ygHe2EyJcY61J8xMsaYk1yDQIm6pOSHqTem7N2SuE522jstHbaIv7RmReY6L9R5SdUVKL1Q5/iGu17ianY5nf+Q7nzHZ+Y7HyHZ+Y7/wAx2/mO78x3PmOx8x3PmFoOzck7XubTs3Ox8x2PmNl3bi+lwlsu7c2fdubfu3Nh3bi0fduPQlt+7cksvZuJ+Ts3Np2bnZH7Np2bmw7NzVTs3JLJ2bk1k7NzZdm4tB2bif2HqbPs3H3B7id2HrggccNfMHknPBrREiBiDAlfYdTtj9i7g9zV7jchAa+w9RO7D1KwHaH7HPb2bj0PZuNGTs3Hpu7c23dud35hq7XuVu16na+YWg7tzbE9OT7l+zv/ADEna9ybJ3bnb+Yhydm5tuzc73yDR2vcXdP2d35ju/Idj5jt/MLQ925D3vcj73uPt37Gurfu3N90fJ3UIf6Q3fwIP4D+oO80NH9I77Ruzcki414di0m1rVloWtZOY8igs3mOgxsNKar4HckdBKBOJpw1YZj1JmJM4JmzNSp7jYlLEpWS+NgszEicSJgq2T5IScLIiw7TrJE5JGToILMblDfgpysJGa+JMXwkw5RRPNORWF2yZ8iKYXVmVX5S22+lh13khaEGmxFcMngnWSDbF3wnCKYycLS07Md+ZUkkkncnF0cyCzYY2WiwXAlkvVktXgklNGxRv7MyhRS5k9WVZk7kk9WS1ZLVnmJvUSzdTedRXy3zKTfbU/ShbmT1fUnq6k9X1J6uokZupLV1JaupvOpvOpuOpvOotR1HzCW5ll+ybzdSerqS1dSbP1E2rqTWbqbjqfcCnv6i1PU3nUer6j1/U1G6nM6ibV1GPnuqua/r7jNXU1LqLUdT74+yHqepvOpuOo21dTcdSerqS1ZzupGYSgaA5TJ6upvOo3d26jfV9Rt6slqyerNx1JerJerJascs79yHf9wnqcxzMb3JaslqMjcrZyV1GKl0Ntm1zHC5OMkkvUnckpFzE5U3uOo3LMnWcucTZZC9bZHZRoeoaG9ISqkVuAoApnYPbE0ximSN1jyGcKblVzzFxF5sY6tocvCBCvxzTgesYN1JHVcacOUUBkxC36R9kdEAtVCynLmNS1QNt6jUmEyxmgmTXGDnoIbSdyZeEkogrZmh9RabFsSkIWiHqV21BlsVwbQklKnpRQ6YbnVT54LZOwzsNHcZ3GdxncZ3Gdhib/RcdJ1IaRedcYOwxNovWjstHbZ32d9o77O00d5o77RDHCZs7Fe+s7muAdhnYZ2md5neZ2HgO+zvtHfaE7+0L7KI5UqpyKBybpWyIP6R2GS/0jvNHeaJf7RUj3o7zR3WjstHaaE/+kdpo7jR3mjuNEmaVWWZG2UnRyTf2iD+0dpoan88H23gGDvND+4dhncZ3WQzehypDMondO52mjvNHdaO20P7KH95HfZ22d9nYZ2GQOUyLGZ6LjArNVgOwzuM7jO4zuPAaQ7DO0xJqkEn7qYxXLAtn1Nv1Nn1Nv1NokpF6EyUoTw5UD0suPQk228xUQ3uhPkTLpJzoLaSa1ROKLOg8u8aCU0wgjDYUJ6imi7MhkmySlf1HFQL0sIVRKMYheCqOSpeKLNskaHJXFYRGMCaJQnWHZaFkm3OlRrC1m1CEllgc5DNjODI8gS9yTUxavQbqrmxv3Hld9uMrudpeVZqQvlvY9xogggoUxjGlL8uZSjnc8KE40KYeRQpihq2Z68ihgNhTTCfAoShloQYjNLyRCQ8EThJKJWhJJQpoUJRJImtBkdT/RDjBBGEk4U0J4FAqik67kUjpVIzGhTQlaY04021UGtX6De5efibuors45kllTXGUhvZUHVnZ3bdRvOZU7KrwbsXfGCBxql2UzfeMMCRLQjgSO0mGtojCSiEL+CFcbnF241fDMlD8CwOxNmF5c8IgTNuYlXcihWpgsuB1sCd1D0NwZFc5NIaohusPWRVPoUwVT2INvyNp/sMedvkiKy8mS/QGQfUpG+h1bSigwJzoMrXYsuW+fYvkbTVbRNbr3FmKVkUajzF+YctnUfSMoe0mbPozZ9GanQZGkgzZidDeDSS7nkz7QPL6THB+pkaPRkafRi0TyZ9sJ/mFb9DGtXPMcjozY9GL+YyTC9kk6lWa9FKEai8mfRM+kY/4jPomU/0M+iZ9oPshH8TIl+pn2A+4Ck/cHljIVQmSjFLzH9oOujvJnL6MX9IfbD7QbLqPtAlKqFzkf2BfxmfbD7ANf3CI/uEf3D7QL+wJJk5R3yfUSiTIdQ/6ga/sDX8jPtB9oNl0ZT/AGD7QfUM++D/AKgWg6MWh6MS/sCFuu8npoSSblCcMyyvzH3Q+4FP9g2fUfZBPyvMV/2Db9R9oIcr8xsOjPomWqcndQ4IiPQrA1OGqfJm16M2vRm36M23Rmy6MWgeTGlXPJkaPQ2PQjR6Ma0+jE1VqTWKu4taNbJXUlvPCCWg3iwpJ9g2yTyNBPzJaEuBI6uAS8lmJkiu0IS8vsdVyXak35leb1hLmgHcC5kkHdG1jVkJK6nAhAhMN9x2Kw0EPbi340+C9sjIoUrIqdW5ERcF1J8yc6dRwyqSOgWbbEiUIXmN3mJhVyHbJE9RFTbcCmtFELqIIj1nUZqqkvdOV6Pgo/uMhGk8CZpQpJMkJatjCm6Qni+o2qIZTI57j4FF5kzIpeobNy3LJJwqVJExpkTxQZWcmjmSolvEknikkkknBoExzrDDxknEkknjCRYFKn4mj+RsbHjJJUqVKlSRJJI1VOjazGJ+os+YeEjZPFJImXGWSAkUtglxzqVdTNVfnEbSTT0fDJJIy7+x09E6FGEbCOqJBJoWDLhAtU/OJlpcmWtQSu/Uk6NtlUQ56DRuWh0ymLVLtSh/2OBrqWXpy5CoebVQsm15iQ2yzFVsOEGiaMfap6mhLG6ygcrsWsQueoKCiCF5JyLH4EEeCkxyuxOQZkayMjMxAUQus2B6kjYUbNoT14tB0HkTnmVR/MogQl7cCXZ2fIONS41KYG9BLT5VQkSw1waxSkuonDGdNMlRdEh9lFOaf0IWIr9RV75jYxU0UJdrEqiWh+iYDbJ8CeCRDEIbbyNH84uTcaW23L4pJJJwTisJUDx7s89gnCSSeKScJJJJwJyJOOheYrrpgxvBJJImSN4JJJJJPJ207MgvC7fIY/CkYhvLhfLHzRDg9lioShpdVz7EOp3jO5TVfB8DQ05cJL0wbCs4Dg4JOq6p5lJS+TToROQTG20DcsFtJSRLI3mIS8x5FPtMh4IUv3m7DFud1DKhWM39wxKBaFC0skhDfd8XusE4HUgaEhLIyUeJKFNiFqZs9UyfJQb0SreZHAnKYhbmaPSLM9wu2yuq+daCZJO+rkruQ0GpQpdXPWVUYLGiG06FFy1ydR1vhawcmITR3m5qnqNltOqOomOPVHJ33uN2fBNCFZeCki2CYG43s9qicDztM9imPvmM8o06PkbHMHI+3LkDcG9N6b03xuiXOb03JvTcj1QioTIqtCXnM+Ixm24bk3pvcEtSb03pvTem9FqTdG6Ic2GTOEeWh6GWkYj1pvOJoLuisH359viUbw3RvjfEuY3JcFEqblMakNCX8ngRq5bzCm2vBWG6N0b03xvjLkJNmN4JFnHqAP6oeFV9oboerNyb83pXvN6J26gmriauzV/od1M9XNGyXZF2yrdCUVbwXHGsaIrIbHrCnEoEizofW2JqT25l4JpFPKS49SDhsOjJZOtcJSG6NejpKRbKingtBNVO9qI0lYTs9RtqtMpNDNyKEqL8w6dFiyWrMWIkVUKrwn1B7vUaZHkEtSepPUalVx6ynU3Ligg5w5sqOrhrUoJF1TkxaiQkZgsihJ3eEkks2BLViP8AQY6LVK142k0tq0EhtbmQvQfV0FKgxOBMQrVG5ynHIjgVjKihYhQZObKpIemM2wJ3pSIdJqvkJwb1xNUGSGN08NgbkVxTTypSbqENhHZcxvgaa8R21LvQaqyzas8zzOY5jmIiOkjoOUc+PInggQkxuvMS9kHhUhkEY1KkEcUEECE2iSVn+obcL86OUR0m0I6DmRzHMRueZ5kiLGTMcLXHda4p4JJqRQRQsLsVYxpaeCUjTibrVECY2iJqemVLlzoXUj0ig7dhmORUmw8NnqYTBAmA0KBKFyIiBz6trtAx1BajbQ7dSHAezNQnEuq6bka0NfNi5jWMi2zDsS6pvYcwJvQVUPNisFGhC5IlqN6mEojgkS9RNI1rdBqVUjTTqo4M5Gy40nRCKZpq3qLodqEufuGk8h72QtmQXN6FqCrYWpiSsFzKZOcLi9oA47dx7DjPYN6WmY92ehSiLLFX4DlDIzBV2MTs5GhOZNolsUhC1F1N7avIcGjkdDJwq6wzLAsxvdv2KzFs0pdiSSpPgQKqf2cixSGyJwkl8YEiZMnirCPT5j4gcvCH+JA3CBAgQ4nI/GFmNb3aBhl4UiRLJEiSSScScGaGQ0QqljP+gfHI1QcZRRdMLCwPSsWxnNxNJIdHuHcN6i5UPMZm4hmiqLoE9zKHQQSIeG7Kqp/Qh+Gi3LuehBcaRJJpFrjbbl4r0SITmraskMvJIa7VVcsGGE+g1QbuJ5kspJaMkVU39DKjnBobkMjyIjhknU8ka3QkS9FEKQ3dWXmhrhPA2lmTYpCzqCGU8xW4ORWqG5Cs0lUTqDOVxy5M29Xgc/8AZim8eo8IF2Koxk7cCcVEjLGtLqSKmXCLcdPmVKIftKuYkipcwTKqrQ4Jl9QhXhzY+qKc+mxPuvyYhZ3JENJsMChpIWgYuo/iWIyLtdSNcjqUIaWgfM8zzPNEbkbkCBG6KCmpG5AhaCEElIWkITIRns1tBrV+TFWIyFoIaSFpNgbA2BsDYG34MwthhW1HoCNEhaSFpIWkUaCoOeTHTRqNZs2A40ELQQtJC0kLQU0ELQQtBC0kLQU0FNBTQUFNAoCiD37TEtyplomJtytJwMyPJm0IaDYDamLmJtS0VzVThnUnsE5FosHqhcFkmX+zgdEXibZBSNz6oNLNSiDRWdzjJODUrC7cguhQIRch4cl2wk2hKxnfUZarZFgVS2XMklJOogrCQiiqYqVTk1Seo0VntzsT1ZYTwnIPYJUyyI/sWskngY4ZUJm8VakhzkcJJJ2wbi49CGzzxl6iRmEnRkpqgkKMCkiErdj/ACtFREiwc2Q40nZDNqUE1/7BjG/FGzu8aiQkEhKqjJG21EsS0J0uZ9kWSDVuiEsItOoXySeCScEi3cgbSEslFCEQOdFstohanOjnRfdFt0c5HU5RzrCjgiXUrcJiIS6JXmbhGoe45jmKakLUhELU8yCCCNyCCCCCMECEO0b1zHVDkjUQUBAQEBARgCAhCFqQtSERwJw5Q1voTvjGEsqWcoWq5f4EpeGY7iYyFcbEUZtI6ToVwWEHZGTFFtdmhDuU3kw15Dp9rVoKWdaTIIS4L1yWCuT2Dla1EjW7EHRw1DKaEcDQ4YwLI0bmByEtDcJwQlUmeCeOm2RXXgoRCwemLeRJSg+DNwMkHISDQE00CK2ZueJGEuALIHLYrmQRwScxIk+WDOU8hypJPZothf40m3CJW72lTlkkkkkkkkk7kkkk8YCCm9oD2Pd1GJJxkkkkkknCScJJJJJ4A1bdORELBI2NkkkkkkkoknCSSScEk4J2Pz6jo4xdiWJhucGpIxoY3UzG+FIlxRlisVPlg2JqXNqhgk2Vw3LlhOEXDNMwn6jkycvq60HBYPDlyIqHOrJHfB04ihPOcLYxaENWE2ZJJDNxCXEk3YUVLDSqZZmEcuG98FEmjwu1O/MCq+6by6eo2JMhJFIbORDVQW6FmMEIi2bZqSVqtGRBsVReehNkSRDTDkJqKNboyoGeY/qIlNwEQanIS1dDZGNBawk1JWqEWq3wSIErpxMaENFzc/FSTjOEk4JnOIchsb4ZJwkkkkknGSSSSSSScHn3i5Df4KdRQiujDWU1MMJYJrIZGNNOHfB4SSTjGnBKo3QW32NxCXNyNSJE5zmIxknxRpHQuUwv8MQ2QiXQhpw1D8ZO9G5Gl0J5V4aeCkxtxnJHcOfAs45kk0JvSE4mpaTaSjFkTO+EiTZQ2lDT023I+lmtU0UoRW34B0cdlOonOZaIny154Q1RCadRZoSLJJmowloEV7HImVfJFCc3pwwCKW3BAirSzL838CQ8CqCQYtk2zaFNoNUGmuuC2jbNo2jbNs2zbNs2zZNs2zbNs2TbwWybRtDEJqmZOIqWRsG2bfEEltriwSWzwyJbOG2cEsUsi8KWYs0KhtGzxLJLZxS2TZNk2cFsm2JuAJqoWsqDIatgjI9E2jaNs2cNslIkkmo2QpEOkwZZfVhtt1kcZoMeDWRwJtjoLLNiefzNoasPVsWTVXnjf4YgQu91FWA2QOIE5XgwyODNKG/Uat+COKiuNVYNjmeFUEnhazgTLKFXc1qvg3BDWoKuCKpKMy3QrfJNDQSVKSieRQhEdRQNg2DaIWgjhiQ3qu9ihW0LhpEq4b4PNmVSK+gSbCUM0weKU3sOVFYkn8VHPlF4Ek8M+JOEvU31Z8E+LOMkkkq6T0HKcPikk8wV6EXMJQzUeqGVMDIMW4Jst0zEbVceYSNwJuLEeXqOTGlxKljwTku8Lk4Mbly8Mr4kxaMo4YwnFKdBUqpc+OUS47YZcKwOgk2RTBueJr1roNKpLUkevM8CylmQIwdsUbyZgmyGTcpchDQmaJtHUnZN3lR4KFbBufyKmksxkobB/mNModHX8dSWRqNNOvHTuL0OZKjJ4N6N+Yl6iuZDJPaPMUUXQ5hzBtNuKYL38HgucCQyu4GxLBpRwy0QrOKOFOOBLJfg54O3Eq8MJD4npGECpYknqS9SWpL1Nw3DeG27iuOwrjtwpNXftbr7IhJz/uMhLN2g3Ll/krW9hIavzVATIWhbfkFRkewkvAQ7uESeYPOGhbDhuijgWQcCwVy7wenHsYOwrDcInFV4F1DQkEkslk+AnU//2gAMAwEAAgADAAAAEGgvuggAAMIgPqolvkFtvn5DvHTTL4/iw408vEvvoY6uWaOFRsqkXvgfl1oAVFQvjtKHvobB4kq37jPggvvqsuvogkggmggEBmgEoggJgECgAgAsqgEAMinINPvhvCYQQV8/utoxfTMIEAFALMLAbvzTaI3Q1rvvHgV/j/r97jFtsv8A/epIoIap44IbqIIAAB0IIU0IAAAQD4AA4CIQAAb/AIAYAUt6T5o9Kq+ubT+qCCHGPEMMKSww62CCC+uLvP2+fzLOEDPeAC0VicTy6ueuISmuaKWCEDQwqG1TCGAAAGOKCCKAAAAS8Q8gcr5dUcc88bS8SOLDTz6EOMIBEz8RrQ+jDnYwyiHHBnxYEJz79BIY0uiS+86yCCCSZ5bIECAVQCyT+eGGCWcDtR3OMwAAATzjrWuy6cx1FEN4qc9d/v8A5Ub1vZBic97XItMXGIxTem05/nDigkWZTWSzTnqZiggvkqI2YdAAFBhABs2osxe+hIaSwQXzPMw9fvtvutSICyaaObWMMP8AT9qqcd5wd4vBXlV3GE3Gw68AgQMU3Bb3MQWAwFH/AF800R888kN8KTAQCXXhbCCJkZ/z0L79DDrCCyu84etXesF1LyvXK7e5PxFQZEyYlBEFahSOuwTycJ92FvvWxAu7LyJmqeyzWT0R5B8hB95huXfQS+MOCDH2i2Kw/aCmuDh32pVRrKQ1l8NPT2T8CE9qs88ajZ29djjCTAdsMQIJQ3UVww2uXcMi7UhZFCSOLc3CCC25JohHI/ErIQe+JmPJtqbBxPCKnIhYe+5bWeUHuPDSHGxhnLJop73Kxrklte+zycTumAM8QPeBfS/M9ipVJlJ5Lu760hemA+CdhgQcFzIfGrS+7ykHyijkMWcQsHzqzXKjSz7QtfPrBW325KQXVHh/ejUuj06SBOiYiXBKkGSsyySirzz++hHFINl/gLeeCMLqQcorjiZ1CeCz93OoTDSBKZ359dEYZ8SCySy2+Cby2/z3iV0ESn3TU++0Xg6/n2xH1ztn03xP/PLNYyyyiTE9Bww05NBs/DqPm+pkuFu7ovdS219CyCOE97fZuCGqACCCnggKSJHOdnqAsMpkGlYbvdPjCuo6R36eplrh6KfnCELZEGOEuc88c8+c8At3T8Ucl/rjdc3V6+qCD5pBfACsOFjpKCjWuCSM5oepOx0iqOyGLf8ABRqrBPYpnzwYIgiBK7LhcN6JgxXF2k9/utLIPPPPHLWABmPKlUzVCdeadfPChnseMePc6JXPgo421KgAqwzhoMkhArDyWBNE0QcSv8CrBqYCDop8w6W843QLIqHwsxxEPvAAHvOKjvfh9HTSOQTE7twj3PPLnNVPAeiSLstGLyzw0qAApYs2YcuqEI3QVL12s+I7ogZKi9qq3LcNPejpkLAtsGuvJFlA6l9NtlPOqhu3OOww4rOSMrUdvkzXTAScntYRl1BUc/4RhyAAkjwQDWAvZUHeIwRNqQatgpWyFw7FKXpq+ww6H3mh1m/URc+XTBidaPfIggnox/pzlsVxrY0fmyiADt2p5lXXqyVtC9x5AwgAAgorEr0We9Y2Xu6cOFJGi/k3VE1YceWGTxw9I0d8T9wXqMCWk2FaAvKgAghX1aaJf/B8gYH/AB+oNTesfdVCUOPStau8Qg5ihgIIMlH/AAbBA9kXIllS9+S9FvJh3uhd0uq9ll0Z2/BNTJJG5DFRdGNrACCCGT7trQgNkr7o2Hwd/wDdnd7bGCfiwcWmk8wF2M+wwFkviJStRXSehSjLTtw13cbgXDv3Mqgol5FGFMYOJaC5nBK+VZNvTsNogwlkU5fP7OXs1UGvHBW22oJoGApSTWayqjggovJYgHuZD1cuQj7lD8tsagRrYsUNov4cQZ23jthGUTlF9pd7gWq90xUO4goggo6vGmVKy/8A1z/Oynvzmb/eM0ic/CO8H6IAAgDNybz8CtiyzqGXUmHRHH+F45aXhNX+jM2tKoeFnR7ZR0aoUBLoERI8oH1p6ABYYptJJ2HC5WrLkePopYUaqbR3SzvoFaYAAALPGdG8IJvz/uSnDihKCcQX8bbPmp0+dI81T/pyl9MolNiq0Bt2dJE8EAUrAAAA6XQIdThEzsPC31uwqO6wPPbpNpLeU56DoABLL78LL5ZhJxGIqYWQWKbo/wAnAptMV++Xs/eift0ZCgxTVQpRpdtSnXFSAAAAk+kyCHjogM1NabA12QTEfGrbtTey5q6rOACGvTf/ADHgruN1yBGeZX4G/sLAs/ONohwt6NF8DDMFk2bpgj59qYggrutSAAggAkvkUDxLHPvCpnsZPGwpDPfVleJeOA9aGigAkA489wg3PL9jD9j3+FQVuEOg8xjA3AUtLISy9tUTEA37zxRO/vCgAgAAAAggAELsX9YlPhkAJnqktPDbqlgn588wH6k4iuveXLz/APs4oDjTjywLr76OztAEFeBGhN1qI7N9PdqmFaV7zg4jDjzSCARwIIgIBQ5fxuSgxSTywKYaJqr9OR6CGmPFxy8acIP133HX6/8A5/OUs8448+++94abD93AX9biH5f4+LeU/c0V+a8EA48gg4oS8AMgAOCAfxekwEakgs2jUWww1VpOImfEWy7y4cGXMsEww9wEM888498qAW8+ZAtzZsBWb27k8wrT8vYM9loX8884AG885/68MMs7++k8ra6CUMksYYqRFokWV11EM5Uw4u9BCMqXCAQoCS88888jDTCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCe8JgB9Z5jn+cA43hnA8oECcAYkPNoUXTQiQqj+6Ndr6HUXuOOOO++8+++vPfPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPO+tPN8d8NNcs88qAXnIc8Mku0wKWe2/riDO6Y2b5pys+4D++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++ivhzZpQQoWGzKA++9Wea/u8q1BPIAKZ/++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++EQEDXzphRowS8syqdy0Q0SgpJN/+McbP++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++CKZJ4tRcERh8oWyU0tE6PGk9Kzoz3Xk7++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++qV70KeNRxlFtVhVGhAFzg+EbwTyBowa3++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++7bUjCOOicJxx5d1FRhbGerIOuSm5j9Oq++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++mSoMIOS2iomSF55MbHC2qSaySQuYkJX++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++39oh8aKypBmoGiyk2eaPYwEsNRFFTe7++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++1LTixcngQDJ6jq6mLBzPx8E3PNfqibaL++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++fZrcqDDnjhnoVXDLlYBFRm6Pey2cEKoc++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++dfqYUjQ0TodGAM2b+r6JWxsNYfbY9t+e/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A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", "base64");

app.get("/assets/tech-battle-bg.jpg", (req, res) => {
  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(BG_IMAGE);
});

const DASHBOARD_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  min-height: 100vh;
  display: flex;
  background: #02050d;
  color: #fff;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  overflow-x: auto;
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  background: url("/assets/tech-battle-bg.jpg") center / cover no-repeat;
  filter: blur(14px) brightness(.5);
  transform: scale(1.05);
}
.stage {
  position: relative;
  z-index: 1;
  flex: none;
  margin: auto;
  width: max(min(100vw, 150vh), 820px);
  aspect-ratio: 3 / 2;
  background: url("/assets/tech-battle-bg.jpg") center / 100% 100% no-repeat;
  container-type: inline-size;
}
.content {
  position: absolute;
  left: 17.6%;
  width: 64.8%;
  top: 47.8%;
  display: flex;
  flex-direction: column;
  gap: .9cqw;
}
.grid, .links {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: .9cqw;
}
.card {
  height: 5.6cqw;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: .3cqw;
  border: .13cqw solid rgba(0,255,154,.75);
  border-radius: .7cqw;
  background: rgba(2, 14, 18, .93);
  box-shadow: 0 0 1cqw rgba(0,255,154,.25), inset 0 0 1cqw rgba(0,255,154,.06);
  text-align: center;
}
.card .icon { font-size: 1.5cqw; line-height: 1; }
.card .label {
  color: #b5cdc6;
  font-size: .85cqw;
  font-weight: 800;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.card .value {
  color: #fff;
  font-size: 1.4cqw;
  font-weight: 900;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.card .value.green { color: #00ff9a; }
.health {
  height: 4.2cqw;
  display: flex;
  align-items: center;
  gap: 1.4cqw;
  padding: 0 1.6cqw;
  border: .13cqw solid rgba(0,255,154,.75);
  border-radius: .7cqw;
  background: rgba(2, 14, 18, .93);
  box-shadow: 0 0 1cqw rgba(0,255,154,.25);
}
.health .label {
  font-size: .95cqw;
  font-weight: 900;
  letter-spacing: .1em;
  text-transform: uppercase;
  white-space: nowrap;
}
.bar {
  flex: 1;
  height: .95cqw;
  background: repeating-linear-gradient(90deg, #00ff9a 0 1.05cqw, transparent 1.05cqw 1.3cqw);
  box-shadow: 0 0 .8cqw rgba(0,255,154,.6);
}
.health .pct { color: #00ff9a; font-size: 1.1cqw; font-weight: 900; }
.link {
  height: 4.6cqw;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: .3cqw;
  border: .13cqw solid rgba(0,255,154,.75);
  border-radius: .7cqw;
  background: rgba(2, 14, 18, .93);
  box-shadow: 0 0 1cqw rgba(0,255,154,.25);
  color: #fff;
  text-decoration: none;
  transition: .15s;
}
.link:hover {
  background: rgba(0,255,154,.12);
  box-shadow: 0 0 1.6cqw rgba(0,255,154,.5);
}
.link .title { font-size: .95cqw; font-weight: 900; letter-spacing: .06em; text-transform: uppercase; }
.link .sub { color: #00ff9a; font-size: .95cqw; font-weight: 800; }
`;

const INFO_PAGE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  min-height: 100vh;
  color: #fff;
  background: #02050d url("/assets/tech-battle-bg.jpg") center top / cover fixed no-repeat;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  overflow-x: hidden;
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  background: rgba(0, 5, 10, .55);
  backdrop-filter: blur(3px);
}
.info-stage {
  position: relative;
  z-index: 1;
  width: min(1000px, calc(100vw - 70px));
  margin: 74px auto 30px;
}
.info-panel {
  border: 1px solid rgba(0,255,154,.62);
  border-radius: 28px;
  padding: 34px;
  background: rgba(2, 14, 20, .91);
  box-shadow: 0 0 35px rgba(0,255,154,.09), inset 0 0 30px rgba(0,255,154,.025);
}
.info-title {
  display: flex;
  align-items: center;
  gap: 18px;
  margin: 0;
  color: #00ff9a;
  font-size: clamp(32px, 4vw, 52px);
  font-weight: 950;
  letter-spacing: .035em;
  text-transform: uppercase;
}
.info-icon { font-size: .75em; }
.info-subtitle { margin: 12px 0 26px; color: #d7eee8; font-size: 16px; }
.info-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
.info-card {
  min-height: 82px;
  padding: 18px;
  border: 1px solid rgba(0,255,154,.38);
  border-radius: 18px;
  background: rgba(3, 20, 27, .88);
}
.info-label {
  color: #91aaa4;
  font-size: 12px;
  font-weight: 850;
  letter-spacing: .09em;
  text-transform: uppercase;
}
.info-value { margin-top: 7px; color: #fff; font-size: 20px; font-weight: 900; }
.info-value.green { color: #00ff9a; }
.info-section {
  margin-top: 22px;
  padding: 20px;
  border: 1px solid rgba(0,255,154,.25);
  border-radius: 18px;
  background: rgba(2, 14, 20, .72);
}
.info-section h2 {
  margin: 0 0 14px;
  color: #00ff9a;
  font-size: 17px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.info-row {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 10px 0;
  border-bottom: 1px solid rgba(0,255,154,.10);
}
.info-row:last-child { border-bottom: 0; }
.info-row span:first-child { color: #a9c3bc; }
.info-row span:last-child { color: #fff; font-weight: 750; text-align: right; }
.back {
  display: inline-block;
  margin-top: 22px;
  padding: 12px 18px;
  border: 1px solid rgba(0,255,154,.55);
  border-radius: 12px;
  color: #00ff9a;
  text-decoration: none;
  font-weight: 850;
}
.back:hover { background: rgba(0,255,154,.08); }
@media (max-width: 700px) {
  .info-stage { width: calc(100vw - 28px); margin-top: 40px; }
  .info-panel { padding: 22px; border-radius: 20px; }
  .info-grid { grid-template-columns: 1fr; }
  .info-row { flex-direction: column; gap: 4px; }
  .info-row span:last-child { text-align: left; }
}
`;

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderDashboard() {
  const cards = [
    ["⚡", "Status", "Active", true, ""],
    ["👥", "Multiplayer", `${MIN_PLAYERS}–${MAX_PLAYERS} Players`, false, ""],
    ["📡", "Socket.IO", "Connected", true, ""],
    ["🗄️", "Database", "In-Memory", true, ""],
    ["❓", "Quiz Questions", "10", false, ""],
    ["⏱️", "Question Timer", `${QUESTION_TIME / 1000} Seconds`, false, ""],
    ["🏠", "Active Rooms", String(rooms.size), false, "rooms"],
    ["🌐", "Environment", process.env.NODE_ENV || "production", false, ""]
  ];

  const cardsHtml = cards.map(([icon, label, value, green, id]) => `
    <div class="card">
      <div class="icon">${icon}</div>
      <div class="label">${escHtml(label)}</div>
      <div class="value ${green ? "green" : ""}" ${id ? `id="${id}"` : ""}>${escHtml(value)}</div>
    </div>`).join("");

  const links = [
    ["❤️", "API Status", "/health", "/health?view=page"],
    ["📡", "Socket.IO", "Enabled", "/socket-info?view=page"],
    ["🎮", "Game API", "/api", "/api?view=page"],
    ["📖", "Documentation", "/docs", "/docs?view=page"]
  ];

  const linksHtml = links.map(([icon, title, sub, href]) => `
    <a class="link" href="${href}">
      <div class="title">${icon} ${escHtml(title)}</div>
      <div class="sub">${escHtml(sub)}</div>
    </a>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#02050d">
<title>Tech Battle • Server Online</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
  <main class="stage">
    <div class="content">
      <section class="grid">${cardsHtml}</section>
      <section class="health">
        <span class="label">💚 Server Health</span>
        <div class="bar"></div>
        <span class="pct">100%</span>
      </section>
      <section class="links">${linksHtml}</section>
    </div>
  </main>
  <script>
    setInterval(function () {
      fetch("/health").then(function (r) { return r.json(); }).then(function (d) {
        var el = document.getElementById("rooms");
        if (el) el.textContent = d.activeRooms;
      }).catch(function () {});
    }, 5000);
  </script>
</body>
</html>`;
}

function renderInfoPage({ icon, title, subtitle, cards = [], sections = [] }) {
  const cardsHtml = cards.map((card) => `
    <article class="info-card">
      <div class="info-label">${escHtml(card.label)}</div>
      <div class="info-value ${card.green ? "green" : ""}">${escHtml(card.value)}</div>
    </article>`).join("");

  const sectionsHtml = sections.map((section) => `
    <section class="info-section">
      <h2>${escHtml(section.title)}</h2>
      ${(section.rows || []).map(([label, value]) => `
        <div class="info-row">
          <span>${escHtml(label)}</span>
          <span>${escHtml(value)}</span>
        </div>`).join("")}
    </section>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)} • Tech Battle</title>
<style>${INFO_PAGE_CSS}</style>
</head>
<body>
  <main class="info-stage">
    <section class="info-panel">
      <h1 class="info-title"><span class="info-icon">${icon}</span>${escHtml(title)}</h1>
      <p class="info-subtitle">${escHtml(subtitle)}</p>
      ${cardsHtml ? `<section class="info-grid">${cardsHtml}</section>` : ""}
      ${sectionsHtml}
      <a class="back" href="/">← Back to Tech Battle Server</a>
    </section>
  </main>
</body>
</html>`;
}

/* ---------- HOME ---------- */

app.get("/", (req, res) => {
  res.send(renderDashboard());
});

/* ============================================================
   API DATA
============================================================ */

const formatsList = () =>
  Object.fromEntries(
    MATCH_SIZES.map((size) => [
      size,
      Object.entries(BATTLE_FORMATS[size]).map(([id, config]) => ({ id, ...config }))
    ])
  );

const quizTypesList = () =>
  Object.entries(QUIZ_TYPES).map(([id, config]) => ({
    id,
    label: config.label,
    categories: config.categories
  }));

function getApiData() {
  return {
    service: "Tech Battle Server",
    status: "online",
    multiplayer: true,
    socketIO: true,
    environment: process.env.NODE_ENV || "production",
    players: { minimum: MIN_PLAYERS, maximum: MAX_PLAYERS },
    questions: 10,
    questionTime: QUESTION_TIME,
    matchSizes: MATCH_SIZES,
    battleFormats: formatsList(),
    quizTypes: quizTypesList()
  };
}

function getSocketInfoData() {
  return {
    ok: true,
    service: "Tech Battle Socket.IO",
    status: "enabled",
    transport: "WebSocket / polling"
  };
}

function getHealthData() {
  return {
    ok: true,
    service: "Tech Battle Server",
    status: "online",
    timestamp: Date.now(),
    uptimeSeconds: Math.floor(process.uptime()),
    activeRooms: rooms.size
  };
}

function getDocsData() {
  return {
    service: "Tech Battle Server",
    transport: "Socket.IO",
    limits: {
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      questionTimeMs: QUESTION_TIME,
      questionsPerGame: 10
    },
    matchSizes: MATCH_SIZES,
    battleFormats: formatsList(),
    quizTypes: quizTypesList(),
    clientEvents: [
      "time_sync", "create_room", "join_room", "reconnect_player",
      "start_game", "use_powerup", "submit_answer", "play_again", "leave_game"
    ],
    serverEvents: [
      "room_state", "countdown", "question", "answer_count", "question_results",
      "game_finished", "leaderboard_update", "battle_intro"
    ]
  };
}

/* ---------- API STATUS ---------- */
app.get("/health", (req, res) => {
  const data = getHealthData();
  if (req.query.view !== "page") return res.json(data);

  res.send(renderInfoPage({
    icon: "⚔️",
    title: "API Status",
    subtitle: "Live server health information",
    cards: [
      { label: "Status", value: "ONLINE", green: true },
      { label: "Active Rooms", value: String(rooms.size) },
      { label: "Uptime", value: `${data.uptimeSeconds}s` },
      { label: "Health", value: "100%", green: true }
    ]
  }));
});

/* ---------- SOCKET.IO ---------- */
app.get("/socket-info", (req, res) => {
  const data = getSocketInfoData();
  if (req.query.view !== "page") return res.json(data);

  res.send(renderInfoPage({
    icon: "📡",
    title: "Socket.IO",
    subtitle: "Real-time multiplayer connection service",
    cards: [
      { label: "Status", value: "ENABLED", green: true },
      { label: "Transport", value: "WEBSOCKET / POLLING" },
      { label: "Rooms", value: String(rooms.size) },
      { label: "Reconnect", value: "ENABLED", green: true }
    ],
    sections: [
      {
        title: "Realtime Events",
        rows: [
          ["Room state", "room_state"],
          ["Battle intro", "battle_intro"],
          ["Leaderboard", "leaderboard_update"],
          ["Questions", "question / question_results"],
          ["Game finished", "game_finished"]
        ]
      }
    ]
  }));
});

/* ---------- GAME API ---------- */
app.get("/api", (req, res) => {
  const data = getApiData();
  if (req.query.view !== "page") return res.json(data);

  res.send(renderInfoPage({
    icon: "🎮",
    title: "Game API",
    subtitle: "Available multiplayer game configuration",
    cards: [
      { label: "Status", value: "ONLINE", green: true },
      { label: "Players", value: `${MIN_PLAYERS}–${MAX_PLAYERS}` },
      { label: "Questions", value: "10" },
      { label: "Question Timer", value: `${QUESTION_TIME / 1000} SECONDS` },
      { label: "Match Sizes", value: MATCH_SIZES.join(" • ") },
      { label: "Quiz Types", value: String(Object.keys(QUIZ_TYPES).length) }
    ],
    sections: [
      {
        title: "Battle Formats",
        rows: MATCH_SIZES.flatMap((size) =>
          Object.values(BATTLE_FORMATS[size]).map((config) => [`${size} Players`, config.label])
        )
      },
      {
        title: "Quiz Types",
        rows: Object.entries(QUIZ_TYPES).map(([id, config]) => [id, config.label])
      }
    ]
  }));
});

/* ---------- DOCUMENTATION ---------- */
app.get("/docs", (req, res) => {
  const data = getDocsData();
  if (req.query.view !== "page") return res.json(data);

  res.send(renderInfoPage({
    icon: "📖",
    title: "Documentation",
    subtitle: "Tech Battle server events, limits and configuration",
    cards: [
      { label: "Transport", value: "SOCKET.IO" },
      { label: "Players", value: `${MIN_PLAYERS}–${MAX_PLAYERS}` },
      { label: "Questions / Game", value: "10" },
      { label: "Question Time", value: `${QUESTION_TIME / 1000} SECONDS` }
    ],
    sections: [
      {
        title: "Client Events",
        rows: data.clientEvents.map((event) => [event, "Client → Server"])
      },
      {
        title: "Server Events",
        rows: data.serverEvents.map((event) => [event, "Server → Client"])
      }
    ]
  }));
});

/* ============================================================
   START SERVER
============================================================ */

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("======================================");
  console.log("        TECH BATTLE SERVER");
  console.log("======================================");
  console.log(`Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log("Socket.IO multiplayer: ENABLED");
  console.log("Quiz types: ENABLED");
  console.log(
    `QuizBase API: ${
      QUIZBASE_API_KEY
        ? "CONFIGURED"
        : "NOT CONFIGURED (local fallback only)"
    }`
  );
  console.log("======================================");
});