import {
  computed,
  defineComponent,
  h,
  inject,
  isVNode,
  onErrorCaptured,
  provide,
  ref,
  watch,
  type Component,
  type ComponentPublicInstance,
  type ComputedRef,
  type PropType,
  type VNode,
} from "vue";
import type {
  UIElement,
  Spec,
  ActionBinding,
  Catalog,
  ComputedFunction,
  SchemaDefinition,
  StateStore,
  InferCatalogComponents,
  InferComponentProps,
} from "@json-render/core";
import {
  resolveElementProps,
  resolveBindings,
  resolveActionParam,
  evaluateVisibility,
  getByPath,
  type PropResolutionContext,
} from "@json-render/core";
import type {
  Components,
  Actions,
  ActionFn,
  SetState,
  StateModel,
  CatalogHasActions,
  EventHandle,
} from "./catalog-types";
import { useVisibility } from "./composables/visibility";
import { useActions } from "./composables/actions";
import { useStateStore } from "./composables/state";
import { StateProvider } from "./composables/state";
import { VisibilityProvider } from "./composables/visibility";
import { ActionProvider } from "./composables/actions";
import { ValidationProvider } from "./composables/validation";
import { ConfirmDialog } from "./composables/actions";
import {
  RepeatScopeProvider,
  useRepeatScope,
} from "./composables/repeat-scope";

/**
 * Props passed to component renderers
 */
export interface ComponentRenderProps<P = Record<string, unknown>> {
  /** The element being rendered */
  element: UIElement<string, P>;
  /** Emit a named event (optionally with runtime params) */
  emit: (event: string, params?: Record<string, unknown>) => void;
  /** Get an event handle with metadata */
  on: (event: string) => EventHandle;
  /**
   * Two-way binding paths resolved from `$bindState` / `$bindItem` expressions.
   * Maps prop name → absolute state path for write-back.
   */
  bindings?: Record<string, string>;
  /** Whether the parent is loading */
  loading?: boolean;
}

/**
 * Registry of component renderers (Vue component definitions)
 */
export type ComponentRegistry = Record<string, Component>;

/**
 * Props for the Renderer component
 */
export interface RendererProps {
  spec: Spec | null;
  registry: ComponentRegistry;
  loading?: boolean;
  fallback?: Component;
}

// ---------------------------------------------------------------------------
// FunctionsContext — provides $computed functions to the element tree
// ---------------------------------------------------------------------------

const EMPTY_FUNCTIONS: Record<string, ComputedFunction> = {};
const FUNCTIONS_KEY = Symbol("json-render:functions");

const FunctionsProvider = defineComponent({
  name: "FunctionsProvider",
  props: {
    functions: {
      type: Object as PropType<Record<string, ComputedFunction>>,
      default: undefined,
    },
  },
  setup(props, { slots }) {
    const fns = computed(() => props.functions ?? EMPTY_FUNCTIONS);
    provide(FUNCTIONS_KEY, fns);
    return () => slots.default?.();
  },
});

function useFunctions(): ComputedRef<Record<string, ComputedFunction>> {
  return inject<ComputedRef<Record<string, ComputedFunction>>>(
    FUNCTIONS_KEY,
    computed(() => EMPTY_FUNCTIONS),
  );
}

// ---------------------------------------------------------------------------
// ElementErrorBoundary — catches rendering errors in individual elements
// ---------------------------------------------------------------------------

const ElementErrorBoundary = defineComponent({
  name: "ElementErrorBoundary",
  props: {
    elementType: {
      type: String,
      required: true,
    },
  },
  setup(props, { slots }) {
    const hasError = ref(false);

    onErrorCaptured((error) => {
      console.error(
        `[json-render] Rendering error in <${props.elementType}>:`,
        error,
      );
      hasError.value = true;
      return false; // prevent propagation
    });

    return () => {
      if (hasError.value) return null;
      return slots.default?.();
    };
  },
});

// ---------------------------------------------------------------------------
// resolveAndExecuteBindings — shared helper for emitEvent / watch handlers
// ---------------------------------------------------------------------------

