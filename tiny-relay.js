/**
 * TINY Robot Relay — Cloudflare Worker (WebSocket relay)
 * -------------------------------------------------------
 * Handles secure connection, message routing, quiz validation, 
 * and short-lived control authorization for the TINY Robot.
 */

const SCORE_THRESHOLD = 6;
const AUTH_DURATION_MS = 10 * 60 * 1000; // 10 minutes

const htmlPage = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TINY Robot Interface</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f9; display: flex; flex-direction: column; align-items: center; padding: 2rem; }
        .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 500px; width: 100%; text-align: center; }
        h1 { color: #3b82f6; }
        button { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-size: 16px; cursor: pointer; margin-top: 20px; }
        button:hover { background: #2563eb; }
        #status { margin-top: 15px; font-weight: bold; color: #6b7280; }
    </style>
</head>
<body>
    <div class="card">
        <h1>🤖 TINY Robot</h1>
        <p>This is the basic web interface served directly from the Worker.</p>
        <div id="status">Connecting to WebSocket...</div>
        <button id="testBtn">Test Connection</button>
    </div>
    <script>
        const ws = new WebSocket((window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws?role=browser');
        const statusEl = document.getElementById('status');
        ws.onopen = () => { statusEl.innerText = "✅ Connected to Cloudflare Relay"; statusEl.style.color = "#10b981"; };
        ws.onclose = () => { statusEl.innerText = "❌ Disconnected"; statusEl.style.color = "#ef4444"; };
        document.getElementById('testBtn').onclick = () => {
            if(ws.readyState === WebSocket.OPEN) {
                alert("WebSocket is active!");
            } else {
                alert("WebSocket is not connected.");
            }
        }
    </script>
</body>
</html>
`;

const devices = new Map(); // deviceId -> { esp32: WebSocket|null, browsers: Map<WebSocket, Session> }

function getRoom(deviceId) {
  if (!devices.has(deviceId)) {
    devices.set(deviceId, { esp32: null, browsers: new Map() });
  }
  return devices.get(deviceId);
}

function notifyBrowsers(room, payload) {
  const msg = JSON.stringify(payload);
  for (const [browser] of room.browsers) {
    try { browser.send(msg); } catch { room.browsers.delete(browser); }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Serve a basic HTML UI on the root path
    if (url.pathname === "/") {
      return new Response(htmlPage, {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, status: "TINY Relay Active" });
    }

    if (url.pathname !== "/ws") {
      return new Response("TINY relay — connect at /ws?role=browser|esp32&device=<id>", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const role = url.searchParams.get("role");
    const deviceId = url.searchParams.get("device") || "tiny-01";
    
    if (role !== "browser" && role !== "esp32") {
      return new Response("role must be 'browser' or 'esp32'", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const room = getRoom(deviceId);

    if (role === "esp32") {
      if (room.esp32) { try { room.esp32.close(1000, "replaced"); } catch {} }
      room.esp32 = server;
      notifyBrowsers(room, { type: "robot.status", payload: { online: true } });
    } else {
      room.browsers.set(server, { authorized: false, expires: 0 });
      server.send(JSON.stringify({ type: "robot.status", payload: { online: !!room.esp32 } }));
    }

    server.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return; // ignore malformed
      }

      if (role === "browser") {
        const session = room.browsers.get(server);
        
        // Handle quiz submission
        if (data.type === "quiz.complete") {
          const score = data.payload?.score || 0;
          if (score > SCORE_THRESHOLD) {
            session.authorized = true;
            session.expires = Date.now() + AUTH_DURATION_MS;
            server.send(JSON.stringify({ type: "quiz.access_granted" }));
            
            // Notify ESP32 of happy expression
            if (room.esp32 && room.esp32.readyState === 1) {
              room.esp32.send(JSON.stringify({ type: "robot.expression", payload: { emotion: "HAPPY" } }));
            }
          } else {
            session.authorized = false;
            server.send(JSON.stringify({ type: "quiz.access_denied" }));
            if (room.esp32 && room.esp32.readyState === 1) {
              room.esp32.send(JSON.stringify({ type: "robot.expression", payload: { emotion: "SAD" } }));
            }
          }
          return;
        }

        // Handle motor control
        if (data.type === "robot.motor_command" || data.type === "robot.emergency_stop") {
          if (!session.authorized || Date.now() > session.expires) {
            session.authorized = false;
            server.send(JSON.stringify({ type: "error", payload: { message: "Unauthorized or expired" } }));
            return;
          }

          if (room.esp32 && room.esp32.readyState === 1) {
            room.esp32.send(JSON.stringify(data));
          } else {
            server.send(JSON.stringify({ type: "error", payload: { message: "robot offline" } }));
          }
        }
      } else if (role === "esp32") {
        // Robot telemetry -> browsers
        notifyBrowsers(room, data);
      }
    });

    const drop = () => {
      if (role === "esp32") {
        if (room.esp32 === server) room.esp32 = null;
        notifyBrowsers(room, { type: "robot.status", payload: { online: false } });
      } else {
        room.browsers.delete(server);
      }
    };
    
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  },
};

