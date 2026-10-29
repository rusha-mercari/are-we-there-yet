# Changelog

## 0.2.0

- A side deck with one card per running subagent, opened on spawn or with `/eta`. Wide panes fit two cards per row; `1`-`9` expand a card.
- ARRIVED and TRACK RECORD sections, collapsed by default (`a` and `r` toggle them).
- An "almost done" signal from `turn.step`: long prose with no tool call, or a `SubagentHandback` call, switches the card to ALMOST DONE.
- The band above the prompt is now a one-line summary.
- Plain ASCII drawing throughout, with status shown by color.
- Fixes: no negative bar for a just-spawned agent; idle agents stay en route; agents briefly missing from the list get five seconds' grace and never teach the average; the bar never moves backwards; cards fit narrow panes.

## 0.1.0

- A band above the prompt with an ETA per subagent, toasts on arrival, and per-type averages learned across sessions.
