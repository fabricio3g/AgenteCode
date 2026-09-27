import { z } from 'zod';
import { generatePrompt } from './prompt';

export interface ComponentRenderProps<P = Record<string, unknown>> {
  props: P;
}

export interface DefinedComponent<T extends z.ZodObject<any> = z.ZodObject<any>> {
  name: string;
  props: T;
  description: string;
  component: any;
  ref: z.ZodType<any>;
}

export interface ComponentGroup {
  name: string;
  components: string[];
  notes?: string[];
}

export interface PromptOptions {
  preamble?: string;
  additionalRules?: string[];
  examples?: string[];
}

export interface Library {
  readonly components: Record<string, DefinedComponent>;
  readonly componentGroups: ComponentGroup[] | undefined;
  readonly root: string | undefined;
  prompt(options?: PromptOptions): string;
  toJSONSchema(): object;
}

export interface LibraryDefinition {
  components: DefinedComponent[];
  componentGroups?: ComponentGroup[];
  root?: string;
}

export function defineComponent<T extends z.ZodObject<any>>(config: {
  name: string;
  props: T;
  description: string;
  component: any;
}): DefinedComponent<T> {
  try {
    (config.props as any).register(z.globalRegistry, { id: config.name });
  } catch {
  }
  return {
    ...config,
    ref: config.props as unknown as z.ZodType<any>
  };
}

export function createLibrary(input: LibraryDefinition): Library {
  const components: Record<string, DefinedComponent> = {};
  for (const component of input.components) {
    components[component.name] = component;
  }
  const library: Library = {
    components,
    componentGroups: input.componentGroups,
    root: input.root,
    prompt(options?: PromptOptions) {
      return generatePrompt(library, options);
    },
    toJSONSchema() {
      const combinedSchema = z.object(
        Object.fromEntries(Object.entries(components).map(([name, component]) => [name, component.props])) as any
      );
      return z.toJSONSchema(combinedSchema);
    }
  };
  return library;
}
