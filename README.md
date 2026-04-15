# Vicinae Git Extensions

A Vicinae plugin for managing extensions from Git repositories: install, update, and remove them.

## Plugin Features

- Install an extension from a Git repository URL.
- Preview extension metadata before installation (`name`, `title`, `description`, icon).
- Automatically build the extension during installation if prebuilt files are missing.
- Check for updates by comparing local and remote `HEAD` commits.
- Update a single extension or update all at once.
- Remove an installed extension.
- Quick actions: open source URL, open repository link from `package.json`, open extension folder.

## How It Works

1. The plugin clones the repository into a temporary directory.
2. It reads `package.json` and validates the Vicinae extension structure.
3. If needed, it runs `npm install` and `npm run build`.
4. It copies the result into the Vicinae extensions directory.
5. It stores service metadata in `.veg-source.json`:
   - source `repoUrl`
   - installed commit SHA
   - installation timestamp

## Requirements

- `git` installed
- `npm` (Node.js)
- Vicinae

## Installation Directory

By default, extensions are installed to:

`~/.local/share/vicinae/extensions/`

## Development

Run in development mode:

```bash
npm install
npm run dev
```

## Build Plugin

```bash
npm run build
```
