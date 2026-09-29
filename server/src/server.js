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
   IMPORTANT: io MUST be initialized before io.on()
============================================================ */

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
   QUESTION BANK
   72 QUESTIONS
============================================================ */

const QUESTION_BANK = [

  /* PROGRAMMING */

  {
    id: "programming-easy-1",
    category: "programming",
    difficulty: "easy",
    text: "Which keyword defines a function in Python?",
    options: ["func", "def", "function", "define"],
    correctIndex: 1
  },

  {
    id: "programming-easy-2",
    category: "programming",
    difficulty: "easy",
    text: "Which symbol starts a comment in Python?",
    options: ["//", "#", "<!-- -->", "/* */"],
    correctIndex: 1
  },

  {
    id: "programming-easy-3",
    category: "programming",
    difficulty: "easy",
    text: "Which data type represents true/false values?",
    options: ["Integer", "Boolean", "String", "Float"],
    correctIndex: 1
  },

  {
    id: "programming-medium-1",
    category: "programming",
    difficulty: "medium",
    text: "What is the average-case lookup complexity of a hash table?",
    options: ["O(1)", "O(log n)", "O(n)", "O(n log n)"],
    correctIndex: 0
  },

  {
    id: "programming-medium-2",
    category: "programming",
    difficulty: "medium",
    text: "What does the acronym 'API' stand for?",
    options: [
      "Application Programming Interface",
      "Automated Program Instruction",
      "Applied Programming Index",
      "Advanced Protocol Interface"
    ],
    correctIndex: 0
  },

  {
    id: "programming-medium-3",
    category: "programming",
    difficulty: "medium",
    text: "Which sorting algorithm has average time complexity O(n log n)?",
    options: [
      "Bubble sort",
      "Merge sort",
      "Selection sort",
      "Insertion sort"
    ],
    correctIndex: 1
  },

  {
    id: "programming-hard-1",
    category: "programming",
    difficulty: "hard",
    text: "Which principle says software entities should be open for extension but closed for modification?",
    options: [
      "DRY",
      "KISS",
      "Open/Closed Principle",
      "YAGNI"
    ],
    correctIndex: 2
  },

  {
    id: "programming-hard-2",
    category: "programming",
    difficulty: "hard",
    text: "What is a race condition?",
    options: [
      "A CPU scheduling algorithm",
      "A bug from unsynchronized concurrent access to shared data",
      "A network routing error",
      "A type of memory leak"
    ],
    correctIndex: 1
  },

  {
    id: "programming-hard-3",
    category: "programming",
    difficulty: "hard",
    text: "Which design pattern restricts a class to a single instance?",
    options: [
      "Factory",
      "Singleton",
      "Observer",
      "Decorator"
    ],
    correctIndex: 1
  },

  /* AI */

  {
    id: "ai-easy-1",
    category: "ai",
    difficulty: "easy",
    text: "What does AI stand for?",
    options: [
      "Automated Interface",
      "Artificial Intelligence",
      "Applied Internet",
      "Algorithmic Integration"
    ],
    correctIndex: 1
  },

  {
    id: "ai-easy-2",
    category: "ai",
    difficulty: "easy",
    text: "What is a 'dataset' in machine learning?",
    options: [
      "A programming language",
      "A collection of data used to train models",
      "A type of neural network",
      "A cloud server"
    ],
    correctIndex: 1
  },

  {
    id: "ai-easy-3",
    category: "ai",
    difficulty: "easy",
    text: "Which company created ChatGPT?",
    options: [
      "Google",
      "Anthropic",
      "OpenAI",
      "Meta"
    ],
    correctIndex: 2
  },

  {
    id: "ai-medium-1",
    category: "ai",
    difficulty: "medium",
    text: "Which type of machine learning uses labeled training examples?",
    options: [
      "Unsupervised learning",
      "Reinforcement learning",
      "Supervised learning",
      "Random learning"
    ],
    correctIndex: 2
  },

  {
    id: "ai-medium-2",
    category: "ai",
    difficulty: "medium",
    text: "What is 'overfitting' in machine learning?",
    options: [
      "A model that performs well on new data",
      "A model that memorizes training data but fails to generalize",
      "A model with too few parameters",
      "A model trained too quickly"
    ],
    correctIndex: 1
  },

  {
    id: "ai-medium-3",
    category: "ai",
    difficulty: "medium",
    text: "What does NLP stand for?",
    options: [
      "Natural Language Processing",
      "Neural Learning Protocol",
      "Network Layer Programming",
      "Numeric Language Parsing"
    ],
    correctIndex: 0
  },

  {
    id: "ai-hard-1",
    category: "ai",
    difficulty: "hard",
    text: "Which activation function is commonly used in hidden layers of modern neural networks?",
    options: [
      "ReLU",
      "Softmax",
      "Linear only",
      "Identity only"
    ],
    correctIndex: 0
  },

  {
    id: "ai-hard-2",
    category: "ai",
    difficulty: "hard",
    text: "Which technique reduces overfitting by randomly disabling neurons during training?",
    options: [
      "Dropout",
      "Batch normalization",
      "Gradient clipping",
      "Pooling"
    ],
    correctIndex: 0
  },

  {
    id: "ai-hard-3",
    category: "ai",
    difficulty: "hard",
    text: "What is the core mechanism behind Transformer models?",
    options: [
      "Convolution",
      "Recurrence",
      "Self-attention",
      "Pooling"
    ],
    correctIndex: 2
  },

  /* COMPUTER SCIENCE */

  {
    id: "cs-easy-1",
    category: "computer-science",
    difficulty: "easy",
    text: "What does CPU stand for?",
    options: [
      "Central Processing Unit",
      "Computer Primary Utility",
      "Core Program Unit",
      "Central Program User"
    ],
    correctIndex: 0
  },

  {
    id: "cs-easy-2",
    category: "computer-science",
    difficulty: "easy",
    text: "What does RAM stand for?",
    options: [
      "Random Access Memory",
      "Read Access Module",
      "Rapid Application Method",
      "Runtime Allocation Memory"
    ],
    correctIndex: 0
  },

  {
    id: "cs-easy-3",
    category: "computer-science",
    difficulty: "easy",
    text: "Which number system uses only 0s and 1s?",
    options: [
      "Decimal",
      "Binary",
      "Hexadecimal",
      "Octal"
    ],
    correctIndex: 1
  },

  {
    id: "cs-medium-1",
    category: "computer-science",
    difficulty: "medium",
    text: "Which data structure follows FIFO ordering?",
    options: [
      "Stack",
      "Queue",
      "Tree",
      "Heap"
    ],
    correctIndex: 1
  },

  {
    id: "cs-medium-2",
    category: "computer-science",
    difficulty: "medium",
    text: "Which data structure uses LIFO ordering?",
    options: [
      "Queue",
      "Stack",
      "Array",
      "Linked list"
    ],
    correctIndex: 1
  },

  {
    id: "cs-medium-3",
    category: "computer-science",
    difficulty: "medium",
    text: "What is recursion?",
    options: [
      "A loop that never ends",
      "A function that calls itself",
      "A sorting algorithm",
      "A type of variable"
    ],
    correctIndex: 1
  },

  {
    id: "cs-hard-1",
    category: "computer-science",
    difficulty: "hard",
    text: "What is the time complexity of binary search on a sorted array?",
    options: [
      "O(1)",
      "O(log n)",
      "O(n)",
      "O(n²)"
    ],
    correctIndex: 1
  },

  {
    id: "cs-hard-2",
    category: "computer-science",
    difficulty: "hard",
    text: "What is the worst-case time complexity of quicksort?",
    options: [
      "O(n log n)",
      "O(n)",
      "O(n²)",
      "O(log n)"
    ],
    correctIndex: 2
  },

  {
    id: "cs-hard-3",
    category: "computer-science",
    difficulty: "hard",
    text: "Which traversal visits a binary tree's root before its children?",
    options: [
      "In-order",
      "Post-order",
      "Pre-order",
      "Level-order"
    ],
    correctIndex: 2
  },

  /* DATABASES */

  {
    id: "db-easy-1",
    category: "databases",
    difficulty: "easy",
    text: "Which SQL command retrieves rows from a table?",
    options: [
      "GET",
      "SELECT",
      "READ",
      "FETCHROW"
    ],
    correctIndex: 1
  },

  {
    id: "db-easy-2",
    category: "databases",
    difficulty: "easy",
    text: "What does SQL stand for?",
    options: [
      "Structured Query Language",
      "Simple Query Logic",
      "Sequential Query List",
      "System Query Language"
    ],
    correctIndex: 0
  },

  {
    id: "db-easy-3",
    category: "databases",
    difficulty: "easy",
    text: "Which command adds new rows to a table?",
    options: [
      "INSERT",
      "ADD",
      "APPEND",
      "CREATE"
    ],
    correctIndex: 0
  },

  {
    id: "db-medium-1",
    category: "databases",
    difficulty: "medium",
    text: "What does a primary key uniquely identify?",
    options: [
      "A database",
      "A table",
      "A row in a table",
      "A SQL query"
    ],
    correctIndex: 2
  },

  {
    id: "db-medium-2",
    category: "databases",
    difficulty: "medium",
    text: "What does a foreign key do?",
    options: [
      "Encrypts a column",
      "Links a row to a row in another table",
      "Indexes a table for speed",
      "Deletes duplicate rows"
    ],
    correctIndex: 1
  },

  {
    id: "db-medium-3",
    category: "databases",
    difficulty: "medium",
    text: "What type of database uses tables with rows and columns?",
    options: [
      "Relational",
      "Document",
      "Graph",
      "Key-value"
    ],
    correctIndex: 0
  },

  {
    id: "db-hard-1",
    category: "databases",
    difficulty: "hard",
    text: "Which normal form removes transitive dependencies?",
    options: [
      "1NF",
      "2NF",
      "3NF",
      "4NF"
    ],
    correctIndex: 2
  },

  {
    id: "db-hard-2",
    category: "databases",
    difficulty: "hard",
    text: "What does ACID stand for in database transactions?",
    options: [
      "Atomicity, Consistency, Isolation, Durability",
      "Access, Control, Index, Data",
      "Automatic Commit In Databases",
      "Aggregation, Cache, Index, Durability"
    ],
    correctIndex: 0
  },

  {
    id: "db-hard-3",
    category: "databases",
    difficulty: "hard",
    text: "Which SQL clause combines rows from two tables based on a related column?",
    options: [
      "WHERE",
      "JOIN",
      "GROUP BY",
      "UNION"
    ],
    correctIndex: 1
  },

  /* WEB DEVELOPMENT */

  {
    id: "web-easy-1",
    category: "web-development",
    difficulty: "easy",
    text: "Which language structures the content of a web page?",
    options: [
      "HTML",
      "CSS",
      "SQL",
      "Bash"
    ],
    correctIndex: 0
  },

  {
    id: "web-easy-2",
    category: "web-development",
    difficulty: "easy",
    text: "Which language is primarily used to style web pages?",
    options: [
      "HTML",
      "CSS",
      "SQL",
      "Python"
    ],
    correctIndex: 1
  },

  {
    id: "web-easy-3",
    category: "web-development",
    difficulty: "easy",
    text: "What does URL stand for?",
    options: [
      "Uniform Resource Locator",
      "Universal Record Link",
      "User Response Layer",
      "Unified Retrieval Language"
    ],
    correctIndex: 0
  },

  {
    id: "web-medium-1",
    category: "web-development",
    difficulty: "medium",
    text: "Which HTTP method is conventionally used to create a resource?",
    options: [
      "GET",
      "POST",
      "HEAD",
      "OPTIONS"
    ],
    correctIndex: 1
  },

  {
    id: "web-medium-2",
    category: "web-development",
    difficulty: "medium",
    text: "Which JavaScript concept lets a function remember variables from its outer scope?",
    options: [
      "Hoisting",
      "Closure",
      "Promise",
      "Callback"
    ],
    correctIndex: 1
  },

  {
    id: "web-medium-3",
    category: "web-development",
    difficulty: "medium",
    text: "What does DOM stand for?",
    options: [
      "Document Object Model",
      "Data Output Method",
      "Dynamic Object Mapping",
      "Document Ordering Module"
    ],
    correctIndex: 0
  },

  {
    id: "web-hard-1",
    category: "web-development",
    difficulty: "hard",
    text: "What does CORS primarily control?",
    options: [
      "Database indexing",
      "Cross-origin browser requests",
      "CPU scheduling",
      "File compression"
    ],
    correctIndex: 1
  },

  {
    id: "web-hard-2",
    category: "web-development",
    difficulty: "hard",
    text: "Which HTTP status code indicates a resource was not found?",
    options: [
      "200",
      "301",
      "404",
      "500"
    ],
    correctIndex: 2
  },

  {
    id: "web-hard-3",
    category: "web-development",
    difficulty: "hard",
    text: "What is the purpose of a JWT?",
    options: [
      "To style web pages",
      "To securely transmit claims between parties as a token",
      "To compress images",
      "To query databases"
    ],
    correctIndex: 1
  },

  /* NETWORKING */

  {
    id: "networking-easy-1",
    category: "networking",
    difficulty: "easy",
    text: "What does IP stand for?",
    options: [
      "Internet Protocol",
      "Internal Port",
      "Interface Process",
      "Internet Provider"
    ],
    correctIndex: 0
  },

  {
    id: "networking-easy-2",
    category: "networking",
    difficulty: "easy",
    text: "What device connects multiple networks together?",
    options: [
      "Router",
      "Monitor",
      "Keyboard",
      "Printer"
    ],
    correctIndex: 0
  },

  {
    id: "networking-easy-3",
    category: "networking",
    difficulty: "easy",
    text: "What does Wi-Fi primarily use to transmit data?",
    options: [
      "Radio waves",
      "Sound waves",
      "Light waves",
      "Sound cables"
    ],
    correctIndex: 0
  },

  {
    id: "networking-medium-1",
    category: "networking",
    difficulty: "medium",
    text: "Which protocol translates domain names into IP addresses?",
    options: [
      "DHCP",
      "DNS",
      "FTP",
      "SSH"
    ],
    correctIndex: 1
  },

  {
    id: "networking-medium-2",
    category: "networking",
    difficulty: "medium",
    text: "Which port does HTTPS typically use?",
    options: [
      "21",
      "80",
      "443",
      "8080"
    ],
    correctIndex: 2
  },

  {
    id: "networking-medium-3",
    category: "networking",
    difficulty: "medium",
    text: "What does VPN stand for?",
    options: [
      "Virtual Private Network",
      "Verified Public Network",
      "Virtual Personal Node",
      "Variable Packet Network"
    ],
    correctIndex: 0
  },

  {
    id: "networking-hard-1",
    category: "networking",
    difficulty: "hard",
    text: "Which transport protocol provides reliable and ordered delivery?",
    options: [
      "UDP",
      "ICMP",
      "TCP",
      "ARP"
    ],
    correctIndex: 2
  },

  {
    id: "networking-hard-2",
    category: "networking",
    difficulty: "hard",
    text: "Which layer of the OSI model handles routing between networks?",
    options: [
      "Data link",
      "Network",
      "Transport",
      "Session"
    ],
    correctIndex: 1
  },

  {
    id: "networking-hard-3",
    category: "networking",
    difficulty: "hard",
    text: "What does a subnet mask do?",
    options: [
      "Encrypts network traffic",
      "Divides an IP network into subnetworks",
      "Assigns MAC addresses",
      "Blocks malicious traffic"
    ],
    correctIndex: 1
  },

  /* CLOUD */

  {
    id: "cloud-easy-1",
    category: "cloud",
    difficulty: "easy",
    text: "Which cloud service model provides virtualized computing resources?",
    options: [
      "IaaS",
      "SaaS",
      "LAN",
      "DNS"
    ],
    correctIndex: 0
  },

  {
    id: "cloud-easy-2",
    category: "cloud",
    difficulty: "easy",
    text: "What does SaaS deliver to users?",
    options: [
      "Raw hardware",
      "Software over the internet",
      "Only storage",
      "Only networking"
    ],
    correctIndex: 1
  },

  {
    id: "cloud-easy-3",
    category: "cloud",
    difficulty: "easy",
    text: "Which company operates AWS?",
    options: [
      "Google",
      "Microsoft",
      "Amazon",
      "IBM"
    ],
    correctIndex: 2
  },

  {
    id: "cloud-medium-1",
    category: "cloud",
    difficulty: "medium",
    text: "Which cloud property allows resources to scale with demand?",
    options: [
      "Elasticity",
      "Normalization",
      "Compilation",
      "Locality"
    ],
    correctIndex: 0
  },

  {
    id: "cloud-medium-2",
    category: "cloud",
    difficulty: "medium",
    text: "What is a 'region' in cloud computing?",
    options: [
      "A single server",
      "A geographic area containing data centers",
      "A type of database",
      "A pricing tier"
    ],
    correctIndex: 1
  },

  {
    id: "cloud-medium-3",
    category: "cloud",
    difficulty: "medium",
    text: "What does 'serverless' computing mean?",
    options: [
      "There are no servers anywhere",
      "Developers don't manage the underlying servers",
      "It only runs on local machines",
      "It requires manual server provisioning"
    ],
    correctIndex: 1
  },

  {
    id: "cloud-hard-1",
    category: "cloud",
    difficulty: "hard",
    text: "Which service model provides a managed application platform?",
    options: [
      "IaaS",
      "PaaS",
      "DNS",
      "LAN"
    ],
    correctIndex: 1
  },

  {
    id: "cloud-hard-2",
    category: "cloud",
    difficulty: "hard",
    text: "What is a key benefit of container orchestration tools like Kubernetes?",
    options: [
      "Manual scaling only",
      "Automated deployment, scaling, and management of containers",
      "Faster internet speed",
      "Cheaper electricity bills"
    ],
    correctIndex: 1
  },

  {
    id: "cloud-hard-3",
    category: "cloud",
    difficulty: "hard",
    text: "What does 'multi-tenancy' mean in cloud architecture?",
    options: [
      "One customer per physical server",
      "Multiple customers sharing the same infrastructure securely",
      "Servers located in multiple countries",
      "Backup servers only"
    ],
    correctIndex: 1
  },

  /* CYBERSECURITY */

  {
    id: "security-easy-1",
    category: "cybersecurity",
    difficulty: "easy",
    text: "What is phishing?",
    options: [
      "A backup method",
      "A social-engineering attack",
      "A routing protocol",
      "A compression algorithm"
    ],
    correctIndex: 1
  },

  {
    id: "security-easy-2",
    category: "cybersecurity",
    difficulty: "easy",
    text: "What is a firewall used for?",
    options: [
      "Speeding up internet",
      "Filtering network traffic for security",
      "Storing passwords",
      "Compressing files"
    ],
    correctIndex: 1
  },

  {
    id: "security-easy-3",
    category: "cybersecurity",
    difficulty: "easy",
    text: "What does 2FA stand for?",
    options: [
      "Two-Factor Authentication",
      "Two-File Access",
      "Twice Fast Authorization",
      "Two-Frame Analysis"
    ],
    correctIndex: 0
  },

  {
    id: "security-medium-1",
    category: "cybersecurity",
    difficulty: "medium",
    text: "Which principle gives users only the permissions they need?",
    options: [
      "Least privilege",
      "Fail-open",
      "Replication",
      "Obfuscation"
    ],
    correctIndex: 0
  },

  {
    id: "security-medium-2",
    category: "cybersecurity",
    difficulty: "medium",
    text: "What is malware?",
    options: [
      "Malicious software designed to harm systems",
      "A hardware component",
      "A networking protocol",
      "A database query"
    ],
    correctIndex: 0
  },

  {
    id: "security-medium-3",
    category: "cybersecurity",
    difficulty: "medium",
    text: "What is a VPN primarily used for in security?",
    options: [
      "Speeding up downloads",
      "Encrypting and securing network traffic",
      "Compressing files",
      "Blocking all internet access"
    ],
    correctIndex: 1
  },

  {
    id: "security-hard-1",
    category: "cybersecurity",
    difficulty: "hard",
    text: "Which attack injects untrusted input into a database query?",
    options: [
      "SQL injection",
      "ARP spoofing",
      "DDoS",
      "Packet fragmentation"
    ],
    correctIndex: 0
  },

  {
    id: "security-hard-2",
    category: "cybersecurity",
    difficulty: "hard",
    text: "What is a 'zero-day' vulnerability?",
    options: [
      "A bug fixed the same day it's found",
      "A flaw unknown to the vendor with no available patch",
      "A vulnerability only in old software",
      "A type of firewall rule"
    ],
    correctIndex: 1
  },

  {
    id: "security-hard-3",
    category: "cybersecurity",
    difficulty: "hard",
    text: "What does encryption 'at rest' protect?",
    options: [
      "Data while being typed",
      "Data stored on disk",
      "Data displayed on screen",
      "Data in browser cache"
    ],
    correctIndex: 1
  }
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

    [result[i], result[j]] =
      [result[j], result[i]];
  }

  return result;
}

