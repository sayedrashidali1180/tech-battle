import React, {
  useEffect,
  useMemo,
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
  hard: "Hard"
};


// --------------------------------------------------
// APP
// --------------------------------------------------

function App() {
  const [screen, setScreen] = useState("home");

  const [mode, setMode] = useState(null);

  const [quizType, setQuizType] = useState("mixed");

  const [quizTypeOpen, setQuizTypeOpen] = useState(false);

  const [name, setName] = useState("");

  const [roomCode, setRoomCode] = useState("");

  const [room, setRoom] = useState(null);

  const [me, setMe] = useState(null);

  const [question, setQuestion] = useState(null);

  const [questionResults, setQuestionResults] = useState(null);

  const [finalResults, setFinalResults] = useState(null);

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


    const handleCountdown = (data) => {
      setCountdown(data);

      setQuestion(null);
      setQuestionResults(null);

      setScreen("countdown");
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

      setQuestion(null);

      setQuestionResults(null);

      setCountdown(null);

      setScreen("final");
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

    socket.on("countdown", handleCountdown);

    socket.on("question", handleQuestion);

    socket.on("answer_count", handleAnswerCount);

    socket.on("question_results", handleQuestionResults);

    socket.on("game_finished", handleGameFinished);

    socket.on("server_error", handleError);


    return () => {
      socket.off("connect", handleConnect);

      socket.off("room_state", handleRoomState);

      socket.off("countdown", handleCountdown);

      socket.off("question", handleQuestion);

      socket.off("answer_count", handleAnswerCount);

      socket.off("question_results", handleQuestionResults);

      socket.off("game_finished", handleGameFinished);

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
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setQuizTypeOpen(false);
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
          quizType: mode === "create" ? quizType : undefined
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
    setCountdown(null);
    setEliminatedOptions([]);

    setPowerups({
      fiftyFiftyAvailable: true,
      doublePointsAvailable: true,
      doublePointsActive: false
    });

    setRoomCode("");
    setName("");

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
  // HOW TO PLAY
  // --------------------------------------------------

  if (screen === "how") {
    return (
      <Shell>
        <Card>
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
            <label>
              Quiz Type
              <div className="quiz-type-select">
                <button
                  type="button"
                  className={`quiz-type-trigger ${
                    quizTypeOpen ? "open" : ""
                  }`}
                  aria-haspopup="listbox"
                  aria-expanded={quizTypeOpen}
                  onClick={() => setQuizTypeOpen((open) => !open)}
                >
                  <span>{QUIZ_TYPE_LABELS[quizType]}</span>
                  <span className="quiz-type-arrow">
                    {quizTypeOpen ? "⌃" : "⌄"}
                  </span>
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
    const activePlayers = room?.players?.filter((player) => player.active) || [];

    const isHost = room && me && room.hostPlayerId === me.id;

    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${room?.code || roomCode}`;

    return (
      <Shell>
        <Card>
          <div className="waiting-header">
            <div>
              <span className="eyebrow">WAITING ROOM</span>

              <h2>Ready for battle?</h2>
            </div>

            <div className="player-count">{activePlayers.length}/8</div>
          </div>

          <div className="room-code-box">
            <span>ROOM CODE</span>

            <strong>{room?.code || roomCode}</strong>

            <button
              className="copy-button"
              onClick={() =>
                navigator.clipboard?.writeText(room?.code || roomCode)
              }
            >
              Copy Code
            </button>
          </div>

          <div className="room-code-box">
            <span>QUIZ TYPE</span>

            <strong>
              {QUIZ_TYPE_LABELS[room?.quizType] || "🎯 Mixed Placement"}
            </strong>
          </div>

          <p className="share-text">
            Share this code, or{" "}
            <button
              className="link-button"
              onClick={() => navigator.clipboard?.writeText(shareUrl)}
            >
              copy an invite link
            </button>
            .
          </p>

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
                  </span>
                </div>

                {player.isHost && <span className="host-badge">👑 HOST</span>}
              </div>
            ))}
          </div>

          {isHost ? (
            <button disabled={activePlayers.length < 2} onClick={startGame}>
              {activePlayers.length < 2
                ? "Need at least 2 players"
                : "Start Game →"}
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
                  {CATEGORY_LABELS[question.category]}
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
            {questionResults.players.map((player, index) => (
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

          <div className="next-question">Next question in 3 seconds...</div>
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

          <div className="final-leaderboard">
            {finalResults.leaderboard.map((player, index) => (
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

                  {player.id === me?.id && <span>YOU</span>}

                  {player.left && <span className="left-tag">LEFT</span>}
                </div>

                <strong>{player.total}</strong>
              </div>
            ))}
          </div>

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


function Card({ children }) {
  return <section className="card">{children}</section>;
}


// --------------------------------------------------
// START REACT
// --------------------------------------------------

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);