import React, {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { createRoot } from "react-dom/client";

import { io } from "socket.io-client";

import "./styles.css";


// --------------------------------------------------
// SERVER CONNECTION
// --------------------------------------------------

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL || "http://localhost:3000";

const BACKGROUND_IMAGE_URL =
  `${SERVER_URL}/assets/tech-battle-bg.jpg`;

const socket = io(SERVER_URL, {
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
});


// --------------------------------------------------
// CONSTANTS
// --------------------------------------------------

const SESSION_KEY = "techBattleSession";

const CATEGORY_LABELS = {
  programming: "Programming / Python",
  ai: "AI / Machine Learning",
  "computer-science": "Computer Science",
  databases: "Databases",
  "web-development": "Web Development",
  networking: "Networking",
  cloud: "Cloud Computing",
  cybersecurity: "Cybersecurity",
  aptitude: "Aptitude",
  reasoning: "Logical Reasoning",
  verbal: "Verbal Ability"
};

const QUIZ_TYPE_LABELS = {
  aptitude: "🧮 Aptitude",
  reasoning: "🧠 Logical Reasoning",
  verbal: "📖 Verbal Ability",
  technical: "💻 Technical",
  mixed: "🎯 Mixed Placement"
};

const DIFFICULTY_LABELS = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  mixed: "Mixed Difficulty"
};


const MATCH_SIZE_LABELS = {
  2: "⚔️ 2 Players",
  4: "⚔️ 4 Players",
  6: "⚔️ 6 Players",
  8: "⚔️ 8 Players"
};

const BATTLE_FORMATS = {
  2: {
    "1v1": "🥊 1v1"
  },
  4: {
    "2v2": "👥 2v2",
    "1v1v1v1": "⚔️ 1v1v1v1"
  },
  6: {
    "3v3": "👥 3v3",
    "2v2v2": "⚔️ 2v2v2",
    "1v1v1v1v1v1": "⚡ 1v1v1v1v1v1"
  },
  8: {
    "4v4": "👥 4v4",
    "2v2v2v2": "⚔️ 2v2v2v2",
    "1v1v1v1v1v1v1v1": "⚡ 1v1v1v1v1v1v1v1"
  }
};



const PROFILE_KEY = "techBattleProfile";

const PROFILE_CATEGORIES = [
  "aptitude",
  "reasoning",
  "verbal",
  "programming",
  "ai",
  "computer-science",
  "databases",
  "web-development",
  "networking",
  "cloud",
  "cybersecurity"
];

function createEmptyProfile() {
  return {
    version: 1,
    name: "",
    gamesPlayed: 0,
    dailyChallenges: 0,
    answered: 0,
    correct: 0,
    score: 0,
    highestScore: 0,
    responseTimeMs: 0,
    bestAverageResponseTime: 0,
    currentDailyStreak: 0,
    longestDailyStreak: 0,
    lastDailyDate: null,
    categories: {},
    difficulties: {},
    history: []
  };
}