async function resolveAndExecuteBindings(
  actionBindings: ActionBinding[],
  ctx: PropResolutionContext,
  getSnapshot: () => Record<string, unknown>,
  execute: (binding: ActionBinding) => Promise<void>,
  cancelled?: () => boolean,
): Promise<void> {
  for (const b of actionBindings) {
    if (cancelled?.()) break;
    if (!b.params) {
      await execute(b);
      if (cancelled?.()) break;
      continue;
    }
    const liveCtx: PropResolutionContext = {
      ...ctx,
      stateModel: getSnapshot(),
    };
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(b.params)) {
      resolved[key] = resolveActionParam(val, liveCtx);
    }
    await execute({ ...b, params: resolved });
    if (cancelled?.()) break;
  }
}

// ---------------------------------------------------------------------------
// ElementRenderer — renders a single element from the spec
// ---------------------------------------------------------------------------

interface ElementRendererInternalProps {
  elementKey: string;
  element: UIElement;
  spec: Spec;
  registry: ComponentRegistry;
  loading?: boolean;
  fallback?: Component;
  registerElementInstance?: (
    elementKey: string,
    instance: ComponentPublicInstance | VNode | Element | null,
  ) => void;
}

const ElementRenderer = defineComponent({
  name: "JsonRenderElement",
  props: {
    elementKey: {
      type: String,
      required: true,
    },
    element: {
      type: Object as PropType<UIElement>,
      required: true,
    },
    spec: {
      type: Object as PropType<Spec>,
      required: true,
    },
    registry: {
      type: Object as PropType<ComponentRegistry>,
      required: true,
    },
    loading: {
      type: Boolean,
      default: undefined,
    },
    fallback: {
      type: Object as PropType<Component>,
      default: undefined,
    },
    registerElementInstance: {
      type: Function as PropType<
        (
          elementKey: string,
          instance: ComponentPublicInstance | VNode | Element | null,
        ) => void
      >,
      default: undefined,
    },
  },
  setup(props: ElementRendererInternalProps) {
    const repeatScope = useRepeatScope();
    const { ctx: visibilityCtx } = useVisibility();
    const { execute } = useActions();
    const { getSnapshot, state: watchState } = useStateStore();
    const functions = useFunctions();

    // Build context with repeat scope and $computed functions
    const fullCtx = computed<PropResolutionContext>(() => {
      const base: PropResolutionContext = repeatScope
        ? {
            ...visibilityCtx.value,
            repeatItem: repeatScope.item,
            repeatIndex: repeatScope.index,
            repeatBasePath: repeatScope.basePath,
          }
        : { ...visibilityCtx.value };
      base.functions = functions.value;
      return base;
    });

    // Create emit function
    const emitEvent = async (
      eventName: string,
      params?: Record<string, unknown>,
    ): Promise<void> => {
      const binding = props.element.on?.[eventName];
      if (!binding) return;
      const actionBindings = Array.isArray(binding) ? binding : [binding];
      const mergedBindings =
        params && Object.keys(params).length > 0
          ? actionBindings.map((b) => ({
              ...b,
              params: { ...(b.params ?? {}), ...params },
            }))
          : actionBindings;
      await resolveAndExecuteBindings(
        mergedBindings,
        fullCtx.value,
        getSnapshot,
        execute,
      );
    };

    // Create on() function
    const onEvent = (eventName: string): EventHandle => {
      const binding = props.element.on?.[eventName];
      if (!binding) {
        return {
          emit: (_params?: Record<string, unknown>) => {},
          shouldPreventDefault: false,
          bound: false,
        };
      }
      const actionBindings = Array.isArray(binding) ? binding : [binding];
      const shouldPreventDefault = actionBindings.some((b) => b.preventDefault);
      return {
        emit: (params?: Record<string, unknown>) => {
          void emitEvent(eventName, params);
        },
        shouldPreventDefault,
        bound: true,
      };
    };

    // Watch effect: fire actions when watched state paths change.
    const watchedValues = computed(() => {
      const cfg = props.element.watch;
      if (!cfg) return undefined;
      const values: Record<string, unknown> = {};
      for (const path of Object.keys(cfg)) {
        values[path] = getByPath(watchState.value, path);
      }
      return values;
    });

    watch(
      watchedValues,
      (current, prev, onCleanup) => {
        const cfg = props.element.watch;
        if (!cfg || !current) return;

        let cancelled = false;
        onCleanup(() => {
          cancelled = true;
        });

        const paths = Object.keys(cfg);
        void (async () => {
          for (const path of paths) {
            if (cancelled) break;
            if (prev && current[path] === prev[path]) continue;
            const binding = cfg[path];
            if (!binding) continue;
            const bindings = Array.isArray(binding) ? binding : [binding];
            await resolveAndExecuteBindings(
              bindings,
              fullCtx.value,
              getSnapshot,
              execute,
              () => cancelled,
            );
          }
        })().catch(console.error);
      },
      { deep: true },
    );

    return () => {
      const ctx = fullCtx.value;

      // Evaluate visibility
      const isVisible =
        props.element.visible === undefined
          ? true
          : evaluateVisibility(props.element.visible, ctx);

      if (!isVisible) return null;

      // Resolve bindings and props
      const rawProps = props.element.props as Record<string, unknown>;
      const elementBindings = resolveBindings(rawProps, ctx);
      const resolvedProps = resolveElementProps(rawProps, ctx);

      const resolvedElement =
        resolvedProps !== props.element.props
          ? { ...props.element, props: resolvedProps }
          : props.element;

      // Get component from registry
      const Component = props.registry[resolvedElement.type] ?? props.fallback;

      if (!Component) {
        console.warn(
          `[json-render] No renderer for component type: ${resolvedElement.type}`,
        );
        return null;
      }

      // Render children
      const childrenVNodes: VNode | VNode[] | undefined = resolvedElement.repeat
        ? h(RepeatChildren, {
            element: resolvedElement,
            spec: props.spec,
            registry: props.registry,
            loading: props.loading,
            fallback: props.fallback,
            registerElementInstance: props.registerElementInstance,
          })
        : (resolvedElement.children
            ?.map((childKey) => {
              const childElement = props.spec.elements[childKey];
              if (!childElement) {
                if (!props.loading) {
                  console.warn(
                    `[json-render] Missing element "${childKey}" referenced as child of "${resolvedElement.type}". This element will not render.`,
                  );
                }
                return null;
              }
              return h(ElementRenderer, {
                key: childKey,
                elementKey: childKey,
                element: childElement,
                spec: props.spec,
                registry: props.registry,
                loading: props.loading,
                fallback: props.fallback,
                registerElementInstance: props.registerElementInstance,
              });
            })
            .filter((n): n is VNode => n !== null) ?? undefined);

      return h(
        ElementErrorBoundary,
        { elementType: resolvedElement.type },
        {
          default: () =>
            h(
              Component,
              {
                ref: (
                  instance: ComponentPublicInstance | VNode | Element | null,
                ) => {
                  props.registerElementInstance?.(props.elementKey, instance);
                },
                ...(resolvedElement.props as Record<string, unknown>),
                // Backward compatibility for SFCs that read nested `props`
                // via `defineProps({ props: ... })`.
                props: resolvedElement.props,
                emit: emitEvent,
                on: onEvent,
                bindings: elementBindings,
                loading: props.loading,
              },
              { default: () => childrenVNodes },
            ),
        },
      );
    };
  },
});

