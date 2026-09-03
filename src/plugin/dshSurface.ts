/**
 * dsh command surface bindings.
 *
 * The dsh host that mounts this plugin is a cordis composition; the shapes
 * below mirror the pieces of its context / services that `apply` touches
 * (`ctx.commands.register`, `ctx.llm.registerAdapter`), declared locally so
 * this package keeps no runtime dependency on dsh. A superset context is
 * passed at runtime.
 */

/** The `llm` service surface this plugin uses (dsh `LlmRuntime`). */
export interface DshLlmService {
    registerAdapter(providers: readonly string[], adapter: unknown): unknown;
}

/** A registered interactive command (dsh `CommandDefinition`, subset). */
export interface DshCommandInvocation {
    /** Exact text following the registered command name, including whitespace. */
    rawInput: string;
    /** Cancellation signal owned by the dispatching UI request. */
    signal?: AbortSignal;
}

export type DshCommandResult =
    | { kind: "success"; text: string }
    | { kind: "error"; text: string };

export interface DshCommandDefinition {
    /** Lowercase command name without the leading slash. */
    name: string;
    /** Human-readable summary used in discovery UI. */
    description: string;
    /**
     * Optional free-form input hint. Declaring it makes dsh treat the
     * command as a host-input command (arguments allowed), like `/goal`;
     * omitting it makes the command "bare", which the UI only executes
     * without trailing arguments.
     */
    input?: { hint: string };
    handler(invocation: DshCommandInvocation): DshCommandResult | Promise<DshCommandResult>;
}

/** The `commands` service surface (dsh `CommandRuntime`). */
export interface DshCommandsService {
    register(definition: DshCommandDefinition): unknown;
}

/** Context available inside an `inject([...])` callback (dsh cordis context). */
export interface DshInjectedContext {
    commands?: DshCommandsService;
}

/** The host context handed to `apply` (dsh cordis context, subset). */
export interface DshContextLike {
    llm: DshLlmService;
    get?<T>(key: string): T | undefined;
    /** Cordis service-injection; callbacks run once the named services are up. */
    inject?(services: readonly string[], callback: (ctx: DshInjectedContext) => void): unknown;
    logger?: {
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}
