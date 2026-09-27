export interface ElementNode {
  type: 'element';
  typeName: string;
  props: Record<string, unknown>;
  partial: boolean;
}

export interface ValidationError {
  component: string;
  path: string;
  message: string;
}

enum BuiltinActionType {
  ContinueConversation = 'continue_conversation',
  OpenUrl = 'open_url'
}

export interface ActionEvent {
  type: string;
  params: Record<string, any>;
  humanFriendlyMessage: string;
  formState?: Record<string, any>;
  formName?: string;
}

export interface ParseResult {
  root: ElementNode | null;
  meta: {
    incomplete: boolean;
    unresolved: string[];
    statementCount: number;
    validationErrors: ValidationError[];
  };
}
