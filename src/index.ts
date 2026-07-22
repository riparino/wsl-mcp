#!/usr/bin/env node

/**
 * MCP server for Windows Subsystem for Linux (WSL)
 *
 * Provides tools for interacting with WSL distributions from Claude Desktop
 * on Windows: running commands, reading/writing files, and inspecting distros.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────────────────

const WSL_EXE = "wsl.exe";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB guard

// ─── Types ────────────────────────────────────────────────────────────────────

interface WslDistro {
  name: string;
  state: "Running" | "Stopped" | string;
  version: number;
  isDefault: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface DirectoryEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  permissions: string;
  size: number;
  modified: string;
}

// ─── WSL output parsing ───────────────────────────────────────────────────────

/**
 * Parse the output of `wsl.exe --list --verbose`.
 *
 * WSL can emit UTF-16 LE (with BOM) or plain UTF-8 depending on the Windows
 * version. We strip null bytes to normalise both encodings, then parse the
 * fixed-width columns.
 *
 * Example output (after stripping):
 *   NAME                   STATE           VERSION
 * * Ubuntu                 Running         2
 *   Debian                 Stopped         2
 */
function parseWslListVerbose(raw: string): WslDistro[] {
  // Normalise: strip null bytes (UTF-16 artefacts), then CRLF → LF.
  const text = raw.replace(/\0/g, "").replace(/\r/g, "");
  const lines = text.split("\n");

  const distros: WslDistro[] = [];

  for (const line of lines) {
    // Skip the header row and blank lines.
    if (!line.trim() || /^\s*NAME\s+STATE/i.test(line)) continue;

    const isDefault = line.startsWith("*");
    // Remove the leading asterisk (or spaces) used for the default marker.
    const body = line.replace(/^\*?\s+/, "");

    // Columns are separated by 2+ spaces.
    const parts = body
      .split(/\s{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length < 3) continue;

    const [name, state, versionStr] = parts;
    const version = parseInt(versionStr, 10);

    if (!name || isNaN(version)) continue;

    distros.push({ name, state, version, isDefault });
  }

  return distros;
}

// ─── Core WSL helpers ─────────────────────────────────────────────────────────

/** Fetch the list of installed WSL distributions. */
async function getDistros(): Promise<WslDistro[]> {
  try {
    // Use a buffer so we can handle both UTF-8 and UTF-16 LE.
    const { stdout } = await execFileAsync(WSL_EXE, ["--list", "--verbose"], {
      timeout: 10_000,
      encoding: "utf8",
    });
    return parseWslListVerbose(stdout);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list WSL distributions: ${msg}. Ensure WSL 2 is installed (run: wsl --install).`
    );
  }
}

/**
 * Resolve a distro name to its canonical form.
 *
 * If no name is supplied, returns the default distribution. Throws a clear
 * McpError if the requested distro cannot be found.
 */
async function resolveDistro(distroName?: string): Promise<string> {
  const distros = await getDistros();

  if (distroName) {
    const match = distros.find(
      (d) => d.name.toLowerCase() === distroName.toLowerCase()
    );
    if (!match) {
      const available = distros.map((d) => d.name).join(", ");
      throw new McpError(
        ErrorCode.InvalidParams,
        `WSL distribution "${distroName}" not found. Available: ${available || "none"}`
      );
    }
    return match.name;
  }

  const defaultDistro = distros.find((d) => d.isDefault);
  if (!defaultDistro) {
    throw new McpError(
      ErrorCode.InternalError,
      "No default WSL distribution is configured. Install one with: wsl --install"
    );
  }
  return defaultDistro.name;
}

// Matches any command that contains a sudo invocation.
// Used to redirect callers to run_privileged_command instead of hanging on a password prompt.
const SUDO_PATTERN = /(?:^|[;&|`\s])sudo\s/;

/**
 * Run a bash command inside a WSL distribution.
 *
 * Captures stdout, stderr, and the exit code. Enforces a timeout and a
 * maximum output size to prevent runaway processes from overwhelming the host.
 *
 * Pass `runAsRoot: true` to run as the root user (via `wsl.exe --user root`).
 * This should only be called after the user has explicitly confirmed the operation.
 */
async function runWslCommand(
  distro: string,
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  runAsRoot = false
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const wslArgs = runAsRoot
      ? ["--distribution", distro, "--user", "root", "--", "bash", "-c", command]
      : ["--distribution", distro, "--", "bash", "-c", command];
    const proc = spawn(WSL_EXE, wslArgs);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    function settle(result: CommandResult | McpError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof McpError) {
        reject(result);
      } else {
        resolve(result);
      }
    }

    // Timeout guard
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      settle(
        new McpError(
          ErrorCode.InternalError,
          `Command timed out after ${timeoutMs}ms. Use the timeout_ms parameter to increase the limit.`
        )
      );
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        proc.kill("SIGKILL");
        settle(
          new McpError(
            ErrorCode.InternalError,
            `Output exceeded the ${MAX_OUTPUT_BYTES / 1024 / 1024} MB limit.`
          )
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle(
          new McpError(
            ErrorCode.InternalError,
            "wsl.exe not found. Ensure WSL is installed on this Windows machine."
          )
        );
      } else {
        settle(
          new McpError(ErrorCode.InternalError, `Failed to spawn wsl.exe: ${err.message}`)
        );
      }
    });

    proc.on("close", (code: number | null) => {
      settle({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? -1,
      });
    });
  });
}

