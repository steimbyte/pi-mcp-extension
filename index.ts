/**
 * Pi MCP Extension
 * 
 * Adds MCP server support to pi without the Zod version conflicts
 * that plague the official SDK approach.
 * 
 * WHY THIS EXISTS:
 * - pi bundles Zod v4 internally
 * - MCP SDK v1.x requires Zod v3
 * - Zod v3/v4 have incompatible APIs (safeParse vs safeParse, different schema types)
 * - The SDK's compat layer doesn't work reliably
 * 
 * SOLUTION:
 * - Direct JSON-RPC over stdio
 * - No dependency on MCP SDK internals
 * - Just spawn the server and talk JSON-RPC directly
 * 
 * INSTALLATION:
 * 1. mkdir -p ~/.pi/agent/extensions/mcp
 * 2. Copy this file to ~/.pi/agent/extensions/mcp/index.ts
 * 3. Create ~/.pi/agent/mcp.json with your servers
 * 4. Run: pi -p "hello"
 */

import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, ChildProcess } from "child_process";

// ============================================================================
// Types
// ============================================================================

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface MCPConfig {
  settings?: {
    toolPrefix?: "server" | "short" | "none";
  };
  mcpServers?: Record<string, MCPServerConfig>;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

interface MCPConnection {
  process: ChildProcess;
  name: string;
  tools: MCPTool[];
  requestId: number;
}

// ============================================================================
// State
// ============================================================================

const connections = new Map<string, MCPConnection>();

// ============================================================================
// Helpers
// ============================================================================

/**
 * Interpolate ${VAR} environment variable references
 */
function envInterpolate(str: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || "");
}

/**
 * Get tool name prefix based on config
 */
function getPrefix(name: string, p: string): string {
  if (p === "none") return "";
  if (p === "short") return name.replace(/-mcp$/, "");
  return name;
}

/**
 * Load MCP config from ~/.pi/agent/mcp.json
 */
async function loadConfig(): Promise<MCPConfig> {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(`${process.env.HOME}/.pi/agent/mcp.json`, "utf-8"));
  } catch {
    return {};
  }
}

// ============================================================================
// JSON-RPC Communication
// ============================================================================

/**
 * Send a JSON-RPC request to the MCP server and wait for response.
 * Uses stdio communication - stdin for requests, stdout for responses.
 */
function sendRequest(conn: MCPConnection, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!conn.process.stdin || !conn.process.stdout) {
      reject(new Error("Not connected to MCP server"));
      return;
    }

    const id = ++conn.requestId;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    const timeout = setTimeout(() => reject(new Error("MCP timeout (30s)")), 30000);

    const handler = (data: Buffer) => {
      try {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          // Match response to request by ID
          if (msg.id === id) {
            clearTimeout(timeout);
            conn.process.stdout!.off("data", handler);
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
            return;
          }
        }
      } catch { /* ignore parse errors for now */ }
    };

    conn.process.stdout.on("data", handler);
    conn.process.stdin.write(payload + "\n");
  });
}

// ============================================================================
// MCP Server Connection
// ============================================================================

/**
 * Connect to an MCP server via stdio transport.
 * 
 * Process:
 * 1. Spawn the server process
 * 2. Send initialize handshake
 * 3. Request tool list
 * 4. Store connection for later tool calls
 */
async function connect(name: string, config: MCPServerConfig): Promise<MCPConnection> {
  // Build environment with interpolated variables
  const envMap: Record<string, string> = { ...process.env };
  for (const [key, val] of Object.entries(config.env || {})) {
    envMap[key] = envInterpolate(val);
  }

  return new Promise((resolve, reject) => {
    // Spawn MCP server with stdio communication
    const proc = spawn(config.command, config.args || [], {
      env: envMap,
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
    });

    proc.on("error", reject);
    proc.on("exit", () => connections.delete(name));

    const conn: MCPConnection = { process: proc, name, tools: [], requestId: 0 };
    connections.set(name, conn);

    // MCP Protocol: Initialize
    sendRequest(conn, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: `pi-${name}`, version: "1.0.0" },
    })
      // MCP Protocol: List available tools
      .then(() => sendRequest(conn, "tools/list"))
      .then((result: any) => {
        conn.tools = result.tools || [];
        console.log(`[MCP] ${name}: ${conn.tools.length} tools`);
        resolve(conn);
      })
      .catch(reject);
  });
}

// ============================================================================
// Tool Schema Builder
// ============================================================================

/**
 * Build a TypeBox schema from an MCP tool's JSON Schema.
 * Maps JSON Schema types to TypeBox types.
 */
function buildSchema(schema: MCPTool["inputSchema"]) {
  const props: Record<string, unknown> = {};
  const req: string[] = [];

  if (schema.properties) {
    for (const [key, val] of Object.entries(schema.properties)) {
      const type = val.type || "string";
      
      // Map JSON Schema types to TypeBox
      props[key] = type === "string" 
        ? Type.String({ description: val.description })
        : type === "number" || type === "integer"
        ? Type.Number({ description: val.description })
        : type === "boolean"
        ? Type.Boolean({ description: val.description })
        : Type.String({ description: val.description });
      
      if (schema.required?.includes(key)) req.push(key);
    }
  }

  return Type.Object(props as Record<string, unknown>, { 
    required: req.length ? req : undefined 
  });
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default async function (pi: ExtensionAPI): Promise<void> {
  console.log("[MCP] Loading...");

  // Load configuration
  const config = await loadConfig();
  const servers = config.mcpServers || {};
  const toolPrefix = config.settings?.toolPrefix || "server";

  if (!Object.keys(servers).length) {
    console.log("[MCP] No servers configured (create ~/.pi/agent/mcp.json)");
    return;
  }

  // Connect to all configured servers
  for (const [name, cfg] of Object.entries(servers)) {
    try {
      await connect(name, cfg);
    } catch (e) {
      console.error(`[MCP] ${name} failed:`, e);
    }
  }

  // Register tools for each connection
  for (const [serverName, conn] of connections) {
    const prefix = getPrefix(serverName, toolPrefix);

    for (const tool of conn.tools) {
      const toolName = tool.name;
      const connection = conn;

      // Register each MCP tool as a pi tool
      pi.registerTool(defineTool({
        name: `${prefix}_${toolName}`,
        label: `MCP: ${toolName}`,
        description: tool.description || "",
        parameters: buildSchema(tool.inputSchema),
        
        async execute(_id, params) {
          try {
            // Call the MCP tool via JSON-RPC
            const result: any = await sendRequest(connection, "tools/call", {
              name: toolName,
              arguments: params,
            });
            
            // Extract text content from MCP response
            const content = result.content?.[0]?.text || JSON.stringify(result, null, 2);
            return { content: [{ type: "text", text: content }], details: {} };
          } catch (e: any) {
            return { 
              content: [{ type: "text", text: `Error: ${e.message}` }], 
              details: { error: true } 
            };
          }
        },
      }));
    }
  }

  console.log(`[MCP] Ready (${connections.size} servers)`);

  // Cleanup on session end
  pi.on("session_shutdown", () => {
    for (const conn of connections.values()) {
      conn.process.kill();
    }
    connections.clear();
  });
}
