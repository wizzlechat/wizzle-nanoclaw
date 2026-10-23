---
name: wizzle-elements
description: Make UI elements in the wizzle phone app, only for what a chat message cannot do, such as flash cards to flip, a deck to swipe through, or a report the user comes back to while you keep it up to date. Everything else goes in a normal markdown message.
---

# wizzle elements

An element is a JSON file you write and send with `send_file`. The wizzle phone app draws it with its own design, shows a link to it in the chat, and lists it under Elements. Elements only appear in the wizzle app; anywhere else the file is just a file.

## When to make one

Answer in a normal message by default. The chat renders markdown: headings, bold, lists, links, code and images. Make an element only when a message cannot do the job:

- the user interacts with it on the phone, such as cards to flip or a deck to swipe through;
- it needs a layout markdown cannot show;
- the user comes back to it and you keep it up to date, such as a deck they study again or a report you refresh during the day.

Never make one just to format text, a list or a link.

## Sending one

1. Write the JSON to `elements/<id>.wizzle.json` in your workspace. The file name must end in `.wizzle.json`.
2. Send it with `send_file` to the conversation you are answering, with a short `text` such as "Here is your deck".
3. To change an element, edit the same file, keep its `id`, and send it again. The phone replaces its copy, and every link to it opens the new version. Keep the file: it is your only copy.

## Format

```
{ "wizzle": 1, "id": "...", "kind": "...", "title": "...", "content": <node> }
```

- `wizzle`: always `1`.
- `id`: letters, digits, `_` and `-`, up to 64 characters, unique among your elements.
- `kind`: what sort of element it is, up to 40 characters, such as `Flash cards` or `Daily report`. The app groups elements by kind, so reuse the same kind for the same sort.
- `title`: up to 120 characters.
- `content`: one node.

Nodes:

- `{ "type": "text", "text": "...", "role": "title" }`: plain text, no markdown. `role` is `title`, `body` (the default) or `caption`.
- `{ "type": "image", "url": "https://...", "alt": "..." }`: an https image; `alt` says what it shows.
- `{ "type": "stack", "children": [ ... ] }`: nodes one under another.
- `{ "type": "list", "items": [ ... ], "ordered": true }`: a bulleted list, numbered when `ordered` is true.
- `{ "type": "reveal", "front": <node>, "back": <node> }`: shows the front; a tap flips it to the back and back again.
- `{ "type": "pager", "pages": [ ... ] }`: one page at a time, swiped through, with a page count.

There are no colors, fonts, sizes or positions: the app decides how everything looks. Limits: 8 levels deep, 50 children or items per node, 200 pages, 2000 nodes, 4000 characters per text. The app drops anything invalid and shows the rest; an element without a valid `id`, `title` or `content` shows only as a file.

## Examples

A deck of flash cards:

```json
{
  "wizzle": 1,
  "id": "spanish-verbs",
  "kind": "Flash cards",
  "title": "Spanish verbs",
  "content": { "type": "pager", "pages": [
    { "type": "reveal",
      "front": { "type": "text", "role": "title", "text": "tener" },
      "back": { "type": "stack", "children": [
        { "type": "text", "role": "title", "text": "to have" },
        { "type": "text", "role": "caption", "text": "tengo, tienes, tiene" }
      ] } },
    { "type": "reveal",
      "front": { "type": "text", "role": "title", "text": "ser" },
      "back": { "type": "text", "role": "title", "text": "to be" } }
  ] }
}
```

A daily report you refresh during the day by sending the same `id` again:

```json
{
  "wizzle": 1,
  "id": "daily-2026-10-22",
  "kind": "Daily report",
  "title": "Thursday, October 22",
  "content": { "type": "stack", "children": [
    { "type": "text", "role": "caption", "text": "Weather" },
    { "type": "text", "text": "Sunny, high of 18, light wind." },
    { "type": "text", "role": "caption", "text": "Today" },
    { "type": "list", "items": [
      { "type": "text", "text": "Dentist at 10:30" },
      { "type": "text", "text": "Call the bank" }
    ] }
  ] }
}
```