// ---------------------------------------------------------------------------
// RepeatChildren — renders child elements once per item in a state array
// ---------------------------------------------------------------------------

const RepeatChildren = defineComponent({
  name: "JsonRenderRepeatChildren",
  props: {
    element: {
      type: Object as PropType<UIElement>,
      required: true,
    },
    spec: {
      type: Object as PropType<Spec>,
      required: true,
    },
    registry: {
      type: Object as PropType<ComponentRegistry>,
      required: true,
    },
    loading: {
      type: Boolean,
      default: undefined,
    },
    fallback: {
      type: Object as PropType<Component>,
      default: undefined,
    },
    registerElementInstance: {
      type: Function as PropType<
        (
          elementKey: string,
          instance: ComponentPublicInstance | VNode | Element | null,
        ) => void
      >,
      default: undefined,
    },
  },
  setup(props) {
    const { state } = useStateStore();

    return () => {
      const repeat = props.element.repeat;
      if (!repeat?.statePath) return null;
      const statePath = repeat.statePath;
      const raw = getByPath(state.value, statePath);
      const items = Array.isArray(raw) ? (raw as unknown[]) : [];

      return items.map((itemValue, index) => {
        const key =
          repeat.key && typeof itemValue === "object" && itemValue !== null
            ? String(
                (itemValue as Record<string, unknown>)[repeat.key] ?? index,
              )
            : String(index);

        return h(
          RepeatScopeProvider,
          { key, item: itemValue, index, basePath: `${statePath}/${index}` },
          {
            default: () =>
              props.element.children
                ?.map((childKey) => {
                  const childElement = props.spec.elements[childKey];
                  if (!childElement) {
                    if (!props.loading) {
                      console.warn(
                        `[json-render] Missing element "${childKey}" referenced as child of "${props.element.type}" (repeat). This element will not render.`,
                      );
                    }
                    return null;
                  }
                  return h(ElementRenderer, {
                    key: childKey,
                    elementKey: childKey,
                    element: childElement,
                    spec: props.spec,
                    registry: props.registry,
                    loading: props.loading,
                    fallback: props.fallback,
                    registerElementInstance: props.registerElementInstance,
                  });
                })
                .filter((n): n is VNode => n !== null) ?? null,
          },
        );
      });
    };
  },
});

