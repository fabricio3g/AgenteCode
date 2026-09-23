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

  /** Shown for a conversation that still has its placeholder title. */
  untitled: {
    home: 'New chat',
    code: 'New conversation',
    roleplay: 'New roleplay'
  },

  /** The workspaces the sidebar switches between. Keys mirror SpaceId. */
  spaces: {
    home: 'Home',
    code: 'Code',
    roleplay: 'Roleplay'
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
    configureProvider: 'Configure a provider'
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
