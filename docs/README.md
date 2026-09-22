# Documentation

The [root README](../README.md) is the client guide for installation, Chat Completions behavior, and nonstandard `x_codex` extensions. These pages explain the proxy for contributors and maintainers.

| Topic                                                | Read it for                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                      | Process and request flow, component boundaries, and policy enforcement                            |
| [Continuation](continuation.md)                      | Durable response mappings, tool batches, and native-versus-fresh admission                        |
| [Compatibility](compatibility.md)                    | Pinned Codex contract, startup catalog workaround, persistence decisions, and verification limits |
| [Development](development.md)                        | Source layout, offline checks, CI, and opt-in live tests                                          |
| [Security](security.md)                              | Local threat model, controls, and sensitive diagnostics                                           |
| [App-server protocol reference](codex-app-server.md) | Pinned upstream app-server behavior; this is not the proxy's HTTP contract                        |
| [Protocol contract](../protocol/CONTRACT.md)         | Exact field and event mappings between Chat Completions and app-server                            |
| [Release checklist](../RELEASE.md)                   | Evidence gates and publication procedure                                                          |

Update the topic that owns a changed decision and its compatibility consequence. Update the root README when clients can observe the change.