// ---------------------------------------------------------------------------
// Renderer — main exported component
// ---------------------------------------------------------------------------

/**
 * Main renderer component
 */
export interface RendererExposed {
  callRendererEvent: (
    elementKey: string,
    methodName: string,
    ...args: unknown[]
  ) => unknown;
  getElementExposed: (
    elementKey: string,
  ) => Record<string, unknown> | undefined;
  hasElement: (elementKey: string) => boolean;
}

export const Renderer = defineComponent({
  name: "JsonRenderer",
  props: {
    spec: {
      type: Object as PropType<Spec | null>,
      default: null,
    },
    registry: {
      type: Object as PropType<ComponentRegistry>,
      required: true,
    },
    loading: {
      type: Boolean,
      default: undefined,
    },
    fallback: {
      type: Object as PropType<Component>,
      default: undefined,
    },
  },
  setup(props, { expose }) {
    const elementInstances = new Map<
      string,
      ComponentPublicInstance | VNode | Element
    >();

    const registerElementInstance = (
      elementKey: string,
      instance: ComponentPublicInstance | VNode | Element | null,
    ): void => {
      if (!instance) {
        elementInstances.delete(elementKey);
        return;
      }
      elementInstances.set(elementKey, instance);
    };

    const getElementExposed = (
      elementKey: string,
    ): Record<string, unknown> | undefined => {
      const instance = elementInstances.get(elementKey);
      if (!instance) return undefined;

      // Case 1: Component public instance
      if ("$" in instance) {
        const exposed = instance.$.exposed;
        if (exposed && typeof exposed === "object") {
          return exposed as Record<string, unknown>;
        }
      }

      // Case 2: VNode ref value
      if (isVNode(instance)) {
        const exposed = instance.component?.exposed;
        if (exposed && typeof exposed === "object") {
          return exposed as Record<string, unknown>;
        }
      }

      // Case 3: native element or unsupported ref target
      return undefined;
    };

    const callRendererEvent = (
      elementKey: string,
      methodName: string,
      ...args: unknown[]
    ): unknown => {
      const exposed = getElementExposed(elementKey);
      if (!exposed) {
        console.warn(
          `[json-render] Element "${elementKey}" has no exposed API.`,
        );
        return undefined;
      }
      const method = exposed[methodName];
      if (typeof method !== "function") {
        console.warn(
          `[json-render] Exposed method "${methodName}" not found on element "${elementKey}".`,
        );
        return undefined;
      }
      return (method as (...fnArgs: unknown[]) => unknown)(...args);
    };

    const hasElement = (elementKey: string): boolean =>
      elementInstances.has(elementKey);

    expose({
      callRendererEvent,
      getElementExposed,
      hasElement,
    } satisfies RendererExposed);

    return () => {
      if (!props.spec?.root) return null;

      const rootElement = props.spec.elements[props.spec.root];
      if (!rootElement) return null;

      return h(ElementRenderer, {
        elementKey: props.spec.root,
        element: rootElement,
        spec: props.spec,
        registry: props.registry,
        loading: props.loading,
        fallback: props.fallback,
        registerElementInstance,
      });
    };
  },
});

