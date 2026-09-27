import { getContext, setContext } from 'svelte';
import { writable, type Writable } from 'svelte/store';
import type { ActionEvent, ElementNode } from './types';
import type { Library } from './library';

export interface UIContextValue {
  library: Library;
  isStreaming: Writable<boolean>;
  renderNode: (value: unknown) => unknown;
  triggerAction: (humanFriendlyMessage: string, formName?: string, action?: { type?: string; params?: Record<string, any> }) => void;
  getFieldValue: (formName: string | undefined, name: string) => any;
  setFieldValue: (formName: string | undefined, componentType: string | undefined, name: string, value: any, shouldPersist?: boolean) => void;
}

const UI_KEY = 'ui-context';

export function createUIContext(args: {
  library: Library;
  isStreaming?: boolean;
  onAction?: (event: ActionEvent) => void;
  onStateUpdate?: (state: Record<string, any>) => void;
  initialState?: Record<string, any>;
  renderNode: (value: unknown) => unknown;
}) {
  let state = JSON.parse(JSON.stringify(args.initialState || {}));
  const isStreaming = writable(!!args.isStreaming);
  const persist = () => args.onStateUpdate?.(JSON.parse(JSON.stringify(state)));
  const ctx: UIContextValue = {
    library: args.library,
    isStreaming,
    renderNode: args.renderNode,
    triggerAction(humanFriendlyMessage, formName, action) {
      args.onAction?.({
        type: action?.type || 'continue_conversation',
        params: action?.params || {},
        humanFriendlyMessage,
        formName,
        formState: formName ? JSON.parse(JSON.stringify(state[formName] || {})) : undefined
      });
    },
    getFieldValue(formName, name) {
      if (!formName) return undefined;
      return state?.[formName]?.[name]?.value;
    },
    setFieldValue(formName, componentType, name, value, shouldPersist = true) {
      if (!formName || !name) return;
      state[formName] ||= {};
      state[formName][name] = { value, componentType: componentType || state[formName][name]?.componentType };
      if (shouldPersist) persist();
    }
  };
  setContext(UI_KEY, ctx);
  return { ctx, setStreaming(value: boolean) { isStreaming.set(value); } };
}

export function useUI(): UIContextValue {
  const context = getContext<UIContextValue>(UI_KEY);
  if (!context) throw new Error('UI context missing');
  return context;
}

export function isElementNode(value: unknown): value is ElementNode {
  return !!value && typeof value === 'object' && (value as ElementNode).type === 'element';
}
