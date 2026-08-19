# probe-shape memory index

The first 40 lines of this file are loaded at every session start. Keep it an
INDEX: one line per durable thing, pointing at where the detail lives. Facts go
in `notes/`, or into the fact store through consolidation; identity and
standing instructions go in `blocks/`.

- `blocks/persona.md` - who this agent is (rendered into the prompt every turn)
- `notes/` - longer notes the agent writes and re-reads on demand