// ---------------------------------------------------------------------------
// ConfirmationDialogManager
// ---------------------------------------------------------------------------

const ConfirmationDialogManager = defineComponent({
  name: "ConfirmationDialogManager",
  setup() {
    const { pendingConfirmation, confirm, cancel } = useActions();

    return () => {
      if (!pendingConfirmation?.action.confirm) return null;

      return h(ConfirmDialog, {
        confirm: pendingConfirmation.action.confirm,
        onConfirm: confirm,
        onCancel: cancel,
      });
    };
  },
});

// ---------------------------------------------------------------------------
// JSONUIProvider — combined provider for all contexts
// ---------------------------------------------------------------------------

/**
 * Props for JSONUIProvider
 */
export interface JSONUIProviderProps {
  registry: ComponentRegistry;
  store?: StateStore;
  initialState?: Record<string, unknown>;
  handlers?: Record<
    string,
    (params: Record<string, unknown>) => Promise<unknown> | unknown
  >;
  navigate?: (path: string) => void;
  validationFunctions?: Record<
    string,
    (value: unknown, args?: Record<string, unknown>) => boolean
  >;
  /** Named functions for `$computed` expressions in props */
  functions?: Record<string, ComputedFunction>;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
}

/**
 * Combined provider for all JSONUI contexts
 */
export const JSONUIProvider = defineComponent({
  name: "JSONUIProvider",
  props: {
    registry: {
      type: Object as PropType<ComponentRegistry>,
      required: true,
    },
    store: {
      type: Object as PropType<StateStore>,
      default: undefined,
    },
    initialState: {
      type: Object as PropType<Record<string, unknown>>,
      default: undefined,
    },
    handlers: {
      type: Object as PropType<
        Record<
          string,
          (params: Record<string, unknown>) => Promise<unknown> | unknown
        >
      >,
      default: undefined,
    },
    navigate: {
      type: Function as PropType<(path: string) => void>,
      default: undefined,
    },
    validationFunctions: {
      type: Object as PropType<
        Record<
          string,
          (value: unknown, args?: Record<string, unknown>) => boolean
        >
      >,
      default: undefined,
    },
    functions: {
      type: Object as PropType<Record<string, ComputedFunction>>,
      default: undefined,
    },
    onStateChange: {
      type: Function as PropType<
        (changes: Array<{ path: string; value: unknown }>) => void
      >,
      default: undefined,
    },
  },
  setup(props, { slots }) {
    return () =>
      h(
        StateProvider,
        {
          store: props.store,
          initialState: props.initialState,
          onStateChange: props.onStateChange,
        },
        {
          default: () =>
            h(VisibilityProvider, null, {
              default: () =>
                h(
                  ValidationProvider,
                  { customFunctions: props.validationFunctions },
                  {
                    default: () =>
                      h(
                        ActionProvider,
                        { handlers: props.handlers, navigate: props.navigate },
                        {
                          default: () =>
                            h(
                              FunctionsProvider,
                              { functions: props.functions },
                              {
                                default: () => [
                                  slots.default?.(),
                                  h(ConfirmationDialogManager),
                                ],
                              },
                            ),
                        },
                      ),
                  },
                ),
            }),
        },
      );
  },
});

// ============================================================================
// defineRegistry
// ============================================================================

/**
 * Result returned by defineRegistry
 */