function cleanName(value) {
  const name = String(value || "")
    .trim()
    .replace(/\s+/g, " ");

  if (
    name.length < 2 ||
    name.length > 16
  ) {
    return null;
  }

  if (
    !/^[A-Za-z0-9 _-]+$/.test(name)
  ) {
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
      const index = Math.floor(
        Math.random() *
          ROOM_CHARACTERS.length
      );

      code += ROOM_CHARACTERS[index];
    }
  } while (rooms.has(code));

  return code;
}

/* ============================================================
   QUESTION SELECTION
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

function createGameQuestions() {
  const repeatedCategories =
    shuffle(CATEGORIES).slice(0, 2);

  const categorySlots = shuffle([
    ...CATEGORIES,
    ...repeatedCategories
  ]);

  const difficultyPool = [
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

  const assignments = [];

  const usedQuestionIds =
    new Set();

  const usedCategoryDifficulty =
    new Set();

  function solve(
    index,
    remainingDifficulties
  ) {
    if (
      index >=
      categorySlots.length
    ) {
      return true;
    }

    const category =
      categorySlots[index];

    const tryOrder =
      shuffle(
        remainingDifficulties
      );

    for (
      const difficulty of tryOrder
    ) {
      const key =
        `${category}:${difficulty}`;

      if (
        usedCategoryDifficulty.has(
          key
        )
      ) {
        continue;
      }

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

      if (
        candidates.length === 0
      ) {
        continue;
      }

      const question =
        candidates[0];

      assignments[index] =
        question;

      usedCategoryDifficulty.add(
        key
      );

      usedQuestionIds.add(
        question.id
      );

      const nextRemaining = [
        ...remainingDifficulties
      ];

      nextRemaining.splice(
        nextRemaining.indexOf(
          difficulty
        ),
        1
      );

      if (
        solve(
          index + 1,
          nextRemaining
        )
      ) {
        return true;
      }

      usedCategoryDifficulty.delete(
        key
      );

      usedQuestionIds.delete(
        question.id
      );

      assignments[index] =
        null;
    }

    return false;
  }

  const solved =
    solve(0, difficultyPool);

  if (!solved) {
    throw new Error(
      "Unable to create question set."
    );
  }

  return shuffle(
    assignments
  ).map(
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

/* ============================================================
   ROOM STATE
============================================================ */

