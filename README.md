# @modelcontextprotocol/server-wsl

An [MCP server](https://modelcontextprotocol.io) that gives Claude Desktop full access to your Windows Subsystem for Linux (WSL) environment. Run commands, read and write files, and inspect your distributions — all from a Claude conversation on Windows.

## Prerequisites

- **Windows 10 version 2004+ or Windows 11**
- **WSL 2** installed (`wsl --install` from an admin PowerShell)
- **At least one Linux distribution** installed via the Microsoft Store or `wsl --install -d <Distro>`
- **Node.js 18 or later** (for building from source)

## Installation

### From npm (recommended)

```bash
npm install -g @modelcontextprotocol/server-wsl
```

### From source

```bash
git clone https://github.com/modelcontextprotocol/servers.git
cd servers/src/wsl
npm install
npm run build
```

## Configuration

Add the server to your Claude Desktop configuration file.

**Config file location:**
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Using npx (zero-install)

```json
{
  "mcpServers": {
    "wsl": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-wsl"]
    }
  }
}
```

### Using a globally installed package

```json
{
  "mcpServers": {
    "wsl": {
      "command": "mcp-server-wsl"
    }
  }
}
```

### Running via WSL itself (alternative)

If you prefer to run the server inside WSL, you can invoke it through `wsl.exe`:

```json
{
  "mcpServers": {
    "wsl": {
      "command": "wsl.exe",
      "args": ["node", "/path/to/wsl-mcp/dist/index.js"]
    }
  }
}
```

After editing the config, restart Claude Desktop. You should see the WSL tools appear in the Claude tool picker.

## Available Tools

| Tool | Description |
|---|---|
| `list_distros` | List all installed WSL distributions, their state (Running/Stopped), WSL version, and which is the default |
| `run_command` | Execute a bash command in a WSL distribution; returns stdout, stderr, and exit code |
| `read_file` | Read a text file from the WSL filesystem by absolute path |
| `write_file` | Write or overwrite a file in the WSL filesystem |
| `list_directory` | List directory contents with names, types, permissions, sizes, and timestamps |
| `get_distro_info` | Get detailed info about a distribution: WSL version, state, kernel, OS release, current user |

### Tool parameters

#### `run_command`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✅ | Bash command to run (passed to `bash -c`) |
| `distro` | string | | Distribution name; defaults to your default distro |
| `timeout_ms` | number | | Milliseconds before the command is killed; defaults to 30 000 |

#### `read_file`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | Absolute path within the WSL filesystem |
| `distro` | string | | Distribution name; defaults to your default distro |

#### `write_file`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | Absolute path within the WSL filesystem |
| `content` | string | ✅ | UTF-8 text content to write |
| `distro` | string | | Distribution name; defaults to your default distro |

#### `list_directory`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | Absolute path to the directory |
| `distro` | string | | Distribution name; defaults to your default distro |

#### `get_distro_info`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `distro` | string | | Distribution name; defaults to your default distro |

## Example prompts

Once connected, try asking Claude:

- *"What WSL distributions do I have installed?"*
- *"Run `df -h` in my Ubuntu distro and show me disk usage"*
- *"Read the file `/etc/hosts` from WSL"*
- *"Create a Python script at `/home/user/hello.py` that prints Hello, World"*
- *"List what's in my home directory in WSL"*
- *"What kernel version is my WSL instance running?"*

## Security considerations

- Commands execute as the **default user** of the chosen distribution (typically your regular Linux user, not root).
- There is no path sandboxing — Claude can read and write any file the WSL user has access to. Grant this MCP server only to trusted Claude conversations.
- Command output is capped at **10 MB** to prevent runaway processes from overwhelming the host.
- The default command timeout is **30 seconds**; use `timeout_ms` to increase it for long-running tasks.

## Troubleshooting

**"wsl.exe not found"**
WSL is not installed or not on the system PATH. Run `wsl --install` from an admin PowerShell.

**"No default WSL distribution is configured"**
You have WSL installed but no distribution set as default. Fix with: `wsl --set-default <DistroName>`

**Distribution shows as Stopped but commands still work**
This is expected — WSL automatically starts a stopped distribution when a command is run.

**UTF-8 output looks garbled**
Some older Windows builds emit WSL list output as UTF-16 LE. The server normalises this automatically; if you still see issues, ensure your WSL is up to date (`wsl --update`).

## License

MIT