export interface DefineRegistryResult {
  registry: ComponentRegistry;
  handlers: (
    getSetState: () => SetState | undefined,
    getState: () => StateModel,
  ) => Record<string, (params: Record<string, unknown>) => Promise<void>>;
  executeAction: (
    actionName: string,
    params: Record<string, unknown> | undefined,
    setState: SetState,
    state?: StateModel,
  ) => Promise<void>;
}

type DefineRegistryOptions<C extends Catalog> = {
  components?: Components<C> | Record<string, Component>;
} & (CatalogHasActions<C> extends true
  ? { actions: Actions<C> }
  : { actions?: Actions<C> });

type DefineRegistryComponentCtx<P> = {
  props: P;
  children?: VNode | VNode[];
  emit: (event: string, params?: Record<string, unknown>) => void;
  on: (event: string) => EventHandle;
  bindings?: Record<string, string>;
  loading?: boolean;
};

type DefineRegistryComponentFn<
  C extends Catalog,
  K extends keyof InferCatalogComponents<C>,
> = (
  ctx: DefineRegistryComponentCtx<InferComponentProps<C, K>>,
) => VNode | VNode[] | null | string;

type DefineRegistryActionFn = (
  params: Record<string, unknown> | undefined,
  setState: SetState,
  state: StateModel,
) => Promise<void>;

/**
 * Create a registry from a catalog with components and/or actions.
 *
 * @example
 * ```ts
 * // Components only
 * const { registry } = defineRegistry(catalog, {
 *   components: {
 *     Card: ({ props, children }) => h('div', { class: 'card' }, [props.title, children]),
 *   },
 * });
 *
 * // Both
 * const { registry, handlers, executeAction } = defineRegistry(catalog, {
 *   components: { ... },
 *   actions: { ... },
 * });
 * ```
 */
export function defineRegistry<C extends Catalog>(
  _catalog: C,
  options: DefineRegistryOptions<C>,
): DefineRegistryResult {
  const registry: ComponentRegistry = {};

  if (options.components) {
    type ComponentKey = keyof InferCatalogComponents<C>;

    for (const [name, componentEntry] of Object.entries(
      options.components,
    ) as Array<[string, Components<C>[ComponentKey] | Component]>) {
      if (
        typeof componentEntry === "function" &&
        !("props" in componentEntry)
      ) {
        const componentFn =
          componentEntry as unknown as DefineRegistryComponentFn<
            C,
            ComponentKey
          >;
        registry[name] = defineComponent({
          name: `JsonRenderRegistry_${name}`,
          props: {
            element: {
              type: Object as PropType<UIElement>,
              required: true,
            },
            emit: {
              type: Function as PropType<
                (event: string, params?: Record<string, unknown>) => void
              >,
              required: true,
            },
            on: {
              type: Function as PropType<(event: string) => EventHandle>,
              required: true,
            },
            bindings: {
              type: Object as PropType<Record<string, string>>,
              default: undefined,
            },
            loading: {
              type: Boolean,
              default: undefined,
            },
          },
          setup(registryProps, { slots }) {
            return () =>
              componentFn({
                props: registryProps.element.props as InferComponentProps<
                  C,
                  ComponentKey
                >,
                children: slots.default?.(),
                emit: registryProps.emit,
                on: registryProps.on,
                bindings: registryProps.bindings,
                loading: registryProps.loading,
              });
          },
        });
      } else {
        registry[name] = componentEntry as Component;
      }
    }
  }

  const actionMap = options.actions
    ? (Object.entries(options.actions) as Array<
        [string, DefineRegistryActionFn]
      >)
    : [];

  const handlers = (
    getSetState: () => SetState | undefined,
    getState: () => StateModel,
  ): Record<string, (params: Record<string, unknown>) => Promise<void>> => {
    const result: Record<
      string,
      (params: Record<string, unknown>) => Promise<void>
    > = {};
    for (const [name, actionFn] of actionMap) {
      result[name] = async (params) => {
        const setState = getSetState();
        const state = getState();
        if (setState) {
          await actionFn(params, setState, state);
        }
      };
    }
    return result;
  };

  const executeAction = async (
    actionName: string,
    params: Record<string, unknown> | undefined,
    setState: SetState,
    state: StateModel = {},
  ): Promise<void> => {
    const entry = actionMap.find(([name]) => name === actionName);
    if (entry) {
      await entry[1](params, setState, state);
    } else {
      console.warn(`Unknown action: ${actionName}`);
    }
  };

  return { registry, handlers, executeAction };
}

