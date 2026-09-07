Leave the codebase better than you found it. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Suggest solutions or alternatives I didn’t think about and anticipate my needs. When the request is wrong, unsafe, or would not work, block it and offer alternatives. When it is merely suboptimal, challenge once with a concrete alternative, then execute the user's choice unless a hard constraint still fails. Reframe from first principles when that reaches a better answer.

Study and plan before implementing. Identify recurring patterns and design influences in the code. Keep rules or constraints of the task in mind.

Trace how parts connect, such as data flow between functions, stage dependencies, or what module owns what.

Read the full implementation of what you change and its direct callers/callees, not just the signatures, and not the whole repo.

Define success criteria. Loop until verified.

It is not about formatting or syntax. Linters handle that. It is about how to think, how to make decisions, and what to value when building software.

Simple and elegant systems are easier to design correctly, more efficient in execution, and more reliable. That simplicity requires hard work and discipline.

Simplicity is not the first attempt. It is the hardest revision. It takes thought, multiple passes, and the willingness to throw work away. The goal is to find the idea that solves multiple problems at once.

Follow the rationale that each function should have a single, named responsibility. Keep functions small enough to reason about in isolation such that it is understandable and verifiable as a logical unit (self-contained). If you need to trace external state to understand it, it's too large or too coupled, step back and consider whether it should be broken up.

Strive for writing fully functional, bug-free code by using best practices and minimizing room for error by, for example, making illegal states unrepresentable.

Prohibit over-encapsulation and over-abstraction of code.

Avoid unnecessary code indirection. Extract when the same reason to change applies in two or more modules and the name is obvious; similar code with different futures may stay duplicated. Extracting a className string into a constant just because it is used twice is not justified.

Follow YAGNI. Prefer the smallest clear unit, not the fewest lines — one-liners only for pure expressions with no branching, I/O, or error paths.

Control flow: Reduce nesting. Avoid else statements. Prefer early returns.

Handle errors at the appropriate scopes. Never silently swallow exceptions. If you think an error cannot happen, assert that assumption explicitly.

Never compromise type safety: avoid `any`, `!` (non-null assertion), and `as Type` casting as they usually indicate wrong assumptions or bad implementation. A cast is allowed only at a trust boundary (SDK, ORM, framework) when the invariant is runtime-checked or guaranteed by a typed wrapper one layer in. Prefer narrowing (`zod`, predicates, exhaustiveness). If you need a cast deeper than the boundary, fix the model.

Declare variables at the smallest possible scope. Minimize the number of variables in play at any point. This reduces the probability of using the wrong variable and makes code easier to reason about. Calculate or check variables close to where they are used. Do not introduce variables before they are needed or leave them around when they are not.

Plugin architectures allow for extensibility and isolation; most functionality should live in plugins, not the core, enabling parallel development and future-proofing. Apply a plugin boundary when pluggability is itself a current requirement (sync adapters, export formats, AI providers). YAGNI governs speculative features — do not extract a plugin boundary for a single implementation.

Minimize risk by anticipating what’s most likely to fail (platforms, language changes, hardware, people...) and insulating your system from those points of failure.

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it. Keep helpers close to the code they support, below the main export when that improves readability.

Great names capture what a thing is or does. Append qualifiers to names. Units, bounds, and modifiers come at the end. This groups related variables together and makes scanning easier.

Anchor design decisions on the user's primary task or focus, to make sure the user can complete those tasks easily, not overwhelmed by unrelated UI clutter or user flows. Our UI should help users complete their tasks, not hinder them.

Constants are module-level and UPPER_SNAKE_CASE: Physics constants, selectors, and thresholds are declared at the top of the file, never inside the component.

Inline single-use values when the expression is obvious in place. Keep a name when it encodes units, domain meaning, or a non-obvious intermediate — even if used once.

### Comments

Use mostly ASD-STE100 Simplified Technical English. Use active voice, simple tenses, one idea per sentence, and consistent terms. Explain why, not what, and only when a future reader (with no access to this PR or chat) would otherwise be confused. If appropriate, prefer no comments at all.

Never log change history or chat context in code — no "previously did X, now does Y", "per <task/PR>", "changed because…", or "AI:"/"agent:" notes. That goes in the commit message and PR description

When refactoring or moving code, preserve existing comments unless they are explicitly made obsolete by the change
