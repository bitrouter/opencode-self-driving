# BitRouter connector boundaries

1. OpenCode owns providers/models, active connections, sessions, tools, and permissions.
2. The plugin reads effective sources through public catalogs and preserves source
   identity, model mappings, and settings that can be faithfully exported.
3. BitRouter owns model selection, upstream protocol conversion, and native
   subscription adapters.
4. The plugin has no decision engine or LLM bridge, context pruning, tool
   approvals, or self-learning.
5. Generated configuration disables ambient registry/default inheritance and must
   not expand the user's source pool.
6. Persistent default changes are limited to the project's `model` field. They
   require a backup, must respect later edits, and must be reversible.
7. OpenCode exclusively owns refresh tokens. BitRouter consumes temporary access
   leases and never refreshes the original account.
8. Failed candidate startup never switches the active generation. New requests
   cannot use an old account that cannot be revalidated. In-flight streams retain
   their original generation.
9. Headless, TUI, and remote clients use the same connector on the OpenCode server machine.
10. Valid configuration, HTTP success, session completion, task correctness, and
    lower cost are separate acceptance claims.

Bootstrap is only a conservative initial configuration without evaluation
evidence, not calibrated intelligent routing for an arbitrary model pool.
Optional policy and decision connections reuse BitRouter's existing capabilities
and do not introduce a second policy engine.
