import htmlPage from './index.html';
import cssContent from './style.css';

const SCORE_THRESHOLD = 6;
const AUTH_DURATION_MS = 10 * 60 * 1000;

const devices = new Map();

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

    if (url.pathname === "/") {
      return new Response(htmlPage, {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }
    
    if (url.pathname === "/style.css") {
      return new Response(cssContent, {
        headers: { "Content-Type": "text/css;charset=UTF-8" }
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, status: "TINY Relay Active" });
    }

    if (url.pathname !== "/ws") {
      return new Response("Not found", { status: 404 });
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
      try { data = JSON.parse(event.data); } catch (e) { return; }

      if (role === "browser") {
        const session = room.browsers.get(server);
        
        if (data.type === "quiz.complete") {
          const score = data.payload?.score || 0;
          if (score > SCORE_THRESHOLD) {
            session.authorized = true;
            session.expires = Date.now() + AUTH_DURATION_MS;
            server.send(JSON.stringify({ type: "quiz.access_granted" }));
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
  }
};