function loadProfile() {
  try {
    const saved = localStorage.getItem(PROFILE_KEY);
    if (!saved) return createEmptyProfile();

    const parsed = JSON.parse(saved);
    return {
      ...createEmptyProfile(),
      ...parsed,
      categories: parsed.categories || {},
      difficulties: parsed.difficulties || {},
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch {
    return createEmptyProfile();
  }
}

function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function accuracyOf(bucket) {
  return bucket?.answered
    ? Math.round((bucket.correct / bucket.answered) * 100)
    : 0;
}

function profileSummary(profile) {
  const accuracy = profile.answered
    ? Math.round((profile.correct / profile.answered) * 100)
    : 0;

  const averageResponseTime = profile.answered
    ? Number((profile.responseTimeMs / profile.answered / 1000).toFixed(1))
    : 0;

  return {
    ...profile,
    accuracy,
    averageResponseTime
  };
}

function mergePerformance(profile, performance, metadata = {}) {
  const next = {
    ...profile,
    categories: { ...(profile.categories || {}) },
    difficulties: { ...(profile.difficulties || {}) },
    history: [...(profile.history || [])]
  };

  const answered = Number(performance?.answered || 0);
  const correct = Number(performance?.correct || 0);
  const avgTimeMs = Number(performance?.averageResponseTime || 0) * 1000;

  next.answered += answered;
  next.correct += correct;
  next.responseTimeMs += avgTimeMs * answered;
  next.score += Number(metadata.score || 0);
  next.highestScore = Math.max(next.highestScore || 0, Number(metadata.score || 0));
  next.gamesPlayed += metadata.daily ? 0 : 1;
  next.dailyChallenges += metadata.daily ? 1 : 0;

  if (answered > 0) {
    const avg = next.responseTimeMs / next.answered / 1000;
    next.bestAverageResponseTime = next.bestAverageResponseTime
      ? Math.min(next.bestAverageResponseTime, avg)
      : avg;
  }

  for (const item of performance?.byCategory || []) {
    const bucket = next.categories[item.key] || {
      answered: 0,
      correct: 0,
      responseTimeMs: 0
    };

    bucket.answered += Number(item.answered || 0);
    bucket.correct += Number(item.correct || 0);
    bucket.responseTimeMs += Number(item.averageResponseTime || 0) * 1000 * Number(item.answered || 0);
    next.categories[item.key] = bucket;
  }

  for (const item of performance?.byDifficulty || []) {
    const bucket = next.difficulties[item.key] || {
      answered: 0,
      correct: 0,
      responseTimeMs: 0
    };

    bucket.answered += Number(item.answered || 0);
    bucket.correct += Number(item.correct || 0);
    bucket.responseTimeMs += Number(item.averageResponseTime || 0) * 1000 * Number(item.answered || 0);
    next.difficulties[item.key] = bucket;
  }

  const historyItem = {
    id: metadata.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    date: new Date().toISOString(),
    type: metadata.daily ? "Daily Challenge" : "Battle",
    score: Number(metadata.score || 0),
    correct,
    answered,
    accuracy: answered ? Math.round((correct / answered) * 100) : 0,
    quizType: metadata.quizType || "",
    difficulty: metadata.difficulty || ""
  };

  if (!next.history.some((item) => item.id === historyItem.id)) {
    next.history.unshift(historyItem);
  }

  next.history = next.history.slice(0, 30);

  return next;
}

function applyDailyStreak(profile) {
  const next = { ...profile };
  const today = new Date().toISOString().slice(0, 10);

  if (next.lastDailyDate === today) {
    return next;
  }

  if (next.lastDailyDate) {
    const previous = new Date(`${next.lastDailyDate}T00:00:00Z`);
    const current = new Date(`${today}T00:00:00Z`);
    const days = Math.round((current - previous) / 86400000);
    next.currentDailyStreak = days === 1
      ? (next.currentDailyStreak || 0) + 1
      : 1;
  } else {
    next.currentDailyStreak = 1;
  }

  next.longestDailyStreak = Math.max(
    next.longestDailyStreak || 0,
    next.currentDailyStreak
  );

  next.lastDailyDate = today;
  return next;
}

// --------------------------------------------------
// APP
// --------------------------------------------------

function App() {
  const [screen, setScreen] = useState("home");

  const [mode, setMode] = useState(null);

  const [quizType, setQuizType] = useState("mixed");

  const [difficulty, setDifficulty] = useState("mixed");

  const [quizTypeOpen, setQuizTypeOpen] = useState(false);
  const [difficultyOpen, setDifficultyOpen] = useState(false);

  const [matchSize, setMatchSize] = useState(2);

  const [matchSizeOpen, setMatchSizeOpen] = useState(false);

  const [battleFormat, setBattleFormat] = useState("1v1");

  const [battleFormatOpen, setBattleFormatOpen] = useState(false);

  const [name, setName] = useState("");

  const [roomCode, setRoomCode] = useState("");

  const [room, setRoom] = useState(null);

  const [me, setMe] = useState(null);

  const [question, setQuestion] = useState(null);

  const [questionResults, setQuestionResults] = useState(null);

  const [finalResults, setFinalResults] = useState(null);

  const [battleIntro, setBattleIntro] = useState(null);

  const [leaderboard, setLeaderboard] = useState([]);

  const [teamLeaderboard, setTeamLeaderboard] = useState([]);

  const [rankChanges, setRankChanges] = useState({});

  const leaderboardRef = useRef([]);

  const battleIntroTimerRef = useRef(null);

  const [countdown, setCountdown] = useState(null);

  const [timeRemaining, setTimeRemaining] = useState(20);

  const [answeredCount, setAnsweredCount] = useState(0);

  const [selectedAnswer, setSelectedAnswer] = useState(null);

  const [eliminatedOptions, setEliminatedOptions] = useState([]);

  const [powerups, setPowerups] = useState({
    fiftyFiftyAvailable: true,
    doublePointsAvailable: true,
    doublePointsActive: false
  });

  const [error, setError] = useState("");

  const [busy, setBusy] = useState(false);

  const [serverOffset, setServerOffset] = useState(0);

  const [restoringSession, setRestoringSession] = useState(false);

  const meRef = useRef(null);
  const roomRef = useRef(null);
  const nameRef = useRef("");

  const [profile, setProfile] = useState(() => loadProfile());

  const [dailyQuestion, setDailyQuestion] = useState(null);
  const [dailyQuestionResult, setDailyQuestionResult] = useState(null);
  const [dailyFinal, setDailyFinal] = useState(null);
  const [dailySelectedAnswer, setDailySelectedAnswer] = useState(null);
  const [dailyTimeRemaining, setDailyTimeRemaining] = useState(20);
  const [dailyBusy, setDailyBusy] = useState(false);

  useEffect(() => { meRef.current = me; }, [me]);
  useEffect(() => { roomRef.current = room; }, [room]);
  useEffect(() => { nameRef.current = name; }, [name]);


  // --------------------------------------------------
  // SERVER TIME SYNCHRONIZATION
  // --------------------------------------------------

  const syncServerTime = () => {
    if (!socket.connected) {
      return;
    }

    const sentAt = Date.now();

    socket.emit("time_sync", (serverNow) => {
      const receivedAt = Date.now();

      const roundTrip = receivedAt - sentAt;

      const estimatedNow = receivedAt - roundTrip / 2;

      setServerOffset(serverNow - estimatedNow);
    });
  };


  // --------------------------------------------------
  // SOCKET EVENTS
  // --------------------------------------------------

  useEffect(() => {
    const handleConnect = () => {
      syncServerTime();
    };


    const handleRoomState = (state) => {
      setRoom(state);

      // A room_state event only ever arrives for a room we're
      // actually in, so it's always safe to reflect "waiting"
      // here -- this is what fixes the "stuck on home screen
      // after refresh" bug.
      if (state.status === "waiting") {
        setScreen("waiting");
      }
    };


    const handleBattleIntro = (data) => {
      setBattleIntro(data);
      setLeaderboard(data.players || []);
      setTeamLeaderboard(data.teams || []);
      leaderboardRef.current = data.players || [];
      setScreen("battle-intro");

      if (battleIntroTimerRef.current) {
        clearTimeout(battleIntroTimerRef.current);
      }

      battleIntroTimerRef.current = setTimeout(() => {
        battleIntroTimerRef.current = null;
        setScreen("countdown");
      }, 1700);
    };


    const handleLeaderboardUpdate = (data) => {
      const nextPlayers = data?.players || [];
      const previous = leaderboardRef.current || [];
      const previousRanks = new Map(
        previous.map((player) => [player.id, player.rank])
      );
      const changes = {};

      nextPlayers.forEach((player) => {
        const oldRank = previousRanks.get(player.id);
        if (oldRank && oldRank !== player.rank) {
          changes[player.id] = player.rank < oldRank ? "up" : "down";
        }
      });

      leaderboardRef.current = nextPlayers;
      setLeaderboard(nextPlayers);
      setTeamLeaderboard(data?.teams || []);
      setRankChanges(changes);

      window.setTimeout(() => setRankChanges({}), 850);
    };


    const handleCountdown = (data) => {
      setCountdown(data);

      setQuestion(null);
      setQuestionResults(null);

      if (!battleIntroTimerRef.current) {
        setScreen("countdown");
      }
    };


    const handleQuestion = (data) => {
      setQuestion(data);

      setQuestionResults(null);

      setCountdown(null);

      setAnsweredCount(data.answeredCount || 0);

      setSelectedAnswer(
        data.alreadyAnswered ? data.selectedIndex ?? null : null
      );

      setEliminatedOptions(data.eliminatedOptions || []);

      if (data.powerups) {
        setPowerups(data.powerups);
      }

      setScreen("game");
    };


    const handleAnswerCount = (data) => {
      setAnsweredCount(data.count);
    };


    const handleQuestionResults = (data) => {
      setQuestionResults(data);

      setSelectedAnswer(null);

      setEliminatedOptions([]);

      setScreen("results");
    };


    const handleGameFinished = (data) => {
      setFinalResults(data);

      const currentMe = meRef.current;
      const currentRoom = roomRef.current;
      const myPlayer = (data?.leaderboard || []).find(
        (player) => player.id === currentMe?.id
      );
      const myPerformance = data?.performanceByPlayer?.[currentMe?.id];

      if (myPerformance && data?.matchId) {
        setProfile((current) => {
          if ((current.history || []).some((item) => item.id === data.matchId)) {
            return current;
          }

          const next = mergePerformance(
            current,
            myPerformance,
            {
              id: data.matchId,
              score: myPlayer?.total || 0,
              quizType: currentRoom?.quizType || "",
              difficulty: currentRoom?.difficulty || ""
            }
          );
          next.name = currentMe?.name || current.name;
          saveProfile(next);
          return next;
        });
      }

      setQuestion(null);
      setQuestionResults(null);
      setCountdown(null);
      setScreen("final");
    };

    const handleDailyQuestion = (data) => {
      setDailyQuestion(data);
      setDailyQuestionResult(null);
      setDailySelectedAnswer(null);
      setScreen("daily");
    };

    const handleDailyQuestionResult = (data) => {
      setDailyQuestionResult(data);
      setDailySelectedAnswer(null);
      setScreen("daily-results");
    };

    const handleDailyFinished = (data) => {
      setDailyFinal(data);

      setProfile((current) => {
        if ((current.history || []).some((item) => item.id === data.attemptId)) {
          return current;
        }

        let next = mergePerformance(
          current,
          data.performance,
          {
            id: data.attemptId,
            score: data.score,
            daily: true
          }
        );
        next = applyDailyStreak(next);
        next.name = nameRef.current || current.name;
        saveProfile(next);
        return next;
      });

      setDailyQuestion(null);
      setDailyQuestionResult(null);
      setScreen("daily-final");
    };


    const handleError = (data) => {
      const message =
        typeof data === "string"
          ? data
          : data?.message || data?.error || "Something went wrong.";

      setError(message);
    };


    socket.on("connect", handleConnect);

    socket.on("room_state", handleRoomState);

    socket.on("battle_intro", handleBattleIntro);

    socket.on("leaderboard_update", handleLeaderboardUpdate);

    socket.on("countdown", handleCountdown);

    socket.on("question", handleQuestion);

    socket.on("answer_count", handleAnswerCount);

    socket.on("question_results", handleQuestionResults);

    socket.on("game_finished", handleGameFinished);

    socket.on("daily_question", handleDailyQuestion);
    socket.on("daily_question_result", handleDailyQuestionResult);
    socket.on("daily_finished", handleDailyFinished);

    socket.on("server_error", handleError);


    return () => {
      socket.off("connect", handleConnect);

      socket.off("room_state", handleRoomState);

      socket.off("battle_intro", handleBattleIntro);

      socket.off("leaderboard_update", handleLeaderboardUpdate);

      socket.off("countdown", handleCountdown);

      if (battleIntroTimerRef.current) {
        clearTimeout(battleIntroTimerRef.current);
      }

      socket.off("question", handleQuestion);

      socket.off("answer_count", handleAnswerCount);

      socket.off("question_results", handleQuestionResults);

      socket.off("game_finished", handleGameFinished);

      socket.off("daily_question", handleDailyQuestion);
      socket.off("daily_question_result", handleDailyQuestionResult);
      socket.off("daily_finished", handleDailyFinished);

      socket.off("server_error", handleError);
    };
  }, []);


  // --------------------------------------------------
  // RESTORE SAVED SESSION / READ ?room= FROM URL
  // --------------------------------------------------

  useEffect(() => {
    const saved = localStorage.getItem(SESSION_KEY);

    if (saved) {
      try {
        const session = JSON.parse(saved);

        if (!session.roomCode || !session.token) {
          localStorage.removeItem(SESSION_KEY);
        } else {
          setRestoringSession(true);

          setRoomCode(session.roomCode);

          setName(session.name || "");

          const reconnect = () => {
            socket.emit(
              "reconnect_player",
              {
                roomCode: session.roomCode,
                token: session.token
              },
              (response) => {
                setRestoringSession(false);

                if (!response?.ok) {
                  localStorage.removeItem(SESSION_KEY);
                  return;
                }

                setMe({
                  id: response.playerId,
                  name: response.name,
                  token: session.token
                });

                setRoomCode(response.roomCode);
              }
            );
          };

          if (!socket.connected) {
            socket.connect();
          }

          if (socket.connected) {
            reconnect();
          } else {
            socket.once("connect", reconnect);
          }

          return;
        }
      } catch {
        localStorage.removeItem(SESSION_KEY);
      }
    }

    // No saved session -- check for a shared "?room=CODE" link.
    const params = new URLSearchParams(window.location.search);

    const sharedRoom = params.get("room");

    if (sharedRoom) {
      setMode("join");

      setRoomCode(sharedRoom.toUpperCase().slice(0, 6));

      setScreen("join");
    }
  }, []);


  // --------------------------------------------------
  // QUIZ TYPE DROPDOWN
  // --------------------------------------------------

  useEffect(() => {
    if (!quizTypeOpen) {
      return;
    }

    const handlePointerDown = (event) => {
      if (!event.target.closest(".quiz-type-select")) {
        setQuizTypeOpen(false);
      }
      if (!event.target.closest(".difficulty-select")) {
        setDifficultyOpen(false);
      }
      if (!event.target.closest(".battle-select")) {
        setMatchSizeOpen(false);
        setBattleFormatOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setQuizTypeOpen(false);
        setDifficultyOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [quizTypeOpen]);


  // --------------------------------------------------
  // TIMER
  // --------------------------------------------------

  useEffect(() => {
    if (!question?.endsAt) {
      return;
    }

    const updateTimer = () => {
      const now = Date.now() + serverOffset;

      const remaining = Math.max(0, question.endsAt - now) / 1000;

      setTimeRemaining(remaining);
    };

    updateTimer();

    const interval = setInterval(updateTimer, 50);

    return () => {
      clearInterval(interval);
    };
  }, [question, serverOffset]);


  // --------------------------------------------------
  // DAILY CHALLENGE TIMER
  // --------------------------------------------------

  useEffect(() => {
    if (!dailyQuestion?.endsAt) {
      return;
    }

    const updateDailyTimer = () => {
      const now = Date.now() + serverOffset;
      const remaining = Math.max(0, dailyQuestion.endsAt - now) / 1000;
      setDailyTimeRemaining(remaining);
    };

    updateDailyTimer();
    const interval = setInterval(updateDailyTimer, 50);

    return () => clearInterval(interval);
  }, [dailyQuestion, serverOffset]);


  // --------------------------------------------------
  // COUNTDOWN TIMER
  // --------------------------------------------------

  const [countdownTick, setCountdownTick] = useState(0);

  const countdownValue = useMemo(() => {
    if (!countdown?.endsAt) {
      return null;
    }

    const now = Date.now() + serverOffset;

    const remaining = Math.max(0, countdown.endsAt - now);

    if (remaining <= 0) {
      return "GO!";
    }

    return Math.ceil(remaining / 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, serverOffset, countdownTick]);


  useEffect(() => {
    if (!countdown?.endsAt) {
      return;
    }

    const interval = setInterval(() => {
      setCountdownTick((tick) => tick + 1);
    }, 50);

    return () => {
      clearInterval(interval);
    };
  }, [countdown]);


  // --------------------------------------------------
  // CREATE / JOIN
  // --------------------------------------------------

  const connectToRoom = () => {
    setError("");

    const cleanedName = name.trim().replace(/\s+/g, " ");

    if (cleanedName.length < 2 || cleanedName.length > 16) {
      setError("Name must contain 2–16 characters.");
      return;
    }

    if (!/^[A-Za-z0-9 _-]+$/.test(cleanedName)) {
      setError("Name may contain letters, numbers, spaces, _ and - only.");
      return;
    }

    if (mode === "join" && !/^[A-Z0-9]{6}$/.test(roomCode)) {
      setError("Enter a valid 6-character room code.");
      return;
    }

    setBusy(true);

    const sendRequest = () => {
      const event = mode === "create" ? "create_room" : "join_room";

      socket.emit(
        event,
        {
          name: cleanedName,
          roomCode: mode === "join" ? roomCode.toUpperCase() : undefined,
          quizType: mode === "create" ? quizType : undefined,
          difficulty: mode === "create" ? difficulty : undefined,
          matchSize: mode === "create" ? matchSize : undefined,
          battleFormat: mode === "create" ? battleFormat : undefined
        },
        (response) => {
          setBusy(false);

          if (!response?.ok) {
            setError(response?.error || "Unable to join room.");
            return;
          }

          const session = {
            roomCode: response.roomCode,
            token: response.token,
            name: response.name || cleanedName
          };

          localStorage.setItem(SESSION_KEY, JSON.stringify(session));

          setRoomCode(response.roomCode);

          setMe({
            id: response.playerId,
            name: response.name || cleanedName,
            token: response.token
          });

          setScreen("waiting");
        }
      );
    };

    if (!socket.connected) {
      socket.connect();

      socket.once("connect", sendRequest);
    } else {
      sendRequest();
    }
  };


  // --------------------------------------------------
  // START GAME
  // --------------------------------------------------

  const startGame = () => {
    setError("");

    socket.emit("start_game", {}, (response) => {
      if (!response?.ok) {
        setError(response?.error || "Unable to start game.");
      }
    });
  };


  // --------------------------------------------------
  // PLAY AGAIN
  // --------------------------------------------------

  const playAgain = () => {
    setError("");

    socket.emit("play_again", {}, (response) => {
      if (!response?.ok) {
        setError(response?.error || "Unable to restart the game.");
      }
    });
  };


  // --------------------------------------------------
  // POWER-UPS
  // --------------------------------------------------

  const useFiftyFifty = () => {
    socket.emit("use_powerup", { type: "fiftyFifty" }, (response) => {
      if (!response?.ok) {
        setError(response?.error || "Unable to use 50/50.");
        return;
      }

      setEliminatedOptions(response.eliminatedOptions || []);

      setPowerups((prev) => ({ ...prev, fiftyFiftyAvailable: false }));
    });
  };


  const useDoublePoints = () => {
    socket.emit("use_powerup", { type: "doublePoints" }, (response) => {
      if (!response?.ok) {
        setError(response?.error || "Unable to use Double Points.");
        return;
      }

      setPowerups((prev) => ({
        ...prev,
        doublePointsAvailable: false,
        doublePointsActive: true
      }));
    });
  };


  // --------------------------------------------------
  // ANSWER QUESTION
  // --------------------------------------------------

  const submitAnswer = (index) => {
    if (selectedAnswer !== null || timeRemaining <= 0 || !question) {
      return;
    }

    if (eliminatedOptions.includes(index)) {
      return;
    }

    setSelectedAnswer(index);

    socket.emit(
      "submit_answer",
      {
        questionId: question.id,
        index
      },
      (response) => {
        if (!response?.ok) {
          setSelectedAnswer(null);

          setError(response?.error || "Unable to submit answer.");
        }
      }
    );
  };


  // --------------------------------------------------
  // PROFILE / DAILY CHALLENGE
  // --------------------------------------------------

  const openProfile = () => {
    setError("");
    setProfile(loadProfile());
    setScreen("profile");
  };

  const startDailyChallenge = () => {
    setError("");
    setDailyBusy(true);

    const playerName = (name.trim() || profile.name || "Player")
      .replace(/\s+/g, " ")
      .slice(0, 16);

    if (playerName.length < 2) {
      setDailyBusy(false);
      setError("Enter your name first.");
      setScreen("profile");
      return;
    }

    const send = () => {
      socket.emit("daily_start", { name: playerName }, (response) => {
        setDailyBusy(false);

        if (!response?.ok) {
          setError(response?.error || "Unable to start the daily challenge.");
          return;
        }

        const nextProfile = { ...profile, name: playerName };
        setProfile(nextProfile);
        saveProfile(nextProfile);
      });
    };

    if (!socket.connected) {
      socket.connect();
      socket.once("connect", send);
    } else {
      send();
    }
  };

  const submitDailyAnswer = (index) => {
    if (!dailyQuestion || dailySelectedAnswer !== null || dailyTimeRemaining <= 0) {
      return;
    }

    setDailySelectedAnswer(index);

    socket.emit(
      "daily_answer",
      {
        questionId: dailyQuestion.id,
        index
      },
      (response) => {
        if (!response?.ok) {
          setDailySelectedAnswer(null);
          setError(response?.error || "Unable to submit answer.");
        }
      }
    );
  };

  const leaveDailyChallenge = () => {
    socket.emit("daily_leave", {}, () => {});
    setDailyQuestion(null);
    setDailyQuestionResult(null);
    setDailyFinal(null);
    setDailySelectedAnswer(null);
    setScreen("home");
  };

  // --------------------------------------------------
  // LEAVE
  // --------------------------------------------------

  const leaveGame = () => {
    socket.emit("leave_game", {}, () => {});

    localStorage.removeItem(SESSION_KEY);

    setRoom(null);
    setMe(null);
    setQuestion(null);
    setQuestionResults(null);
    setFinalResults(null);
    setDailyQuestion(null);
    setDailyQuestionResult(null);
    setDailyFinal(null);
    setDailySelectedAnswer(null);
    setCountdown(null);
    setEliminatedOptions([]);

    setPowerups({
      fiftyFiftyAvailable: true,
      doublePointsAvailable: true,
      doublePointsActive: false
    });

    setRoomCode("");
    setName("");
    setBattleIntro(null);
    setLeaderboard([]);
    setTeamLeaderboard([]);
    leaderboardRef.current = [];

    // Clear a shared-link room param so leaving doesn't re-trigger it.
    if (window.location.search) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    setScreen("home");
  };


  // --------------------------------------------------
  // RESTORING SESSION
  // --------------------------------------------------

  if (restoringSession) {
    return (
      <Shell>
        <div className="hero">
          <div className="logo">⚡</div>

          <h1>Tech Battle</h1>

          <p>Reconnecting you to your game...</p>
        </div>
      </Shell>
    );
  }


  // --------------------------------------------------
  // HOME
  // --------------------------------------------------

  if (screen === "home") {
    return (
      <Shell hideFooter>
        <div
          className="hero tech-battle-home"
          style={{
            backgroundImage: `url("${BACKGROUND_IMAGE_URL}")`
          }}
        >
          <div className="home-content">
            <div className="home-subtitle">
              REAL-TIME MULTIPLAYER TECHNOLOGY QUIZ
            </div>

            <div className="button-stack">
              <button
                onClick={() => {
                  setMode("create");
                  setError("");
                  setScreen("join");
                }}
              >
                CREATE ROOM
              </button>

              <button
                className="secondary"
                onClick={() => {
                  setMode("join");
                  setError("");
                  setScreen("join");
                }}
              >
                JOIN ROOM
              </button>

              <button
                className="profile-home-button"
                onClick={openProfile}
              >
                👤 PROFILE & STATS
              </button>

              <button
                className="daily-home-button"
                onClick={() => setScreen("daily-start")}
              >
                🔥 DAILY CHALLENGE
              </button>

              <button className="ghost" onClick={() => setScreen("how")}>
                HOW TO PLAY
              </button>
            </div>
          </div>
        </div>
      </Shell>
    );
  }


  // --------------------------------------------------
  // PROFILE
  // --------------------------------------------------

  if (screen === "profile") {
    const stats = profileSummary(profile);
    const overall = stats.accuracy;

    return (
      <Shell>
        <Card className="profile-card">
          <div className="profile-header">
            <div>
              <span className="eyebrow">PLAYER PROFILE</span>
              <h1>{profile.name || "Your Profile"}</h1>
              <p>Your Tech Battle performance</p>
            </div>
            <div className="profile-avatar-large">
              {(profile.name || "P").charAt(0).toUpperCase()}
            </div>
          </div>

          <div className="profile-overall">
            <div
              className="accuracy-ring"
              style={{ "--progress": `${overall}%` }}
            >
              <div className="accuracy-ring-inner">
                <strong>{overall}%</strong>
                <span>ACCURACY</span>
              </div>
            </div>
            <div className="profile-overall-copy">
              <span className="eyebrow">OVERALL PERFORMANCE</span>
              <h2>{overall === 0 ? "Start at 0%" : `${overall}% overall accuracy`}</h2>
              <p>
                {stats.answered === 0
                  ? "Play your first challenge to start building your statistics."
                  : `${stats.correct} correct out of ${stats.answered} answered.`}
              </p>
            </div>
          </div>

          <div className="profile-stat-grid">
            <div className="profile-stat-card"><span>GAMES</span><strong>{stats.gamesPlayed}</strong></div>
            <div className="profile-stat-card"><span>DAILY CHALLENGES</span><strong>{stats.dailyChallenges}</strong></div>
            <div className="profile-stat-card"><span>BEST SCORE</span><strong>{stats.highestScore}</strong></div>
            <div className="profile-stat-card"><span>AVG. RESPONSE</span><strong>{stats.averageResponseTime}s</strong></div>
            <div className="profile-stat-card"><span>DAILY STREAK</span><strong>🔥 {stats.currentDailyStreak}</strong></div>
            <div className="profile-stat-card"><span>LONGEST STREAK</span><strong>{stats.longestDailyStreak}</strong></div>
          </div>

          <div className="profile-section-title">CATEGORY ACCURACY</div>
          <div className="category-stat-list">
            {PROFILE_CATEGORIES.map((key) => {
              const bucket = profile.categories?.[key] || { answered: 0, correct: 0 };
              const value = accuracyOf(bucket);
              return (
                <div className="category-stat-row" key={key}>
                  <div className="category-stat-label">
                    <span>{CATEGORY_LABELS[key] || key}</span>
                    <strong>{value}%</strong>
                  </div>
                  <div className="category-stat-track">
                    <div style={{ width: `${value}%` }} />
                  </div>
                  <small>{bucket.correct || 0}/{bucket.answered || 0} correct</small>
                </div>
              );
            })}
          </div>

          <div className="profile-section-title">DIFFICULTY ACCURACY</div>
          <div className="difficulty-stat-grid">
            {[["easy", "🟢 Easy"], ["medium", "🟡 Medium"], ["hard", "🔴 Hard"]].map(([key, label]) => {
              const bucket = profile.difficulties?.[key] || { answered: 0, correct: 0 };
              return (
                <div className="difficulty-stat-card" key={key}>
                  <span>{label}</span>
                  <strong>{accuracyOf(bucket)}%</strong>
                  <small>{bucket.correct || 0}/{bucket.answered || 0}</small>
                </div>
              );
            })}
          </div>

          <div className="profile-section-title">RECENT HISTORY</div>
          <div className="profile-history">
            {profile.history?.length ? profile.history.slice(0, 10).map((item) => (
              <div className="history-row" key={item.id}>
                <div>
                  <strong>{item.type}</strong>
                  <small>{new Date(item.date).toLocaleDateString()} • {item.accuracy}% accuracy</small>
                </div>
                <strong>{item.score} pts</strong>
              </div>
            )) : (
              <div className="empty-profile">No matches yet. Your first result will appear here.</div>
            )}
          </div>

          <div className="profile-actions">
            <button onClick={() => setScreen("daily-start")}>🔥 Daily Challenge</button>
            <button className="ghost" onClick={() => setScreen("home")}>← Back Home</button>
          </div>
        </Card>
      </Shell>
    );
  }


  // --------------------------------------------------
  // DAILY START
  // --------------------------------------------------

  if (screen === "daily-start") {
    const today = new Date().toLocaleDateString();
    return (
      <Shell>
        <Card className="daily-card">
          <div className="daily-hero">
            <div className="daily-icon">🔥</div>
            <span className="eyebrow">DAILY CHALLENGE</span>
            <h1>Today's 10 Questions</h1>
            <p>{today} • 4 Easy • 4 Medium • 2 Hard</p>
          </div>

          <div className="daily-feature-grid">
            <div><strong>20s</strong><span>per question</span></div>
            <div><strong>100+</strong><span>base points</span></div>
            <div><strong>🔥</strong><span>streak bonus</span></div>
          </div>

          <label>
            Player Name
            <input
              value={name || profile.name || ""}
              maxLength={16}
              placeholder="Enter your name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <button disabled={dailyBusy} onClick={startDailyChallenge}>
            {dailyBusy ? "Starting..." : "Start Today's Challenge →"}
          </button>

          <button className="ghost" onClick={() => setScreen("profile")}>View Profile</button>
          <button className="ghost" onClick={() => setScreen("home")}>← Back Home</button>
        </Card>
      </Shell>
    );
  }


  // --------------------------------------------------
  // DAILY QUESTION
  // --------------------------------------------------

  if (screen === "daily" && dailyQuestion) {
    const progress = Math.max(0, Math.min(100, (dailyTimeRemaining / 20) * 100));

    return (
      <Shell>
        <Card className="game-card daily-game-card">
          <div className="game-top">
            <div>
              <span className="eyebrow">DAILY CHALLENGE • QUESTION {dailyQuestion.number} / {dailyQuestion.total}</span>
              <div className="question-meta">
                <span className="category-tag">{CATEGORY_LABELS[dailyQuestion.category] || dailyQuestion.category}</span>
                <span className={`difficulty ${dailyQuestion.difficulty}`}>{DIFFICULTY_LABELS[dailyQuestion.difficulty]}</span>
              </div>
            </div>
            <div className={`timer ${dailyTimeRemaining <= 5 ? "danger" : ""}`}>
              {Math.ceil(dailyTimeRemaining)}<small>s</small>
            </div>
          </div>

          <div className="timer-bar"><div style={{ width: `${progress}%` }} /></div>

          <div className="question-area">
            <h2>{dailyQuestion.text}</h2>
            <div className="answers-grid">
              {dailyQuestion.options.map((option, index) => (
                <button
                  key={index}
                  disabled={dailySelectedAnswer !== null || dailyTimeRemaining <= 0}
                  className={dailySelectedAnswer === index ? "answer selected" : "answer"}
                  onClick={() => submitDailyAnswer(index)}
                >
                  <span className="option-letter">{String.fromCharCode(65 + index)}</span>
                  <span>{option}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="daily-question-footer">
            <span>🔥 Daily streak: {profile.currentDailyStreak}</span>
            <span>Answer before time runs out</span>
          </div>
        </Card>
      </Shell>
    );
  }


  // --------------------------------------------------
  // DAILY QUESTION RESULTS
  // --------------------------------------------------

  if (screen === "daily-results" && dailyQuestionResult) {
    return (
      <Shell>
        <Card className="daily-card">
          <div className={`daily-result-icon ${dailyQuestionResult.correct ? "correct" : "wrong"}`}>
            {dailyQuestionResult.correct ? "✓" : "×"}
          </div>
          <span className="eyebrow">DAILY CHALLENGE</span>
          <h1>{dailyQuestionResult.correct ? "Correct!" : "Not this time"}</h1>
          <div className="correct-answer">{dailyQuestionResult.correctAnswer}</div>

          <div className="daily-result-stats">
            <div><span>POINTS</span><strong>+{dailyQuestionResult.points}</strong></div>
            <div><span>SCORE</span><strong>{dailyQuestionResult.score}</strong></div>
            <div><span>STREAK</span><strong>🔥 {dailyQuestionResult.streak}</strong></div>
          </div>

          <div className="next-question">Next daily question in 3 seconds...</div>
        </Card>
      </Shell>
    );
  }


  // --------------------------------------------------
  // DAILY FINAL
  // --------------------------------------------------

  if (screen === "daily-final" && dailyFinal) {
    return (
      <Shell>
        <Card className="daily-card">
          <div className="daily-final-trophy">🏆</div>
          <span className="eyebrow">DAILY CHALLENGE COMPLETE</span>
          <h1>{dailyFinal.score} POINTS</h1>
          <p>{dailyFinal.correct}/{dailyFinal.answered} correct • {dailyFinal.performance?.accuracy || 0}% accuracy</p>

          <div className="daily-streak-banner">
            🔥 Daily streak: {profile.currentDailyStreak}
          </div>

          <div className="performance-overview">
            <div className="performance-stat"><span>ACCURACY</span><strong>{dailyFinal.performance?.accuracy || 0}%</strong></div>
            <div className="performance-stat"><span>CORRECT</span><strong>{dailyFinal.correct}/{dailyFinal.answered}</strong></div>
            <div className="performance-stat"><span>AVG. TIME</span><strong>{dailyFinal.performance?.averageResponseTime || 0}s</strong></div>
          </div>

          <div className="profile-actions">
            <button onClick={() => setScreen("profile")}>View My Stats</button>
            <button className="ghost" onClick={() => setScreen("home")}>Return Home</button>
          </div>
        </Card>
      </Shell>
    );
  }

  // --------------------------------------------------
  // HOW TO PLAY
  // --------------------------------------------------

  if (screen === "how") {
    return (
      <Shell>
        <Card className="form-card">
          <div className="section-title">
            <span>📖</span>
            <h2>How to Play</h2>
          </div>

          <div className="rules">
            <div className="rule">
              <strong>1.</strong>
              <span>Create a room or join using a 6-character room code.</span>
            </div>

            <div className="rule">
              <strong>2.</strong>
              <span>Enter a unique player name between 2 and 16 characters.</span>
            </div>

            <div className="rule">
              <strong>3.</strong>
              <span>The host can start when at least 2 players have joined.</span>
            </div>

            <div className="rule">
              <strong>4.</strong>
              <span>Play 10 questions: 4 Easy, 4 Medium and 2 Hard.</span>
            </div>

            <div className="rule">
              <strong>5.</strong>
              <span>
                All 8 Tech Battle categories are covered. Two randomly selected
                categories appear twice.
              </span>
            </div>

            <div className="rule">
              <strong>6.</strong>
              <span>Every question has exactly 4 answer options, shuffled each game.</span>
            </div>

            <div className="rule">
              <strong>7.</strong>
              <span>Each question has 20 seconds.</span>
            </div>

            <div className="rule">
              <strong>8.</strong>
              <span>Correct answer = 100 points, plus up to 50 for speed.</span>
            </div>

            <div className="rule">
              <strong>9.</strong>
              <span>
                Answer streaks add a bonus: +10 points per consecutive correct
                answer, up to +50.
              </span>
            </div>

            <div className="rule">
              <strong>10.</strong>
              <span>
                Each player gets one 50/50 (removes two wrong answers) and one
                Double Points power-up per game.
              </span>
            </div>

            <div className="rule">
              <strong>11.</strong>
              <span>Wrong or unanswered questions receive 0 points and reset your streak.</span>
            </div>

            <div className="rule">
              <strong>12.</strong>
              <span>You can submit only one answer per question.</span>
            </div>

            <div className="rule">
              <strong>13.</strong>
              <span>Other players' answers stay hidden during the question.</span>
            </div>

            <div className="rule">
              <strong>14.</strong>
              <span>
                After every question, the correct answer and full scores are
                shown for 3 seconds.
              </span>
            </div>

            <div className="rule">
              <strong>15.</strong>
              <span>The player with the highest final score wins the battle.</span>
            </div>

            <div className="rule">
              <strong>16.</strong>
              <span>
                If you disconnect, your slot is reserved for 60 seconds so you
                can reconnect.
              </span>
            </div>
          </div>

          <button className="ghost" onClick={() => setScreen("home")}>
            ← Back
          </button>
        </Card>
      </Shell>
    );
  }


  // --------------------------------------------------
  // CREATE / JOIN
  // --------------------------------------------------

  if (screen === "join") {
    return (
      <Shell>
        <Card>
          <div className="section-title">
            <span>{mode === "create" ? "🚀" : "🔑"}</span>

            <h2>{mode === "create" ? "Create Room" : "Join Room"}</h2>
          </div>

          <label>
            Your Name
            <input
              value={name}
              maxLength={16}
              autoComplete="off"
              placeholder="Enter your name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          {mode === "create" && (
            <>
              <label>
                Quiz Type
                <div className="quiz-type-select">
                  <button
                    type="button"
                    className={`quiz-type-trigger ${quizTypeOpen ? "open" : ""}`}
                    aria-haspopup="listbox"
                    aria-expanded={quizTypeOpen}
                    onClick={() => setQuizTypeOpen((open) => !open)}
                  >
                    <span>{QUIZ_TYPE_LABELS[quizType]}</span>
                    <span
                      className={`quiz-type-arrow ${quizTypeOpen ? "up" : ""}`}
                      aria-hidden="true"
                    />
                  </button>

                  {quizTypeOpen && (
                    <div className="quiz-type-menu" role="listbox">
                      {Object.entries(QUIZ_TYPE_LABELS).map(([value, label]) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={quizType === value}
                          key={value}
                          className={`quiz-type-option ${
                            quizType === value ? "selected" : ""
                          }`}
                          onClick={() => {
                            setQuizType(value);
                            setQuizTypeOpen(false);
                          }}
                        >
                          <span>{label}</span>
                          {quizType === value && (
                            <span className="quiz-type-check">✓</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </label>

              <label>
                Difficulty
                <div className="difficulty-select">
                  <button
                    type="button"
                    className={`quiz-type-trigger ${
                      difficultyOpen ? "open" : ""
                    }`}
                    aria-haspopup="listbox"
                    aria-expanded={difficultyOpen}
                    onClick={() => {
                      setDifficultyOpen((open) => !open);
                      setQuizTypeOpen(false);
                    }}
                  >
                    <span>
                      {difficulty === "mixed"
                        ? "🎲 Mixed Difficulty"
                        : difficulty === "easy"
                        ? "🟢 Easy"
                        : difficulty === "medium"
                        ? "🟡 Medium"
                        : "🔴 Hard"}
                    </span>
                    <span
                      className={`quiz-type-arrow ${
                        difficultyOpen ? "up" : ""
                      }`}
                      aria-hidden="true"
                    />
                  </button>

                  {difficultyOpen && (
                    <div className="quiz-type-menu" role="listbox">
                      {[
                        ["mixed", "🎲 Mixed Difficulty"],
                        ["easy", "🟢 Easy"],
                        ["medium", "🟡 Medium"],
                        ["hard", "🔴 Hard"]
                      ].map(([value, label]) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={difficulty === value}
                          key={value}
                          className={`quiz-type-option ${
                            difficulty === value ? "selected" : ""
                          }`}
                          onClick={() => {
                            setDifficulty(value);
                            setDifficultyOpen(false);
                          }}
                        >
                          <span>{label}</span>
                          {difficulty === value && (
                            <span className="quiz-type-check">✓</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </label>

              <label>
                Match Size
                <div className="battle-select">
                  <button
                    type="button"
                    className={`battle-select-trigger ${
                      matchSizeOpen ? "open" : ""
                    }`}
                    onClick={() => {
                      setMatchSizeOpen((open) => !open);
                      setBattleFormatOpen(false);
                    }}
                  >
                    <span>{MATCH_SIZE_LABELS[matchSize]}</span>
                    <span
                      className={`quiz-type-arrow ${
                        matchSizeOpen ? "up" : ""
                      }`}
                      aria-hidden="true"
                    />
                  </button>

                  {matchSizeOpen && (
                    <div className="battle-select-menu">
                      {Object.entries(MATCH_SIZE_LABELS).map(([value, label]) => (
                        <button
                          type="button"
                          key={value}
                          className={`quiz-type-option ${
                            Number(value) === matchSize ? "selected" : ""
                          }`}
                          onClick={() => {
                            const nextSize = Number(value);
                            const nextFormat =
                              Object.keys(BATTLE_FORMATS[nextSize])[0];
                            setMatchSize(nextSize);
                            setBattleFormat(nextFormat);
                            setMatchSizeOpen(false);
                          }}
                        >
                          <span>{label}</span>
                          {Number(value) === matchSize && (
                            <span className="quiz-type-check">✓</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </label>

              <label>
                Battle Format
                <div className="battle-select">
                  <button
                    type="button"
                    className={`battle-select-trigger ${
                      battleFormatOpen ? "open" : ""
                    }`}
                    onClick={() => {
                      setBattleFormatOpen((open) => !open);
                      setMatchSizeOpen(false);
                    }}
                  >
                    <span>{BATTLE_FORMATS[matchSize][battleFormat]}</span>
                    <span
                      className={`quiz-type-arrow ${
                        battleFormatOpen ? "up" : ""
                      }`}
                      aria-hidden="true"
                    />
                  </button>

                  {battleFormatOpen && (
                    <div className="battle-select-menu">
                      {Object.entries(BATTLE_FORMATS[matchSize]).map(
                        ([value, label]) => (
                          <button
                            type="button"
                            key={value}
                            className={`quiz-type-option ${
                              battleFormat === value ? "selected" : ""
                            }`}
                            onClick={() => {
                              setBattleFormat(value);
                              setBattleFormatOpen(false);
                            }}
                          >
                            <span>{label}</span>
                            {battleFormat === value && (
                              <span className="quiz-type-check">✓</span>
                            )}
                          </button>
                        )
                      )}
                    </div>
                  )}
                </div>
              </label>
            </>
          )}

          {mode === "join" && (
            <label>
              Room Code
              <input
                value={roomCode}
                maxLength={6}
                autoComplete="off"
                placeholder="ABC123"
                onChange={(event) =>
                  setRoomCode(
                    event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "")
                  )
                }
              />
            </label>
          )}

          <button disabled={busy} onClick={connectToRoom}>
            {busy ? "Connecting..." : mode === "create" ? "Create Room" : "Join Room"}
          </button>

          {error && <div className="error">{error}</div>}

          <button className="ghost" onClick={() => setScreen("home")}>
            ← Back
          </button>
        </Card>
      </Shell>
    );
  }


  // --------------------------------------------------
  // BATTLE INTRO
  // --------------------------------------------------

  if (screen === "battle-intro" && battleIntro) {
    const introPlayers = battleIntro.players || [];
    const introTeams = battleIntro.teams || [];

    return (
      <Shell hideFooter>
        <div className="battle-intro-screen">
          <div className="battle-intro-kicker">TECH BATTLE</div>
          <h1>⚔️ {battleIntro.battleFormatLabel || "BATTLE"}</h1>

          <div className="battle-versus-layout">
            <div className="battle-side battle-side-left">
              <span className="battle-side-label">TEAM A</span>
              <strong>
                {introTeams[0]?.name ||
                  introPlayers[0]?.name ||
                  "PLAYER 1"}
              </strong>
              <div className="battle-side-players">
                {(introTeams[0]?.players || introPlayers.slice(0, 1)).map(
                  (player) => (
                    <span key={player.id}>{player.name}</span>
                  )
                )}
              </div>
            </div>

            <div className="battle-vs">VS</div>

            <div className="battle-side battle-side-right">
              <span className="battle-side-label">TEAM B</span>
              <strong>
                {introTeams[1]?.name ||
                  introPlayers[1]?.name ||
                  "PLAYER 2"}
              </strong>
              <div className="battle-side-players">
                {(introTeams[1]?.players || introPlayers.slice(1, 2)).map(
                  (player) => (
                    <span key={player.id}>{player.name}</span>
                  )
                )}
              </div>
            </div>
          </div>

          <div className="battle-intro-meta">
            {battleIntro.matchSize} PLAYERS <span>•</span>{" "}
            {battleIntro.battleFormatLabel}
          </div>
        </div>
      </Shell>
    );
  }


  // --------------------------------------------------
  // COUNTDOWN
  // --------------------------------------------------

  if (screen === "countdown") {
    return (
      <Shell>
        <div className="countdown-screen">
          <div className="countdown-label">GET READY!</div>

          <div className="countdown-number">{countdownValue}</div>

          <p>Question 1 is about to begin</p>
        </div>
      </Shell>
    );
  }


  // --------------------------------------------------
  // WAITING ROOM
  // --------------------------------------------------

  if (screen === "waiting") {
    const activePlayers =
      room?.players?.filter((player) => player.active) || [];

    const isHost = room && me && room.hostPlayerId === me.id;
    const requiredPlayers =
      room?.requiredPlayers || room?.matchSize || 2;

    const shareUrl =
      `${window.location.origin}${window.location.pathname}?room=${
        room?.code || roomCode
      }`;

    const waitingTeams = room?.teams || [];

    return (
      <Shell>
        <Card>
          <div className="waiting-header">
            <div>
              <span className="eyebrow">WAITING ROOM</span>
              <h2>Ready for battle?</h2>
            </div>

            <div className="player-count">
              {activePlayers.length}/{requiredPlayers}
            </div>
          </div>

          <div className="battle-settings-grid">
            <div className="battle-info-box">
              <span>QUIZ TYPE</span>
              <strong>
                {QUIZ_TYPE_LABELS[room?.quizType] ||
                  room?.quizTypeLabel ||
                  "🎯 Mixed Placement"}
              </strong>
            </div>

            <div className="battle-info-box">
              <span>BATTLE</span>
              <strong>{room?.battleFormatLabel || "1v1"}</strong>
            </div>

            <div className="battle-info-box">
              <span>DIFFICULTY</span>
              <strong>
                {room?.difficultyLabel ||
                  DIFFICULTY_LABELS[room?.difficulty] ||
                  "Mixed Difficulty"}
              </strong>
            </div>

            <div className="battle-info-box">
              <span>MATCH SIZE</span>
              <strong>{requiredPlayers} PLAYERS</strong>
            </div>
          </div>

          <div className="room-code-box">
            <span>ROOM CODE</span>
            <strong>{room?.code || roomCode}</strong>

            <button
              className="copy-button"
              onClick={() =>
                navigator.clipboard?.writeText(
                  room?.code || roomCode
                )
              }
            >
              Copy Code
            </button>
          </div>

          <p className="share-text">
            Share this code, or{" "}
            <button
              className="link-button"
              onClick={() =>
                navigator.clipboard?.writeText(shareUrl)
              }
            >
              copy an invite link
            </button>
            .
          </p>

          {waitingTeams.length > 0 && (
            <div className="waiting-teams">
              <div className="players-heading">
                <h3>Battle Teams</h3>
                <span>{waitingTeams.length} teams</span>
              </div>

              <div className="team-grid">
                {waitingTeams.map((team) => (
                  <div className="team-card" key={team.id}>
                    <div className="team-card-top">
                      <strong>{team.name}</strong>
                      <span>{team.score} pts</span>
                    </div>

                    <div className="team-member-list">
                      {team.players.map((player) => (
                        <span key={player.id}>
                          ⚡ {player.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="players-heading">
            <h3>Players</h3>
            <span>{activePlayers.length} joined</span>
          </div>

          <div className="players-list">
            {activePlayers.map((player) => (
              <div className="player-card" key={player.id}>
                <div className="player-avatar">
                  {player.name.charAt(0).toUpperCase()}
                </div>

                <div className="player-info">
                  <strong>{player.name}</strong>

                  <span>
                    {player.isHost
                      ? "Host"
                      : player.connected
                      ? "Connected"
                      : "Reconnecting..."}
                    {player.teamName
                      ? ` • ${player.teamName}`
                      : ""}
                  </span>
                </div>

                {player.isHost && (
                  <span className="host-badge">👑 HOST</span>
                )}
              </div>
            ))}
          </div>

          {isHost ? (
            <button
              disabled={activePlayers.length !== requiredPlayers}
              onClick={startGame}
            >
              {activePlayers.length !== requiredPlayers
                ? `Need ${
                    requiredPlayers - activePlayers.length
                  } more player${
                    requiredPlayers - activePlayers.length === 1
                      ? ""
                      : "s"
                  }`
                : "Start Battle →"}
            </button>
          ) : (
            <div className="waiting-message">
              <span className="pulse-dot" />
              Waiting for the host to start...
            </div>
          )}

          <button className="ghost" onClick={leaveGame}>
            Leave Room
          </button>

          {error && <div className="error">{error}</div>}
        </Card>
      </Shell>
    );
  }


  // --------------------------------------------------
  // GAME
  // --------------------------------------------------

  if (screen === "game" && question) {
    const connectedPlayers =
      room?.players?.filter((player) => player.active && player.connected)
        .length || 0;

    const progress = Math.max(0, Math.min(100, (timeRemaining / 20) * 100));

    return (
      <Shell>
        <Card className="game-card">
          <div className="game-top">
            <div>
              <span className="eyebrow">
                QUESTION {question.number} / {question.total}
              </span>

              <div className="question-meta">
                <span className="category-tag">
                  {CATEGORY_LABELS[question.category] || question.category}
                </span>

                <span className={`difficulty ${question.difficulty}`}>
                  {DIFFICULTY_LABELS[question.difficulty]}
                </span>

                {question.streak >= 2 && (
                  <span className="streak-tag">
                    🔥 {question.streak} streak
                  </span>
                )}

                {powerups.doublePointsActive && (
                  <span className="double-tag">2x POINTS</span>
                )}
              </div>
            </div>

            <div className={`timer ${timeRemaining <= 5 ? "danger" : ""}`}>
              {Math.ceil(timeRemaining)}
              <small>s</small>
            </div>
          </div>

          <div className="timer-bar">
            <div style={{ width: `${progress}%` }} />
          </div>

          <div className="question-area">
            <h2>{question.text}</h2>

            <div className="answers-grid">
              {question.options.map((option, index) => {
                const isEliminated = eliminatedOptions.includes(index);

                return (
                  <button
                    key={index}
                    disabled={
                      selectedAnswer !== null ||
                      timeRemaining <= 0 ||
                      isEliminated
                    }
                    className={
                      selectedAnswer === index
                        ? "answer selected"
                        : isEliminated
                        ? "answer eliminated"
                        : "answer"
                    }
                    onClick={() => submitAnswer(index)}
                  >
                    <span className="option-letter">
                      {String.fromCharCode(65 + index)}
                    </span>

                    <span>{option}</span>
                  </button>
                );
              })}
            </div>

            <div className="powerup-row">
              <button
                className="powerup-button"
                disabled={!powerups.fiftyFiftyAvailable || selectedAnswer !== null}
                onClick={useFiftyFifty}
              >
                ✂️ 50/50
              </button>

              <button
                className="powerup-button"
                disabled={
                  !powerups.doublePointsAvailable ||
                  powerups.doublePointsActive ||
                  selectedAnswer !== null
                }
                onClick={useDoublePoints}
              >
                ✨ 2x Points
              </button>
            </div>
          </div>

          <LiveLeaderboard
            players={leaderboard}
            teams={teamLeaderboard}
            me={me}
            rankChanges={rankChanges}
          />

          <div className="game-footer">
            <div className="answer-status">
              <span className="status-dot" />
              {answeredCount} / {connectedPlayers} players answered
            </div>

            {selectedAnswer !== null && (
              <span className="locked">✓ Answer locked</span>
            )}
          </div>
        </Card>
      </Shell>
    );
  }


  // --------------------------------------------------
  // RESULTS
  // --------------------------------------------------

  if (screen === "results" && questionResults) {
    return (
      <Shell>
        <Card>
          <div className="results-header">
            <span className="success-icon">✓</span>

            <div>
              <span className="eyebrow">QUESTION COMPLETE</span>

              <h2>Correct Answer</h2>
            </div>
          </div>

          <div className="correct-answer">{questionResults.correctAnswer}</div>

          <div className="leaderboard-heading">
            <h3>Scoreboard</h3>
          </div>

          <div className="leaderboard">
            {(questionResults.players || leaderboard).map((player, index) => (
              <div
                key={player.id}
                className={`leaderboard-row ${
                  player.id === me?.id ? "current-player" : ""
                }`}
              >
                <div className="rank">{index + 1}</div>

                <div className="leader-name">
                  <strong>{player.name}</strong>

                  <span>
                    +{player.points} this question
                    {player.streak >= 2 ? ` · 🔥${player.streak}` : ""}
                  </span>
                </div>

                <strong className="total-score">{player.total}</strong>
              </div>
            ))}
          </div>

          {(questionResults.teams || teamLeaderboard || []).length > 0 && (
            <div className="results-teams">
              <div className="leaderboard-heading">
                <h3>Team Score</h3>
              </div>

              {(questionResults.teams || teamLeaderboard).map((team) => (
                <div className="team-score-row" key={team.id}>
                  <span>#{team.rank} {team.name}</span>
                  <strong>{team.score}</strong>
                </div>
              ))}
            </div>
          )}

          <div className="next-question">
            Next question in 3 seconds...
          </div>
        </Card>
      </Shell>
    );
  }


  // --------------------------------------------------
  // FINAL RESULTS
  // --------------------------------------------------

  if (screen === "final" && finalResults) {
    const winners = finalResults.winners || [];

    const isHost = room && me && room.hostPlayerId === me.id;

    const myPerformance =
      finalResults.performanceByPlayer?.[me?.id] || null;

    return (
      <Shell>
        <Card>
          <div className="final-header">
            <div className="trophy">🏆</div>

            <span className="eyebrow">FINAL RESULTS</span>

            <h1>{winners.length > 1 ? "Winners!" : "Winner!"}</h1>

            <p>
              {winners.length > 0
                ? winners.map((winner) => winner.name).join(" & ")
                : "No winner"}
            </p>
          </div>

          <div className="final-section-title">INDIVIDUAL RESULTS</div>

          <div className="final-leaderboard">
            {(finalResults.leaderboard || []).map((player, index) => (
              <div
                key={player.id}
                className={`final-row ${
                  player.id === me?.id ? "current-player" : ""
                }`}
              >
                <div className="final-rank">
                  {index === 0 ? "🏆" : index + 1}
                </div>

                <div className="final-name">
                  <strong>{player.name}</strong>
                  {player.teamName && <small>{player.teamName}</small>}
                  {player.id === me?.id && <span>YOU</span>}
                  {player.left && <span className="left-tag">LEFT</span>}
                </div>

                <strong>{player.total}</strong>
              </div>
            ))}
          </div>

          {(finalResults.teams || []).length > 0 && (
            <>
              <div className="final-section-title">TEAM RESULTS</div>

              <div className="final-leaderboard team-final-leaderboard">
                {finalResults.teams.map((team, index) => (
                  <div className="final-row" key={team.id}>
                    <div className="final-rank">
                      {index === 0 ? "🏆" : index + 1}
                    </div>

                    <div className="final-name">
                      <strong>{team.name}</strong>
                      <small>
                        {team.players
                          .map((player) => player.name)
                          .join(" • ")}
                      </small>
                    </div>

                    <strong>{team.score}</strong>
                  </div>
                ))}
              </div>
            </>
          )}

          {myPerformance && (
            <>
              <div className="final-section-title">
                YOUR PLACEMENT PERFORMANCE
              </div>

              <div className="performance-overview">
                <div className="performance-stat">
                  <span>ACCURACY</span>
                  <strong>{myPerformance.accuracy}%</strong>
                </div>

                <div className="performance-stat">
                  <span>CORRECT</span>
                  <strong>
                    {myPerformance.correct}/{myPerformance.answered}
                  </strong>
                </div>

                <div className="performance-stat">
                  <span>AVG. TIME</span>
                  <strong>
                    {myPerformance.averageResponseTime}s
                  </strong>
                </div>
              </div>

              <div className="performance-grid">
                <div className="performance-panel">
                  <div className="performance-panel-title">
                    BY CATEGORY
                  </div>

                  {myPerformance.byCategory.map((item) => (
                    <div className="performance-row" key={item.key}>
                      <span>
                        {CATEGORY_LABELS[item.key] || item.key}
                      </span>
                      <strong>{item.accuracy}%</strong>
                    </div>
                  ))}
                </div>

                <div className="performance-panel">
                  <div className="performance-panel-title">
                    BY DIFFICULTY
                  </div>

                  {myPerformance.byDifficulty.map((item) => (
                    <div className="performance-row" key={item.key}>
                      <span>
                        {DIFFICULTY_LABELS[item.key] || item.key}
                      </span>
                      <strong>{item.accuracy}%</strong>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {isHost ? (
            <button onClick={playAgain}>Play Again ↻</button>
          ) : (
            <div className="waiting-message">
              <span className="pulse-dot" />
              Waiting for the host to restart...
            </div>
          )}

          <button className="ghost" onClick={leaveGame}>
            Return Home
          </button>

          {error && <div className="error">{error}</div>}
        </Card>
      </Shell>
    );
  }


  return null;
}


// --------------------------------------------------
// LIVE LEADERBOARD
// --------------------------------------------------

function LiveLeaderboard({ players, teams, me, rankChanges }) {
  if (!players?.length) {
    return null;
  }

  return (
    <div className="live-leaderboard">
      <div className="live-leaderboard-header">
        <div>
          <span className="eyebrow">LIVE BATTLE</span>
          <h3>Leaderboard</h3>
        </div>

        <span className="live-indicator">
          <i /> LIVE
        </span>
      </div>

      <div className="live-leaderboard-list">
        {players.map((player) => {
          const movement = rankChanges?.[player.id];

          return (
            <div
              className={`live-rank-row ${
                player.id === me?.id ? "current-player" : ""
              } ${movement ? `rank-${movement}` : ""}`}
              key={player.id}
            >
              <div className="live-rank">
                <span>{player.rank}</span>
                {movement && (
                  <b>{movement === "up" ? "▲" : "▼"}</b>
                )}
              </div>

              <div className="live-player-name">
                <strong>{player.name}</strong>
                <small>{player.teamName || "Player"}</small>
              </div>

              <strong className="live-score">{player.score}</strong>
            </div>
          );
        })}
      </div>

      {teams?.length > 0 && (
        <div className="live-team-summary">
          {teams.map((team) => (
            <div key={team.id} className="live-team-row">
              <span>
                #{team.rank} {team.name}
              </span>
              <strong>{team.score}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// --------------------------------------------------
// UI COMPONENTS
// --------------------------------------------------

function Shell({ children, hideFooter }) {
  return (
    <main>
      {children}

      {!hideFooter && (
        <footer>
          ⚡ Tech Battle
          <span>Real-time multiplayer quiz</span>
        </footer>
      )}
    </main>
  );
}


function Card({ children, className = "" }) {
  return (
    <section className={`card ${className}`.trim()}>
      {children}
    </section>
  );
}


// --------------------------------------------------
// START REACT
// --------------------------------------------------

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);