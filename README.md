# pi-sub-quota

See your coding-plan quota — and your prepaid balance — right in the [pi](https://github.com/earendil-works/pi) footer. Nothing to run: while a supported provider is active, the numbers are simply there:

```
↑1.2k ↓3.4k 38%/200k                    (zai-coding-cn 13% 58%) glm-5.3 • max
↑1.2k ↓3.4k 38%/200k                 (zai-coding-cn 96% 41m 58%) glm-5.3 • max
↑960 ↓1.2k 38%/200k                      (deepseek ¥18.67+¥1.00) deepseek-flash • max
```

- The two percentages are your plan's usage windows — the 5-hour one first, then the 7-day one. Green means plenty left, amber means watch out, red means nearly gone.
- The countdown (`41m`) appears on its own when a window needs attention: it is nearly used up (≥ 80%) or about to reset (within 30 minutes). Quiet windows stay quiet and show only their percentage.
- DeepSeek has no usage windows; you see your balance instead, split into what you topped up and what was granted (`¥18.67+¥1.00`), exact to the cent. Accounts with several currencies show one balance per currency.

## Install

```bash
pi install npm:pi-sub-quota
```

Restart pi (or run `/reload`). There is nothing to configure: the extension reuses the credentials pi already stored, so the quota always belongs to the account pi is actually running with. When no supported provider is active — or there is no data yet — the footer stays exactly as pi built it.

## Commands

| Command | Effect |
| --- | --- |
| `/quota` | cached quota for every configured provider, instantly — stale numbers refresh in the background and the panel updates when they land |
| `/quota refresh` | force a re-fetch for the active provider now (at most one request per provider per minute, machine-wide, plus one immediate in-cycle retry when a request fails) |
| `/quota mode inline\|line\|off` | how — and whether — the footer shows quota |
| `/quota help` | list options |

Everything completes with Tab. `inline` is the default, and your choice is remembered across sessions; `off` restores the built-in footer.

## The two display modes

**inline** (default) — the numbers live inside the provider prefix:

```
(zai-coding-cn 96% 41m 58%)
               │   │   └ 7d window
               │   └ countdown — only while it matters
               └ 5h window
```

When the terminal gets narrow, the balance folds into a single exact total (`¥19.67`), then the quota drops away, then the prefix — your stats are never sacrificed.

**line** — a dedicated quota line under the stats, always in full detail:

```
~/dev/project (main)
↑1.2k ↓3.4k 38%/200k                            (zai-coding-cn) glm-5.3 • max
(Max) 5h ▓▓▓▓▓▓▓▓▓▓ 96% 41m · 58%
```

Every window always shows its label, meter, percentage, and reset, and the line opens with your plan tier (`(Max)`). The meters shrink automatically on narrow terminals.

## The /quota panel

`/quota` shows all configured providers at once — the active one first:

```
zai-coding-cn  coding plan · Max · active
  5h  ▓▓▓▓░░░░░░   62% left   reset 13:47
  7d  ▓▓▓▓▓░░░░░   55% left   reset Fri 15:00

deepseek  pay as you go · ¥19.67 + ¥1.00 granted · $2.50

kimi-coding  coding plan · Allegretto · booster ¥100.00/¥200.00
  5h  ▓▓▓▓▓▓▓░░░   30% left   reset 17:10
  7d  ▓░░░░░░░░░   89% left   reset Mon 00:00

/quota refresh · /quota mode line|inline|off · /quota help
```

The footer shows how much you have used; the panel shows what is left, as a meter and a percentage, with each reset as a concrete local time (`13:47` today, `Fri 15:00` this week, `Sep 01` later). The panel never waits on the network: whatever is cached renders the moment you press Enter — old numbers carry a `~`, missing ones read `fetching…` — and a second panel replaces it once the refreshed numbers land.

## Supported providers

| Provider | What you see |
| --- | --- |
| ZAI / GLM coding plans — `zai-coding-cn`, `zai-coding`, GLM and bigmodel aliases | 5h / 7d usage windows with resets, your plan tier (Lite / Pro / Max) |
| Kimi — `kimi-coding` | 5h / 7d usage windows (+ 30d monthly pool on plans that report one), membership tier (Andante / Moderato / Allegretto) from the account endpoint, and the booster wallet balance (`booster ¥5.00/¥20.00`) once topped up |
| DeepSeek — `deepseek` | prepaid balance per currency, topped-up + granted split |

Custom providers work without configuration too: detection falls back to the model's base URL host (`bigmodel.cn`, `*.z.ai` with a `/coding` path, `*.kimi.com` / `*.kimi.ai` with a `/coding` path, `*.deepseek.com`).

## Good to know

- Numbers refresh while you work — on model switches, on every agent run, and after each assistant turn, so a long-running task keeps the footer current too — but at most once every five minutes per provider; an idle session, mode `off`, and non-TUI sessions (RPC, JSON) send no requests at all.
- Each provider endpoint is asked at most once per minute, machine-wide: every attempt (even a failed one) persists its timestamp in the shared cache before the request starts, so several pi sessions keep their distance too. A failed request earns a single immediate retry inside its cycle; when a fetch keeps failing, the `/quota` panel says so on the provider's own line — never as an interrupting notification.
- A failed refresh never breaks anything: the last numbers stay, marked `~`, until the next success — and `/quota` says why a provider failed (`quota unavailable (HTTP 401)`) or when it will retry (`retry in 42s`).
- Several pi sessions on the same machine share one cache safely.
- A lapsed Kimi OAuth token is skipped with a note — it refreshes the next time pi itself calls Kimi.
- Credentials come only from pi's own store; no environment variables are read, and a key can never be sent to the wrong host.
- While quota is displayed, the footer is a re-implementation of pi's and drops a few rare markers (the virtual-model routing arrow, `xp`, `(auto)`). Everything else renders the same.

## License

MIT © 2026 Ning. See [LICENSE](LICENSE).