function publicRoomState(room) {
  const players =
    [
      ...room.players.values()
    ]
      .filter(
        (player) =>
          player.active
      )
      .map(
        (player) => ({
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
            room.hostPlayerId
        })
      );

  return {
    code: room.code,

    status:
      room.status,

    hostPlayerId:
      room.hostPlayerId,

    players,

    currentQuestion:
      room.currentQuestionIndex,

    answeredCount:
      room.answers.size,

    connectedAnswerCount:
      getConnectedPlayers(
        room
      ).filter(
        (player) =>
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
      Boolean(
        existingAnswer
      ),

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
   SEND CURRENT STATE
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
  }
}

/* ============================================================
   CLEAR TIMERS
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
   START COUNTDOWN
============================================================ */

function startCountdown(room) {
  clearRoomTimers(room);

  room.status =
    "countdown";

  room.currentQuestionIndex =
    -1;

  room.questions =
    createGameQuestions();

  room.countdownEndsAt =
    Date.now() +
    COUNTDOWN_TIME;

  broadcastRoom(room);

  io.to(room.code).emit(
    "countdown",
    {
      endsAt:
        room.countdownEndsAt
    }
  );

  room.timer =
    setTimeout(
      () => {
        startQuestion(room);
      },
      COUNTDOWN_TIME
    );
}

/* ============================================================
   START QUESTION
============================================================ */

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
      () => {
        finishQuestion(room);
      },
      QUESTION_TIME
    );
}