/**
 * Write content to a file inside WSL by piping to bash's stdin.
 *
 * Using stdin avoids all shell-quoting issues with arbitrary file content.
 */
async function writeFileViaStdin(
  distro: string,
  path: string,
  content: string
): Promise<void> {
  const escapedPath = shellEscape(path);

  return new Promise((resolve, reject) => {
    const proc = spawn(WSL_EXE, [
      "--distribution",
      distro,
      "--",
      "bash",
      "-c",
      `cat > ${escapedPath}`,
    ]);

    const stderrChunks: Buffer[] = [];
    let settled = false;

    function settle(err?: McpError) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    }

    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("error", (err: Error) => {
      settle(new McpError(ErrorCode.InternalError, `Failed to write file: ${err.message}`));
    });

    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        settle(
          new McpError(
            ErrorCode.InternalError,
            `Failed to write file (exit ${code}): ${stderr || "unknown error"}`
          )
        );
      } else {
        settle();
      }
    });

    proc.stdin.write(content, "utf8");
    proc.stdin.end();
  });
}

// ─── Shell quoting ────────────────────────────────────────────────────────────

/** POSIX single-quote escape a path for use in bash -c strings. */
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// ─── Directory listing ────────────────────────────────────────────────────────

/**
 * Parse the output of `ls -la --color=never` into structured entries.
 *
 * Example line:
 *   -rw-r--r-- 1 user group 1234 Jan 01 12:00 filename.txt
 *   drwxr-xr-x 2 user group 4096 Jan 01 12:00 dirname
 */
