# pi-boat

`pi --boat` runs [pi](https://pi.dev)'s tools inside a [boat.dev](https://boat.dev) cloud sandbox. The agent, your models and your API keys stay on your machine. `bash`, `read`, `write`, `edit`, `ls`, `grep` and `find` run on a fresh Ubuntu VM.

Your files don't change until you say so: the agent works on a copy, and `/boat-pull` brings its changes back as a patch.

This is an unofficial extension. It is not affiliated with boat.dev.

## Install

```bash
pi install npm:pi-boat
```

You need:

- pi (tested with 1.4.0)
- the [boat CLI](https://docs.boat.dev) on your `PATH`, signed in (`boat login`)
- OpenSSH, on macOS or Linux (tested on macOS)

## Use

```bash
cd my-project
pi --boat                     # new sandbox
pi --boat --boat-type large   # small | default | large | xlarge
pi --boat -c                  # continue the last session and reattach its sandbox
```

| Command | What it does |
| --- | --- |
| `/boat` | Show the sandbox id, state, auto-stop time, and a command to open a shell in it |
| `/boat-pull` | Apply everything the agent changed to your local copy |

## How it works

1. **Start.** `boat new` creates a sandbox. In a git repository, `boat push` copies the files git tracks or does not ignore, without `.git`, to `/home/user/<project>`. That copy is committed in the sandbox and tagged `boat-base`. Outside a git repository nothing is copied, and the agent starts in an empty `/home/user/workspace`.
2. **Work.** Each tool call runs over one shared SSH connection, so a call costs a round trip, not a new handshake. `!` commands typed in pi run in the sandbox too.
3. **Pull.** `/boat-pull` diffs the sandbox against `boat-base` and applies the patch locally with `git apply`. The apply is all or nothing: on a conflict, no file is written. Then `boat-base` moves forward, so the next pull brings only newer changes.
4. **Quit.** If the sandbox has changes you have not pulled, it is left running, and pi prints how to get them back. Otherwise it is stopped. With `--no-session` it is deleted.
5. **Resume.** `pi --boat -c` finds the session's sandbox, resumes it if it stopped, and reattaches.

boat's auto-stop runs from the start time, and SSH activity does not push it back. So pi-boat extends the sandbox to one hour from now on each tool call (at most once every 10 minutes). If pi crashes, the sandbox stops about an hour after the last tool call.

## Accounts that delete on stop

If your boat account has delete-on-stop data retention on (`boat data-retention status`), stopping a sandbox erases it. pi-boat warns you about this at startup. A session can't be resumed once its sandbox has stopped, so run `/boat-pull` before it does. A sandbox left running with unpulled changes still auto-stops within about an hour.

## Safety

- With `--boat`, a tool call never falls back to your machine. If the sandbox is unavailable, the call fails.
- Your local environment variables are not sent to the sandbox.
- Like any `boat new`, the sandbox gets your boat account's default environment: its stored variables and secrets.
- Host keys are trusted on first use, per sandbox, in `~/.pi/agent/boat/`. pi-boat uses the key the boat CLI manages at `~/.ssh/ascii_box_ed25519`.

## Limitations

- The sandbox has no git history, and nothing is pushed to GitHub.
- Stopping a command (Escape or a timeout) closes its SSH channel. A process that ignores SIGHUP keeps running in the sandbox.
- A background process that keeps stdout open keeps the bash call open. Redirect its output: `npm run dev > dev.log 2>&1 &`.
- Do not combine `--boat` with `--daytona`: both replace the same tools.
- pi gives each tool name to the first extension that loads. If another extension that replaces pi's tools (such as `@daytona/pi`) loads before pi-boat, `--boat` blocks every tool call and tells you so. To fix it, list `npm:pi-boat` before that package under `"packages"` in `~/.pi/agent/settings.json`.

## Development

```bash
git clone https://github.com/bas3line/pi-boat && cd pi-boat
npm install
npm run typecheck
pi -ne -e ./index.ts --boat   # try the local copy for one run, without other extensions
```

## Credits

The approach follows pi's `examples/extensions/ssh.ts` (MIT) and [`@daytona/pi`](https://github.com/daytona/integrations/tree/main/packages/pi-extension) (Apache-2.0).

## License

MIT
