# Agente Desktop - Development Documentation

## Native Module Rebuilding

This project uses Electron with native Node.js modules that must be rebuilt for Electron's specific Node ABI version.

### Native Modules

- **better-sqlite3** - SQLite database bindings
- **sherpa-onnx-node** - ONNX runtime for speech processing

### Why Rebuilding is Required

Electron bundles its own version of Node.js with a different ABI (Application Binary Interface) than your system Node.js. Native modules compiled for system Node.js won't work in Electron unless rebuilt.

**Example error when modules aren't rebuilt:**
```
Error: The module 'better-sqlite3' was compiled against a different Node.js version
using NODE_MODULE_VERSION 131. This version of Node.js requires NODE_MODULE_VERSION 145
```

### Automatic Rebuilding

The rebuild happens automatically via npm lifecycle scripts:

1. **postinstall** - Runs after `npm install` to rebuild native modules
2. **prebuild** - Runs before `npm run build` to ensure production builds have correct binaries

### Manual Rebuilding

If you encounter native module errors, run:

```bash
npm run rebuild:native
```

Or use the direct command:

```bash
npx @electron/rebuild -f -w better-sqlite3 -w sherpa-onnx-node
```

### Command Options

- `-f` - Force rebuild even if module appears correct
- `-w <module>` - Specify which module(s) to rebuild
- `-v <version>` - Target specific Electron version (auto-detected if omitted)

### When to Rebuild

You need to rebuild native modules when:
- After `npm install` or `npm update`
- After changing Electron version
- After upgrading native module versions
- When seeing "NODE_MODULE_VERSION" mismatch errors

### Troubleshooting

#### Windows Build Issues

If you see `Could not load the Visual C++ component "VCBuild.exe"`:

1. Install Visual Studio Build Tools via Node.js installer
2. Or run: `C:\Program Files\nodejs\install_tools.bat`

#### Module Not Found After Rebuild

1. Clear cache: `npm cache clean --force`
2. Delete `node_modules` and `.node-gyp` directories
3. Run `npm install` fresh

### References

- [better-sqlite3 Troubleshooting](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)
- [@electron/rebuild Documentation](https://github.com/electron/rebuild)
- [Electron Native Modules Guide](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)

---

## Development Workflow

### Prerequisites

- Node.js 22+ (required by @electron/rebuild)
- Visual Studio Build Tools (Windows)
- Git

### Quick Start

```bash
# Install dependencies (includes automatic native module rebuild)
npm install

# Start development environment
npm run dev
```

### Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start full dev environment (renderer + main + electron) |
| `npm run dev:renderer` | Start Vite dev server on port 5173 |
| `npm run dev:main` | Start esbuild watch for main process |
| `npm run dev:electron` | Start Electron app |
| `npm run rebuild:native` | Rebuild native modules for Electron |
| `npm run build` | Build for production |
| `npm run start` | Run production build |
| `npm run test` | Run test suite |

### Architecture

```
apps/desktop/
├── main/           # Electron main process (TypeScript)
├── preload/        # Preload scripts (bridge between main/renderer)
├── renderer/       # Svelte frontend (Vite + TypeScript)
├── build/          # Build resources (icons, etc.)
└── dist-electron/  # Compiled output
```

### Build Configuration

The project uses:
- **esbuild** for main process bundling (CJS output)
- **Vite** for renderer bundling
- **electron-builder** for packaging

Native modules are externalized and marked for unpacking in ASAR to ensure they load correctly:

```json
"asarUnpack": [
  "node_modules/apache-arrow/**/*",
  "node_modules/@lancedb/**/*",
  "node_modules/better-sqlite3/**/*"
]
```