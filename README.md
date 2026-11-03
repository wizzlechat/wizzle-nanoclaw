# wizzle-nanoclaw

Connects the Wizzle app to a NanoClaw install through the Wizzle relay.
Messages are end to end encrypted between the app and this bridge, and the
relay only forwards ciphertext. Node 22.18 or later, no dependencies.

From the app you can chat with your agents and read their history, send and
receive files, answer their questions and approval requests, and see, run,
pause or resume their scheduled tasks. You can create agents from templates,
pause, resume, restart or delete them, start topics and rooms, and clear a
chat. On a NanoClaw install that uses OneCLI you can also manage keys and
attach them to agents. Agents can send elements: JSON files the app draws as
its own screens.

## Install

```
curl -fsSL https://wizzle.app/install.sh | bash
```

The installer adds the bridge to NanoClaw, applies a small patch to NanoClaw's
core (message ids and agent pause), and shows the pairing code.

## Use

- `ncl wizzle pair` shows a one-time pairing QR code that expires after 15
  minutes. `--replace` unpairs the current app and shows a new code.
- `WIZZLE_RELAY_URL`: the relay, default `wss://relay.wizzle.app`.
- `WIZZLE_INVITE_TTL_MINUTES`: how long a pairing code lives, 1 to 1440,
  default 15.

## Test

```
npm test
```