/* ============================================================
   FINISH QUESTION
============================================================ */

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
        (
          remaining /
          QUESTION_TIME
        );

      const streakBonus =
        Math.min(
          STREAK_BONUS_CAP,
          player.streak *
            STREAK_BONUS_PER_STEP
        );

      points =
        Math.round(
          100 +
          speedBonus +
          streakBonus
        );

      if (
        player.doublePointsActive
      ) {
        points *= 2;
      }

      player.streak += 1;
    } else {
      player.streak = 0;
    }

    player.doublePointsActive =
      false;

    player.lastPoints =
      points;

    player.score +=
      points;
  }

  const leaderboard =
    getActivePlayers(room)
      .map(
        (player) => ({
          id: player.id,

          name: player.name,

          points:
            player.lastPoints ||
            0,

          total:
            player.score,

          streak:
            player.streak
        })
      )
      .sort(
        (a, b) =>
          b.total -
          a.total
      );

  room.lastResults = {
    questionNumber:
      room.currentQuestionIndex +
      1,

    correctAnswer:
      question.options[
        question.correctIndex
      ],

    players:
      leaderboard
  };

  broadcastRoom(room);

  io.to(room.code).emit(
    "question_results",
    room.lastResults
  );

  room.timer =
    setTimeout(
      () => {
        if (
          room.currentQuestionIndex >=
          room.questions.length - 1
        ) {
          finishGame(room);
        } else {
          startQuestion(room);
        }
      },
      RESULTS_TIME
    );
}

