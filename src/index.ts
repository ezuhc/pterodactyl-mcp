#!/usr/bin/env node

import "dotenv/config";
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PterodactylClient } from "./lib/pterodactyl.js";
import { WebSocketManager } from "./lib/websocket.js";
import { registerTools, type ToolClients } from "./tools/index.js";

const transportMode = process.argv.includes("--stdio") ? "stdio" : "http";

function getPort(): number {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1]) {
    return parseInt(process.argv[idx + 1], 10);
  }
  return parseInt(process.env.PORT ?? "3000", 10);
}

const PTERO_URL = process.env.PTERODACTYL_URL;
const PTERO_APP_KEY = process.env.PTERODACTYL_APP_KEY;
const PTERO_CLIENT_KEY = process.env.PTERODACTYL_CLIENT_KEY;

if (!PTERO_URL) {
  console.error("Missing PTERODACTYL_URL environment variable.");
  process.exit(1);
}

if (!PTERO_APP_KEY && !PTERO_CLIENT_KEY) {
  console.error(
    "At least one API key is required:\n" +
      "  PTERODACTYL_APP_KEY    (ptla_*) for admin tools\n" +
      "  PTERODACTYL_CLIENT_KEY (ptlc_*) for client tools\n" +
      "Copy .env.example to .env and fill in your panel credentials.",
  );
  process.exit(1);
}

const clients: ToolClients = {};

if (PTERO_APP_KEY) {
  clients.admin = new PterodactylClient({ baseUrl: PTERO_URL, apiKey: PTERO_APP_KEY });
}
if (PTERO_CLIENT_KEY) {
  clients.client = new PterodactylClient({ baseUrl: PTERO_URL, apiKey: PTERO_CLIENT_KEY });
  clients.wsManager = new WebSocketManager(clients.client.client, PTERO_URL.replace(/\/+$/, ""));
}

const scopes = [
  clients.admin && "admin (ptla_)",
  clients.client && "client (ptlc_)",
].filter(Boolean);
console.error(`Pterodactyl API scopes: ${scopes.join(", ")}`);

function createServer(): McpServer {
  const server = new McpServer({
    name: "pterodactyl-mcp",
    version: "0.1.0",
  });

  registerTools(server, clients);

  return server;
}

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function startHttp() {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  const port = getPort();
  app.listen(port, () => {
    console.log(`Pterodactyl MCP server listening on http://localhost:${port}/mcp`);
  });
}

if (transportMode === "stdio") {
  startStdio();
} else {
  startHttp();
}
