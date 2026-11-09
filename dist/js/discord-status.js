(() => {
  const userId = "1142998777364484107";
  const statusElement = document.getElementById("discordPresence");
  const statusLabel = document.getElementById("discordStatusLabel");
  const activityElement = document.getElementById("discordActivity");
  const avatar = document.getElementById("discordAvatar");

  if (!statusElement || !statusLabel || !activityElement) {
    return;
  }

  let socket;
  let heartbeatTimer;
  let reconnectTimer;
  let reconnectAttempts = 0;

  const statusLabels = {
    online: "Online",
    idle: "Idle",
    dnd: "Do Not Disturb",
    offline: "Offline",
  };

  function showConnectionStatus(status, label) {
    statusElement.dataset.status = status;
    statusLabel.textContent = label;
    activityElement.hidden = true;
  }

  function updateAvatar(user) {
    if (!avatar) {
      return;
    }

    if (!user || !/^\d+$/.test(user.id || "") || !/^[\w]+$/.test(user.avatar || "")) {
      avatar.src = avatar.dataset.fallback || "plug.png";
      return;
    }

    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    avatar.onerror = () => {
      avatar.onerror = null;
      avatar.src = avatar.dataset.fallback || "plug.png";
    };
    avatar.src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=256`;
  }

  function getActivity(presence) {
    if (presence.spotify && presence.spotify.song) {
      const artists = presence.spotify.artist || "Unknown artist";
      return `Listening to ${presence.spotify.song} by ${artists}`;
    }

    const activities = Array.isArray(presence.activities) ? presence.activities : [];
    const activity = activities.find((item) => item && item.type !== 4 && item.name);

    if (activity) {
      const verbs = {
        0: "Playing",
        1: "Streaming",
        2: "Listening to",
        3: "Watching",
        5: "Competing in",
      };
      const title = `${verbs[activity.type] || "Using"} ${activity.name}`;
      const details = [activity.details, activity.state]
        .filter((value) => typeof value === "string" && value.trim())
        .filter((value, index, values) => values.indexOf(value) === index);

      return details.length ? `${title} — ${details.join(" · ")}` : title;
    }

    const customStatus = activities.find((item) => item && item.type === 4 && item.state);
    if (customStatus) {
      const emoji = customStatus.emoji && customStatus.emoji.name
        ? `${customStatus.emoji.name} `
        : "";
      return `${emoji}${customStatus.state}`;
    }

    return "No current activity";
  }

  function renderPresence(presence) {
    if (!presence || !Object.prototype.hasOwnProperty.call(statusLabels, presence.discord_status)) {
      showConnectionStatus("unavailable", "Discord status unavailable");
      return;
    }

    const status = presence.discord_status;
    statusElement.dataset.status = status;
    statusLabel.textContent = statusLabels[status];
    activityElement.textContent = getActivity(presence);
    activityElement.hidden = false;
    updateAvatar(presence.discord_user);
    reconnectAttempts = 0;
  }

  function findPresence(data) {
    if (Array.isArray(data)) {
      return data.find((item) => item && (item.user_id === userId || item.discord_user?.id === userId))
        || (data.length === 1 ? data[0] : null);
    }

    if (data && typeof data === "object") {
      if (data.discord_status) {
        return data;
      }

      if (data[userId]) {
        return data[userId];
      }

      if (data.presence) {
        return data.presence;
      }
    }

    return null;
  }

  function scheduleReconnect() {
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
    showConnectionStatus("reconnecting", "Reconnecting to Discord...");

    const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    showConnectionStatus("loading", "Connecting to Discord...");

    try {
      socket = new WebSocket("wss://api.lanyard.rest/socket");
    } catch (error) {
      console.error("Could not connect to the Discord presence service.", error);
      scheduleReconnect();
      return;
    }

    socket.addEventListener("message", (event) => {
      let message;

      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.error("Received an invalid Discord presence message.", error);
        return;
      }

      if (message.op === 1 && message.d && Number.isFinite(message.d.heartbeat_interval)) {
        clearInterval(heartbeatTimer);
        socket.send(JSON.stringify({ op: 2, d: { subscribe_to_id: userId } }));
        heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: 3 }));
          }
        }, message.d.heartbeat_interval);
        return;
      }

      if (message.op === 0 && (message.t === "INIT_STATE" || message.t === "PRESENCE_UPDATE")) {
        const presence = findPresence(message.d);
        if (presence) {
          renderPresence(presence);
        } else {
          showConnectionStatus("unavailable", "Discord status unavailable");
        }
        return;
      }

      if (message.op === 4) {
        console.error("Discord presence service rejected the subscription.", message.d);
        showConnectionStatus("unavailable", "Status unavailable — check Lanyard opt-in");
      }
    });

    socket.addEventListener("error", () => {
      socket.close();
    });

    socket.addEventListener("close", scheduleReconnect);
  }

  connect();
})();