/* ============================================================
   FINISH GAME
============================================================ */

function finishGame(room) {
  clearRoomTimers(room);

  room.status =
    "finished";

  const leaderboard =
    [
      ...room.players.values()
    ]
      .map(
        (player) => ({
          id: player.id,
          name: player.name,
          total: player.score,
          left:
            !player.active
        })
      )
      .sort(
        (a, b) =>
          b.total -
          a.total
      );

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

  room.finalResults = {
    leaderboard,

    winners,

    winner:
      winners[0] ||
      null
  };

  broadcastRoom(room);

  io.to(room.code).emit(
    "game_finished",
    room.finalResults
  );

  room.cleanupTimer =
    setTimeout(
      () => {
        rooms.delete(
          room.code
        );
      },
      ROOM_IDLE_CLEANUP
    );
}

/* ============================================================
   RESET FOR PLAY AGAIN
============================================================ */

function resetRoomForReplay(room) {
  clearRoomTimers(room);

  room.status =
    "waiting";

  room.currentQuestionIndex =
    -1;

  room.questions = [];

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
   RECONNECT EXPIRY
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
    setTimeout(
      () => {
        if (
          player.connected ||
          !player.active
        ) {
          return;
        }

        player.active =
          false;

        if (
          room.hostPlayerId ===
          player.id
        ) {
          transferHost(room);
        }

        broadcastRoom(room);

        checkMinPlayers(room);

        maybeDeleteEmptyRoom(room);
      },
      RECONNECT_GRACE
    );
}

/* ============================================================
   EARLY FINISH
============================================================ */

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
    connected.length === 0
  ) {
    return;
  }

  const allAnswered =
    connected.every(
      (player) =>
        room.answers.has(
          player.id
        )
    );

  if (allAnswered) {
    finishQuestion(room);
  }
}

/* ============================================================
   MINIMUM PLAYERS
============================================================ */

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
        .length < MIN_PLAYERS
    ) {
      finishGame(room);
    }
  }
}

/* ============================================================
   DELETE EMPTY ROOM
============================================================ */

