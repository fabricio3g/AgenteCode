# Agente Server

Agente Server is `agente serve` running headless: the same runtime Agente
Desktop and Agente Code use, kept alive so bots answer, routines run on time
and you can connect from anywhere with `agente attach`.

## Run it with Docker

```bash
export AGENTE_TOKEN=$(openssl rand -hex 32)   # keep it: clients need it
docker run -d --name agente \
  -p 127.0.0.1:7420:7420 \
  -e AGENTE_TOKEN \
  -e OPENROUTER_API_KEY \
  -v agente-data:/home/agente/.agente \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/fabricio3g/agente-server:latest
```

Or with Compose, from the repository root:

```bash
AGENTE_TOKEN=$(openssl rand -hex 32) docker compose -f docker/compose.yaml up -d
```

To build the image yourself: `docker build -f docker/Dockerfile -t agente-server .`

What the container keeps:

| Path | What |
|---|---|
| `/home/agente/.agente` (volume) | `config.json`, sessions, bots (`bots/<handle>/`), routines, the token file |
| `/workspace` | the project folder the agent works in |

## Models

Give the container the API key of each provider you use, as an environment
variable: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`DEEPSEEK_API_KEY`, `GROQ_API_KEY`, and so on. To choose the default model,
put a `config.json` in the volume:

```json
{ "default_provider": "openrouter", "default_model": "anthropic/claude-sonnet-5" }
```

A bot can also pin its own model (in Desktop: Bots → Edit).

## Connect

```bash
# A bot's chat, or a session (id prefix), or the latest session
agente attach @colina --remote 127.0.0.1:7420 --token "$AGENTE_TOKEN"
```

Every client must send the token with its first message (`initialize`);
anything else is refused. Without `--token` or `AGENTE_TOKEN`, the server
makes one in `~/.agente/serve-token` (readable only by its user) and says so
when it starts.

## Bots on Telegram

A bot can answer on Telegram. In Desktop: Bots → Edit → Telegram. On a
server:

```bash
export AGENTE_TOKEN=...                 # the server's token, for --remote
R="--remote 127.0.0.1:7420"
TELEGRAM_BOT_TOKEN=123456:ABC... agente telegram connect @colina $R   # token from @BotFather
agente telegram pair @colina --full $R  # prints /pair <code> for you to send the bot
agente telegram pair @colina $R         # a read-only person (chat and search, no tools)
agente telegram status @colina $R
```

Only paired people can talk to the bot, in private chats. A code works
once, for 10 minutes. Each bot answers on its own model and within its
daily budget.

## Bot sandbox

A bot's programs (its shell commands and background processes) run in a box:
- **Files:** they write only the bot's `workspace/` and read only the system's programs and libraries, never your home folder, `~/.agente` or another bot.
- **Environment:** none of the server's keys or tokens.
- **Network:** none, unless you allow it for that bot.
- **Limits:** caps on file size and CPU time.

A boxed bot works unattended (routines, handoffs, Telegram). A bot without a box asks before each change.

On Linux the box is Landlock plus seccomp, applied by the `agente` binary itself; it needs kernel 5.13+ with Landlock enabled. Check what a server has (Desktop's bot editor also says so under Tools):

```bash
agente serve --status   # … bot sandbox: landlock (programs are boxed)
```

In Docker, the container's seccomp profile has to allow the `landlock_*` system calls. Current Docker releases do; if yours doesn't, `available` is `false` and bots fall back to asking. For a stronger wall around the whole server, run the container under gVisor (`--runtime=runsc`).

A bot's `bot.toml` can open its box a little:

```toml
[sandbox]
network = true                       # outgoing network for its programs
read = ["~/Documents/Reports"]       # extra folders it may read
write = ["~/Documents/Drafts"]       # extra folders it may write
file_mb = 1024                       # largest file it may write
cpu_secs = 600                       # CPU time per program
```

## Reaching it safely

The connection is **not encrypted**. The examples publish the port on
`127.0.0.1` only. To use it from another machine, pick one:

- **SSH tunnel:** `ssh -N -L 7420:127.0.0.1:7420 you@server`, then attach to
  `127.0.0.1:7420` as if it were local.
- **A VPN** such as WireGuard or Tailscale, publishing the port on the VPN
  address only.
- **A TLS reverse proxy** that passes raw TCP (for example Caddy's layer4 or
  nginx `stream` with `ssl_preread`).

Never publish port 7420 on a public address without one of these.

## Without Docker

```bash
agente serve --listen 127.0.0.1:7420            # token from ~/.agente/serve-token
AGENTE_TOKEN=... agente serve --listen 0.0.0.0:7420
agente serve --status                            # is it running?
```

`agente serve` stops cleanly on Ctrl-C or SIGTERM. It also keeps serving
the local socket (`$XDG_RUNTIME_DIR/agente/agente.sock`, or a named pipe on
Windows), which is how Desktop and a local `agente attach` connect.