function parseLsOutput(raw: string): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    // Skip totals line and blank lines.
    if (!trimmed || trimmed.startsWith("total ")) continue;

    // ls -la columns: permissions links owner group size month day time/year name
    const match = trimmed.match(
      /^([dlcbps-][rwxXsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/
    );

    if (!match) continue;

    const [, perms, sizeStr, modified, name] = match;

    // Determine type from the leading character of the permission string.
    let type: DirectoryEntry["type"];
    switch (perms[0]) {
      case "d":
        type = "directory";
        break;
      case "l":
        type = "symlink";
        break;
      case "-":
        type = "file";
        break;
      default:
        type = "other";
    }

    entries.push({
      name,
      type,
      permissions: perms,
      size: parseInt(sizeStr, 10),
      modified,
    });
  }

  return entries;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_distros",
    description:
      "List all installed WSL distributions and their current state. " +
      "Shows each distribution's name, whether it is Running or Stopped, " +
      "its WSL version (1 or 2), and which one is the default. " +
      "Use this to discover available distributions before running commands.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: "run_command",
    description:
      "Execute a shell command inside a WSL distribution as the default (unprivileged) user. " +
      "Returns stdout, stderr, and the exit code. " +
      "Do NOT include 'sudo' in the command — it will hang waiting for a password that cannot " +
      "be supplied. For operations that require root access use run_privileged_command instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description:
            "The bash command to execute (passed to `bash -c`). " +
            "Must not contain 'sudo'. " +
            "Complex commands with pipes, redirections, and multi-line scripts are all supported.",
        },
        distro: {
          type: "string",
          description:
            "Name of the WSL distribution to run the command in " +
            "(e.g. 'Ubuntu', 'Debian'). Defaults to the system default distribution.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Maximum execution time in milliseconds before the command is killed. " +
            "Defaults to 30000 (30 seconds). Increase for long-running operations.",
          default: DEFAULT_TIMEOUT_MS,
        },
      },
      required: ["command"],
    },
  },
  {
    name: "run_privileged_command",
    description:
      "⚠️  ELEVATED — runs as root (via `wsl.exe --user root`). " +
      "IMPORTANT: Before calling this tool you MUST show the user the exact command that will " +
      "be executed and ask for explicit confirmation. Only call it once the user has confirmed. " +
      "Use this instead of sudo — do not include 'sudo' in the command string. " +
      "Examples of operations that require this tool: apt install, systemctl, " +
      "editing /etc files, chown/chmod on system paths, mounting filesystems.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description:
            "The bash command to run as root (passed to `bash -c`). " +
            "Do not prefix with 'sudo' — the command already runs as root.",
        },
        distro: {
          type: "string",
          description:
            "Name of the WSL distribution. Defaults to the system default distribution.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Maximum execution time in milliseconds. Defaults to 30000 (30 seconds).",
          default: DEFAULT_TIMEOUT_MS,
        },
        reason: {
          type: "string",
          description:
            "Brief explanation of why root access is needed, shown alongside the confirmation " +
            "prompt. E.g. 'install nginx via apt' or 'edit /etc/hosts'.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file from the WSL filesystem. " +
      "Returns the file content as a UTF-8 string. " +
      "Supports any text file accessible to the default WSL user. " +
      "For binary files, consider piping through `base64` using run_command instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the file within the WSL filesystem, " +
            "e.g. '/home/user/project/main.py' or '/etc/hosts'.",
        },
        distro: {
          type: "string",
          description:
            "Name of the WSL distribution that contains the file. " +
            "Defaults to the system default distribution.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write or overwrite a file in the WSL filesystem with the provided content. " +
      "Creates the file if it does not exist; overwrites it if it does. " +
      "The parent directory must already exist. " +
      "Use run_command with `mkdir -p` to create missing directories first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path where the file should be written within the WSL filesystem, " +
            "e.g. '/home/user/project/script.sh'.",
        },
        content: {
          type: "string",
          description: "The UTF-8 text content to write to the file.",
        },
        distro: {
          type: "string",
          description:
            "Name of the WSL distribution. Defaults to the system default distribution.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description:
      "List the contents of a directory in the WSL filesystem. " +
      "Returns each entry with its name, type (file, directory, symlink), " +
      "Unix permissions, size in bytes, and last-modified timestamp. " +
      "Equivalent to running `ls -la` in the target directory.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the directory to list within the WSL filesystem, " +
            "e.g. '/home/user' or '/var/log'.",
        },
        distro: {
          type: "string",
          description:
            "Name of the WSL distribution. Defaults to the system default distribution.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_distro_info",
    description:
      "Get detailed information about a specific WSL distribution. " +
      "Returns the WSL version, running state, current user identity, " +
      "Linux kernel version, and OS release details (distro name, version, etc.). " +
      "Useful for understanding the environment before running commands.",
    inputSchema: {
      type: "object" as const,
      properties: {
        distro: {
          type: "string",
          description:
            "Name of the WSL distribution to inspect (e.g. 'Ubuntu', 'Debian'). " +
            "Defaults to the system default distribution.",
        },
      },
      required: [] as string[],
    },
  },
] as const;

// ─── Argument helpers ─────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

function requireString(args: ToolArgs, key: string): string {
  const val = args[key];
  if (typeof val !== "string" || val.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `"${key}" must be a non-empty string`);
  }
  return val;
}

