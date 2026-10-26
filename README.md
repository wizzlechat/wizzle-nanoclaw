# wizzle-nanoclaw

The NanoClaw side of wizzle: a channel adapter that pairs one phone to a
NanoClaw install through the wizzle relay. Zero dependencies beyond Node 22
(global `WebSocket`, `node:crypto`).

## Layout

- `src/relay-client.ts`: one relay connection per pairing. Sends `hello`,
  reconnects with backoff, runs the handshake, seals packets, keeps an outbox
  of unacked frames and resends it after every reconnect and whenever the
  relay reports the phone back online (the phone drops repeats). Session
  state is persisted before a frame leaves so a crash never reuses a nonce.
  Once a phone is pinned it says `hello` with the paired relay secret, falls
  back to the invite's secret when the relay refuses it, and sends `rekey`
  whenever it is attached with the invite's secret. `revoke()` makes the
  relay forget the pairing.
- `src/pairing.ts`: the pairing lifecycle (`PairingManager`). Issues one-time
  invites with a fresh static key and an expiry, pins the first phone that
  completes a handshake, revokes an invite nobody scanned in time, forgets the
  pairing when the phone removes the bridge, and resumes all of it from disk.
  Also `isRelayUrl`, `inviteText` (the QR plus the URL), `DEFAULT_RELAY_URL`.
- `src/bridge.ts`: runtime agnostic core. Takes a `BridgeHost` (how to list
  agents, read history, read activity, render a question, create an agent)
  and `BridgeHooks` (how to hand a phone message or an answer to the runtime).
  Maps runtime output (`deliver`) to protocol packets and phone packets to host
  calls. Fixed `wizzle:system` System conversation for host initiated cards
  such as approvals. A conversation wired after the last catalog was sent is
  announced to the phone before its first message.
- `src/store.ts`: `pairing.json` (relay, pairing id, secret, the bridge's
  static key pair, the invite expiry, the pinned phone key), `session.json`,
  and the pending `invite.txt` under a 0700 directory, 0600 files, atomic
  writes. A `pairing.json` from before static keys reads as no pairing.
- `src/qr.ts`: dependency free QR encoder (byte mode, versions 1 to 10,
  levels L and M) used to print the pairing invite in the terminal. Verified
  bit exact against `qrencode` in `test/qr.test.ts` when that binary exists.
- `src/transport.ts`: socket abstraction so tests can run against an in
  process relay (`test/fake-relay.ts`).
- `nanoclaw/wizzle.ts`: the fork shaped adapter. Written with `.js` import
  suffixes against NanoClaw internals; it does not compile in this folder.
  See "In the fork".

## Behavior

- Config: `WIZZLE_RELAY_URL` (env or `.env`), defaulting to
  `wss://relay.wizzle.app`. It must be `wss://`; `ws://` is accepted only for
  localhost or 127.0.0.1. Anything else means the factory returns null and
  NanoClaw skips the channel with a warning. `WIZZLE_INVITE_TTL_MINUTES`
  (1 to 1440, default 15) sets how long an unscanned invite lives.
- Pairing: `ncl wizzle pair` (host only, hidden from agents) creates a pairing
  and prints a QR code plus the `wizzle://pair?...` invite in the operator's
  terminal; the same text goes to `data/wizzle/invite.txt` and stdout. With a
  phone paired it refuses; `ncl wizzle pair --replace` revokes that phone at
  the relay first. The first phone to complete a handshake is pinned, the relay
  is told to swap the invite's secret for the paired one, and the invite file
  is removed. An invite nobody scans is revoked at expiry and forgotten. When
  the phone removes the bridge the relay sends `revoked` and the bridge forgets
  the pairing. Nothing pairs at startup on its own: a restart resumes a paired
  phone, re-announces a pending invite, or drops an expired one.
- The bridge dials the configured relay URL. When it differs from the one the
  phone paired with it logs a warning, since the phone has to pair again.
- Each agent group's conversation is the wizzle messaging group wired to it.
  NanoClaw's channel setup wires `wizzle:phone` to the first agent (the skill
  resolves `owner_handle` as `owner` and `platform_id` as `wizzle:phone`).
  Agents without a wiring get one at adapter setup, created with the same host
  commands the CLI uses (`messaging-groups-create`, `wirings-create`):
  platform id `wizzle:agent:<agentGroupId>`, instance `wizzle`, name `Phone`.
  The owner user is `wizzle:owner`.
- Topics: an agent can hold more conversations than its default one. A topic is
  another wizzle messaging group, platform id
  `wizzle:agent:<agentGroupId>:<slug>`, wired to the same agent with
  `session_mode: 'shared'` and threads off, so NanoClaw keys a session per
  messaging group and the topic gets its own context. The slug is the title
  lowercased with every run of other characters turned into `-`, trimmed, cut to
  40 characters, then `-2` to `-9` on a collision; the whole id stays under 200
  characters. `create_conversation`, `rename_conversation` and
  `delete_conversation` reach the host's `createConversation`,
  `renameConversation` and `deleteConversation`; `listConversations` reports
  the default first. A rename changes the group name only, never the id. Delete
  removes the session, then the wirings, then the group, in that order, since
  the schema has foreign keys on and no cascade. The default conversation and
  `wizzle:system` cannot be renamed or deleted.
