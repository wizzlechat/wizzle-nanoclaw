# wizzle-nanoclaw

Connects one Wizzle app to a NanoClaw install through the Wizzle relay. Node
22.18 or later, no dependencies.

- `src/`: the bridge core (protocol, relay connection, pairing). It knows
  nothing about NanoClaw; `wizzle-openclaw` uses it too.
- `nanoclaw/`: the NanoClaw adapter and the agents' element and room skills,
  shipped in the NanoClaw fork as the `add-wizzle` skill.

## Files

| File | What it does |
| --- | --- |
| `src/bridge.ts` | `WizzleBridge`: app packets to `BridgeHost` calls, runtime output to packets; capabilities follow the host's methods |
| `src/pairing.ts` | `PairingManager`: one-time invites, pinning the app, expiry, `unpair()` |
| `src/relay-client.ts` | One relay connection: handshake, encryption, outbox, reconnect |
| `src/store.ts` | `pairing.json`, `session.json`, `invite.txt` (0600, atomic writes flushed to disk) |
| `src/history.ts` | NanoClaw mailbox rows to chat history; a room's history merges its member sessions |
| `src/rooms.ts` | Room ids and `RoomRouter`: fans messages out to member channels, flags mentions, caps handoffs |
| `src/qr.ts` | QR encoder for the invite in the terminal |
| `src/transport.ts` | Socket wrapper, so tests run against `test/fake-relay.ts` |
| `nanoclaw/wizzle.ts` | The NanoClaw adapter; compiles only in the fork |
| `nanoclaw/skills/wizzle-elements/` | Teaches agents to send element files (`AGENT-UI.md`) |
| `nanoclaw/skills/wizzle-rooms/` | Teaches agents how to hand off and when to stop in a room |

## Use

- `ncl wizzle pair [--replace]` prints the pairing QR and writes the invite to
  `data/wizzle/invite.txt`.
- `WIZZLE_RELAY_URL`: default `wss://relay.wizzle.app`; `ws://` only for
  localhost.
- `WIZZLE_INVITE_TTL_MINUTES`: 1 to 1440, default 15.

## In the fork

The payload is in the fork's `.claude/skills/add-wizzle` and installed into
`src/channels/`; the fork holds both copies, so update both.

| Here | In the fork |
| --- | --- |
| `nanoclaw/wizzle.ts` | `src/channels/wizzle.ts` |
| `src/`, `test/` | `src/channels/wizzle-adapter/` |
| `../wizzle-protocol/src` and tests | `src/channels/wizzle-adapter/protocol/` |
| `nanoclaw/skills/wizzle-elements/` | `container/skills/wizzle-elements/` |
| `nanoclaw/skills/wizzle-rooms/` | `container/skills/wizzle-rooms/` |

The copy rewrites `.ts` imports to `.js` and `node:test` to `vitest`. Seven more
suites (`src/channels/wizzle-*.test.ts`) exist only in the fork because they
need its database and CLI.

Two core patches make live and history message ids match: the mailbox history
reads include the row `id`, and delivery passes the `messages_out` id to the
adapter. Without them the adapter falls back to generated ids.

## Rooms

A room `wizzle:room:<roomId>` is one channel per member,
`wizzle:room:<roomId>:<agentGroupId>`, wired `engage_mode` `mention`,
`ignored_message_policy` `accumulate` and `session_mode` `shared`, so each
member has its own session. Rooms live in the host DB only: members are the
wired member channels, the title is their name. `data/wizzle/rooms/<roomId>.json`
keeps what members that left or were deleted saw, so the history keeps it.

- The owner's message goes to every member channel under one id; only the
  members it names (or `@all`) wake.
- An agent's message shows in the room under its speaker, then goes to every
  other member under its `messages_out` id with sender id
  `wizzle-agent:<agentGroupId>`. A delivery without an id is not passed on.
- After 6 agent to agent wakes without an owner message the next named members
  are held (`room_hold`); Continue wakes them, and an owner message starts
  the count again.
- On create, clear and every member change each member gets a note (no wake)
  listing the members and their handles; history leaves notes out.

## Checks

```
npm test
../wizzle/node_modules/.bin/tsc -p tsconfig.json --typeRoots ../wizzle/node_modules/@types
```
