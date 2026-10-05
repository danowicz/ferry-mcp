# Installing Ferry — instructions for coding agents

You are installing **Ferry**, an MCP server that builds animated presentations of code changes. Run each step yourself, fix what you can, and stop to ask the user only when a step needs their decision. Keep the user informed in one or two sentences per step.

## 1. Check the prerequisites

```sh
node --version   # must be ≥ 22.18 — Ferry runs its TypeScript directly
git --version
```

If Node is missing or older than 22.18, stop and tell the user how to upgrade with the tool they already use (`brew upgrade node`, `nvm install 22`, `fnm install 22`, `volta install node@22`, or <https://nodejs.org>). Don't switch version managers on your own.

## 2. Get the code

Install into `~/.ferry-mcp` unless the user asked for another directory.

```sh
if [ -d ~/.ferry-mcp/.git ]; then git -C ~/.ferry-mcp pull --ff-only; else git clone https://github.com/danowicz/ferry-mcp.git ~/.ferry-mcp; fi
cd ~/.ferry-mcp && npm install
```

## 3. Verify

```sh
cd ~/.ferry-mcp && npm test
```

This runs every tool end to end in a temporary directory (about 20 seconds) and should finish with `All checks passed`. If it fails, show the user the failing check.

## 4. Register Ferry with the user's MCP client

Get the absolute paths first; MCP clients don't expand `~`:

```sh
echo "$HOME/.ferry-mcp/bin/ferry.js"
command -v node
```

Register Ferry with the client you are running in, plus any others the user names. Merge into existing config files; never remove other servers.

| Client | How |
| --- | --- |
| Claude Code | `claude mcp add ferry --scope user -- node /ABS/PATH/.ferry-mcp/bin/ferry.js` |
| Codex CLI | Add to `~/.codex/config.toml`:<br>`[mcp_servers.ferry]`<br>`command = "node"`<br>`args = ["/ABS/PATH/.ferry-mcp/bin/ferry.js"]` |
| Cursor | Add to `mcpServers` in `~/.cursor/mcp.json` (JSON below) |
| Claude Desktop | Add to `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| VS Code | Add to `servers` in the user `mcp.json` (*MCP: Open User Configuration*) |
| Anything else | The client's MCP config, using the JSON below |

```json
{
  "mcpServers": {
    "ferry": { "command": "node", "args": ["/ABS/PATH/.ferry-mcp/bin/ferry.js"] }
  }
}
```

GUI apps such as Claude Desktop often don't inherit the shell's `PATH`. When Node comes from nvm, fnm, volta, or asdf, use the absolute path from `command -v node` as `command`.

## 5. Hand over

Tell the user:

- Ferry is installed at `~/.ferry-mcp`, and which clients you registered it with.
- They need to restart or reload those clients before the `ferry` tools appear.
- To try it, open any git repository with a branch or uncommitted changes and ask: **"Explain the changes on this branch with a Ferry presentation."**
- The viewer runs at <http://localhost:4747>. Decks are saved in `~/.ferry/decks`.
- To update later: `git -C ~/.ferry-mcp pull && npm install --prefix ~/.ferry-mcp`.
