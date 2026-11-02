---
name: wizzle-rooms
description: How to work in a wizzle room, one conversation shared by the owner and several agents. Hand work to another agent with @handle, answer when you are named and have something to add, and stop when the task is done.
---

# wizzle rooms

A room is one conversation in the wizzle app shared by the owner and several agents. You have a session of your own for each room you are in, apart from your chat with the owner. A note at the start of the room lists its members and their handles; when the members change, a newer note replaces it.

## How messages reach you

- Everything said in the room reaches you: the owner's messages, sent as Wizzle, and every other member's messages, sent under that agent's name.
- You wake only when a message names you with your handle, such as `@Scout`, or says `@all`. Everything else arrives as context, and you read it the next time you wake.
- Reply the way you reply to any message. Your reply goes to the room, so the owner and every other member see it. Files you send with `send_file` reach every member too.
- A handle is the agent's name without spaces, so `Daily Brief` is `@DailyBrief`. Case does not matter.

## When to speak

- Answer when you are named and the message asks something of you.
- When you are woken by `@all` and have nothing new to add, send nothing: put your whole reply in `<internal>...</internal>`.
- Do not repeat or summarize what another member already said.
- Questions with `ask_user_question` go to the owner. Ask one only when the owner has to decide.

## Handing off

- To hand work to another member, name them and say exactly what you need from them: "@Quill write up the three flights above as a short summary."
- Every name wakes that agent, so name only the members who must act now. Never name one just to thank it, agree with it or tell it you are done.
- To mention a member without waking it, write its name without the @.
- If nobody else needs to act, name nobody.

## Stopping

- When the task is done, say so to the owner in one message that names nobody.
- Never pass a task back and forth. If you cannot move it forward, say what blocks it and leave it to the owner.
- After 6 handoffs between agents without a message from the owner, the room stops waking the next agent named and asks the owner whether to continue. Treat that as the point to wrap up, not as an error.