function maybeDeleteEmptyRoom(
  room
) {
  const stillPresent =
    [
      ...room.players.values()
    ].some(
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

/* ============================================================
   REMOVE PLAYER
============================================================ */

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

  player.active =
    false;

  player.connected =
    false;

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

  maybeDeleteEmptyRoom(room);
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

  const playerId =
    randomId();

  const token =
    randomId();

  const room = {
    code:
      roomCode,

    status:
      "waiting",

    hostPlayerId:
      playerId,

    players:
      new Map(),

    questions:
      [],

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

  const player = {
    id:
      playerId,

    token:
      token,

    name:
      name,

    score:
      0,

    streak:
      0,

    lastPoints:
      0,

    powerups: {
      fiftyFifty:
        true,

      doublePoints:
        true
    },

    doublePointsActive:
      false,

    active:
      true,

    connected:
      true,

    socketId:
      socket.id,

    reconnectTimer:
      null
  };

  room.players.set(
    playerId,
    player
  );

  rooms.set(
    roomCode,
    room
  );

  socket.join(
    roomCode
  );

  socket.data.roomCode =
    roomCode;

  socket.data.playerId =
    playerId;

  socket.data.token =
    token;

  callback({
    ok: true,

    roomCode,

    playerId,

    token,

    name
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
    rooms.get(
      roomCode
    );

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
    getActivePlayers(
      room
    );

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
        player.name
          .toLowerCase() ===
        name.toLowerCase()
    );

  if (duplicate) {
    callback({
      error:
        "That player name is already taken."
    });

    return;
  }

  const playerId =
    randomId();

  const token =
    randomId();

  const player = {
    id:
      playerId,

    token:
      token,

    name:
      name,

    score:
      0,

    streak:
      0,

    lastPoints:
      0,

    powerups: {
      fiftyFifty:
        true,

      doublePoints:
        true
    },

    doublePointsActive:
      false,

    active:
      true,

    connected:
      true,

    socketId:
      socket.id,

    reconnectTimer:
      null
  };

  room.players.set(
    playerId,
    player
  );

  socket.join(
    roomCode
  );

  socket.data.roomCode =
    roomCode;

  socket.data.playerId =
    playerId;

  socket.data.token =
    token;

  callback({
    ok: true,

    roomCode,

    playerId,

    token,

    name
  });

  broadcastRoom(room);
}

/* ============================================================
   RECONNECT PLAYER
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
      payload?.token ||
      ""
    );

  const room =
    rooms.get(
      roomCode
    );

  if (!room) {
    callback({
      error:
        "The room no longer exists."
    });

    return;
  }

  const player =
    [
      ...room.players.values()
    ].find(
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

  socket.join(
    roomCode
  );

  socket.data.roomCode =
    roomCode;

  socket.data.playerId =
    player.id;

  socket.data.token =
    player.token;

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

    /* CREATE ROOM */

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

    /* JOIN ROOM */

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

    /* START GAME */

    socket.on(
      "start_game",
      (
        payload,
        callback
      ) => {

        const room =
          rooms.get(
            socket.data.roomCode
          );

        if (!room) {

          callback({
            error:
              "Room not found."
          });

          return;
        }

        const player =
          room.players.get(
            socket.data.playerId
          );

        if (!player) {

          callback({
            error:
              "Player not found."
          });

          return;
        }

        if (
          room.hostPlayerId !==
          player.id
        ) {

          callback({
            error:
              "Only the host can start the game."
          });

          return;
        }

        if (
          room.status !==
          "waiting"
        ) {

          callback({
            error:
              "The game has already started."
          });

          return;
        }

        if (
          getActivePlayers(room)
            .length <
          MIN_PLAYERS
        ) {

          callback({
            error:
              "At least 2 players are required."
          });

          return;
        }

        try {

          startCountdown(
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

    /* USE POWER-UP */

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

          callback?.({
            error:
              "Room not found."
          });

          return;
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

          callback?.({
            error:
              "You are not an active player."
          });

          return;
        }

        if (
          room.status !==
          "question"
        ) {

          callback?.({
            error:
              "Power-ups can only be used during a question."
          });

          return;
        }

        if (
          room.answers.has(
            player.id
          )
        ) {

          callback?.({
            error:
              "You already answered this question."
          });

          return;
        }

        const type =
          payload?.type;

        const question =
          room.questions[
            room.currentQuestionIndex
          ];

        if (
          type ===
          "fiftyFifty"
        ) {

          if (
            !player.powerups
              .fiftyFifty
          ) {

            callback?.({
              error:
                "You already used 50/50."
            });

            return;
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

          callback?.({
            ok: true,

            eliminatedOptions:
              eliminated
          });

          return;
        }

        if (
          type ===
          "doublePoints"
        ) {

          if (
            !player.powerups
              .doublePoints
          ) {

            callback?.({
              error:
                "You already used Double Points."
            });

            return;
          }

          player.powerups
            .doublePoints =
            false;

          player.doublePointsActive =
            true;

          callback?.({
            ok: true,

            doublePointsActive:
              true
          });

          return;
        }

        callback?.({
          error:
            "Unknown power-up."
        });

      }
    );

    /* SUBMIT ANSWER */

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

          callback({
            error:
              "Room not found."
          });

          return;
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

          callback({
            error:
              "You are not an active player."
          });

          return;
        }

        if (
          room.status !==
          "question"
        ) {

          callback({
            error:
              "The question is no longer active."
          });

          return;
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

          callback({
            error:
              "This question is no longer current."
          });

          return;
        }

        if (
          room.answers.has(
            player.id
          )
        ) {

          callback({
            error:
              "You have already answered this question."
          });

          return;
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
            question.options.length
        ) {

          callback({
            error:
              "Invalid answer."
          });

          return;
        }

        const now =
          Date.now();

        if (
          now >
          room.questionEndsAt
        ) {

          callback({
            error:
              "Time is up."
          });

          return;
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

        const connectedPlayers =
          getConnectedPlayers(
            room
          );

        io.to(
          room.code
        ).emit(
          "answer_count",
          {
            count:
              room.answers.size,

            total:
              connectedPlayers.length
          }
        );

        checkEarlyFinish(
          room
        );

      }
    );

    /* PLAY AGAIN */

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

          callback?.({
            error:
              "Room not found."
          });

          return;
        }

        const player =
          room.players.get(
            socket.data.playerId
          );

        if (!player) {

          callback?.({
            error:
              "Player not found."
          });

          return;
        }

        if (
          room.hostPlayerId !==
          player.id
        ) {

          callback?.({
            error:
              "Only the host can restart the game."
          });

          return;
        }

        if (
          room.status !==
          "finished"
        ) {

          callback?.({
            error:
              "The game hasn't finished yet."
          });

          return;
        }

        resetRoomForReplay(
          room
        );

        callback?.({
          ok: true
        });

      }
    );

    /* LEAVE GAME */

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

          callback?.({
            ok: true
          });

          return;
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

    /* DISCONNECT */

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

          transferHost(
            room
          );

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
   DASHBOARD
   VISUAL DESIGN UPDATED TO MATCH SECOND PHOTO STYLE
   ONLY EXISTING SERVER INFORMATION IS USED
============================================================ */

