import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

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
          room.hostPlayerId
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

    hostPlayerId:
      room.hostPlayerId,

    players,

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

function startCountdown(room) {
  clearRoomTimers(room);

  room.status =
    "countdown";

  room.currentQuestionIndex =
    -1;

  room.questions =
    createGameQuestions(room);

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
    getActivePlayers(room)
      .map((player) => ({
        id: player.id,

        name:
          player.name,

        points:
          player.lastPoints ||
          0,

        total:
          player.score,

        streak:
          player.streak
      }))
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

  const leaderboard =
    [...room.players.values()]
      .map((player) => ({
        id:
          player.id,

        name:
          player.name,

        total:
          player.score,

        left:
          !player.active
      }))
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

  const room = {
    code:
      roomCode,

    status:
      "waiting",

    quizType,

    hostPlayerId:
      player.id,

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
      ].label
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

    name
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

        if (
          getActivePlayers(
            room
          ).length <
          MIN_PLAYERS
        ) {
          return callback({
            error:
              "At least 2 players are required."
          });
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
   HTTP API
============================================================ */

app.get(
  "/",
  (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tech Battle Server</title>
<style>
*{
  box-sizing:border-box;
}
body{
  margin:0;
  min-height:100vh;
  background:
    radial-gradient(circle at top,#092c2b,#03060f 55%);
  color:#fff;
  font-family:Arial,sans-serif;
  display:flex;
  align-items:center;
  justify-content:center;
}
.container{
  width:min(900px,92%);
  padding:40px;
  border:1px solid #00ff9a55;
  border-radius:24px;
  background:#071016dd;
  box-shadow:0 0 50px #00ff9a18;
}
h1{
  margin:0 0 10px;
  color:#00ff9a;
}
p{
  color:#9eb5b1;
}
.grid{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:15px;
  margin-top:30px;
}
.card{
  padding:20px;
  border:1px solid #00ff9a35;
  border-radius:14px;
  background:#0b171c;
}
.label{
  font-size:12px;
  color:#829995;
  text-transform:uppercase;
}
.value{
  margin-top:8px;
  font-weight:bold;
}
.green{
  color:#00ff9a;
}
.links{
  display:flex;
  gap:12px;
  flex-wrap:wrap;
  margin-top:25px;
}
a{
  color:#00ff9a;
  text-decoration:none;
  border:1px solid #00ff9a44;
  padding:10px 16px;
  border-radius:10px;
}
a:hover{
  background:#00ff9a12;
}
@media(max-width:650px){
  .grid{
    grid-template-columns:1fr;
  }
}
</style>
</head>
<body>
<div class="container">
<h1>⚔️ TECH BATTLE</h1>
<p>The Tech Battle multiplayer server is online and ready.</p>

<div class="grid">

<div class="card">
<div class="label">Status</div>
<div class="value green">ONLINE</div>
</div>

<div class="card">
<div class="label">Multiplayer</div>
<div class="value">2–8 PLAYERS</div>
</div>

<div class="card">
<div class="label">Socket.IO</div>
<div class="value green">CONNECTED</div>
</div>

<div class="card">
<div class="label">Quiz Questions</div>
<div class="value">10</div>
</div>

<div class="card">
<div class="label">Question Timer</div>
<div class="value">20 SECONDS</div>
</div>

<div class="card">
<div class="label">Active Rooms</div>
<div class="value">${rooms.size}</div>
</div>

</div>

<div class="links">
<a href="/health">❤️ Health</a>
<a href="/api">⚡ API</a>
<a href="/docs">📖 Docs</a>
</div>

</div>
</body>
</html>
`);
  }
);

/* ============================================================
   HEALTH
============================================================ */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "Tech Battle Server",

      status:
        "online",

      timestamp:
        Date.now(),

      uptimeSeconds:
        Math.floor(
          process.uptime()
        ),

      activeRooms:
        rooms.size
    });
  }
);

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

      players: {
        minimum:
          MIN_PLAYERS,

        maximum:
          MAX_PLAYERS
      },

      questions:
        10,

      questionTime:
        QUESTION_TIME,

      quizTypes:
        Object.entries(
          QUIZ_TYPES
        ).map(
          ([id, config]) => ({
            id,

            label:
              config.label,

            categories:
              config.categories
          })
        )
    });
  }
);

/* ============================================================
   DOCUMENTATION
============================================================ */

app.get(
  "/docs",
  (req, res) => {
    res.json({
      service:
        "Tech Battle Server",

      transport:
        "Socket.IO",

      limits: {
        minPlayers:
          MIN_PLAYERS,

        maxPlayers:
          MAX_PLAYERS,

        questionTimeMs:
          QUESTION_TIME,

        questionsPerGame:
          10
      },

      quizTypes:
        Object.entries(
          QUIZ_TYPES
        ).map(
          ([id, config]) => ({
            id,

            label:
              config.label,

            categories:
              config.categories
          })
        ),

      clientEvents: [
        "time_sync",
        "create_room",
        "join_room",
        "reconnect_player",
        "start_game",
        "use_powerup",
        "submit_answer",
        "play_again",
        "leave_game"
      ],

      serverEvents: [
        "room_state",
        "countdown",
        "question",
        "answer_count",
        "question_results",
        "game_finished"
      ]
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
      "        TECH BATTLE SERVER"
    );

    console.log(
      "======================================"
    );

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `Health: http://localhost:${PORT}/health`
    );

    console.log(
      "Socket.IO multiplayer: ENABLED"
    );

    console.log(
      "Quiz types: ENABLED"
    );

    console.log(
      "======================================"
    );
  }
);