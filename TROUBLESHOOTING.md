# Debugging Log: Pi MCP Extension

This document chronicles the debugging journey that led to the final solution.

## Initial Problem

pi doesn't have built-in MCP support. The goal: add MCP server capability (playwright, brave-search) to pi, stealing config from opencode.

## Approach 1: Official pi-mcp-adapter

### Installation
```bash
pi install npm:pi-mcp-adapter
```

### Result
Failed - npm permission denied for global install.

### Workaround
```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
npm init -y
npm install pi-mcp-adapter
```

Modified `package.json` to include pi manifest:
```json
{
  "pi": {
    "extensions": ["./node_modules/pi-mcp-adapter"]
  }
}
```

### Problem
Extension not auto-loading. pi's package discovery not finding it.

## Approach 2: Custom Extension with MCP SDK

Created `~/.pi/agent/extensions/mcp/index.ts` using `@modelcontextprotocol/sdk`.

### Installation
```bash
cd ~/.pi/agent/extensions/mcp
npm init -y
npm install @modelcontextprotocol/sdk
```

### First Error
```
Error: spawn n ENOENT
```

**Cause:** Config parsing bug - `command` was an array instead of string.

**Fix:** Updated config format to use `command` + `args` separately.

### Works But...
Extension loads, tools register, but calling tools fails:

```
TypeError: v3Schema.safeParse is not a function
```

## Root Cause Analysis

### Why the Error Occurs

1. **pi bundles Zod v4** internally for its own type system
2. **MCP SDK requires Zod v3** (see `package.json`):
   ```json
   "dependencies": {
     "zod": "^3.25 || ^4.0"
   }
   ```
3. **Zod v3/v4 have incompatible APIs:**
   - Zod v3: `schema.safeParse(data)`
   - Zod v4: `safeParse(schema, data)` (different signature)
   
4. **MCP SDK's compat layer fails:**
   ```javascript
   // zod-compat.ts
   export function safeParse(schema, data) {
     if (isZ4Schema(schema)) {
       const result = z4mini.safeParse(schema, data);  // Different API!
       return result;
     }
     const v3Schema = schema;
     const result = v3Schema.safeParse(data);  // Zod v3 method
     return result;
   }
   ```

5. **The SDK calls methods that don't exist** on the installed Zod version.

### Versions Tested

| Package | Version | Result |
|---------|---------|--------|
| MCP SDK | 1.29.0 | Fails (v3Schema.safeParse) |
| MCP SDK | 0.7.0 | Fails (resultSchema.parse) |
| Zod | 3.25.76 | Fails |
| Zod | 4.3.6 | Fails |

### Why Both SDK Versions Fail

Even with matching Zod versions:
- The SDK's `setRequestHandler` expects specific schema types
- The MCP server responds with schemas that don't match expectations
- Version 0.7.0 has different protocol handling than 1.x

## Approach 3: Direct JSON-RPC (Solution)

**Key insight:** The MCP SDK is just a wrapper around JSON-RPC over stdio. We can implement the protocol directly without the SDK.

### What MCP Protocol Actually Is

```
Client                          Server
  |                               |
  |--- initialize ----------------->|
  |<-- initialize/result ----------|
  |                               |
  |--- tools/list ---------------->|
  |<-- tools/list/result ----------|
  |                               |
  |--- tools/call ---------------->|
  |     { name, arguments }       |
  |<-- tools/call/result ----------|
  |     { content }               |
```

Each message is a JSON-RPC 2.0 request/response on stdin/stdout.

### Implementation

```typescript
// Spawn server
const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

// Initialize
proc.stdin.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "pi-mcp", version: "1.0.0" }
  }
}) + "\n");

// Wait for response on stdout
```

### Result

✅ **Works perfectly!**

- Brave search returns results
- Playwright tools register and execute
- No Zod version conflicts
- Clean, minimal implementation

## Lessons Learned

1. **Don't trust SDK compat layers** - they often don't work across major versions
2. **Protocols are often simpler than libraries** - JSON-RPC over stdio is trivial
3. **Check dependency versions** - pi uses Zod v4, SDK needs v3
4. **Test incrementally** - each fix revealed new issues

## Files Modified

- `~/.pi/agent/mcp.json` - MCP server configuration
- `~/.pi/agent/extensions/mcp/index.ts` - Custom extension (final solution)

## Key Commands

```bash
# Test MCP server directly
echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}' \
  | BRAVE_API_KEY="$BRAVE_API_KEY" npx -y @modelcontextprotocol/server-brave-search

# List tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | ...

# Call tool
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"brave_web_search","arguments":{"query":"hello"}}}' | ...
```

## See Also

- [MCP Protocol Specification](https://modelcontextprotocol.io)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [pi coding agent](https://github.com/badlogic/pi-mono)
