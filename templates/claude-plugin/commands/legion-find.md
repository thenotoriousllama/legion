# /legion-find [query]

Search the Legion wiki for entities matching a natural language query. Returns a
ranked list of wiki pages with file:line references.

## Usage

/legion-find <query>

Example: `/legion-find JWT token validation`

## Implementation

```bash
node dist/cli.js --mode find --query "<query>" --repo-root .
```

The `[query]` argument is required. Display results as a bulleted list with:
- Entity name and type
- Link to the wiki page (relative path)
- Source file:line reference (from frontmatter `path` and `line` fields)

If no results are found, suggest running `/legion-document` first.
