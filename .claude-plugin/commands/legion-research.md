# /legion-research [topic]

Run Legion's auto-research mode for a given topic. Legion gathers context
from the wiki, the codebase, and recent commit messages, then synthesizes a
structured research summary and files wiki pages.

## Usage

/legion-research <topic>

Example: `/legion-research authentication-flow`

## Implementation

```bash
node dist/cli.js --mode autoresearch --topic "<topic>" --repo-root .
```

The `[topic]` argument is required. If omitted, ask the user for a topic before running.

Stream all stdout output to the conversation. Research passes can take 30-120 seconds
for deep topics — keep the user informed of progress via the streaming output.
