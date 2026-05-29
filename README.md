# Chatea

AI Chat Assistant built with Electron, Svelte, and TypeScript.

## Quick Start

```bash
# Install dependencies (native modules are auto-rebuilt for Electron)
npm install

# Start development environment
npm run dev
```

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full documentation.

### Common Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev environment |
| `npm run build` | Build for production |
| `npm run rebuild:native` | Rebuild native modules |
| `npm run test` | Run tests |
| `npm run fallow:summary` | Show Fallow dead code, duplication, and health summary |
| `npm run fallow:audit` | Run the baseline-backed Fallow PR gate locally |

### Static Analysis With Fallow

Chatea uses [Fallow](https://docs.fallow.tools/cli/audit) as its codebase truth layer for dead code, duplication, and complexity review.

- Run `npm run fallow:summary` for a quick overview.
- Run `npm run fallow:audit` before opening a PR.
- Baselines live in `fallow-baselines/` and are committed on purpose.
- Local cache and scratch output stay under `.fallow/` and remain ignored.

### Native Module Issues?

If you see errors about `NODE_MODULE_VERSION` mismatch:

```bash
npm run rebuild:native
```

This rebuilds `better-sqlite3` and `sherpa-onnx-node` for Electron's Node ABI.

## Requirements

- Node.js 22+
- Visual Studio Build Tools (Windows)
- Electron 41.x

## License

MIT
