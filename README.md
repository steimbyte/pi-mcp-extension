[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/steimerbyte)

> ⭐ If you find this useful, consider [supporting me on Ko-fi](https://ko-fi.com/steimerbyte)!

<img src="https://storage.ko-fi.com/cdn/generated/fhfuc7slzawvi/2026-04-23_rest-162bec27f642a562eb8401eb0ceb3940-onjpojl8.jpg" width="250" alt="steimerbyte" style="border-radius: 5%; margin: 16px 0; max-width: 100%;"/>

# Pi MCP Extension

Add MCP (Model Context Protocol) server support to [pi](https://github.com/badlogic/pi-mono) coding agent with minimal context overhead.

## The Problem

pi is intentionally minimal - no built-in MCP support. The official [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) package exists but suffers from **Zod version conflicts** that cause runtime errors:

```
TypeError: v3Schema.safeParse is not a function
TypeError: resultSchema.parse is not a function
```

This happens because:
1. pi bundles its own Zod version (v4)
2. MCP SDK v1.x requires Zod v3
3. The `safeParse` / `parse` methods have incompatible signatures between versions

## The Solution

This extension uses **direct JSON-RPC over stdio** - bypassing the broken MCP SDK entirely. Simple, reliable, zero dependencies on SDK internals.

## Features

- Connect to multiple MCP servers simultaneously
- Tools registered as `server_<tool_name>` for easy discovery
- Lazy connection on first tool call
- Automatic protocol negotiation
- Clean shutdown on session end

## Installation

### 1. Create extension directory

```bash
mkdir -p ~/.pi/agent/extensions/mcp
```

### 2. Copy extension

Copy [`index.ts`](index.ts) to `~/.pi/agent/extensions/mcp/index.ts`

### 3. Create config

Create `~/.pi/agent/mcp.json` with your servers:

```json
{
  "settings": {
    "toolPrefix": "server"
  },
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest",
        "--browser",
        "firefox"
      ]
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "${BRAVE_API_KEY}"
      }
    }
  }
}
```

### 4. Test

```bash
pi -p "use server_brave_web_search with query=\"hello\""
```

## Config Format

```json
{
  "settings": {
    "toolPrefix": "server"
  },
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": {
        "API_KEY": "${API_KEY}"
      }
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `toolPrefix` | Tool name prefix: `server` (default), `short` (strips `-mcp`), or `none` |
| `command` | Executable (e.g., `npx`, `node`, `/usr/bin/server`) |
| `args` | Command arguments |
| `env` | Environment variables with `${VAR}` interpolation |

## Available Tools

Each MCP tool is registered with a `server_` prefix:

| MCP Server | Example Tools |
|------------|--------------|
| playwright | `server_playwright_browser_navigate`, `server_playwright_browser_screenshot`, ... |
| brave-search | `server_brave_web_search`, `server_brave_local_search` |
| filesystem | `server_read_file`, `server_write_file`, ... |
| github | `server_search_repositories`, `server_get_file_contents`, ... |

## Usage Examples

```bash
# Web search
pi -p "use server_brave_web_search with query=\"latest news\""

# Browser automation  
pi -p "use server_playwright_browser_navigate with url=\"https://github.com\""

# List all tools
pi -p "list all tools"
```

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  pi                                                  │
│  ┌───────────────────────────────────────────────┐  │
│  │  MCP Extension (index.ts)                     │  │
│  │                                               │  │
│  │  1. Load config from ~/.pi/agent/mcp.json    │  │
│  │  2. Spawn MCP server process (stdio)         │  │
│  │  3. JSON-RPC handshake (initialize)           │  │
│  │  4. Fetch tool list (tools/list)             │  │
│  │  5. Register tools as pi tools               │  │
│  │  6. On tool call → JSON-RPC (tools/call)    │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
          │
          │ stdio (JSON-RPC)
          │
          ▼
┌─────────────────────────────────────────────────────┐
│  MCP Server (e.g., @modelcontextprotocol/server-   │
│  brave-search, @playwright/mcp)                     │
└─────────────────────────────────────────────────────┘
```

## Why No SDK?

The MCP SDK has deep Zod coupling:

```typescript
// MCP SDK internal (broken with Zod v4)
const v3Schema = schema;
const result = v3Schema.safeParse(data);  // Zod v3 method
```

pi uses Zod v4 internally, causing method conflicts. The SDK's Zod compat layer doesn't work reliably.

**Direct JSON-RPC avoids this entirely.**

## Protocol Details

The extension implements MCP's stdio protocol:

```typescript
// Initialize
{ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "pi-playwright", version: "1.0.0" }
}}

// List tools
{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {}}

// Call tool
{ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
  name: "brave_web_search",
  arguments: { query: "hello" }
}}
```

## Troubleshooting

### "MCP not connected"

Server failed to start. Check:
- Command exists (`npx`, `node`, etc.)
- Args are valid
- Environment variables are set

### Slow startup

First connection requires spawning and initializing the MCP server. Use a session to keep connections warm.

### Context overhead

Each tool name + description adds tokens. Use `toolPrefix: "none"` if you only need a few tools.

## License

MIT

## See Also

- [pi coding agent](https://github.com/badlogic/pi-mono)
- [MCP Protocol Spec](https://modelcontextprotocol.io)
- [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) - Official adapter (has Zod issues)

---

## Hinweis zur KI-Unterstützung

Bei der Entwicklung dieses Projekts wurden teilweise oder vollständig KI-gestützte Tools und Technologien eingesetzt.