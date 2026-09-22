# wizzle-nanoclaw

The NanoClaw side of wizzle: a channel adapter that pairs one phone to a
NanoClaw install through the wizzle relay. Zero dependencies beyond Node 22
(global `WebSocket`, `node:crypto`).

## Layout

- `src/relay-client.ts`: one relay connection per pairing. Sends `hello`,
  reconnects with backoff, runs the handshake, seals packets, keeps an outbox
  of unacked frames and resends it after every reconnect. Session state is
  persisted before a frame leaves so a crash never reuses a nonce.
- `src/bridge.ts`: runtime agnostic core. Takes a `BridgeHost` (how to list
  agents, read history, read activity, render a question, create an agent)
  and `BridgeHooks` (how to hand a phone message or an answer to the runtime).
  Maps runtime output (`deliver`) to protocol packets and phone packets to host
  calls. Fixed `wizzle:system` System conversation for host initiated cards
  such as approvals. A conversation wired after the last catalog was sent is
  announced to the phone before its first message.
- `src/store.ts`: `pairing.json`, `session.json`, and the pending
  `invite.txt` under a 0700 directory, 0600 files, atomic writes.
- `src/qr.ts`: dependency free QR encoder (byte mode, versions 1 to 10,
  levels L and M) used to print the pairing invite in the terminal. Verified
  bit exact against `qrencode` in `test/qr.test.ts` when that binary exists.
- `src/transport.ts`: socket abstraction so tests can run against an in
  process relay (`test/fake-relay.ts`).
- `nanoclaw/wizzle.ts`: the fork shaped adapter. Written with `.js` import
  suffixes against NanoClaw internals; it does not compile in this folder.
  See "In the fork".

## Behavior

- Config: `WIZZLE_RELAY_URL` (env or `.env`, must be `ws://` or `wss://`).
  Missing or invalid means the factory returns null and NanoClaw skips the
  channel with a warning.
- First start creates a pairing (`data/wizzle/pairing.json`) and writes a QR
  code plus the `wizzle://pair?...` invite to `data/wizzle/invite.txt` and to
  stdout. The invite is written again on every start until a phone has
  completed a handshake, then the file is removed.
- Each agent group's conversation is the wizzle messaging group wired to it.
  NanoClaw's channel setup wires `wizzle:phone` to the first agent (the skill
  resolves `owner_handle` as `owner` and `platform_id` as `wizzle:phone`).
  Agents without a wiring get one at adapter setup, created with the same host
  commands the CLI uses (`messaging-groups-create`, `wirings-create`):
  platform id `wizzle:agent:<agentGroupId>`, instance `wizzle`, name `Phone`.
  The owner user is `wizzle:owner`.
- Inbound phone messages become `chat` inbound messages with
  `{ text, sender: 'Phone', senderId: 'wizzle:owner' }` and base64 attachments
  that NanoClaw stages into the session inbox.
- Outbound: text and markdown become `message`, `ask_question` becomes
  `question` (rendered through the question render registry), edits with a
  terminal card become `edit` plus `question_resolved`, reactions and cards
  pass through, files become `file` packets with the bytes as the body.
  Files above 16 MiB are replaced by a note.
- Typing: activity packets (`thinking` or `tool` with the current tool from
  the mailbox container state) only while a reply is pending and a phone is
  online, deduplicated.
- History: inbound chat plus outbound text from the session mailbox, merged
  by timestamp, capped at 200 per request.
- Approvals: NanoClaw delivers approval cards as `ask_question` to the
  approver's DM, which `openDM` maps to the `wizzle:system` conversation. The phone
  sees them as `question` packets there; `answer` and `resolve` both reach
  the host's `onAction`. The protocol's `approval` packet is unused for now.
- Capabilities advertised to the phone: questions, approvals, files, history,
  createAgent. Not yet: streaming, tasks, clearSession, abort.

## In the fork

Placed through `.claude/skills/add-wizzle` in the NanoClaw fork. The skill
payload mirrors its destinations: `src/channels/wizzle.ts` is
`nanoclaw/wizzle.ts`, `src/channels/wizzle-adapter/` is `src/*.ts` here, and
`src/channels/wizzle-adapter/protocol/` is `../wizzle-protocol/src/*.ts`, with
`.ts` import suffixes rewritten to `.js` and the protocol import pointing at
`./protocol/index.js`. The vendored subdirectory follows the one precedent in
the repo, `src/channels/mattermost-adapter/`. The test files travel with it:
the suites in `test/` here and in `../wizzle-protocol/test/` are copied beside
the code with `test` imported from `vitest` instead of `node:test`. The skill
appends `import './wizzle.js';` to `src/channels/index.ts`, prompts for
`WIZZLE_RELAY_URL`, and captures the owner wiring constants. After a change
here, regenerate the payload the same way and copy it over the fork's
`src/channels/` files.

## Checks

```
node --test test/*.test.ts
tsc -p tsconfig.json
```

`tsc` needs `typescript` and `@types/node` on its path; nothing is installed
here. `test/qr.test.ts` skips the comparison when `qrencode` is not on PATH.