- Inbound phone messages become `chat` inbound messages with
  `{ text, sender: 'Phone', senderId: 'wizzle:owner', msgId }` and base64
  attachments that NanoClaw stages into the session inbox. `msgId` is the
  phone's own id for the message, 1 to 64 characters of `[A-Za-z0-9_-]`;
  anything else is refused with `bad_request`.
- Outbound: text and markdown become `message`, `ask_question` becomes
  `question` (rendered through the question render registry), edits with a
  terminal card become `edit` plus `question_resolved`, reactions and cards
  pass through, files become `file` packets with the bytes as the body.
  Files above 16 MiB are replaced by a note. The `messages_out` row id
  (`OutboundMessage.id`, passed by the fork's core) is the packet's `msgId`;
  the files of one row get `<id>:f<index>`. Without an id the bridge makes a
  UUID, so a live message and its history row share one id only with the
  patched core.
- Push wake: after `deliver` emitted a `message`, `question`, `card` or
  `file`, and after `notify`, the bridge sends the relay one `wake` control
  message per pairing whose phone is offline; the relay turns it into a push.
  While the relay is not attached the wake is held and sent after the next
  `welcome` if the phone is still offline. Never for edits, reactions,
  `question_resolved`, activity, catalog or history replies, or errors.
- Typing: activity packets (`thinking` or `tool` with the current tool from
  the mailbox container state) only while a reply is pending and a phone is
  online, deduplicated against what actually reached the phone. A pending
  check after the mailbox read drops a `thinking` that would land after the
  reply. `sync` reports activity only for replies still pending, never for an
  idle running container. Twelve seconds without a typing refresh sends
  `idle`, which covers a turn that ends with only a reaction or an edit. The
  phone clears all activity when a new connection's `hello` arrives.
- History: inbound chat plus outbound text from the session mailbox, merged
  by timestamp, capped at 200 per request. An inbound row's `msgId` is the
  `msgId` in its content (the phone's id), else the row id; an outbound row's
  is the row id, so it matches what the phone saw live. Outbound rows whose
  content has an `operation` (edits, reactions) are skipped. A core without
  the row id in its history reads falls back to the old `in-`/`out-`
  timestamp ids.
- Approvals: NanoClaw delivers approval cards as `ask_question` to the
  approver's DM, which `openDM` maps to the `wizzle:system` conversation. The phone
  sees them as `question` packets there; `answer` and `resolve` both reach
  the host's `onAction`. The protocol's `approval` packet is unused for now.
- Lifecycle: `pause_agent`, `resume_agent` and `restart_agent` reach the
  host's `pauseAgent`, `resumeAgent` and `restartAgent`, which call the fork's
  `groups-pause`, `groups-resume` and `groups-restart` (never with rebuild).
  Pause also clears the agent's open questions and approvals, since an answer
  would wake it, and the bridge closes them on the phone. A paused agent lists
  as `paused`, which wins over running and idle. A send to it is refused with
  code `paused`, and a restart with `bad_request` until it is resumed.
  `groups-restart` only reaches running containers, so a restart message for an
  idle agent is written to its default conversation and woken with reason
  `cli`. The System agent cannot be paused, restarted or deleted.
- Delete: `delete_agent` reaches `deleteAgent(agentId, removeWorkspace)`. It
  pauses the group, stops every running container (answering `busy` after 15
  seconds and resuming the group if it was running), clears pending questions
  and approvals, runs `groups-delete` (sessions, wirings, destinations), then
  deletes each wizzle messaging group of the agent left with no wiring, so a
  `wizzle:phone` shared with another agent stays. Session mailboxes are not
  erased. With `removeWorkspace`, `groups/<folder>` and
  `data/v2-sessions/<id>` are renamed to `<name>.deleted-<timestamp>`; without
  it the folder stays, so re-creating the same name lands on a suffixed folder.
  The bridge then sends `agent_deleted` and the new catalog.
- Keys: when the install's gateway is OneCLI (`configuredGatewayProviderKind()`
  is `onecli`), the host talks to OneCLI's REST API at `ONECLI_URL` with
  `ONECLI_API_KEY`, as NanoClaw's own gateway does. `secrets` lists
  `/v1/secrets` (id, name, type, host and path pattern, injection; OneCLI never
  lists a value), `create_secret`, `update_secret` and `delete_secret` reach
  `POST`, `PATCH` and `DELETE` on it, and OneCLI's refusal text reaches the
  phone as the error message. A save answers the asker with `secret` (its `ref`
  is the request id) and every phone with the new `secrets`; a delete sends
  `secret_deleted` first. `agent_secrets`, `attach_secret` and `detach_secret`
  use `/v1/agents/:id/grants`, where the OneCLI agent is the one whose
  identifier is the group id. A group only gets that agent on its first spawn,
  so attach creates it (409 means a spawn made it first) and the list of a group
  without one is empty. Attach and detach answer every phone with the agent's
  new `agent_secrets`.
- `create_agent` takes `secrets`, at most 64 ids. With OneCLI reachable, an id
  no longer in the vault is refused with `unknown_secret` before anything is
  created. After the group exists the keys are attached before onboarding, so
  the first spawn carries them. A key that does not attach, or OneCLI being down,
  never fails the create: the new agent's chat gets a system line naming the
  keys, which the phone attaches later from the agent's Keys.
- Templates: `templates` lists the installed templates (each folder of
  `templates/` with a `plugin.json`), then the public library's from
  `templates-list --registry`, which caches the index for five minutes. A
  library row carries `category`, the first part of its ref, and `downloaded`;
  a downloaded one also carries its counts. An unreachable library lists none.
  A create from a template runs `ensureTemplateLocal` first, which downloads a
  library template into `templates/<category>/<name>` and never overwrites a
  local copy, so a failed download creates nothing (`unknown_template`).
- Capabilities advertised to the phone: questions, approvals, files, history,
  clearSession, createAgent, templates, topics, lifecycle, deleteAgent, and
  keys on a OneCLI install. Not yet: streaming, tasks, abort.

## In the fork

Placed through `.claude/skills/add-wizzle` in the NanoClaw fork. The skill
payload mirrors its destinations: `src/channels/wizzle.ts` is
`nanoclaw/wizzle.ts`, `src/channels/wizzle-adapter/` is `src/*.ts` here, and
`src/channels/wizzle-adapter/protocol/` is `../wizzle-protocol/src/*.ts`, with
`.ts` import suffixes rewritten to `.js` and the protocol import pointing at
`./protocol/index.js`. `nanoclaw/skills/wizzle-elements/` is the agents' element
skill (`SKILL.md` with the format, `instructions.md` always in context); it is
copied as is to `container/skills/wizzle-elements/`. The vendored subdirectory follows the one precedent in
the repo, `src/channels/mattermost-adapter/`. The test files travel with it:
the suites in `test/` here and in `../wizzle-protocol/test/` are copied beside
the code with `test` imported from `vitest` instead of `node:test`. The skill
appends `import './wizzle.js';` to `src/channels/index.ts`, prompts for
`WIZZLE_RELAY_URL`, and captures the owner wiring constants. After a change
here, regenerate the payload the same way and copy it over the fork's
`src/channels/` files. Six suites exist only there, because they need the
fork's database and CLI resources: `src/channels/wizzle-registration.test.ts`,
`src/channels/wizzle-topics.test.ts` (ids, slugs, one session per topic, and
the default conversation being created beside an existing topic),
`src/channels/wizzle-create.test.ts` (agent creation through the real
`groups-create`, `groups-config-*` and `tasks-list` ops: name and folder
collisions, template stamping with paused tasks, copy from, timezones, and the
create serializer) and `src/channels/wizzle-lifecycle.test.ts` (pause, resume,
restart and delete through the real `groups-*` and `messaging-groups-delete`
ops: the paused status, refusals, the idle restart wake, which conversations a
delete removes, the folders moved aside, and the busy answer),
`src/channels/wizzle-clear.test.ts` (clearing a conversation and deleting a
topic) and `src/channels/wizzle-keys.test.ts` (keys against a fake OneCLI API:
the vault listing, create, update, delete, attach and detach, a create with
keys and its failure note, and library templates from a local library). All
six are listed in the skill's `nc:copy` file list.

The fork's core carries two small patches outside the payload: the mailbox
history reads (`MailboxHistoryMessage`, both `SELECT`s in
`src/mailbox/sqlite/index.ts`) include the row `id`, and delivery hands the
`messages_out` row id to the adapter as `OutboundMessage.id`
(`ChannelDeliveryAdapter.deliver` takes a trailing `messageId`, set only when
defined). The adapter works without them, with the fallbacks above.

Two facts about the fork that the adapter had to work around: there is no
`sessions-delete` CLI op, so a topic delete calls `deleteSession()` directly,
and the owner wiring created by channel setup uses the platform id
`wizzle:phone`, so the default conversation for the first agent is found by
that id and not by the `wizzle:agent:` prefix.

## Checks

`test/pairing.test.ts` drives `PairingManager` against the fake relay: a pairing
end to end with the rekey, replacing a paired phone, expiry, resuming from disk,
and the phone removing the bridge.

```
node --test test/*.test.ts
tsc -p tsconfig.json
```

`tsc` needs `typescript` and `@types/node` on its path; nothing is installed
here. `test/qr.test.ts` skips the comparison when `qrencode` is not on PATH.
