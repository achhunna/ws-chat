import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getStoredUsername() {
  try {
    return localStorage.getItem("ws-chat.username") || "";
  } catch {
    return "";
  }
}

function setStoredUsername(value) {
  try {
    localStorage.setItem("ws-chat.username", value);
  } catch {
    // Ignore storage failures.
  }
}

function isRenderableMessage(message) {
  return (
    message &&
    message.type === "chat" &&
    typeof message.id === "string" &&
    typeof message.user === "string" &&
    typeof message.text === "string" &&
    message.text.trim().length > 0
  );
}

function colorForUsername(username) {
  const palette = [
    ["#2563eb", "rgba(37, 99, 235, 0.14)"],
    ["#0f766e", "rgba(15, 118, 110, 0.14)"],
    ["#7c3aed", "rgba(124, 58, 237, 0.14)"],
    ["#b45309", "rgba(180, 83, 9, 0.14)"],
    ["#be185d", "rgba(190, 24, 93, 0.14)"],
    ["#0891b2", "rgba(8, 145, 178, 0.14)"],
    ["#ea580c", "rgba(234, 88, 12, 0.14)"],
    ["#16a34a", "rgba(22, 163, 74, 0.14)"],
  ];
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) {
    hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function messageStyleForUser(message) {
  if (message?.userColor && message?.userBg) {
    return [message.userColor, message.userBg];
  }
  return colorForUsername(message?.user || "guest");
}

const MINE_COLOR = "#2563eb";
const MINE_BG = "rgba(37, 99, 235, 0.18)";

function App() {
  const [messages, setMessages] = React.useState([]);
  const [status, setStatus] = React.useState("connecting");
  const [name, setName] = React.useState(() => getStoredUsername());
  const [text, setText] = React.useState("");
  const [socket, setSocket] = React.useState(null);
  const listRef = React.useRef(null);

  React.useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/socket`);
    const storedName = getStoredUsername();
    if (storedName) setName(storedName);

    ws.onopen = () => setStatus("live");
    ws.addEventListener("open", () => {
      const helloPayload = storedName
        ? { type: "hello", user: storedName }
        : { type: "hello" };
      ws.send(JSON.stringify(helloPayload));
    });
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "history") {
        setMessages(payload.history.filter(isRenderableMessage));
        return;
      }
      if (payload.type === "assigned-name") {
        setName(payload.user);
        setStoredUsername(payload.user);
        return;
      }
      if (payload.type === "history-cleared") {
        setMessages([]);
        return;
      }
      if (!isRenderableMessage(payload)) return;
      setMessages((prev) => [...prev, payload].slice(-100));
    };
    ws.onerror = () => setStatus("reconnecting");
    ws.onclose = () => setStatus("disconnected");

    setSocket(ws);
    return () => ws.close();
  }, []);

  React.useEffect(() => {
    document.title = name ? `Chat - ${name}` : "Chat";
  }, [name]);

  React.useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function sendMessage(event) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !socket || socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({ text: trimmed }));
    setText("");
  }

  async function clearHistory() {
    try {
      const response = await fetch("/api/chat/history", { method: "DELETE" });
      if (!response.ok) return;
      setMessages([]);
    } catch {
      // Ignore clear failures.
    }
  }

  const users = messages.reduce((acc, message) => {
    if (acc.indexOf(message.user) === -1) {
      acc.push(message.user);
    }
    return acc;
  }, []);

  return (
    <main className="shell chat-shell">
      <section className="hero chat-hero">
        <div>
          <p className="eyebrow">WebSocket chat</p>
          <h2>Realtime chat room</h2>
          <p className="lede">
            A small websocket chat app with live broadcast, message history, and
            a simple composer.
          </p>
        </div>
        <div className="panel">
          <div>
            <span className="label">Status</span>
            <strong>{status}</strong>
          </div>
          <div>
            <span className="label">You are</span>
            <strong
              className="username-badge"
              style={{
                "--username-color": MINE_COLOR,
                "--username-bg": MINE_BG,
              }}
            >
              {name}
            </strong>
          </div>
          <div>
            <span className="label">Users</span>
            <strong>{users.length}</strong>
          </div>
          <button type="button" className="clear-button" onClick={clearHistory}>
            Clear chat
          </button>
        </div>
      </section>

      <section className="chat-card">
        <div className="chat-list" ref={listRef}>
          {messages.map((message) => {
            const [userColor, userBg] = messageStyleForUser(message);
            const isMine = message.user === name;
            const displayColor = isMine ? MINE_COLOR : userColor;
            const displayBg = isMine ? MINE_BG : userBg;
            return (
              <article
                key={message.id}
                className={`chat-message ${isMine ? "mine" : ""}`}
                style={{
                  "--username-color": displayColor,
                  "--message-bg": displayBg,
                }}
              >
                <div className="chat-meta">
                  <strong
                    className="username-badge"
                    style={{
                      "--username-color": displayColor,
                      "--username-bg": displayBg,
                    }}
                  >
                    {message.user}
                  </strong>
                  <span>{formatTime(message.ts)}</span>
                </div>
                <p>{message.text}</p>
              </article>
            );
          })}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <input
            className="message-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type a message and press Enter"
            maxLength={240}
          />
          <button type="submit">Send</button>
        </form>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