function optionalString(args: ToolArgs, key: string): string | undefined {
  const val = args[key];
  if (val === undefined || val === null || val === "") return undefined;
  if (typeof val !== "string") {
    throw new McpError(ErrorCode.InvalidParams, `"${key}" must be a string`);
  }
  return val;
}

function optionalNumber(args: ToolArgs, key: string, fallback: number): number {
  const val = args[key];
  if (val === undefined || val === null) return fallback;
  if (typeof val !== "number" || !isFinite(val) || val <= 0) {
    throw new McpError(ErrorCode.InvalidParams, `"${key}" must be a positive number`);
  }
  return val;
}

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "server-wsl",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as ToolArgs;

  switch (name) {
    // ── list_distros ──────────────────────────────────────────────────────────
    case "list_distros": {
      const distros = await getDistros();

      if (distros.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No WSL distributions are installed.\n\n" +
                "Install one with: wsl --install\n" +
                "Or install a specific distro: wsl --install -d Ubuntu",
            },
          ],
        };
      }

      const lines = distros.map((d) => {
        const marker = d.isDefault ? "* " : "  ";
        const badge = d.isDefault ? " [default]" : "";
        return `${marker}${d.name} — ${d.state} — WSL ${d.version}${badge}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Installed WSL distributions (* = default):\n\n${lines.join("\n")}`,
          },
        ],
      };
    }

    // ── run_command ───────────────────────────────────────────────────────────
    case "run_command": {
      const command = requireString(args, "command");
      const distroName = optionalString(args, "distro");
      const timeoutMs = optionalNumber(args, "timeout_ms", DEFAULT_TIMEOUT_MS);

      // Guard: sudo would block waiting for a password that can never arrive.
      // Redirect the caller to run_privileged_command instead.
      if (SUDO_PATTERN.test(command)) {
        // Strip leading sudo so the suggestion is ready to paste
        const stripped = command.replace(/(?:^|\s)sudo\s+/g, " ").trim();
        return {
          content: [
            {
              type: "text",
              text:
                "Command contains 'sudo', which cannot be used here because there is no " +
                "interactive terminal to supply a password.\n\n" +
                "To run commands that require root access:\n" +
                "1. Remove 'sudo' from the command.\n" +
                "2. Use the run_privileged_command tool instead — it runs as root directly " +
                "via `wsl.exe --user root`.\n\n" +
                "Suggested call: run_privileged_command({ command: " +
                JSON.stringify(stripped) +
                " })",
            },
          ],
          isError: true,
        };
      }

      const distro = await resolveDistro(distroName);
      const result = await runWslCommand(distro, command, timeoutMs);

      const parts: string[] = [
        `Distribution: ${distro}`,
        `Exit code: ${result.exitCode}`,
      ];
      if (result.stdout) parts.push(`\nStdout:\n${result.stdout.trimEnd()}`);
      if (result.stderr) parts.push(`\nStderr:\n${result.stderr.trimEnd()}`);

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        isError: result.exitCode !== 0,
      };
    }

    // ── run_privileged_command ────────────────────────────────────────────────
    case "run_privileged_command": {
      const command = requireString(args, "command");
      const distroName = optionalString(args, "distro");
      const timeoutMs = optionalNumber(args, "timeout_ms", DEFAULT_TIMEOUT_MS);
      const reason = optionalString(args, "reason");

      // Guard: if sudo slipped in anyway, strip it — we're already root.
      const effectiveCommand = command.replace(/(?:^|\s)sudo\s+/g, " ").trim();

      const distro = await resolveDistro(distroName);
      const result = await runWslCommand(distro, effectiveCommand, timeoutMs, true);

      const parts: string[] = [
        "⚠️  Executed as root",
        `Distribution: ${distro}`,
        ...(reason ? [`Reason: ${reason}`] : []),
        `Command: ${effectiveCommand}`,
        `Exit code: ${result.exitCode}`,
      ];
      if (result.stdout) parts.push(`\nStdout:\n${result.stdout.trimEnd()}`);
      if (result.stderr) parts.push(`\nStderr:\n${result.stderr.trimEnd()}`);

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        isError: result.exitCode !== 0,
      };
    }

    // ── read_file ─────────────────────────────────────────────────────────────
    case "read_file": {
      const path = requireString(args, "path");
      const distroName = optionalString(args, "distro");

      const distro = await resolveDistro(distroName);
      const result = await runWslCommand(distro, `cat ${shellEscape(path)}`);

      if (result.exitCode !== 0) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read "${path}": ${result.stderr.trim() || "file not found or permission denied"}`
        );
      }

      return {
        content: [{ type: "text", text: result.stdout }],
      };
    }

    // ── write_file ────────────────────────────────────────────────────────────
    case "write_file": {
      const path = requireString(args, "path");
      const content = args.content;
      const distroName = optionalString(args, "distro");

      if (typeof content !== "string") {
        throw new McpError(ErrorCode.InvalidParams, '"content" must be a string');
      }

      const distro = await resolveDistro(distroName);
      await writeFileViaStdin(distro, path, content);

      const byteCount = Buffer.byteLength(content, "utf8");
      return {
        content: [
          {
            type: "text",
            text: `Wrote ${byteCount.toLocaleString()} bytes to ${path} in ${distro}`,
          },
        ],
      };
    }

    // ── list_directory ────────────────────────────────────────────────────────
    case "list_directory": {
      const path = requireString(args, "path");
      const distroName = optionalString(args, "distro");

      const distro = await resolveDistro(distroName);
      const result = await runWslCommand(
        distro,
        `ls -la --color=never ${shellEscape(path)}`
      );

      if (result.exitCode !== 0) {
        throw new McpError(
          ErrorCode.InternalError,
          `Cannot list "${path}": ${result.stderr.trim() || "directory not found or permission denied"}`
        );
      }

      const entries = parseLsOutput(result.stdout);

      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: `${path} is empty` }],
        };
      }

      // Format as an aligned table.
      const rows = entries.map((e) => {
        const typeChar = e.type === "directory" ? "/" : e.type === "symlink" ? "@" : "";
        const sizeStr = e.type === "directory" ? "     -" : e.size.toLocaleString().padStart(6);
        return `${e.permissions}  ${sizeStr}  ${e.modified}  ${e.name}${typeChar}`;
      });

      const header = `Contents of ${path} (${entries.length} entries):\n`;
      const legend = "\n[/ = directory, @ = symlink]";

      return {
        content: [
          {
            type: "text",
            text: header + rows.join("\n") + legend,
          },
        ],
      };
    }

    // ── get_distro_info ───────────────────────────────────────────────────────
    case "get_distro_info": {
      const distroName = optionalString(args, "distro");
      const distro = await resolveDistro(distroName);

      const distros = await getDistros();
      const meta = distros.find((d) => d.name === distro)!;

      // Run info commands in parallel.
      const [kernelResult, userResult, osResult] = await Promise.all([
        runWslCommand(distro, "uname -r"),
        runWslCommand(distro, "id && echo \"username=$(whoami)\""),
        runWslCommand(
          distro,
          // Pretty-print the key OS release fields.
          'grep -E "^(NAME|VERSION|PRETTY_NAME)=" /etc/os-release 2>/dev/null || echo "OS info unavailable"'
        ),
      ]);

      const sections: string[] = [
        "=== WSL Distribution Info ===",
        "",
        `Name:        ${meta.name}`,
        `State:       ${meta.state}`,
        `WSL Version: ${meta.version}`,
        `Default:     ${meta.isDefault ? "Yes" : "No"}`,
        "",
        `Kernel:      ${kernelResult.stdout.trim() || "unavailable"}`,
        "",
        "OS Release:",
        osResult.stdout.trim(),
        "",
        "Current User:",
        userResult.stdout.trim(),
      ];

      return {
        content: [{ type: "text", text: sections.join("\n") }],
      };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: "${name}"`);
  }
});

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is reserved for the MCP protocol.
  console.error("WSL MCP server running on stdio");
}

main().catch((err: unknown) => {
  console.error("Fatal error in WSL MCP server:", err);
  process.exit(1);
});
