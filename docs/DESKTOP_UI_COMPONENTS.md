# Desktop UI components

Renderer screens use the shared library in `apps/desktop/renderer/src/lib/components/ui/`.
Import from `$lib/components/ui`, or import one component directly. Native buttons and
form controls belong only in that library; `control-migration.spec.ts` checks the
Svelte syntax tree across all screens, including generated UI adapters.

| UI element | Shared owner | Customization |
| --- | --- | --- |
| Actions and icon actions | `Button`, `IconButton` | `button/variants.ts`; common interaction treatment in `primitives.css` |
| Text and multiline fields | `Input`, `Textarea` | `control-styles.ts`: default, surface, inline, composer |
| Search | `SearchField` | Leading icon, clear action, focus return |
| Choices | `Select`, `Switch`, `Checkbox`, `Radio`, `Range`, `ColorInput` | Keyboard, disabled and accessible state stay with the control |
| File picking | `FileInput` | Native file selection; accepts, multiple, event handlers and element reference |
| Form labels and settings rows | `Field`, `FormRow` | Label, description, error, tile, stacked/responsive control column |
| Sections and panels | `Section`, `Surface` | Quiet surfaces; spacing, tone and optional scroll containment |
| Tables, notices and dividers | `DataTable`, `Callout`, `Separator` | Horizontal scrolling, readable data cells and quiet separation |
| Layout | `Toolbar`, `Stack` | Density, wrapping, alignment and content spacing |
| List rows and tabs | `ListRow`, `TabBar`, `SegmentedControl` | Selection, focus, disabled items and keyboard navigation |
| Dialog actions | `DialogActions`, `DialogFooter` | Outlined cancellation, solid confirmation, red destructive actions; labels and height scale together |
| Menus, dialogs and folded content | `Menu`, `MenuItem`, `Dialog`, `Disclosure` | Shared positioning, focus behavior and motion |
| Empty, loading, error and progress | `EmptyState`, `AsyncState`, `Progress`, `StatusIndicator` | Message, action, retry, determinate/unknown progress |
| Identity and small metadata | `Avatar`, `Badge`, `StatusDot`, `ProviderIcon` | Theme colors, sizes and accessible labels |
| Supporting interactions | `Tooltip`, `ResizeHandle`, `Portal` | Tooltip positioning and shortcuts, pane resizing, overlay placement |

## Screen code

Use variants for appearance and props for behavior. Keep screen CSS for domain
geometry (the spreadsheet grid, timeline, diagram or page preview), not another
version of a button or field. The migrated controls with `ui-local-*` classes keep
specialized layout selectors scoped to that screen even though their root element
now lives in a component. They are not theme definitions.

`Button variant="plain"` is the interaction base for specialized objects such as a
canvas selection target or a composer meter. Ordinary actions use the button
variants; selectable full-width records use `ListRow`. Use `TabBar` for ordinary
text tabs. The pane strip and slide thumbnails keep their specialized composition.

Native element references use `bind:ref` (not `bind:this`, which binds a component
instance). Event handlers retain the actual native `event.currentTarget`, so file
picking, caret operations, keyboard shortcuts and numeric inputs keep working.
Text fields support `bind:value`, choices support their own bindings, and file
fields expose `files` and their native input reference.

The settings and document-viewer components remain small adapters that supply
application text to these primitives. The generated UI renderer also uses the
same controls and panel components. Sandboxed generated documents and the offline
HTML widget kit are separate content renderers: they cannot mount app components
inside their opaque frames.

## Theme and accessibility

Chat textareas use the composer variant: no inner border, colored ring or focus fill.
Confirmation actions share the reference button treatment and preserve cancel, submit and loading behavior.

Colors, typography, radius and motion come from `renderer/src/app.css` tokens.
Shared controls use the type ladder and reading scale; focus remains visible,
disabled controls retain native behavior, and reduced motion disables decoration.
A local CSS selector must not create another global control face.

## Verification

- The UI boundary test prevents raw form controls returning to screens.
- Control behavior tests cover numeric/range bindings, multiline input, files,
  checkbox state, focus forwarding, search clearing and tab navigation.
- The Electron document harness verifies real generated Markdown, HTML, Word,
  Excel, PDF and slides in light/dark, narrow and enlarged-text views.

To refresh the ownership inventory, run `npm run audit:ui` in the renderer directory.
The audit reports component usage and fails if a native control appears outside the library.

The cloud-thinking regression checks also cover route changes, late capability results,
cloud requests through local gateways, and separation of provider-native reasoning
fields from llama.cpp template controls.
