/**
 * English source of every shared UI string (see `copy.svelte.ts`).
 *
 * Rules this file exists to enforce:
 *  - One phrasing per concept. There is one "No matches", not four.
 *  - One ellipsis glyph: `…`. Never `...`.
 *  - No sentence is typed in two components. If you need it twice, it belongs here.
 *
 * Other languages override these keys in `locales.ts`; a missing key falls
 * back to the English here, and the shape is type-checked against this object.
 */

export const COPY_EN = {
  actions: {
    copy: 'Copy',
    copied: 'Copied',
    copyCode: 'Copy code',
    edit: 'Edit',
    retry: 'Retry',
    regenerate: 'Regenerate',
    delete: 'Delete',
    cancel: 'Cancel',
    close: 'Close',
    save: 'Save',
    stop: 'Stop',
    more: 'More',
    open: 'Open',
    download: 'Download',
    export: 'Export',
    confirm: 'Confirm',
    rename: 'Rename',
    splitRight: 'Open beside it',
    splitBelow: 'Open below it',
    splitTooSmall: 'The window is too narrow to split',
    remove: 'Remove',
    add: 'Add',
    test: 'Test',
    show: 'Show',
    hide: 'Hide',
    back: 'Back',
    apply: 'Apply',
    revert: 'Revert',
    restore: 'Restore',
    reveal: 'Show in folder',
    copyPath: 'Copy path',
    continue: 'Continue',
    load: 'Load',
    unload: 'Unload',
    refresh: 'Refresh'
  },

  confirm: {
    deleteMessage: {
      title: 'Delete message?',
      message: 'This cannot be undone.'
    },
    deleteChat: {
      title: 'Delete chat?',
      message: 'This cannot be undone.'
    },
    discardChanges: {
      title: 'Discard changes?',
      message: 'Your edits will be lost.',
      confirmLabel: 'Discard'
    }
  },

  empty: {
    noMatches: 'No matches',
    noMatchesHint: 'Try a different term',
    noConversations: 'No conversations yet',
    noMessages: 'No messages yet',
    noSources: 'No sources',
    noActivity: 'No activity'
  },

  /** Live activity verbs. The only place these words are spelled. */
  status: {
    /** Neutral in-progress verb, used when nothing more specific is known. */
    working: 'Working',
    thinking: 'Thinking',
    planning: 'Planning',
    reasoning: 'Reasoning',
    writing: 'Writing',
    searching: 'Searching',
    reading: 'Reading',
    loading: 'Loading',
    saving: 'Saving',
    listening: 'Listening',
    transcribing: 'Transcribing',
    processing: 'Processing',
    downloading: 'Downloading',
    extracting: 'Extracting'
  },

  /**
   * Tool / agent-step chrome. These words describe a step's outcome and are
   * shared by the inline status line, the activity drawer, and each tool row —
   * so a step never reads "Failed" in one place and "Error" in another.
   */
  tool: {
    needsApproval: 'Needs approval',
    approvalLede: 'The run is paused until you decide.',
    approvalDestructive: 'This can modify or remove data.',
    allow: 'Allow',
    deny: 'Deny',
    failed: 'Failed',
    cancelled: 'Cancelled',
    stopped: 'Stopped',
    done: 'Done',
    error: 'Error',
    result: 'Result',
    truncated: '… (truncated)'
  },

  /** Code agent tool rows: the verb for each tool, plus run-level notes. */
  codeRun: {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    bash: 'Run',
    grep: 'Search',
    ls: 'List',
    todo_write: 'Update tasks',
    git_status: 'Git status',
    git_diff: 'Git diff',
    browser_open: 'Open page',
    browser_snapshot: 'Read page',
    browser_click: 'Click',
    browser_fill: 'Type',
    browser_select: 'Choose option',
    browser_press: 'Press key',
    browser_hover: 'Hover',
    browser_scroll: 'Scroll',
    browser_wait: 'Wait for page',
    browser_back: 'Go back',
    browser_reload: 'Reload',
    browser_console: 'Check console',
    browser_screenshot: 'Screenshot',
    process_list: 'List processes',
    process_output: 'Read process output',
    process_stop: 'Stop process',
    message_bot: 'Ask',
    memory_update: 'Remember',
    approvePlan: 'Approve plan',
    approval: 'Approval',
    approved: 'Approved',
    denied: 'Denied',
    compacting: 'Compacting context',
    compacted: 'Context compacted',
    continuing: 'Hit the output cap — continuing',
    planNote: 'Approving lets the agent start editing; every edit still asks individually.',
    turnLimit: 'Stopped at the turn limit',
    interrupted: 'Interrupted — the app closed during this run',
    plan: 'Plan',
    noReply: 'The model finished without replying. Try again, or switch to a model that handles tools better.'
  },

  /** Shown for a conversation that still has its placeholder title. */
  untitled: {
    home: 'New chat',
    code: 'New conversation',
    roleplay: 'New roleplay',
    design: 'New design'
  },

  /** The top-bar tabs: the three spaces (keys mirror SpaceId), then Bots. */
  spaces: {
    label: 'Sections',
    home: 'Home',
    code: 'Code',
    roleplay: 'Roleplay',
    design: 'Design',
    bots: 'Bots'
  },

  /** Roleplay space: character library, personas, scenes. */
  roleplay: {
    newRoleplay: 'New roleplay',
    characters: 'Characters',
    library: 'Character library',
    newCharacter: 'New character',
    importCharacter: 'Import',
    pickCharacter: 'Pick a character to start',
    pickCharacterHint: 'Characters you create appear here.',
    noRoleplays: 'No roleplay sessions yet',
    noRoleplaysHint: 'Start a scene with a character and it will appear here.',
    enableInSettings: 'Enable Roleplay in Settings → General.'
  },

  /** Design space: HTML/CSS screens built by an agent, previewed on a canvas. */
  design: {
    newDesign: 'New design', noDesigns: 'No designs yet', noDesignsHint: 'Describe a screen and it will take shape here.',
    steps: { design_list: 'List files', design_read: 'Read', design_write: 'Write', design_edit: 'Edit', design_snapshot: 'Save version', design_preview: 'Preview', design_inspect: 'Inspect', design_motion: 'Motion', design_reference: 'Study reference', design_view: 'View image' },
    canvas: { empty: 'Start with a screen', emptyHint: 'Describe it in the chat — or pick a starter. The page appears here as soon as it is written.', reload: 'Reload preview', openFolder: 'Open design folder', hideChat: 'Hide chat', showChat: 'Show chat', previewLabel: 'Design preview', viewport: 'Viewport', page: 'Page' },
    suggestions: [
      { id: 'landing', label: 'Landing page', prompt: 'Design a landing page for a product. Hero, three feature blocks, pricing and a footer.' },
      { id: 'dashboard', label: 'Dashboard', prompt: 'Design an analytics dashboard with a sidebar, KPI cards, a chart and a recent-activity table.' },
      { id: 'mobile', label: 'Mobile app', prompt: 'Design a mobile onboarding flow: welcome, permissions and sign-up screens, 390px wide.' },
      { id: 'pricing', label: 'Pricing', prompt: 'Design a pricing page with three tiers, a monthly/yearly toggle and an FAQ.' },
      { id: 'login', label: 'Sign in', prompt: 'Design a clean sign-in screen with email, password and social options.' },
      { id: 'micro', label: 'Micro-interactions', prompt: 'Design the micro-interactions of a small UI. A button in its hover, pressed and focus states, a sliding toggle, and a toast that enters and leaves, all on the motion tokens, with a reduced-motion version.' },
    ],
    timeline: {
      title: 'Timeline', play: 'Play', pause: 'Pause', replay: 'Replay', speed: 'Playback speed', reduced: 'Reduced motion preview',
      reducedHint: 'A preview: durations are cut here the way a reduce block cuts them', close: 'Close timeline', scrub: 'Scrub the timeline', change: 'Change this animation',
      none: 'No animations on this page.', noneHint: 'Add a transition or an animation, then open the timeline again.'
    },
    motion: {
      presets: { standard: 'Standard', decelerate: 'Decelerate', accelerate: 'Accelerate', emphasized: 'Emphasized', spring: 'Spring' },
      custom: 'Custom'
    },
    viewports: { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop', fit: 'Fit' },
    variants: { title: 'Variants', none: 'No variants yet', noneHint: 'Ask for options, for example "three directions for the hero".', use: 'Use this variant', current: 'Current design', close: 'Close' },
    versions: { title: 'Versions', none: 'No versions yet', restore: 'Restore', auto: 'Saved after a turn', files: 'files', restored: 'Version restored' },
    select: {
      hint: 'Click an element · Shift+click adds · Double-click text to edit · Esc to finish',
      element: 'Element', remove: 'Remove', clear: 'Clear', clearAll: 'Clear all', showMore: 'Show all', showFewer: 'Show fewer'
    },
    comments: {
      pin: 'Comment', placeholder: 'What should change here?', hint: 'Enter saves · Esc cancels',
      save: 'Save', cancel: 'Cancel', chip: 'Comment'
    },
    zoom: { label: 'Zoom', fit: 'Fit to pane', actual: 'Actual size', in: 'Zoom in', out: 'Zoom out' },
    empty: { title: 'Start with a screen', hint: 'Describe it in the chat, or pick a starter below. The page takes shape here as soon as it is written.', sketching: 'Sketching the first screen…' },
    resize: { dock: 'Resize the chat · double-click to reset', inspector: 'Resize the inspector · double-click to reset' },
    dock: { title: 'What should we design?', hint: 'A screen, a flow or a whole product. Describe it, or start from a starter.', placeholder: 'Describe a screen, or select an element to change it', starters: 'Starters' },
    toolbar: {
      viewport: { mobile: 'Mobile · 390px', tablet: 'Tablet · 834px', desktop: 'Desktop · 1440px', fit: 'Fit to pane' },
      zoom: 'Zoom', zoomIn: 'Zoom in', zoomOut: 'Zoom out', zoomFit: 'Fit to pane', zoomReset: 'Actual size',
      scheme: { label: 'Preview color scheme', auto: 'Auto', light: 'Light', dark: 'Dark' },
      inspector: 'Inspector', showInspector: 'Show inspector', hideInspector: 'Hide inspector', more: 'More', fit: 'Fit'
    },
    tools: {
      label: 'Canvas tools', browse: 'Browse', select: 'Select element', comment: 'Comment on the canvas',
      comments: 'Comments', sendComments: 'Send comments', commentsSent: 'Comments added to the next message'
    },
    prompt: { placeholder: 'Describe a change to this', send: 'Send change' },
    edit: { label: 'Edit the selected element', smaller: 'Smaller text', larger: 'Larger text', bold: 'Bold', textColor: 'Text color', background: 'Background color', radiusLess: 'Less rounded', radiusMore: 'More rounded', paddingLess: 'Less padding', paddingMore: 'More padding', more: 'More', copySelector: 'Copy selector', openCode: 'Show in Code', designColors: 'Colors of this design', reset: 'Remove override' },
    layers: { title: 'Layers', show: 'Show layers', hide: 'Hide layers', empty: 'No elements on this page' },
    draw: { tool: 'Draw on the canvas', mark: 'Mark' },
    tweaks: { title: 'Tweaks' },
    /** The menu on a board frame's label; `{page}` is filled in by the caller. */
    frame: { actions: 'Frame actions', zoom: 'Zoom to frame', variant: 'Ask for a variant', variantPrompt: 'Make a variant of {page} in variants/: ', remove: 'Delete page', removeVariant: 'Delete variant', removeTitle: 'Delete {page}?', removeMessage: 'A version is saved first, so Versions can bring it back.', removeConfirm: 'Delete', tidy: 'Tidy up board', drag: 'Drag to move' },
    inspector: {
      element: 'Element', tokens: 'Tokens', code: 'Code', none: 'Select an element on the canvas',
      noneHint: 'Its text, box and styles appear here, and quick changes go to the chat.',
      text: 'Text', box: 'Box', styles: 'Styles', changes: 'Quick changes',
      prominent: 'Make this more prominent', tighten: 'Tighten spacing', variants: 'Try 3 variants of this',
      noTokens: 'No tokens yet', tokensHint: 'Ask for a token file, for example "define color, spacing and radius tokens".',
      colors: 'Colors', space: 'Spacing', radius: 'Radius', type: 'Type', shadow: 'Shadows', other: 'Other',
      moreSelected: 'more selected', motion: 'Motion', updateFailed: 'Could not update the token', noSource: 'Nothing to show yet', file: 'File', copy: 'Copy', copied: 'Copied'
    },
    export: { button: 'Export', copyHtml: 'Copy HTML', download: 'Download HTML', openBrowser: 'Open in browser', copied: 'HTML copied', failed: 'Export failed' },
    systems: {
      label: 'Design system',
      intro: 'Start from a system',
      none: 'No system',
      saveAs: 'Save design as system…',
      import: 'Import from a folder…',
      specimenAction: 'Generate specimen',
      specimenPrompt: 'Write components.html: a specimen page for this design system with the type scale, colors, buttons, inputs and cards. Use only the tokens in tokens.css and no external URLs.',
      manage: 'Manage systems…',
      title: 'Design systems',
      description: 'Tokens, guidance and a specimen page that designs can reuse',
      saveTitle: 'Save this design as a system',
      nameLabel: 'System name',
      namePlaceholder: 'e.g. Studio brand',
      descriptionLabel: 'What it is for',
      descriptionPlaceholder: 'Optional',
      save: 'Save system',
      saved: 'Design system saved',
      noSave: 'Open a design to save it as a system.',
      listTitle: 'Saved systems',
      empty: 'No design systems yet',
      emptyHint: 'Save a design as a system, or import the tokens of a project folder.',
      noSpecimen: 'No specimen yet',
      tokens: 'tokens',
      specimen: 'specimen',
      fromDesign: 'From a design',
      fromFolder: 'From a folder',
      apply: 'Use here',
      applied: 'System applied. The earlier files are saved as a version.',
      inUse: 'In use',
      rename: 'Rename',
      delete: 'Delete',
      deleteTitle: 'Delete this system?',
      deleteMessage: 'Its files leave the library. Designs that already use it keep their copies.',
      deleteConfirm: 'Delete system',
      imported: 'System imported from the folder'
    },
    handoff: {
      bundle: 'Download bundle (.zip)', toCode: 'Hand off to Code…', copyPrompt: 'Copy build prompt', copyDoc: 'Copy HANDOFF.md', bundled: 'Bundle saved', copied: 'Copied',
      dialog: {
        keepHtml: 'Keep HTML/CSS',
        title: 'Hand off to Code', description: 'Copies the design into a project, then opens a Code conversation with the build prompt. Nothing runs until you send it.', project: 'Project',
        noProjects: 'No projects yet. Choose a folder to add one.', choose: 'Choose folder…', stack: 'Build with', stackCustom: 'Another stack, e.g. Next.js + Tailwind',
        copies: 'Copies the design and its HANDOFF.md into a new folder under', confirm: 'Hand off', working: 'Copying…',
        cancel: 'Cancel', needProject: 'Choose a project folder first.', failed: 'Could not hand off the design'
      }
    }
  },

  thread: {
    activity: 'Activity',
    jumpToLatest: 'Jump to latest',
    previousVersion: 'Previous version',
    nextVersion: 'Next version',
    jumpToSelection: 'Jump to original selection',
    generationFailed: 'Generation failed',
    listen: 'Listen',
    stopListening: 'Stop',
    sources: 'Sources',
    outputTokens: 'output tok'
  },

  composer: {
    placeholder: 'Ask anything',
    errorPlaceholder: 'Something went wrong. Try again.',
    send: 'Send message',
    stop: 'Stop response',
    attach: 'Attach',
    dictate: 'Dictate',
    dropFiles: 'Drop files here',
    dropHint: 'Images, PDFs, documents',
    hint: 'Enter to send · Shift+Enter for newline',
    selectMode: 'Select mode',
    selectSearchMode: 'Select search mode',
    documents: 'Documents',
    clearAll: 'Clear all'
  },

  /** Shown above the composer while a conversation has no messages yet. */
  emptyState: {
    greeting: 'How can I help you today?',
    /**
     * Starter prompts. Selecting one fills the composer and focuses it — it
     * never sends on its own, so a mis-tap costs nothing.
     */
    suggestions: [
      { id: 'weather', label: 'Weather', prompt: "What's the weather like today?" },
      { id: 'code', label: 'Code', prompt: 'Help me write a function that ' },
      { id: 'write', label: 'Write', prompt: 'Help me write ' },
      { id: 'analyze', label: 'Analyze', prompt: 'Analyze this for me:\n\n' },
      { id: 'brainstorm', label: 'Brainstorm', prompt: 'Brainstorm ideas for ' }
    ]
  },

  model: {
    loading: 'Loading model…',
    none: 'No model loaded',
    browseAll: 'Browse all models',
    changeRuntime: 'Change runtime',
    configureProvider: 'Configure a provider',
    loadFailed: {
      oom: 'Not enough memory to load this model. Lower the context length or GPU layers, or pick a smaller quant.',
      port: "The local server's port is already in use. Close the other llama-server and try again.",
      runtime: 'The llama.cpp runtime is missing or failed to start. Reinstall it from Runtimes.',
      file: "This model file couldn't be read. It may be incomplete or not a valid GGUF.",
      generic: 'The model failed to load: {reason}'
    }
  },

  /** Document-viewer states. One ellipsis glyph, one failure heading. */
  viewer: {
    loadingPdf: 'Loading PDF…',
    loadingFile: 'Loading file…',
    convertingDocument: 'Converting document…',
    convertingSpreadsheet: 'Converting spreadsheet…',
    previewUnavailable: 'Preview unavailable'
  },

  search: {
    chats: 'Search chats',
    placeholder: 'Search chats…'
  },

  /** Composer search modes. Label and description together, so they can't drift. */
  searchModes: {
    chat: { label: 'Auto', description: 'Use tools and search when needed' },
    search: { label: 'Search', description: 'Quick web check' },
    deep: { label: 'Deep', description: 'Thorough research · more sources' },
    max: { label: 'Max', description: 'Exhaustive research · slower, more sources' }
  }
} as const;

export type CopyShape = typeof COPY_EN;