app.get("/", (req, res) => {

  res.send(`

<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
/>

<title>Tech Battle Server</title>

<style>

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
}

body {

  min-height: 100vh;

  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  color: #ffffff;

  overflow-x: hidden;

  position: relative;

  background:

    radial-gradient(
      circle at 50% 8%,
      rgba(
        0,
        255,
        154,
        0.15
      ),
      transparent 22%
    ),

    radial-gradient(
      circle at 10% 70%,
      rgba(
        0,
        255,
        190,
        0.08
      ),
      transparent 25%
    ),

    radial-gradient(
      circle at 90% 75%,
      rgba(
        70,
        120,
        255,
        0.10
      ),
      transparent 28%
    ),

    linear-gradient(
      180deg,
      #05070f 0%,
      #071018 50%,
      #03060b 100%
    );
}

body::before {

  content: "";

  position: fixed;

  inset: 0;

  pointer-events: none;

  opacity: 0.55;

  background-image:

    radial-gradient(
      circle,
      rgba(
        255,
        255,
        255,
        0.9
      )
      0 1px,
      transparent 1.5px
    ),

    radial-gradient(
      circle,
      rgba(
        0,
        255,
        166,
        0.65
      )
      0 1px,
      transparent 1.5px
    );

  background-size:
    115px 115px,
    185px 185px;

  background-position:
    12px 25px,
    70px 80px;
}

body::after {

  content: "";

  position: fixed;

  width: 720px;

  height: 720px;

  right: -260px;

  top: 130px;

  border-radius: 50%;

  background:

    radial-gradient(
      circle at 35% 30%,
      rgba(
        255,
        255,
        255,
        0.14
      ),
      transparent 8%
    ),

    radial-gradient(
      circle at 45% 45%,
      #182332 0%,
      #0a111a 52%,
      #02040a 70%
    );

  box-shadow:

    inset
      -70px
      -35px
      100px
      rgba(
        0,
        0,
        0,
        0.75
      );

  opacity: 0.58;

  pointer-events: none;
}

.page {

  position: relative;

  z-index: 1;

  width:
    min(
      1120px,
      92vw
    );

  margin:
    0 auto;

  padding:
    48px 0 34px;
}

.hero {

  text-align: center;

  position: relative;
}

.crown {

  font-size:
    clamp(
      42px,
      7vw,
      70px
    );

  line-height: 0.8;

  filter:
    drop-shadow(
      0 0 18px
      rgba(
        255,
        205,
        70,
        0.55
      )
    );
}

.weapons {

  position: absolute;

  left: 2%;

  top: 42px;

  font-size:
    clamp(
      38px,
      6vw,
      68px
    );

  transform:
    rotate(-28deg);

  filter:
    drop-shadow(
      0 0 14px
      rgba(
        0,
        255,
        160,
        0.45
      )
    );
}

.controller {

  position: absolute;

  right: 2%;

  top: 45px;

  font-size:
    clamp(
      40px,
      6vw,
      68px
    );

  transform:
    rotate(9deg);

  filter:
    drop-shadow(
      0 0 14px
      rgba(
        0,
        255,
        160,
        0.40
      )
    );
}

h1 {

  margin:
    8px 0 4px;

  font-size:
    clamp(
      48px,
      9vw,
      92px
    );

  line-height:
    0.95;

  letter-spacing:
    0.09em;

  font-weight:
    950;

  font-style:
    italic;

  color:
    #ffffff;

  text-shadow:

    0 0 8px
      rgba(
        0,
        255,
        160,
        0.9
      ),

    0 0 25px
      rgba(
        0,
        255,
        160,
        0.55
      ),

    0 0 55px
      rgba(
        0,
        255,
        160,
        0.25
      );
}

.title-line {

  width:
    min(
      650px,
      75vw
    );

  height:
    2px;

  margin:
    14px auto 16px;

  background:
    linear-gradient(
      90deg,
      transparent,
      #00ff9a,
      transparent
    );

  box-shadow:
    0 0 18px
    rgba(
      0,
      255,
      154,
      0.8
    );
}

.subtitle {

  color:
    #d9fff1;

  font-size:
    clamp(
      12px,
      2vw,
      17px
    );

  letter-spacing:
    0.22em;

  text-transform:
    uppercase;

  font-weight:
    800;
}

.online {

  width:
    fit-content;

  margin:
    25px auto 8px;

  padding:
    9px 20px;

  border:
    1px solid
    rgba(
      0,
      255,
      154,
      0.55
    );

  border-radius:
    999px;

  background:
    rgba(
      0,
      255,
      154,
      0.07
    );

  color:
    #00ff9a;

  font-size:
    13px;

  font-weight:
    900;

  letter-spacing:
    0.15em;

  box-shadow:

    0 0 25px
    rgba(
      0,
      255,
      154,
      0.12
    ),

    inset
    0 0 20px
    rgba(
      0,
      255,
      154,
      0.04
    );
}

.dot {

  display:
    inline-block;

  width:
    9px;

  height:
    9px;

  margin-right:
    9px;

  border-radius:
    50%;

  background:
    #00ff9a;

  box-shadow:
    0 0 12px
    #00ff9a;
}

.tagline {

  color:
    #8da5a0;

  margin:
    10px 0 28px;

  font-size:
    14px;
}

.health {

  padding:
    22px 24px;

  border:
    1px solid
    rgba(
      0,
      255,
      154,
      0.30
    );

  border-radius:
    18px;

  background:
    rgba(
      6,
      17,
      20,
      0.76
    );

  box-shadow:

    0 0 30px
    rgba(
      0,
      255,
      154,
      0.07
    ),

    inset
    0 0 35px
    rgba(
      0,
      255,
      154,
      0.025
    );

  margin-bottom:
    20px;
}

.health-head {

  display:
    flex;

  justify-content:
    space-between;

  gap:
    20px;

  align-items:
    center;

  margin-bottom:
    12px;
}

.health-label {

  font-weight:
    800;

  color:
    #dffef2;
}

.health-value {

  color:
    #00ff9a;

  font-size:
    18px;

  font-weight:
    900;
}

.bar {

  height:
    13px;

  border-radius:
    999px;

  background:
    #111b20;

  overflow:
    hidden;

  border:
    1px solid
    rgba(
      255,
      255,
      255,
      0.07
    );
}

.bar > div {

  width:
    100%;

  height:
    100%;

  border-radius:
    inherit;

  background:
    linear-gradient(
      90deg,
      #00a96d,
      #00ff9a,
      #7dffd1
    );

  box-shadow:
    0 0 18px
    rgba(
      0,
      255,
      154,
      0.8
    );
}

.cards {

  display:
    grid;

  grid-template-columns:
    repeat(
      3,
      1fr
    );

  gap:
    14px;
}

.card {

  min-height:
    132px;

  padding:
    22px 16px;

  text-align:
    center;

  border:
    1px solid
    rgba(
      0,
      255,
      154,
      0.24
    );

  border-radius:
    18px;

  background:
    linear-gradient(
      145deg,
      rgba(
        10,
        28,
        30,
        0.86
      ),
      rgba(
        4,
        12,
        17,
        0.88
      )
    );

  box-shadow:

    inset
    0 0 25px
    rgba(
      0,
      255,
      154,
      0.025
    ),

    0 12px 35px
    rgba(
      0,
      0,
      0,
      0.22
    );

  transition:
    transform
    0.2s,
    border-color
    0.2s,
    box-shadow
    0.2s;
}

.card:hover {

  transform:
    translateY(-4px);

  border-color:
    rgba(
      0,
      255,
      154,
      0.62
    );

  box-shadow:
    0 0 28px
    rgba(
      0,
      255,
      154,
      0.10
    );
}

.icon {

  font-size:
    29px;

  margin-bottom:
    9px;
}

.label {

  color:
    #78908c;

  text-transform:
    uppercase;

  letter-spacing:
    0.16em;

  font-size:
    10px;

  font-weight:
    800;
}

.value {

  margin-top:
    9px;

  color:
    #ffffff;

  font-size:
    19px;

  font-weight:
    900;

  letter-spacing:
    0.06em;
}

.value.green {

  color:
    #00ff9a;

  text-shadow:
    0 0 12px
    rgba(
      0,
      255,
      154,
      0.4
    );
}

.links {

  display:
    grid;

  grid-template-columns:
    repeat(
      2,
      1fr
    );

  gap:
    14px;

  margin-top:
    20px;
}

.link {

  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  gap:
    15px;

  padding:
    18px 20px;

  color:
    #ffffff;

  text-decoration:
    none;

  border:
    1px solid
    rgba(
      0,
      255,
      154,
      0.22
    );

  border-radius:
    15px;

  background:
    rgba(
      5,
      15,
      20,
      0.72
    );

  transition:
    0.2s;
}

.link:hover {

  border-color:
    #00ff9a;

  box-shadow:
    0 0 24px
    rgba(
      0,
      255,
      154,
      0.1
    );

  transform:
    translateY(-2px);
}

.link strong {

  color:
    #dffff3;

  font-size:
    13px;
}

.link small {

  color:
    #00ff9a;

  font-weight:
    800;
}

.footer {

  text-align:
    center;

  margin-top:
    30px;

  color:
    #627772;

  font-size:
    12px;

  letter-spacing:
    0.08em;
}

@media (
  max-width: 800px
) {

  .weapons,
  .controller {

    opacity:
      0.25;
  }

  .cards {

    grid-template-columns:
      repeat(
        2,
        1fr
      );
  }
}

@media (
  max-width: 520px
) {

  .page {

    padding-top:
      30px;
  }

  .cards,
  .links {

    grid-template-columns:
      1fr;
  }

  .weapons,
  .controller {

    display:
      none;
  }

  .health-head {

    align-items:
      flex-start;
  }
}

</style>

</head>

<body>

<main class="page">

  <section class="hero">

    <div class="weapons">
      ⚔️
    </div>

    <div class="controller">
      🎮
    </div>

    <div class="crown">
      👑
    </div>

    <h1>
      TECH BATTLE
    </h1>

    <div class="title-line"></div>

    <div class="subtitle">
      ⚔️ REAL-TIME MULTIPLAYER TECHNOLOGY QUIZ 🎮
    </div>

    <div class="online">

      <span class="dot"></span>

      SERVER ONLINE

    </div>

    <p class="tagline">

      The Tech Battle server is running
      and ready for players.

    </p>

  </section>


  <section class="health">

    <div class="health-head">

      <div class="health-label">

        💚 Server Health

      </div>

      <div class="health-value">

        100%

      </div>

    </div>

    <div class="bar">

      <div></div>

    </div>

  </section>


  <section class="cards">

    <article class="card">

      <div class="icon">
        ⚡
      </div>

      <div class="label">
        Status
      </div>

      <div class="value green">
        ACTIVE
      </div>

    </article>


    <article class="card">

      <div class="icon">
        ⚔️
      </div>

      <div class="label">
        Multiplayer
      </div>

      <div class="value">
        ENABLED
      </div>

    </article>


    <article class="card">

      <div class="icon">
        🌐
      </div>

      <div class="label">
        Environment
      </div>

      <div class="value">
        PRODUCTION
      </div>

    </article>


    <article class="card">

      <div class="icon">
        🔌
      </div>

      <div class="label">
        Port
      </div>

      <div class="value">
        ${PORT}
      </div>

    </article>


    <article class="card">

      <div class="icon">
        ❤️
      </div>

      <div class="label">
        Health
      </div>

      <div class="value green">
        100%
      </div>

    </article>


    <article class="card">

      <div class="icon">
        🎮
      </div>

      <div class="label">
        Game Engine
      </div>

      <div class="value">
        READY
      </div>

    </article>

  </section>


  <section class="links">

    <a
      class="link"
      href="/health"
    >

      <strong>
        ❤️ HEALTH CHECK
      </strong>

      <small>
        /health
      </small>

    </a>


    <a
      class="link"
      href="/api"
    >

      <strong>
        ⚡ SERVER API
      </strong>

      <small>
        /api
      </small>

    </a>

  </section>


  <div class="footer">

    <b>
      TECH BATTLE
    </b>

    • Multiplayer Quiz Server
    • Socket.IO Online

  </div>

</main>

</body>

</html>

  `);

});

/* ============================================================
   API INFO
============================================================ */

app.get(
  "/api",
  (req, res) => {

    res.json({

      service:
        "Tech Battle Server",

      status:
        "online",

      multiplayer:
        true,

      socketIO:
        true,

      environment:
        process.env.NODE_ENV ||
        "production",

      endpoints: {

        health:
          "/health",

        socket:
          "Socket.IO"

      }

    });

  }
);

/* ============================================================
   HEALTH CHECK
============================================================ */

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok:
        true,

      service:
        "Tech Battle server",

      timestamp:
        Date.now()

    });

  }
);

/* ============================================================
   START SERVER
============================================================ */

httpServer.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "======================================"
    );

    console.log(
      "       TECH BATTLE SERVER"
    );

    console.log(
      "======================================"
    );

    console.log(
      `Server: http://localhost:${PORT}`
    );

    console.log(
      `Health: http://localhost:${PORT}/health`
    );

    console.log(
      "Socket.IO multiplayer: ENABLED"
    );

    console.log(
      "======================================"
    );

  }
);