// ============================================================================
// createRenderer
// ============================================================================

/**
 * Props for renderers created with createRenderer
 */
export interface CreateRendererProps {
  spec: Spec | null;
  store?: StateStore;
  state?: Record<string, unknown>;
  onAction?: (actionName: string, params?: Record<string, unknown>) => void;
  onStateChange?: (changes: Array<{ path: string; value: unknown }>) => void;
  /** Named functions for `$computed` expressions in props */
  functions?: Record<string, ComputedFunction>;
  loading?: boolean;
  fallback?: Component;
}

/**
 * Component map type — maps component names to Vue components
 */
export type ComponentMap<
  TComponents extends Record<string, { props: unknown }>,
> = {
  [K in keyof TComponents]: Component;
};

/**
 * Create a renderer from a catalog
 *
 * @example
 * ```typescript
 * const DashboardRenderer = createRenderer(dashboardCatalog, {
 *   Card: ({ props, children }) => h('div', { class: 'card' }, children),
 *   Metric: ({ props }) => h('span', null, props.value),
 * });
 *
 * // Usage in template
 * <DashboardRenderer :spec="aiGeneratedSpec" :state="state" />
 * ```
 */
export function createRenderer<
  TDef extends SchemaDefinition,
  TCatalog extends { components: Record<string, { props: unknown }> },
>(
  catalog: Catalog<TDef, TCatalog>,
  components: ComponentMap<TCatalog["components"]>,
): Component {
  const registry: ComponentRegistry =
    components as unknown as ComponentRegistry;

  return defineComponent({
    name: "CatalogRenderer",
    props: {
      spec: {
        type: Object as PropType<Spec | null>,
        default: null,
      },
      store: {
        type: Object as PropType<StateStore>,
        default: undefined,
      },
      state: {
        type: Object as PropType<Record<string, unknown>>,
        default: undefined,
      },
      onAction: {
        type: Function as PropType<
          (actionName: string, params?: Record<string, unknown>) => void
        >,
        default: undefined,
      },
      onStateChange: {
        type: Function as PropType<
          (changes: Array<{ path: string; value: unknown }>) => void
        >,
        default: undefined,
      },
      functions: {
        type: Object as PropType<Record<string, ComputedFunction>>,
        default: undefined,
      },
      loading: {
        type: Boolean,
        default: undefined,
      },
      fallback: {
        type: Object as PropType<Component>,
        default: undefined,
      },
    },
    setup(rendererProps) {
      return () => {
        // Build the action handlers proxy if onAction is provided
        const actionHandlers = rendererProps.onAction
          ? new Proxy(
              {} as Record<
                string,
                (params: Record<string, unknown>) => void | Promise<void>
              >,
              {
                get: (_target, prop: string) => {
                  return (params: Record<string, unknown>) =>
                    rendererProps.onAction!(prop, params);
                },
                has: () => true,
              },
            )
          : undefined;

        return h(
          StateProvider,
          {
            store: rendererProps.store,
            initialState: rendererProps.state,
            onStateChange: rendererProps.onStateChange,
          },
          {
            default: () =>
              h(VisibilityProvider, null, {
                default: () =>
                  h(ValidationProvider, null, {
                    default: () =>
                      h(
                        ActionProvider,
                        { handlers: actionHandlers },
                        {
                          default: () =>
                            h(
                              FunctionsProvider,
                              { functions: rendererProps.functions },
                              {
                                default: () => [
                                  h(Renderer, {
                                    spec: rendererProps.spec,
                                    registry,
                                    loading: rendererProps.loading,
                                    fallback: rendererProps.fallback,
                                  }),
                                  h(ConfirmationDialogManager),
                                ],
                              },
                            ),
                        },
                      ),
                  }),
              }),
          },
        );
      };
    },
  });
}
