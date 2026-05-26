import { afterAll, describe, expect, test } from "bun:test";
import { createGatewayServer } from "./index";
import { parseRoutesFromEnv } from "./config";

const upstreamServer = Bun.serve({
  port: 0,
  fetch(request, server) {
    if (new URL(request.url).pathname === "/") {
      const upgraded = server.upgrade(request);
      if (upgraded) {
        return;
      }
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    message(ws, message) {
      ws.send(typeof message === "string" ? `echo:${message}` : message);
    },
  },
});

const gatewayServer = createGatewayServer({
  port: 0,
  routes: parseRoutesFromEnv({
    PROXY_ROUTES: JSON.stringify([
      {
        prefix: "/socket",
        target: `http://127.0.0.1:${upstreamServer.port}`,
      },
    ]),
  }),
});

afterAll(() => {
  gatewayServer.stop(true);
  upstreamServer.stop(true);
});

describe("websocket proxy", () => {
  test("forwards websocket messages in both directions", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${gatewayServer.port}/socket`);
    socket.binaryType = "nodebuffer";

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Client websocket failed to open")),
        { once: true },
      );
    });

    const messagePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for proxied websocket message")),
        2000,
      );

      socket.addEventListener(
        "message",
        (event) => {
          clearTimeout(timeout);
          resolve(String(event.data));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          clearTimeout(timeout);
          reject(
            new Error(`Socket closed before message (${event.code}: ${event.reason})`),
          );
        },
        { once: true },
      );
    });

    socket.send("hello");
    const message = await messagePromise;
    expect(message).toBe("echo:hello");

    await new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.close(1000, "done");
    });
  });
});
