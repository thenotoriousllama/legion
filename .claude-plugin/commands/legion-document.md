# /legion-document

Trigger a Legion wiki scan and documentation pass on the current repository.
Equivalent to clicking "Document" in the Legion VS Code sidebar.

## Usage

/legion-document

## Implementation

Run the following shell command from the repository root:

```bash
node dist/cli.js --mode document --repo-root .
```

If `dist/cli.js` is not found, inform the user:

> "Legion CLI not found. Open VS Code, run 'Legion: Build CLI', then retry."

Stream all stdout output to the conversation. On non-zero exit code, show stderr
and suggest checking the Legion Output channel in VS Code.
