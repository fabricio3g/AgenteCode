# Chatea LM

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